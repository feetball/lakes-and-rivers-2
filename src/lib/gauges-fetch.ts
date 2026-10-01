import { unstable_cache } from 'next/cache';
import { readPublicDataText } from '@/lib/data-assets';
import type { FloodCategory, GaugeStatus, GaugesResponse } from '@/lib/types';
import { sanitizeThresholds, categorizeByStage } from '@/lib/floodStatus';

const NWPS_LIST = 'https://api.water.noaa.gov/nwps/v1/gauges?state=TX';
export const GAUGES_CACHE_TAG = 'gauges-list';

type MetaEntry = {
  id: string; name: string; lat: number; lon: number;
  usgsId: string | null;
  thresholds: { action: number | null; minor: number | null; moderate: number | null; major: number | null } | null;
  unit: string | null;
  // Build-time observation snapshot. Lets the runtime fallback ship real
  // (stale) flood categories instead of "not_defined" until the live cache
  // populates. Optional because pre-observation builds may still be loaded.
  category?: FloodCategory;
  observedStage?: number | null;
  observedAt?: string | null;
};

type MetaFile = {
  gauges: MetaEntry[];
  observationsAt?: string | null;
  builtAt?: string;
};

let metaCache: { entries: Map<string, MetaEntry>; observationsAt: string | null } | null = null;
async function loadMeta(): Promise<{ entries: Map<string, MetaEntry>; observationsAt: string | null }> {
  if (metaCache && metaCache.entries.size > 0) return metaCache;
  try {
    const raw = await readPublicDataText('gauges-meta.json');
    if (raw === null) throw new Error('gauges-meta.json not found (fs or ASSETS binding)');
    const parsed = JSON.parse(raw) as MetaFile;
    const entries = new Map(
      parsed.gauges.map(g => [g.id, { ...g, thresholds: sanitizeThresholds(g.thresholds) }]),
    );
    metaCache = { entries, observationsAt: parsed.observationsAt ?? null };
  } catch (err) {
    // A failed read here is the silent failure mode behind "rivers render
    // gray": no thresholds means gauges NWPS reports as not_defined can't be
    // upgraded to a real flood category. On Vercel this happens when
    // gauges-meta.json isn't traced into the function bundle (see
    // outputFileTracingIncludes in next.config.mjs); on Cloudflare, when the
    // ASSETS binding can't resolve /data/gauges-meta.json. Log it loudly so a
    // path regression shows up in function logs instead of looking like
    // upstream behavior. Don't cache the empty result, so a transient read
    // error can recover on the next request.
    console.error('[gauges] failed to load gauges-meta.json — thresholds unavailable, gauges will be uncolored:', err);
    return { entries: new Map(), observationsAt: null };
  }
  return metaCache;
}

const VALID: FloodCategory[] = ['no_flooding', 'not_defined', 'action', 'minor', 'moderate', 'major'];
function normalizeCategory(raw: unknown): FloodCategory {
  return typeof raw === 'string' && (VALID as string[]).includes(raw)
    ? (raw as FloodCategory)
    : 'not_defined';
}

// NWPS often returns floodCategory: null even for gauges with a valid current
// observation and full set of thresholds. Without this, those gauges paint
// "No data" gray on the map even though the gauge sheet shows real values.
// When the upstream category is missing but we have both stage and thresholds,
// derive it ourselves via the same comparison NWS uses.
function resolveCategory(
  rawCategory: unknown,
  stage: number | null,
  thresholds: GaugeStatus['thresholds'],
): FloodCategory {
  const normalized = normalizeCategory(rawCategory);
  if (normalized !== 'not_defined') return normalized;
  if (stage === null || !thresholds) return normalized;
  return categorizeByStage(stage, thresholds);
}

// Per-attempt upstream timeout. NWPS's TX list is ~13 MB and takes ~40 s on a
// good day (and can hang ~60 s before a 504), so this must exceed ~40 s for a
// healthy fetch yet abort before Vercel's function cap.
const NWPS_TIMEOUT_MS = Number(process.env.NWPS_TIMEOUT_MS) || 45_000;
// Attempts per call. Default 1: one ~45 s attempt fits comfortably inside
// Vercel Hobby's 60 s function budget (the cron awaits this, and /api/gauges
// warms it via after() on the same clock). NWPS is flaky, but a missed refresh
// is invisible — users always get the 4 s build-time fallback — and the cache
// retries every 30 min (revalidate) plus on each cron tick. Self-hosters with
// no time cap can set NWPS_MAX_ATTEMPTS=2+ for more resilience.
const NWPS_MAX_ATTEMPTS = Math.max(1, Number(process.env.NWPS_MAX_ATTEMPTS) || 1);

