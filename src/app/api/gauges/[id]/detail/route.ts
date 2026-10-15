import { NextResponse } from 'next/server';
import { readPublicDataText } from '@/lib/data-assets';
import { buildDetail, resolveGaugeId, type GaugeDetail } from '@/lib/gaugeDetail';

export const dynamic = 'force-dynamic';

// Per-gauge detail for the gauge sheet: NWPS's gauge record (impact statements,
// crests) plus its observed and forecast stage series, normalised and thinned by
// src/lib/gaugeDetail.ts. Three small requests instead of the phone making them:
// the observed series alone is ~430 KB of 15-minute readings for 30 days, and
// the phone has no need to see NWPS or hold that.
const NWPS = 'https://api.water.noaa.gov/nwps/v1/gauges';
// One budget for all three requests, which run in parallel.
const FETCH_TIMEOUT_MS = 8_000;
const TTL_OK_MS = 10 * 60_000;
// Retry soon after a failure, so one NWPS hiccup is not pinned for 10 minutes.
const TTL_DEGRADED_MS = 30_000;
const MAX_CACHED = 300;

let knownIds: Set<string> | null = null;
// Only gauges in the build-time list are served: the id goes into an upstream
// URL, and this route must not become an open proxy for NWPS.
async function loadKnownIds(): Promise<Set<string>> {
  if (knownIds && knownIds.size > 0) return knownIds;
  try {
    const raw = await readPublicDataText('gauges-meta.json');
    if (raw === null) throw new Error('gauges-meta.json not found (fs or ASSETS binding)');
    const parsed = JSON.parse(raw) as { gauges: { id: string }[] };
    knownIds = new Set(parsed.gauges.map(g => g.id));
    return knownIds;
  } catch (err) {
    // Not cached, so a transient read error can recover. Callers answer 503.
    console.error('[gauges/detail] failed to load gauges-meta.json — cannot validate ids:', err);
    return new Set();
  }
}

// Parsed JSON, or null for any failure (timeout, 404, non-JSON, upstream error).
async function fetchJson(url: string, signal: AbortSignal): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal,
      headers: { 'User-Agent': 'texas-flood-map/0.1', Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

type Cached = { body: GaugeDetail; expires: number };
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached>>();

async function build(id: string): Promise<Cached> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const base = `${NWPS}/${id}`;
    const [record, observed, forecast] = await Promise.all([
      fetchJson(base, ctl.signal),
      fetchJson(`${base}/stageflow/observed`, ctl.signal),
      fetchJson(`${base}/stageflow/forecast`, ctl.signal),
    ]);
    const now = Date.now();
    const body = buildDetail(id, { record, observed, forecast }, now);
    const complete = body.sources.record && body.sources.observed && body.sources.forecast;
    return { body, expires: now + (complete ? TTL_OK_MS : TTL_DEGRADED_MS) };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const known = await loadKnownIds();
  if (known.size === 0) {
    return NextResponse.json({ error: 'gauge list unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const id = resolveGaugeId(rawId, known);
  if (!id) {
    return NextResponse.json({ error: 'unknown gauge id' }, { status: 404, headers: { 'Cache-Control': 'public, max-age=3600' } });
  }

  let entry = cache.get(id);
  const hit = !!entry && entry.expires > Date.now();
  if (!hit) {
    // Single flight: concurrent opens of one gauge share one set of NWPS requests.
    let pending = inflight.get(id);
    if (!pending) {
      pending = build(id).finally(() => inflight.delete(id));
      inflight.set(id, pending);
    }
    entry = await pending;
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.set(id, entry);
  }
  const { body, expires } = entry!;
  // Fail soft: an all-failed answer is a 200 with ok:false (the sheet shows its
  // error state) and stays out of shared caches, like a degraded one, so the
  // next open retries. The edge may hold a good one as long as this isolate would.
  const ttl = Math.max(0, Math.floor((expires - Date.now()) / 1000));
  return NextResponse.json(body, {
    headers: {
      'Cache-Control': body.ok && ttl > 60 ? `public, max-age=${Math.min(ttl, 300)}, s-maxage=${ttl}` : 'no-store',
      'X-Cache': hit ? 'HIT' : 'MISS',
    },
  });
}
