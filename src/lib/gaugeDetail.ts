// Pure normalisation behind GET /api/gauges/[id]/detail: NWPS's per-gauge record
// and its observed/forecast stage series in, one small payload for the gauge
// sheet out. No Next/Workers imports so tests/gaugeDetail.test.mjs can run it
// against real NWPS responses; the route does the fetching and caching.
import { cleanTime } from './gaugeStatus';
import { STALE_DATA_MS, isValidStage } from './floodStatus';

/** One stage reading or forecast value: epoch milliseconds and the stage. */
export interface DetailPoint { t: number; v: number }

/** What NWS says happens at a stage ("NWS impact statement"). */
export interface DetailImpact { stage: number; statement: string }

/** A past crest. `date` is a calendar date (YYYY-MM-DD): old crests carry no time of day. */
export interface DetailCrest { date: string; stage: number }

export type Trend = 'rising' | 'falling' | 'steady';

export interface GaugeDetail {
  id: string;
  /** False only when NWPS answered none of the three requests. */
  ok: boolean;
  /**
   * Which upstream answers arrived. A section whose source failed is unknown,
   * which is not the same as "NWS has none": the client says "unavailable" for
   * the first and "no forecast for this gauge" only for the second.
   */
  sources: { record: boolean; observed: boolean; forecast: boolean };
  unit: string | null;
  impacts: DetailImpact[];
  crests: { recent: DetailCrest[]; historic: DetailCrest[] };
  /** Last 48 h, downsampled; oldest first. */
  observed: DetailPoint[];
  /** Time of the newest observed point (ISO), if any. */
  observedAt: string | null;
  /** NWS forecast series, oldest first; empty when NWS has no current forecast. */
  forecast: DetailPoint[];
  /** When NWS issued that forecast (ISO), if it did. */
  forecastIssuedAt: string | null;
  trendFtPerHour: number | null;
  trend: Trend | null;
  /** When this payload was assembled. */
  updatedAt: string;
}

const HOUR = 3_600_000;
export const OBSERVED_WINDOW_MS = 48 * HOUR;
export const OBSERVED_MAX_POINTS = 96;
export const FORECAST_MAX_POINTS = 120;
export const TREND_WINDOW_MS = 3 * HOUR;
/** Below this the stage is called steady: a reading wobbles by a hundredth or two. */
export const STEADY_FT_PER_HOUR = 0.05;
const MAX_IMPACTS = 20;
const MAX_STATEMENT = 600;
const CREST_COUNT = 5;

// ---------------------------------------------------------------------------
// Gauge id: the route is not an open proxy
// ---------------------------------------------------------------------------

// NWS location ids are five letters/digits (AMAT2, HNFT2). Checked before the id
// goes anywhere near an upstream URL, and again against the gauges we know.
const LID = /^[A-Za-z0-9]{5}$/;

