import { unstable_cache } from 'next/cache';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { FloodCategory, GaugeStatus, GaugesResponse } from '@/lib/types';
import { sanitizeThresholds } from '@/lib/floodStatus';

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
    const raw = await readFile(resolve(process.cwd(), 'public/data/gauges-meta.json'), 'utf8');
    const parsed = JSON.parse(raw) as MetaFile;
    const entries = new Map(
      parsed.gauges.map(g => [g.id, { ...g, thresholds: sanitizeThresholds(g.thresholds) }]),
    );
    metaCache = { entries, observationsAt: parsed.observationsAt ?? null };
  } catch {
    metaCache = { entries: new Map(), observationsAt: null };
  }
  return metaCache;
}

const VALID: FloodCategory[] = ['no_flooding', 'not_defined', 'action', 'minor', 'moderate', 'major'];
function normalizeCategory(raw: unknown): FloodCategory {
  return typeof raw === 'string' && (VALID as string[]).includes(raw)
    ? (raw as FloodCategory)
    : 'not_defined';
}

async function fetchFreshGauges(): Promise<GaugesResponse> {
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
      const meta = (await loadMeta()).entries;
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
      category: g.category ?? 'not_defined',
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
