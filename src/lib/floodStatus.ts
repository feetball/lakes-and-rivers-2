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

// Map a stage reading to a flood category using NWS thresholds. Missing
// thresholds cascade down (e.g., a gauge with only `action` defined still
// reports `no_flooding` below that and `action` above it).
export function categorizeByStage(stage: number, t: Thresholds): FloodCategory {
  if (t.major != null && stage >= t.major) return 'major';
  if (t.moderate != null && stage >= t.moderate) return 'moderate';
  if (t.minor != null && stage >= t.minor) return 'minor';
  if (t.action != null && stage >= t.action) return 'action';
  return 'no_flooding';
}
