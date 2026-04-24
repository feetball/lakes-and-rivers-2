import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { FloodCategory, GaugeStatus, GaugesResponse } from '@/lib/types';
import { sanitizeThresholds } from '@/lib/floodStatus';

// The NWPS list response is ~13 MB (over Next's 2 MB fetch-cache limit) and
// takes ~45-60 s to serve, so we keep an in-memory cache per server instance
// and serve a static fallback on cold start instead of making the user wait.
export const dynamic = 'force-dynamic';

const NWPS_LIST = 'https://api.water.noaa.gov/nwps/v1/gauges?state=TX';
const TTL_MS = 10 * 60 * 1000;
const COLD_BUDGET_MS = 4_000; // how long we wait on the first fetch before serving fallback

let cache: { body: GaugesResponse; ts: number } | null = null;
let inflight: Promise<GaugesResponse> | null = null;

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
  } catch {
    metaCache = new Map();
  }
  return metaCache;
}

const VALID: FloodCategory[] = ['no_flooding', 'not_defined', 'action', 'minor', 'moderate', 'major'];
function normalizeCategory(raw: unknown): FloodCategory {
  return typeof raw === 'string' && (VALID as string[]).includes(raw)
    ? (raw as FloodCategory)
    : 'not_defined';
}

async function fetchFresh(): Promise<GaugesResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 90_000);
    try {
      const res = await fetch(NWPS_LIST, {
        cache: 'no-store',
        signal: ctl.signal,
        headers: { 'User-Agent': 'texas-flood-map/0.1' },
      });
      if (!res.ok) throw new Error(`NWPS ${res.status}`);
      const data: any = await res.json();
      const list: any[] = Array.isArray(data) ? data : data.gauges ?? [];
      const meta = await loadMeta();
      const gauges: Record<string, GaugeStatus> = {};
      for (const g of list) {
        if (!g?.lid || g?.state?.abbreviation !== 'TX') continue;
        const obs = g.status?.observed;
        const m = meta.get(g.lid);
        gauges[g.lid] = {
          id: g.lid,
          name: g.name ?? g.lid,
          lat: g.latitude,
          lon: g.longitude,
          category: normalizeCategory(obs?.floodCategory ?? g.ObservedFloodCategory),
          observedStage: typeof obs?.primary === 'number' ? obs.primary : null,
          observedAt: obs?.validTime ?? null,
          unit: obs?.primaryUnit ?? g.flood?.stageUnits ?? m?.unit ?? null,
          thresholds: m?.thresholds ?? null,
        };
      }
      return { gauges, updatedAt: new Date().toISOString() };
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

function ensureFetch(): Promise<GaugesResponse> {
  if (inflight) return inflight;
  inflight = fetchFresh()
    .then(body => { cache = { body, ts: Date.now() }; return body; })
    .finally(() => { inflight = null; });
  return inflight;
}

async function fallbackFromMeta(): Promise<GaugesResponse> {
  const meta = await loadMeta();
  const gauges: Record<string, GaugeStatus> = {};
  for (const g of meta.values()) {
    gauges[g.id] = {
      id: g.id, name: g.name, lat: g.lat, lon: g.lon,
      category: 'not_defined',
      observedStage: null, observedAt: null,
      unit: g.unit, thresholds: g.thresholds,
    };
  }
  return { gauges, updatedAt: new Date(0).toISOString() };
}

export async function GET() {
  // Fresh cache → instant serve.
  if (cache && Date.now() - cache.ts < TTL_MS) {
    return NextResponse.json(cache.body, {
      headers: { 'Cache-Control': 'public, max-age=60', 'X-Cache': 'HIT' },
    });
  }
  // Stale cache → serve it, refresh in the background.
  if (cache) {
    ensureFetch().catch(() => {});
    return NextResponse.json(cache.body, {
      headers: { 'Cache-Control': 'public, max-age=30', 'X-Cache': 'STALE' },
    });
  }
  // No cache yet → race the fetch against a short budget; if the fetch
  // doesn't complete in time, serve the static fallback and keep the fetch
  // going so subsequent calls hit cache.
  const fetchPromise = ensureFetch();
  try {
    const body = await Promise.race([
      fetchPromise,
      new Promise<GaugesResponse>((_, rej) =>
        setTimeout(() => rej(new Error('cold-budget')), COLD_BUDGET_MS),
      ),
    ]);
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, max-age=60', 'X-Cache': 'MISS' },
    });
  } catch {
    // Fetch still running (or failed) — serve fallback now. SWR on the
    // client will re-poll and pick up real data shortly.
    try {
      const fb = await fallbackFromMeta();
      return NextResponse.json(fb, {
        headers: { 'Cache-Control': 'public, max-age=15', 'X-Cache': 'FALLBACK' },
      });
    } catch (e) {
      return NextResponse.json(
        { error: 'Failed to fetch gauge data', detail: String(e) },
        { status: 502 },
      );
    }
  }
}
