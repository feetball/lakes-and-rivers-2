import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { FloodCategory, GaugeStatus, GaugesResponse } from '@/lib/types';
import { categorizeByStage, sanitizeThresholds } from '@/lib/floodStatus';

export const dynamic = 'force-dynamic';

// NWPS forecast product — per-gauge stage/flow forecast timeseries.
const NWPS_FORECAST = (lid: string) => `https://api.water.noaa.gov/nwps/v1/gauges/${lid}/stageflow/forecast`;
const FORECAST_WINDOW_HOURS = 24 * 5; // 5 days ahead supported
const PAST_GRACE_MS = 5 * 60_000; // allow a few minutes of clock skew into the past
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 16;
const SERIES_TTL_MS = 30 * 60_000; // forecast points update a few times a day upstream
const EDGE_EXTRAPOLATION_MS = 6 * 3_600_000; // only extend the first point 6h backward

type MetaEntry = {
  id: string; name: string; lat: number; lon: number;
  usgsId: string | null;
  thresholds: { action: number | null; minor: number | null; moderate: number | null; major: number | null } | null;
  unit: string | null;
};

let metaCache: Map<string, MetaEntry> | null = null;
async function loadMeta(): Promise<Map<string, MetaEntry>> {
  if (metaCache && metaCache.size > 0) return metaCache;
  try {
    const raw = await readFile(resolve(process.cwd(), 'public/data/gauges-meta.json'), 'utf8');
    const parsed = JSON.parse(raw) as { gauges: MetaEntry[] };
    metaCache = new Map(parsed.gauges.map(g => [g.id, { ...g, thresholds: sanitizeThresholds(g.thresholds) }]));
  } catch (err) {
    // Same silent-failure mode as the history route: no meta means no
    // thresholds means every gauge renders not_defined. Log loudly, don't
    // cache the empty result so a transient read error can recover.
    console.error('[gauges/forecast] failed to load gauges-meta.json — thresholds unavailable:', err);
    return new Map();
  }
  return metaCache;
}

// A single forecast point in ft (stage) at a point in time.
type ForecastPoint = { t: number; stage: number };

// null = "fetched, no usable forecast for this gauge" (cache the miss too).
type SeriesEntry = { points: ForecastPoint[] | null; ts: number };

const seriesCache: Map<string, SeriesEntry> = new Map();
let seriesBuildPromise: Promise<Map<string, SeriesEntry>> | null = null;

async function fetchForecastSeries(lid: string): Promise<ForecastPoint[] | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(NWPS_FORECAST(lid), {
      signal: ctl.signal,
      headers: { 'User-Agent': 'texas-flood-map/0.1', Accept: 'application/json' },
    });
    if (!res.ok) return null; // includes 404 — gauge has no forecast product
    let json: any;
    try {
      json = await res.json();
    } catch {
      return null; // non-JSON body
    }
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const points: ForecastPoint[] = [];
    for (const d of data) {
      const validTime = d?.validTime;
      const raw = d?.primary;
      if (typeof validTime !== 'string' || typeof raw !== 'number') continue;
      if (!Number.isFinite(raw) || raw <= -100) continue; // NWPS missing-value sentinel
      const ms = new Date(validTime).getTime();
      if (!Number.isFinite(ms)) continue;
      points.push({ t: ms, stage: raw });
    }
    if (points.length === 0) return null;
    points.sort((a, b) => a.t - b.t);
    return points;
  } catch {
    return null; // timeout / network error — treat as no forecast for this request
  } finally {
    clearTimeout(t);
  }
}

// Run `fn` over `items` with at most `limit` in flight at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Build (or reuse an in-flight build of) the series cache for the given
// lids. Single-flight so N concurrent requests during a cold cache don't
// each hammer NWPS for the same few hundred gauges.
async function getSeriesCache(lids: string[]): Promise<Map<string, SeriesEntry>> {
  const now = Date.now();
  const stale = lids.some(lid => {
    const e = seriesCache.get(lid);
    return !e || now - e.ts >= SERIES_TTL_MS;
  });
  if (!stale) return seriesCache;

  if (!seriesBuildPromise) {
    seriesBuildPromise = (async () => {
      const missing = lids.filter(lid => {
        const e = seriesCache.get(lid);
        return !e || Date.now() - e.ts >= SERIES_TTL_MS;
      });
      const fetched = await mapLimit(missing, FETCH_CONCURRENCY, async lid => {
        const points = await fetchForecastSeries(lid);
        return [lid, points] as const;
      });
      const ts = Date.now();
      for (const [lid, points] of fetched) {
        seriesCache.set(lid, { points, ts });
      }
      return seriesCache;
    })();
    try {
      await seriesBuildPromise;
    } finally {
      seriesBuildPromise = null;
    }
  } else {
    await seriesBuildPromise;
  }
  return seriesCache;
}

