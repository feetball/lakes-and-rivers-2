import type { FloodCategory } from './types';

export const CATEGORY_ORDER: FloodCategory[] = [
  'not_defined',
  'no_flooding',
  'action',
  'minor',
  'moderate',
  'major',
];

export const CATEGORY_COLORS: Record<FloodCategory, string> = {
  not_defined: '#94a3b8',  // slate — no live data
  no_flooding: '#2563eb',  // blue — normal
  action:      '#eab308',  // yellow — nearing flood stage
  minor:       '#f97316',  // orange
  moderate:    '#dc2626',  // red
  major:       '#7f1d1d',  // dark red
};

export const CATEGORY_LABELS: Record<FloodCategory, string> = {
  not_defined: 'No data',
  no_flooding: 'Normal',
  action: 'Action',
  minor: 'Minor flood',
  moderate: 'Moderate flood',
  major: 'Major flood',
};

export function colorFor(category: FloodCategory | undefined | null): string {
  return CATEGORY_COLORS[category ?? 'not_defined'] ?? CATEGORY_COLORS.not_defined;
}

export interface Thresholds {
  action: number | null;
  minor: number | null;
  moderate: number | null;
  major: number | null;
}

// NWPS uses -9999 (and sometimes -999) as a missing-value sentinel for
// flood thresholds that aren't defined for a given gauge. Treat any value
// well below zero as missing — real flood thresholds are physically
// positive (gauge height) or large positive (lake elevation in ft).
function valid(t: number | null | undefined): t is number {
  return typeof t === 'number' && t > -100;
}

// Map a stage reading to a flood category using NWS thresholds. Missing
// thresholds cascade down (e.g., a gauge with only `action` defined still
// reports `no_flooding` below that and `action` above it).
export function categorizeByStage(stage: number, t: Thresholds): FloodCategory {
  if (valid(t.major) && stage >= t.major) return 'major';
  if (valid(t.moderate) && stage >= t.moderate) return 'moderate';
  if (valid(t.minor) && stage >= t.minor) return 'minor';
  if (valid(t.action) && stage >= t.action) return 'action';
  return 'no_flooding';
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
