import { put, list, del, get } from '@vercel/blob';
import { IS_WORKERD } from '@/lib/data-assets';
import { getDataBucket, type R2BucketLike } from '@/lib/r2-data';

// Self-hosted analytics. Replaces the need for Vercel's paid Web Analytics
// for the metrics this app cares about (pageviews, unique visitors,
// most-opened gauges, referrers) and the data is queryable from our own
// admin panel.
//
// Storage: Cloudflare R2 (DATA_BUCKET binding) on the Workers deploy, Vercel
// Blob (BLOB_READ_WRITE_TOKEN) on Vercel/Docker — both behind the same
// four-operation Backend interface below, so the aggregation logic is
// backend-agnostic.
//
// Design: events are APPEND-ONLY. Each event is written as its own immutable
// object under analytics/raw/<day>/<random>.json. We never read-modify-write
// a shared counter, so concurrent serverless invocations can't clobber each
// other's writes (the classic lost-update race). Aggregation happens at READ
// time in the admin route: list the raw objects and fold them into counters.
//
// To keep reads bounded as traffic accumulates, the admin read also COMPACTS:
// days older than today are folded into a single analytics/rollup/<day>.json
// summary and their raw event objects are deleted. So a read only ever
// fetches today's raw events plus the small per-day rollups.

const RAW_PREFIX = 'analytics/raw/';
const ROLLUP_PREFIX = 'analytics/rollup/';

export type TrackEvent = {
  // 'pageview' | 'gauge_open' — kept open-ended so new event types don't need a
  // schema change.
  type: string;
  // For gauge_open: the gauge id/lid. Undefined for pageviews.
  gaugeId?: string;
  // Referrer hostname only (no full URL / query) — enough for "where from",
  // without storing anything identifying.
  referrer?: string;
  // Opaque per-visitor hash (sha256 of ip+ua+day, truncated). Lets us count
  // uniques without storing IPs. Rotates daily so it isn't a stable tracker.
  visitor?: string;
  // ISO timestamp.
  at: string;
};

// Per-day aggregate shape, shared by rollups and the admin response.
export type DayAggregate = {
  day: string; // YYYY-MM-DD
  pageviews: number;
  visitors: number; // distinct visitor hashes seen that day
  gaugeOpens: Record<string, number>; // gaugeId -> count
  referrers: Record<string, number>; // hostname -> count
};

// ---------------------------------------------------------------------------
// Storage backends

// `ref` is whatever deleteAll needs to remove the object: the R2 key, or the
// Vercel blob URL.
type Listed = { pathname: string; ref: string };
type Backend = {
  put(pathname: string, json: string): Promise<void>;
  readJson<T>(pathname: string): Promise<T | null>;
  listPage(prefix: string, cursor?: string): Promise<{ items: Listed[]; cursor?: string }>;
  deleteAll(refs: string[]): Promise<void>;
};

