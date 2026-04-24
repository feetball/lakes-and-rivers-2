import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { FloodCategory, GaugeStatus, GaugesResponse } from '@/lib/types';
import { categorizeByStage, sanitizeThresholds } from '@/lib/floodStatus';

export const dynamic = 'force-dynamic';

// USGS IV endpoint — instantaneous values, free, no key.
const USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
const PARAM_STAGE = '00065'; // gauge height, ft
const WINDOW_HOURS = 24 * 7; // 7 days lookback supported
const BATCH_SIZE = 100; // USGS caps multi-site requests; keep batches small

type MetaEntry = {
  id: string; name: string; lat: number; lon: number;
  usgsId: string | null;
  thresholds: { action: number | null; minor: number | null; moderate: number | null; major: number | null } | null;
  unit: string | null;
};

let metaCache: Map<string, MetaEntry> | null = null;
async function loadMeta(): Promise<Map<string, MetaEntry>> {
  if (metaCache && metaCache.size > 0) return metaCache;
  const raw = await readFile(resolve(process.cwd(), 'public/data/gauges-meta.json'), 'utf8');
  const parsed = JSON.parse(raw) as { gauges: MetaEntry[] };
  metaCache = new Map(parsed.gauges.map(g => [g.id, { ...g, thresholds: sanitizeThresholds(g.thresholds) }]));
  return metaCache;
}

// Cache per-ISO-time results for 10 min so a user scrubbing the timeline
// doesn't re-hit USGS for the same point twice.
const resCache = new Map<string, { body: GaugesResponse; ts: number }>();
const RES_TTL_MS = 10 * 60 * 1000;

function cacheKey(atIso: string): string {
  // Snap to 5-minute buckets to coalesce near-identical requests.
  const ts = Math.round(new Date(atIso).getTime() / 300_000) * 300_000;
  return new Date(ts).toISOString();
}

async function fetchBatch(sites: string[], startIso: string, endIso: string): Promise<any> {
  const params = new URLSearchParams({
    format: 'json',
    sites: sites.join(','),
    parameterCd: PARAM_STAGE,
    startDT: startIso,
    endDT: endIso,
  });
  const url = `${USGS_IV}?${params.toString()}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'texas-flood-map/0.1' } });
    if (!res.ok) throw new Error(`USGS ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Pick the observation closest to the target time from a USGS values array.
function closestValue(values: any[], targetMs: number): { value: number; dateTime: string } | null {
  let best: { value: number; dateTime: string; diff: number } | null = null;
  for (const v of values) {
    const dt = v?.dateTime;
    const raw = v?.value;
    if (typeof dt !== 'string' || raw == null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= -999) continue; // USGS missing-value sentinel
    const ms = new Date(dt).getTime();
    if (!Number.isFinite(ms)) continue;
    const diff = Math.abs(ms - targetMs);
    if (!best || diff < best.diff) best = { value: num, dateTime: dt, diff };
  }
  return best ? { value: best.value, dateTime: best.dateTime } : null;
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
  const maxBack = now - WINDOW_HOURS * 3_600_000;
  if (at.getTime() < maxBack || at.getTime() > now + 60_000) {
    return NextResponse.json({ error: `?at must be within the last ${WINDOW_HOURS}h` }, { status: 400 });
  }

  const key = cacheKey(at.toISOString());
  const cached = resCache.get(key);
  if (cached && Date.now() - cached.ts < RES_TTL_MS) {
    return NextResponse.json(cached.body, { headers: { 'X-Cache': 'HIT' } });
  }

  const meta = await loadMeta();
  // Only gauges we actually have USGS IDs for can be time-traveled.
  const usable = Array.from(meta.values()).filter(m => m.usgsId && m.thresholds);
  const siteToGauge = new Map<string, MetaEntry>();
  for (const m of usable) siteToGauge.set(m.usgsId!, m);

  const startIso = new Date(at.getTime() - 30 * 60_000).toISOString();
  const endIso = new Date(at.getTime() + 30 * 60_000).toISOString();

  const gauges: Record<string, GaugeStatus> = {};
  const siteIds = [...siteToGauge.keys()];
  for (let i = 0; i < siteIds.length; i += BATCH_SIZE) {
    const batch = siteIds.slice(i, i + BATCH_SIZE);
    let json: any;
    try {
      json = await fetchBatch(batch, startIso, endIso);
    } catch {
      continue; // partial failure — leave those gauges out for this timestamp
    }
    const series = json?.value?.timeSeries ?? [];
    for (const ts of series) {
      const siteId = ts?.sourceInfo?.siteCode?.[0]?.value;
      const m = siteId ? siteToGauge.get(siteId) : null;
      if (!m) continue;
      const values = ts?.values?.[0]?.value ?? [];
      const pick = closestValue(values, at.getTime());
      const stage = pick?.value ?? null;
      const category: FloodCategory = stage !== null && m.thresholds
        ? categorizeByStage(stage, m.thresholds)
        : 'not_defined';
      gauges[m.id] = {
        id: m.id, name: m.name, lat: m.lat, lon: m.lon,
        category,
        observedStage: stage,
        observedAt: pick?.dateTime ?? null,
        unit: m.unit,
        thresholds: m.thresholds,
      };
    }
  }

  // Include any gauges we didn't hear back from so the map still renders them
  // (as not_defined at this historical moment).
  for (const m of usable) {
    if (gauges[m.id]) continue;
    gauges[m.id] = {
      id: m.id, name: m.name, lat: m.lat, lon: m.lon,
      category: 'not_defined',
      observedStage: null, observedAt: null,
      unit: m.unit, thresholds: m.thresholds,
    };
  }

  const body: GaugesResponse = { gauges, updatedAt: at.toISOString() };
  resCache.set(key, { body, ts: Date.now() });
  return NextResponse.json(body, { headers: { 'Cache-Control': 'public, max-age=60', 'X-Cache': 'MISS' } });
}