/** The canonical (upper-case) id when `raw` is the shape of a gauge id AND a gauge we list; else null. */
export function resolveGaugeId(raw: unknown, known: { has(id: string): boolean }): string | null {
  if (typeof raw !== 'string' || !LID.test(raw)) return null;
  const id = raw.toUpperCase();
  return known.has(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

type RawSeries = { issuedTime?: unknown; primaryUnits?: unknown; data?: unknown } | null | undefined;
type RawPoint = { validTime?: unknown; primary?: unknown } | null | undefined;

export interface NormalizedSeries {
  points: DetailPoint[];
  issuedAt: string | null;
  unit: string | null;
}

/**
 * NWPS series -> valid points, oldest first. Drops the -999/-9999 "no value"
 * sentinels (BOQT2's real series has -9999 rows), unparsable times and repeats.
 * An empty `data` array with a year-1 issuedTime is NWPS's "no forecast".
 */
export function normalizeSeries(raw: RawSeries): NormalizedSeries {
  const rows: unknown[] = Array.isArray(raw?.data) ? raw.data : [];
  const byTime = new Map<number, number>();
  for (const row of rows as RawPoint[]) {
    const iso = cleanTime(row?.validTime);
    const v = row?.primary;
    if (iso === null || typeof v !== 'number' || !isValidStage(v)) continue;
    byTime.set(Date.parse(iso), v);
  }
  const points = [...byTime].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
  const unit = typeof raw?.primaryUnits === 'string' && raw.primaryUnits.trim() ? raw.primaryUnits : null;
  return { points, issuedAt: points.length ? cleanTime(raw?.issuedTime) : null, unit };
}

/**
 * Thin a series to about `max` points for the wire. Keeps the first and last
 * points, the highest and the lowest (a crest must never be smoothed away),
 * and the last point of each equal-width time bucket in between.
 */
export function downsample(points: DetailPoint[], max: number): DetailPoint[] {
  if (points.length <= max) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const keep = new Map<number, DetailPoint>();
  for (const p of [first, last]) keep.set(p.t, p);
  let hi = first;
  let lo = first;
  for (const p of points) {
    if (p.v > hi.v) hi = p;
    if (p.v < lo.v) lo = p;
  }
  keep.set(hi.t, hi);
  keep.set(lo.t, lo);
  const buckets = Math.max(1, max - 4);
  const width = (last.t - first.t) / buckets || 1;
  const lastInBucket = new Map<number, DetailPoint>();
  for (const p of points) lastInBucket.set(Math.min(buckets - 1, Math.floor((p.t - first.t) / width)), p);
  for (const p of lastInBucket.values()) keep.set(p.t, p);
  return [...keep.values()].sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export interface TrendResult { trendFtPerHour: number | null; trend: Trend | null }

const NO_TREND: TrendResult = { trendFtPerHour: null, trend: null };

/**
 * Rising / falling / steady from the newest 3 hours of OBSERVED readings (a
 * least-squares slope, so one noisy reading does not flip it). Null whenever it
 * cannot be said honestly: the newest reading is more than 90 minutes old, or
 * fewer than 4 readings (or under 1.5 h of them) fall in the window. BOQT2's
 * real series has gaps of many hours, which is exactly this case.
 */
export function computeTrend(points: DetailPoint[], nowMs: number): TrendResult {
  const last = points[points.length - 1];
  if (!last || nowMs - last.t > 1.5 * HOUR) return NO_TREND;
  const win = points.filter(p => p.t >= last.t - TREND_WINDOW_MS);
  if (win.length < 4 || last.t - win[0].t < 1.5 * HOUR) return NO_TREND;
  // Slope of v against hours, centred on the mean for numerical sanity.
  const n = win.length;
  const mt = win.reduce((s, p) => s + p.t, 0) / n;
  const mv = win.reduce((s, p) => s + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of win) {
    const dt = (p.t - mt) / HOUR;
    num += dt * (p.v - mv);
    den += dt * dt;
  }
  if (den === 0) return NO_TREND;
  // + 0 turns a -0 (a tiny negative slope rounded away) into 0.
  const rate = Math.round((num / den) * 100) / 100 + 0;
  const trend: Trend = Math.abs(rate) < STEADY_FT_PER_HOUR ? 'steady' : rate > 0 ? 'rising' : 'falling';
  return { trendFtPerHour: rate, trend };
}

/**
 * A stage gaining at least this many feet an hour (the 3-hour slope above) is "rising quickly".
 * It needs no flood stage, so it is the one warning sign a gauge without NWS stages can give.
 * Chosen by replaying real USGS 15-minute data through computeTrend (tests/fixtures/usgs-iv):
 * Hunt on 2025-07-04 (1.6 to 21.2 ft in under 5 h) crosses it at 6.9 ft, 2.5 h before the crest;
 * from May to August 2025 it fires 3 times at Hunt and 5 at Shoal Creek in Austin, each a real
 * rise, and about 0.2 % and 0.7 % of the time.
 */
export const RAPID_RISE_FT_PER_HOUR = 1;

/**
 * The rate (ft/h) when this gauge's stage is rising quickly right now, else null. "Right now"
 * means the newest reading is no older than STALE_DATA_MS at `nowMs` (the trend itself is
 * cached for up to 10 minutes), and only stages in feet count: a lake level is an elevation
 * and a rate in other units would not mean the same thing.
 */
export function risingQuicklyRate(
  detail: Pick<GaugeDetail, 'trend' | 'trendFtPerHour' | 'observedAt' | 'unit'> | null | undefined,
  nowMs: number,
): number | null {
  if (!detail || detail.trend !== 'rising') return null;
  const rate = detail.trendFtPerHour;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < RAPID_RISE_FT_PER_HOUR) return null;
  if (detail.unit !== null && !/^ft$/i.test(detail.unit.trim())) return null;
  const newest = detail.observedAt ? Date.parse(detail.observedAt) : NaN;
  if (!Number.isFinite(newest) || nowMs - newest > STALE_DATA_MS) return null;
  return rate;
}

/**
 * The highest forecast value from `nowMs` on (what NWPS's own list reports as
 * the forecast), or null when the whole series is already in the past. The
 * client calls this too, with the clock of the phone.
 */
export function forecastCrest(points: DetailPoint[], nowMs: number): DetailPoint | null {
  let best: DetailPoint | null = null;
  for (const p of points) {
    if (p.t >= nowMs && (!best || p.v > best.v)) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Gauge record: impacts and crests
// ---------------------------------------------------------------------------

type RawRecord = {
  timeZone?: unknown;
  flood?: {
    stageUnits?: unknown;
    impacts?: unknown;
    crests?: { recent?: unknown; historic?: unknown };
  };
} | null | undefined;

function cleanStatement(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > MAX_STATEMENT ? `${s.slice(0, MAX_STATEMENT - 1)}…` : s;
}

/** NWS impact statements, highest stage first. Public text, rendered as text only. */
export function normalizeImpacts(raw: unknown): DetailImpact[] {
  if (!Array.isArray(raw)) return [];
  const out: DetailImpact[] = [];
  for (const row of raw as { stage?: unknown; statement?: unknown }[]) {
    const statement = cleanStatement(row?.statement);
    if (statement === null || typeof row?.stage !== 'number' || !isValidStage(row.stage)) continue;
    out.push({ stage: row.stage, statement });
  }
  return out.sort((a, b) => b.stage - a.stage).slice(0, MAX_IMPACTS);
}

// "YYYY-MM-DD" of an instant in the gauge's own time zone (NWPS gives POSIX-ish
// names such as CST6CDT that Intl accepts), UTC if it does not.
function localDate(ms: number, timeZone: unknown): string {
  const fmt = (tz?: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  try {
    return fmt(typeof timeZone === 'string' && timeZone ? timeZone : 'UTC');
  } catch {
    return fmt('UTC');
  }
}

// Crests go back to the 1800s, so cleanTime (which also rejects everything
// before 1970) is too strict; NWPS's year-1 "no time" is the only value to refuse.
const EARLIEST_CREST_MS = Date.parse('1800-01-01T00:00:00Z');

function normalizeCrests(raw: unknown, timeZone: unknown): { ms: number; crest: DetailCrest }[] {
  if (!Array.isArray(raw)) return [];
  const out: { ms: number; crest: DetailCrest }[] = [];
  const seen = new Set<string>();
  for (const row of raw as { occurredTime?: unknown; stage?: unknown; olddatum?: unknown }[]) {
    const iso = typeof row?.occurredTime === 'string' ? row.occurredTime : null;
    if (iso === null || !(Date.parse(iso) > EARLIEST_CREST_MS) || typeof row?.stage !== 'number' || !isValidStage(row.stage)) continue;
    // Measured against an earlier gauge datum: not comparable with today's stage.
    if (row.olddatum === true) continue;
    const ms = Date.parse(iso);
    // Old crests are stored as midnight UTC (date only): keep that calendar date
    // instead of letting a US time zone shift it to the day before.
    const date = /T00:00:00(\.0+)?Z$/.test(iso) ? iso.slice(0, 10) : localDate(ms, timeZone);
    const key = `${date}|${row.stage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ms, crest: { date, stage: row.stage } });
  }
  return out;
}

/** The 5 most recent crests (newest first) and the 5 highest on record (highest first). */
export function normalizeRecord(raw: RawRecord): {
  unit: string | null;
  impacts: DetailImpact[];
  crests: GaugeDetail['crests'];
} {
  const flood = raw?.flood;
  const unit = typeof flood?.stageUnits === 'string' && flood.stageUnits.trim() ? flood.stageUnits : null;
  const recent = normalizeCrests(flood?.crests?.recent, raw?.timeZone)
    .sort((a, b) => b.ms - a.ms).slice(0, CREST_COUNT).map(c => c.crest);
  const historic = normalizeCrests(flood?.crests?.historic, raw?.timeZone)
    .sort((a, b) => b.crest.stage - a.crest.stage || b.ms - a.ms).slice(0, CREST_COUNT).map(c => c.crest);
  return { unit, impacts: normalizeImpacts(flood?.impacts), crests: { recent, historic } };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The response body. Each argument is the parsed JSON of one NWPS answer, or
 * null when that request failed; `sources` records which, so a failed section
 * is never mistaken for an empty one.
 */
export function buildDetail(
  id: string,
  raw: { record: unknown; observed: unknown; forecast: unknown },
  nowMs: number,
): GaugeDetail {
  const sources = { record: raw.record != null, observed: raw.observed != null, forecast: raw.forecast != null };
  const record = normalizeRecord(raw.record as RawRecord);
  const obs = normalizeSeries(raw.observed as RawSeries);
  const fc = normalizeSeries(raw.forecast as RawSeries);
  const trend = computeTrend(obs.points, nowMs);
  const window = obs.points.filter(p => p.t >= nowMs - OBSERVED_WINDOW_MS);
  const newest = obs.points[obs.points.length - 1];
  return {
    id,
    ok: sources.record || sources.observed || sources.forecast,
    sources,
    unit: record.unit ?? obs.unit ?? fc.unit,
    impacts: record.impacts,
    crests: record.crests,
    observed: downsample(window, OBSERVED_MAX_POINTS),
    observedAt: newest ? new Date(newest.t).toISOString() : null,
    forecast: downsample(fc.points, FORECAST_MAX_POINTS),
    forecastIssuedAt: fc.issuedAt,
    trendFtPerHour: trend.trendFtPerHour,
    trend: trend.trend,
    updatedAt: new Date(nowMs).toISOString(),
  };
}