// Linear interpolation between the two forecast points surrounding `targetMs`.
// Returns null if `targetMs` falls outside the series (past the last point,
// or more than EDGE_EXTRAPOLATION_MS before the first point).
function interpolate(points: ForecastPoint[], targetMs: number): number | null {
  if (points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (targetMs <= first.t) {
    return first.t - targetMs <= EDGE_EXTRAPOLATION_MS ? first.stage : null;
  }
  if (targetMs > last.t) return null; // no forecast that far out for this gauge
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (targetMs <= b.t) {
      if (b.t === a.t) return a.stage;
      const frac = (targetMs - a.t) / (b.t - a.t);
      return a.stage + frac * (b.stage - a.stage);
    }
  }
  return null;
}

// Cache per-ISO-time results for 10 min so a user scrubbing the forecast
// timeline doesn't rebuild the same interpolated response twice.
const resCache = new Map<string, { body: GaugesResponse; ts: number }>();
const RES_TTL_MS = 10 * 60_000;

function cacheKey(atIso: string): string {
  // Forecast points are ~hourly at best, so snap to coarser 15-minute
  // buckets than the history route to avoid cache bloat.
  const ts = Math.round(new Date(atIso).getTime() / 900_000) * 900_000;
  return new Date(ts).toISOString();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const atParam = url.searchParams.get('at');
  if (!atParam) {
    return NextResponse.json({ error: 'missing ?at=<ISO>' }, { status: 400 });
  }
  const at = new Date(atParam);
  if (Number.isNaN(at.getTime())) {
    return NextResponse.json({ error: 'invalid ?at' }, { status: 400 });
  }
  const now = Date.now();
  const minAt = now - PAST_GRACE_MS;
  const maxAt = now + FORECAST_WINDOW_HOURS * 3_600_000;
  if (at.getTime() < minAt || at.getTime() > maxAt) {
    return NextResponse.json(
      { error: `?at must be within the next ${FORECAST_WINDOW_HOURS}h (and not more than 5min in the past)` },
      { status: 400 },
    );
  }

  const key = cacheKey(at.toISOString());
  const cached = resCache.get(key);
  if (cached && Date.now() - cached.ts < RES_TTL_MS) {
    return NextResponse.json(cached.body, { headers: { 'X-Cache': 'HIT' } });
  }

  const meta = await loadMeta();
  // Only gauges with flood thresholds are worth forecasting — mirrors the
  // history route's eligibility filter (NWPS lid == our gauge id).
  const usable = Array.from(meta.values()).filter(m => m.thresholds);

  const series = await getSeriesCache(usable.map(m => m.id));

  const gauges: Record<string, GaugeStatus> = {};
  const targetMs = at.getTime();
  for (const m of usable) {
    const entry = series.get(m.id);
    const points = entry?.points ?? null;
    const stage = points ? interpolate(points, targetMs) : null;
    const category: FloodCategory = stage !== null && m.thresholds
      ? categorizeByStage(stage, m.thresholds)
      : 'not_defined';
    gauges[m.id] = {
      id: m.id, name: m.name, lat: m.lat, lon: m.lon,
      category,
      observedStage: stage,
      observedAt: stage !== null ? at.toISOString() : null,
      unit: m.unit,
      thresholds: m.thresholds,
    };
  }

  const body: GaugesResponse = { gauges, updatedAt: at.toISOString() };
  resCache.set(key, { body, ts: Date.now() });
  return NextResponse.json(body, { headers: { 'Cache-Control': 'public, max-age=60', 'X-Cache': 'MISS' } });
}
