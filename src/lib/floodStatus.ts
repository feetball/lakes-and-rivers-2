import type { FloodCategory, GaugeStatus } from './types';

// What the map, the list and the sheets show for a gauge: the API's FloodCategory
// plus one state the API never sends, `no_stages` (see displayCategory). It is
// derived on the client so the API contract, the cached snapshots and the app
// builds already installed on phones stay as they are.
export type DisplayCategory = FloodCategory | 'no_stages';

export const CATEGORY_ORDER: DisplayCategory[] = [
  'not_defined',
  'no_stages',
  'no_flooding',
  'action',
  'minor',
  'moderate',
  'major',
];

export const CATEGORY_COLORS: Record<DisplayCategory, string> = {
  not_defined: '#94a3b8',  // slate — no live data
  // Warm tan — there IS a reading but NWS publishes no flood stages for the gauge. Not blue
  // (that is "Normal"), not slate (that is "No data"), not green (reads as safe); far from
  // every other status, alert and "you are here" colour, colour-blind viewers included
  // (tests/gauge-palette.test.mjs, tests/alerts-style.test.mjs).
  no_stages:   '#a18e72',
  no_flooding: '#2563eb',  // blue — normal
  action:      '#eab308',  // yellow — nearing flood stage
  minor:       '#f97316',  // orange
  moderate:    '#dc2626',  // red
  major:       '#7f1d1d',  // dark red
};

export const CATEGORY_LABELS: Record<DisplayCategory, string> = {
  not_defined: 'No data',
  no_stages: 'No flood stages',
  no_flooding: 'Normal',
  action: 'Action',
  minor: 'Minor flood',
  moderate: 'Moderate flood',
  major: 'Major flood',
};

export function colorFor(category: DisplayCategory | undefined | null): string {
  return CATEGORY_COLORS[category ?? 'not_defined'] ?? CATEGORY_COLORS.not_defined;
}

export interface Thresholds {
  action: number | null;
  minor: number | null;
  moderate: number | null;
  major: number | null;
}

// NWPS uses -9999 (and sometimes -999) as a missing-value sentinel for
// flood thresholds that aren't defined for a given gauge, and -999 for a
// reading it doesn't have. Treat any value well below zero as missing — real
// flood thresholds are physically positive (gauge height) or large positive
// (lake elevation in ft), and so are stage readings.
function valid(t: number | null | undefined): t is number {
  return typeof t === 'number' && Number.isFinite(t) && t > -100;
}

/** A real stage reading (not null, not the -999 "no reading" sentinel). */
export function isValidStage(n: number | null | undefined): n is number {
  return valid(n);
}

/** True when at least one flood stage (action/minor/moderate/major) is defined. */
export function hasValidThresholds(t: Thresholds | null | undefined): boolean {
  return !!t && (valid(t.action) || valid(t.minor) || valid(t.moderate) || valid(t.major));
}

// Map a stage reading to a flood category using NWS thresholds. Missing
// thresholds cascade down (e.g., a gauge with only `action` defined still
// reports `no_flooding` below that and `action` above it).
//
// With NO defined stage there is nothing to compare against, so the answer is
// `not_defined` (gray), never `no_flooding`: a blue "Normal" would tell people a
// gauge is fine when NWS has simply not published flood stages for it (a third
// of Texas gauges, including the Guadalupe at Hunt and Kerrville). The same goes
// for a missing reading (-999): no stage, no status.
export function categorizeByStage(stage: number, t: Thresholds): FloodCategory {
  if (!valid(stage) || !hasValidThresholds(t)) return 'not_defined';
  if (valid(t.major) && stage >= t.major) return 'major';
  if (valid(t.moderate) && stage >= t.moderate) return 'moderate';
  if (valid(t.minor) && stage >= t.minor) return 'minor';
  if (valid(t.action) && stage >= t.action) return 'action';
  return 'no_flooding';
}

// The category to SHOW for a gauge. It is the gauge's own category except that gray splits
// in two, so "no flood stages" never reads as "no data": a gauge that reports a stage but
// whose flood stages NWS has not defined (a third of Texas gauges) is `no_stages`, and only
// a gauge that reports nothing stays `not_defined` ("No data"). An all-empty thresholds
// object is NWS's "none defined"; null thresholds only mean we do not have them (a gauge
// newer than the build-time list), which proves nothing either way, so those are left alone.
// A "Normal" with no flood stages behind it is a statement about nothing, so it becomes
// `no_stages` too. A flood category is never replaced.
export function displayCategory(g: Pick<GaugeStatus, 'category' | 'observedStage' | 'thresholds'>): DisplayCategory {
  if (
    (g.category === 'not_defined' || g.category === 'no_flooding') &&
    g.thresholds && !hasValidThresholds(g.thresholds) && isValidStage(g.observedStage)
  ) return 'no_stages';
  return g.category;
}

// Live gauge data refreshes every ~30 min; past a few missed cycles a reading
// can no longer be trusted to reflect current conditions — a lake can climb
// from normal pool through Action stage in hours during a flood event, so a
// day-old "Normal" is actively misleading. 90 min = 3 missed refresh cycles.
export const STALE_DATA_MS = 90 * 60 * 1000;

// Age of an ISO timestamp in ms, or null when there's nothing meaningful to
// measure (missing, unparsable, or the epoch-0 "no data yet" sentinel).
export function dataAgeMs(iso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t === 0) return null;
  return nowMs - t;
}

// "3 hours" / "45 minutes" / "2 days" — for stale-data messaging.
export function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// Strip NWPS sentinels from a thresholds object — useful when surfacing
// thresholds to the UI so we don't show "-9999 ft" to users.
export function sanitizeThresholds(t: Thresholds | null | undefined): Thresholds | null {
  if (!t) return null;
  return {
    action:   valid(t.action)   ? t.action   : null,
    minor:    valid(t.minor)    ? t.minor    : null,
    moderate: valid(t.moderate) ? t.moderate : null,
    major:    valid(t.major)    ? t.major    : null,
  };
}
