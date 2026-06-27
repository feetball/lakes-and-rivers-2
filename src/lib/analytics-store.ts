import { put, list, del, get } from '@vercel/blob';

// Self-hosted, Blob-backed analytics. Replaces the need for Vercel's paid Web
// Analytics for the metrics this app cares about (pageviews, unique visitors,
// most-opened gauges, referrers) and — unlike Vercel Analytics — the data is
// queryable from our own admin panel.
//
// Design: events are APPEND-ONLY. Each event is written as its own immutable
// blob under analytics/raw/<day>/<random>.json. We never read-modify-write a
// shared counter, so concurrent serverless invocations can't clobber each
// other's writes (the classic lost-update race). Aggregation happens at READ
// time in the admin route: list() the raw blobs and fold them into counters.
//
// To keep reads bounded as traffic accumulates, the admin read also COMPACTS:
// days older than today are folded into a single analytics/rollup/<day>.json
// summary and their raw event blobs are deleted. So a read only ever fetches
// today's raw events plus the small per-day rollups.

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

function hasBlobToken(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export function analyticsEnabled(): boolean {
  return hasBlobToken();
}

// UTC day key for an ISO timestamp.
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

// Append one event. Best-effort: never throws into the request path (the
// /api/track route ignores failures so a Blob hiccup never breaks the page).
export async function recordEvent(ev: TrackEvent, rand: string): Promise<void> {
  if (!hasBlobToken()) return;
  const day = dayOf(ev.at);
  // rand is supplied by the caller (crypto.randomUUID in the route) so this
  // module stays free of the Date.now/random ban and keys never collide.
  await put(`${RAW_PREFIX}${day}/${rand}.json`, JSON.stringify(ev), {
    access: 'private',
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
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

// Read a PRIVATE blob's JSON body. Events/rollups are written with
// access:'private', which are NOT fetchable by plain URL — they must be read
// through the SDK's get(..., { access:'private' }), same as gauges-store.ts.
// (The previous fetch(b.url) silently returned null for every blob, so every
// aggregate came back as zeros even though events were being written.)
async function readJson<T>(pathname: string): Promise<T | null> {
  try {
    const result = await get(pathname, { access: 'private' });
    if (!result || result.statusCode !== 200) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// Aggregate all raw events for one day into a DayAggregate. Fetches every raw
// blob for that day — bounded because compaction removes past days' raw events.
async function aggregateRawDay(day: string): Promise<DayAggregate> {
  const agg = emptyDay(day);
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `${RAW_PREFIX}${day}/`, cursor, limit: 1000 });
    const events = await Promise.all(page.blobs.map((b) => readJson<TrackEvent>(b.pathname)));
    for (const ev of events) if (ev) foldEvent(agg, ev, seen);
    cursor = page.hasMore ? page.cursor : undefined;
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

// Compact a finished (past) day: write its rollup, then delete its raw blobs so
// future reads don't re-fetch them. Idempotent — re-running just rewrites the
// same rollup. Called only for days strictly before `today`.
async function compactDay(day: string): Promise<DayAggregate> {
  const agg = await aggregateRawDay(day);
  await put(`${ROLLUP_PREFIX}${day}.json`, JSON.stringify(agg), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
  // Delete the raw events now that they're rolled up.
  let cursor: string | undefined;
  const urls: string[] = [];
  do {
    const page = await list({ prefix: `${RAW_PREFIX}${day}/`, cursor, limit: 1000 });
    for (const b of page.blobs) urls.push(b.url);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (urls.length) await del(urls);
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
  if (!hasBlobToken()) return { totals: { pageviews: 0, visitors: 0, gaugeOpens: {}, referrers: {} }, byDay: [] };

  // 1. Existing rollups.
  const rollupDays: DayAggregate[] = [];
  {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: ROLLUP_PREFIX, cursor, limit: 1000 });
      const loaded = await Promise.all(page.blobs.map((b) => readJson<DayAggregate>(b.pathname)));
      for (const d of loaded) if (d) rollupDays.push(d);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  const haveRollup = new Set(rollupDays.map((d) => d.day));

  // 2. Which days have raw events? list() with a delimiter would give folders;
  // simpler to scan keys and pull the day segment.
  const rawDays = new Set<string>();
  {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: RAW_PREFIX, cursor, limit: 1000 });
      for (const b of page.blobs) {
        // key: analytics/raw/<day>/<rand>.json
        const seg = b.pathname.slice(RAW_PREFIX.length).split('/')[0];
        if (seg) rawDays.add(seg);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  const liveDays: DayAggregate[] = [];
  for (const day of rawDays) {
    if (day < today) {
      // Past day with leftover raw events — compact it (and it joins rollups).
      if (!haveRollup.has(day)) {
        liveDays.push(await compactDay(day));
      } else {
        // Already have a rollup but raw events linger (a crash mid-compact):
        // recompact to be safe.
        liveDays.push(await compactDay(day));
      }
    } else {
      // Today: aggregate live, do NOT compact (more events may still arrive).
      liveDays.push(await aggregateRawDay(day));
    }
  }

  // Drop any rollup day we just recomputed live, to avoid double counting.
  const liveSet = new Set(liveDays.map((d) => d.day));
  const allDays = [...rollupDays.filter((d) => !liveSet.has(d.day)), ...liveDays].sort((a, b) => a.day.localeCompare(b.day));

  return { totals: mergeDays(allDays), byDay: allDays };
}