function r2Backend(bucket: R2BucketLike): Backend {
  return {
    async put(pathname, json) {
      await bucket.put(pathname, json);
    },
    async readJson<T>(pathname: string): Promise<T | null> {
      try {
        const obj = await bucket.get(pathname);
        if (!obj) return null;
        return JSON.parse(await obj.text()) as T;
      } catch {
        return null;
      }
    },
    async listPage(prefix, cursor) {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      return {
        items: page.objects.map(o => ({ pathname: o.key, ref: o.key })),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
    async deleteAll(refs) {
      // R2 accepts up to 1000 keys per delete call.
      for (let i = 0; i < refs.length; i += 1000) {
        await bucket.delete(refs.slice(i, i + 1000));
      }
    },
  };
}

function vercelBlobBackend(): Backend {
  return {
    async put(pathname, json) {
      await put(pathname, json, {
        access: 'private',
        contentType: 'application/json',
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });
    },
    // Events/rollups are written with access:'private', which are NOT
    // fetchable by plain URL — they must be read through the SDK's
    // get(..., { access:'private' }), same as gauges-store.ts.
    async readJson<T>(pathname: string): Promise<T | null> {
      try {
        const result = await get(pathname, { access: 'private' });
        if (!result || result.statusCode !== 200) return null;
        const text = await new Response(result.stream).text();
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
    async listPage(prefix, cursor) {
      const page = await list({ prefix, cursor, limit: 1000 });
      return {
        items: page.blobs.map(b => ({ pathname: b.pathname, ref: b.url })),
        cursor: page.hasMore ? page.cursor : undefined,
      };
    },
    async deleteAll(refs) {
      if (refs.length) await del(refs);
    },
  };
}

async function getBackend(): Promise<Backend | null> {
  const bucket = await getDataBucket();
  if (bucket) return r2Backend(bucket);
  if (process.env.BLOB_READ_WRITE_TOKEN) return vercelBlobBackend();
  return null;
}

export function analyticsEnabled(): boolean {
  // On Cloudflare the DATA_BUCKET binding can't be checked synchronously;
  // assume it's configured (wrangler.jsonc declares it) — recordEvent
  // degrades to a no-op if it isn't. Elsewhere, Vercel Blob needs its token.
  return IS_WORKERD || !!process.env.BLOB_READ_WRITE_TOKEN;
}

// UTC day key for an ISO timestamp.
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

// Append one event. Best-effort: never throws into the request path (a
// storage hiccup must never break the page).
export async function recordEvent(ev: TrackEvent, rand: string): Promise<void> {
  try {
    const backend = await getBackend();
    if (!backend) return;
    const day = dayOf(ev.at);
    // rand is supplied by the caller (crypto.randomUUID in the route) so this
    // module stays free of the Date.now/random ban and keys never collide.
    await backend.put(`${RAW_PREFIX}${day}/${rand}.json`, JSON.stringify(ev));
  } catch {
    // swallow — analytics must never break the request
  }
}

function emptyDay(day: string): DayAggregate {
  return { day, pageviews: 0, visitors: 0, gaugeOpens: {}, referrers: {} };
}

// Fold a single event into an aggregate. `seenVisitors` tracks distinct
// visitor hashes for the uniques count (passed in so it spans a whole day's
// raw events).
function foldEvent(agg: DayAggregate, ev: TrackEvent, seenVisitors: Set<string>) {
  if (ev.type === 'pageview') agg.pageviews++;
  if (ev.type === 'gauge_open' && ev.gaugeId) {
    agg.gaugeOpens[ev.gaugeId] = (agg.gaugeOpens[ev.gaugeId] ?? 0) + 1;
  }
  if (ev.referrer) {
    agg.referrers[ev.referrer] = (agg.referrers[ev.referrer] ?? 0) + 1;
  }
  if (ev.visitor && !seenVisitors.has(ev.visitor)) {
    seenVisitors.add(ev.visitor);
    agg.visitors++;
  }
}

// Aggregate all raw events for one day into a DayAggregate. Fetches every raw
// object for that day — bounded because compaction removes past days' events.
async function aggregateRawDay(backend: Backend, day: string): Promise<DayAggregate> {
  const agg = emptyDay(day);
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await backend.listPage(`${RAW_PREFIX}${day}/`, cursor);
    const events = await Promise.all(page.items.map(it => backend.readJson<TrackEvent>(it.pathname)));
    for (const ev of events) if (ev) foldEvent(agg, ev, seen);
    cursor = page.cursor;
  } while (cursor);
  return agg;
}

// Merge per-day aggregates into one total (for the admin summary). Visitor
// counts are summed across days — a visitor is "unique per day", which is the
// standard daily-unique convention and avoids storing stable identifiers.
function mergeDays(days: DayAggregate[]): Omit<DayAggregate, 'day'> {
  const total = { pageviews: 0, visitors: 0, gaugeOpens: {} as Record<string, number>, referrers: {} as Record<string, number> };
  for (const d of days) {
    total.pageviews += d.pageviews;
    total.visitors += d.visitors;
    for (const [k, v] of Object.entries(d.gaugeOpens)) total.gaugeOpens[k] = (total.gaugeOpens[k] ?? 0) + v;
    for (const [k, v] of Object.entries(d.referrers)) total.referrers[k] = (total.referrers[k] ?? 0) + v;
  }
  return total;
}

// Compact a finished (past) day: write its rollup, then delete its raw
// objects so future reads don't re-fetch them. Idempotent — re-running just
// rewrites the same rollup. Called only for days strictly before `today`.
async function compactDay(backend: Backend, day: string): Promise<DayAggregate> {
  const agg = await aggregateRawDay(backend, day);
  await backend.put(`${ROLLUP_PREFIX}${day}.json`, JSON.stringify(agg));
  // Delete the raw events now that they're rolled up.
  let cursor: string | undefined;
  const refs: string[] = [];
  do {
    const page = await backend.listPage(`${RAW_PREFIX}${day}/`, cursor);
    for (const it of page.items) refs.push(it.ref);
    cursor = page.cursor;
  } while (cursor);
  await backend.deleteAll(refs);
  return agg;
}

// Build the admin analytics summary. `today` (YYYY-MM-DD, UTC) is passed in by
// the route so this module avoids the Date ban. Steps:
//   1. Load existing rollups (past days, already compacted).
//   2. Find raw-event days; compact any that are < today; aggregate today live.
//   3. Merge everything into totals + a per-day series.
export async function getAnalyticsSummary(today: string): Promise<{
  totals: Omit<DayAggregate, 'day'>;
  byDay: DayAggregate[];
}> {
  const backend = await getBackend();
  if (!backend) return { totals: { pageviews: 0, visitors: 0, gaugeOpens: {}, referrers: {} }, byDay: [] };

  // 1. Existing rollups.
  const rollupDays: DayAggregate[] = [];
  {
    let cursor: string | undefined;
    do {
      const page = await backend.listPage(ROLLUP_PREFIX, cursor);
      const loaded = await Promise.all(page.items.map(it => backend.readJson<DayAggregate>(it.pathname)));
      for (const d of loaded) if (d) rollupDays.push(d);
      cursor = page.cursor;
    } while (cursor);
  }

  // 2. Which days have raw events? Scan keys and pull the day segment.
  const rawDays = new Set<string>();
  {
    let cursor: string | undefined;
    do {
      const page = await backend.listPage(RAW_PREFIX, cursor);
      for (const it of page.items) {
        // key: analytics/raw/<day>/<rand>.json
        const seg = it.pathname.slice(RAW_PREFIX.length).split('/')[0];
        if (seg) rawDays.add(seg);
      }
      cursor = page.cursor;
    } while (cursor);
  }

  const liveDays: DayAggregate[] = [];
  for (const day of rawDays) {
    if (day < today) {
      // Past day with leftover raw events — compact it (and it joins the
      // rollups). If a rollup already exists but raw events linger (a crash
      // mid-compact), recompact to be safe.
      liveDays.push(await compactDay(backend, day));
    } else {
      // Today: aggregate live, do NOT compact (more events may still arrive).
      liveDays.push(await aggregateRawDay(backend, day));
    }
  }

  // Drop any rollup day we just recomputed live, to avoid double counting.
  const liveSet = new Set(liveDays.map((d) => d.day));
  const allDays = [...rollupDays.filter((d) => !liveSet.has(d.day)), ...liveDays].sort((a, b) => a.day.localeCompare(b.day));

  return { totals: mergeDays(allDays), byDay: allDays };
}