// Turn a raw NWPS gauge list (the ~13 MB JSON from NWPS_LIST, or the `gauges`
// array within it) into our compact GaugesResponse. Pulls thresholds from the
// build-time meta so categories resolve identically to the live path. Exported
// so the ingest endpoint — which receives the raw list fetched by an external
// worker that isn't bound by Vercel's 60 s cap — can reuse the exact same
// processing instead of duplicating it.
export async function processNwpsList(list: any[]): Promise<GaugesResponse> {
  const meta = (await loadMeta()).entries;
  const gauges: Record<string, GaugeStatus> = {};
  for (const g of list) {
    if (!g?.lid || g?.state?.abbreviation !== 'TX') continue;
    const obs = g.status?.observed;
    const m = meta.get(g.lid);
    const stage = typeof obs?.primary === 'number' ? obs.primary : null;
    const thresholds = m?.thresholds ?? null;
    gauges[g.lid] = {
      id: g.lid,
      name: g.name ?? g.lid,
      lat: g.latitude,
      lon: g.longitude,
      category: resolveCategory(obs?.floodCategory ?? g.ObservedFloodCategory, stage, thresholds),
      observedStage: stage,
      observedAt: obs?.validTime ?? null,
      unit: obs?.primaryUnit ?? g.flood?.stageUnits ?? m?.unit ?? null,
      thresholds,
    };
  }
  return { gauges, updatedAt: new Date().toISOString() };
}

// USGS Instantaneous Values — same physical stage readings NWPS surfaces,
// but split across sites so each batch is small and fast (~8 requests for
// TX instead of one ~13 MB list). Used as a fallback below.
const USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
const USGS_PARAM_STAGE = '00065'; // gauge height, ft
const USGS_BATCH_SIZE = 100; // USGS caps multi-site requests; keep batches small
// Per-batch timeout. On Vercel the fallback runs AFTER the ~45 s NWPS attempt
// inside the same 60 s function budget (maxDuration on the cron/gauges
// routes), so cap it there: 45 + 12 + overhead stays under the platform
// kill. Cloudflare/Docker have no wall-clock cap on the awaited refresh, so
// they get the full window.
const USGS_TIMEOUT_MS = process.env.VERCEL === '1'
  ? Math.min(Number(process.env.USGS_TIMEOUT_MS) || 30_000, 12_000)
  : Number(process.env.USGS_TIMEOUT_MS) || 30_000;

async function fetchUsgsBatch(sites: string[]): Promise<any> {
  const params = new URLSearchParams({
    format: 'json',
    sites: sites.join(','),
    parameterCd: USGS_PARAM_STAGE,
    period: 'PT2H',
  });
  const url = `${USGS_IV}?${params.toString()}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), USGS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'texas-flood-map/0.1' } });
    if (!res.ok) throw new Error(`USGS ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Pick the most recent valid (finite, > missing-value sentinel) point from a
// USGS values array. Doesn't trust the array to already be time-ordered —
// USGS IV responses are typically ascending, but validate explicitly rather
// than assuming.
function latestValue(values: any[]): { value: number; dateTime: string } | null {
  let best: { value: number; dateTime: string; ms: number } | null = null;
  for (const v of values) {
    const dt = v?.dateTime;
    const raw = v?.value;
    if (typeof dt !== 'string' || raw == null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= -999) continue; // USGS missing-value sentinel
    const ms = Date.parse(dt);
    if (!Number.isFinite(ms)) continue;
    if (!best || ms > best.ms) best = { value: num, dateTime: dt, ms };
  }
  return best ? { value: best.value, dateTime: best.dateTime } : null;
}

// Fallback for when NWPS's TX list is unreachable. NWPS's 504s hit regularly
// under Vercel's function time cap; USGS IV carries the same physical stage
// readings NWPS is built on, but split into ~8 small, fast batch requests
// instead of one ~13 MB list fetch, so the cron refresh can still succeed
// when NWPS is down. Builds a response over every meta entry (like
// fallbackFromMeta) so gauges without a USGS ID, or whose batch failed,
// still render using their build-time snapshot rather than disappearing.
async function fetchViaUsgsIv(): Promise<GaugesResponse> {
  const meta = await loadMeta();
  if (meta.entries.size === 0) throw new Error('no meta available for USGS fallback');

  // usgsId -> ALL lids sharing that site. Normally one lid per site, but the
  // meta really does contain shared sites (e.g. UMBT2 and UMRT2 both map to
  // 07295500) — a reading must fan out to every lid, same as the build-time
  // fallback in build-waterways-data.mjs does.
  const siteToLids = new Map<string, string[]>();
  for (const m of meta.entries.values()) {
    if (!m.usgsId) continue;
    const lids = siteToLids.get(m.usgsId);
    if (lids) lids.push(m.id);
    else siteToLids.set(m.usgsId, [m.id]);
  }
  const siteIds = [...siteToLids.keys()];

  const readings = new Map<string, { value: number; dateTime: string }>();
  const batches: string[][] = [];
  for (let i = 0; i < siteIds.length; i += USGS_BATCH_SIZE) {
    batches.push(siteIds.slice(i, i + USGS_BATCH_SIZE));
  }
  const results = await Promise.all(
    batches.map(async batch => {
      try {
        const json = await fetchUsgsBatch(batch);
        const series = json?.value?.timeSeries ?? [];
        for (const ts of series) {
          const siteId = ts?.sourceInfo?.siteCode?.[0]?.value;
          const lids = siteId ? siteToLids.get(siteId) : null;
          if (!lids) continue;
          const values = ts?.values?.[0]?.value ?? [];
          const pick = latestValue(values);
          if (pick) for (const lid of lids) readings.set(lid, pick);
        }
        return true;
      } catch {
        return false; // partial failure — tolerated as long as some batch succeeds
      }
    }),
  );
  const failedBatches = results.filter(ok => !ok).length;
  if (siteIds.length > 0 && failedBatches === batches.length) {
    throw new Error(`all ${batches.length} USGS IV batches failed`);
  }
  // Batches can "succeed" yet carry no usable points (empty timeSeries,
  // all-sentinel values). Returning meta-only data stamped with a fresh
  // updatedAt would falsely present the build-time snapshot as live — let
  // the caller keep the previous cache / meta fallback instead, which report
  // their staleness honestly.
  if (readings.size === 0) {
    throw new Error('USGS IV returned no usable readings');
  }

  const gauges: Record<string, GaugeStatus> = {};
  for (const g of meta.entries.values()) {
    const live = readings.get(g.id);
    if (live) {
      gauges[g.id] = {
        id: g.id, name: g.name, lat: g.lat, lon: g.lon,
        category: g.thresholds ? categorizeByStage(live.value, g.thresholds) : 'not_defined',
        observedStage: live.value,
        observedAt: live.dateTime,
        unit: g.unit, thresholds: g.thresholds,
      };
    } else {
      gauges[g.id] = {
        id: g.id, name: g.name, lat: g.lat, lon: g.lon,
        category: normalizeCategory(g.category),
        observedStage: g.observedStage ?? null,
        observedAt: g.observedAt ?? null,
        unit: g.unit, thresholds: g.thresholds,
      };
    }
  }

  console.log(
    `[gauges] USGS IV fallback: ${readings.size}/${siteIds.length} sites returned a live reading (${failedBatches}/${batches.length} batches failed)`,
  );

  // updatedAt = now, same convention as processNwpsList: it stamps when the
  // dataset was assembled, and per-gauge observedAt carries each reading's
  // real age. The readings.size guard above ensures we never stamp a payload
  // that contains no live data at all.
  return { gauges, updatedAt: new Date().toISOString() };
}

async function fetchFreshGauges(): Promise<GaugesResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < NWPS_MAX_ATTEMPTS; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), NWPS_TIMEOUT_MS);
    try {
      const res = await fetch(NWPS_LIST, {
        cache: 'no-store',
        signal: ctl.signal,
        headers: { 'User-Agent': 'texas-flood-map/0.1' },
      });
      if (!res.ok) throw new Error(`NWPS ${res.status}`);
      const data: any = await res.json();
      const list: any[] = Array.isArray(data) ? data : data.gauges ?? [];
      return await processNwpsList(list);
    } catch (e) {
      lastErr = e;
      // Only back off if another attempt follows — don't sleep then throw.
      if (attempt < NWPS_MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    } finally {
      clearTimeout(t);
    }
  }
  // NWPS is down (or every attempt timed out/504'd). Fall back to USGS IV
  // rather than throwing — a failed refresh here means the shared cache
  // never updates and users sit on the stale "Loading live gauge data"
  // banner indefinitely. If the fallback also fails, surface the original
  // NWPS error since that's the primary path users/ops care about.
  console.warn(`[gauges] NWPS list failed (${lastErr}); falling back to USGS IV`);
  try {
    return await fetchViaUsgsIv();
  } catch {
    throw lastErr;
  }
}

// Wraps the upstream fetch in Next.js's data cache so the result is shared
// across all function instances on Vercel (the prior module-level `cache`
// variable was per-instance only). The cron at /api/cron/refresh-gauges
// invalidates this tag every 30 min so the cache is proactively refreshed.
export const getCachedGauges = unstable_cache(
  fetchFreshGauges,
  ['gauges-list-tx'],
  { revalidate: 1800, tags: [GAUGES_CACHE_TAG] },
);

export async function fallbackFromMeta(): Promise<GaugesResponse> {
  const { entries, observationsAt } = await loadMeta();
  const gauges: Record<string, GaugeStatus> = {};
  for (const g of entries.values()) {
    gauges[g.id] = {
      id: g.id, name: g.name, lat: g.lat, lon: g.lon,
      // Defense-in-depth: older meta files may carry raw NWPS operational
      // strings (out_of_service / obs_not_current / low_threshold) that aren't
      // FloodCategory members and would render as gray with broken labels.
      // normalizeCategory collapses anything unknown to not_defined.
      category: normalizeCategory(g.category),
      observedStage: g.observedStage ?? null,
      observedAt: g.observedAt ?? null,
      unit: g.unit, thresholds: g.thresholds,
    };
  }
  // observationsAt — the most recent observation time captured at build —
  // becomes the response's updatedAt. Falls back to epoch-0 only when the
  // build skipped observation capture (e.g. NWPS list timed out at build),
  // which is the legacy "no real data" sentinel the client uses to decide
  // whether to show the "Loading live gauge data" banner.
  return { gauges, updatedAt: observationsAt ?? new Date(0).toISOString() };
}
