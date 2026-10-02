// Pure logic behind the gauge list sheet (favorites, near me, search): distances,
// status ranking, sorting, reading age and text search. No React and no DOM, so it
// runs under node:test (tests/gaugeList.test.mjs).

import type { FloodCategory, GaugeStatus } from './types.ts';
import { CATEGORY_LABELS, STALE_DATA_MS, dataAgeMs, formatAge } from './floodStatus.ts';

export interface LatLon {
  lat: number;
  lon: number;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_MILE = 1.609344;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine, mean Earth radius). */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const kmToMiles = (km: number) => km / KM_PER_MILE;

/** "0.4 mi", "12 mi", "1,204 mi": one decimal under 10 miles, none above. */
export function formatMiles(km: number): string {
  const mi = kmToMiles(km);
  if (mi < 0.1) return '<0.1 mi';
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi).toLocaleString('en-US')} mi`;
}

function spokenMiles(km: number): string {
  const mi = kmToMiles(km);
  if (mi < 0.1) return 'less than a tenth of a mile away';
  const shown = mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString('en-US');
  return `${shown} ${shown === '1.0' || shown === '1' ? 'mile' : 'miles'} away`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Worst first. Anything the API sends that is not listed here ranks as "no data". */
export const STATUS_RANK: Readonly<Record<FloodCategory, number>> = {
  major: 5,
  moderate: 4,
  minor: 3,
  action: 2,
  no_flooding: 1,
  not_defined: 0,
};

export function statusRank(category: FloodCategory): number {
  return Object.hasOwn(STATUS_RANK, category) ? STATUS_RANK[category] : 0;
}

// NWPS and USGS send -999 (or -9999) for "no reading"; a real stage is never this low.
const MISSING_STAGE_BELOW = -100;
// A gauge with no observation arrives with observedAt "0001-01-01T00:00:00Z". Nothing
// before this is a real reading, so it is treated as "no time" rather than "2,000 years old".
const EARLIEST_REAL_OBSERVATION_MS = Date.UTC(2000, 0, 1);

/** True when the gauge reports an actual stage (not null, NaN or the -999 sentinel). */
export function hasReading(gauge: Pick<GaugeStatus, 'observedStage'>): boolean {
  const stage = gauge.observedStage;
  return typeof stage === 'number' && Number.isFinite(stage) && stage > MISSING_STAGE_BELOW;
}

/** True when at least one flood stage (action, minor, moderate, major) is defined. */
export function hasFloodStages(gauge: Pick<GaugeStatus, 'thresholds'>): boolean {
  const t = gauge.thresholds;
  if (!t) return false;
  return [t.action, t.minor, t.moderate, t.major].some(v => typeof v === 'number' && v > MISSING_STAGE_BELOW);
}

/** Milliseconds since the reading was taken, or null when the gauge reports no usable time. */
export function readingAgeMs(gauge: Pick<GaugeStatus, 'observedAt'>, nowMs: number = Date.now()): number | null {
  const age = dataAgeMs(gauge.observedAt, nowMs);
  if (age === null || nowMs - age < EARLIEST_REAL_OBSERVATION_MS) return null;
  return Math.max(0, age); // a timestamp a little in the future is clock skew, not a forecast
}

/**
 * The category the list shows and sorts by. It is the gauge's own category with one
 * exception: "Normal" needs a reading behind it, so a gauge that reports nothing is
 * listed as "no data" instead of looking all clear. A flood category is never downgraded.
 */
export function listCategory(gauge: GaugeStatus): FloodCategory {
  if (!Object.hasOwn(STATUS_RANK, gauge.category)) return 'not_defined';
  return gauge.category === 'no_flooding' && !hasReading(gauge) ? 'not_defined' : gauge.category;
}

// ---------------------------------------------------------------------------
// List items and sorting
// ---------------------------------------------------------------------------

export interface GaugeListItem {
  gauge: GaugeStatus;
  /** See listCategory. */
  category: FloodCategory;
  hasReading: boolean;
  /** False for a gauge with no flood stages: its category cannot mean much. */
  hasStages: boolean;
  /** Null when the gauge reports no usable observation time. */
  ageMs: number | null;
  /** The reading is older than STALE_DATA_MS, or its time is unknown. False when there is no reading. */
  stale: boolean;
  /** Straight-line distance from the reference point, when there is one. */
  distanceKm: number | null;
}

export function toListItem(gauge: GaugeStatus, nowMs: number, from: LatLon | null = null): GaugeListItem {
  const reading = hasReading(gauge);
  const ageMs = readingAgeMs(gauge, nowMs);
  return {
    gauge,
    category: listCategory(gauge),
    hasReading: reading,
    hasStages: hasFloodStages(gauge),
    ageMs,
    stale: reading && (ageMs === null || ageMs > STALE_DATA_MS),
    distanceKm: from ? haversineKm(from, { lat: gauge.lat, lon: gauge.lon }) : null,
  };
}

export type SortMode = 'status' | 'distance';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a: GaugeListItem, b: GaugeListItem) =>
  collator.compare(a.gauge.name, b.gauge.name) || collator.compare(a.gauge.id, b.gauge.id);
const byDistanceThenName = (a: GaugeListItem, b: GaugeListItem) =>
  a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm
    ? a.distanceKm - b.distanceKm
    : byName(a, b);

/**
 * 'status': worst category first, then nearest (when distances are known), then name.
 * 'distance': nearest first, then name. Returns a new array.
 */
export function sortItems(items: readonly GaugeListItem[], mode: SortMode): GaugeListItem[] {
  return [...items].sort((a, b) => {
    if (mode === 'status') {
      const byStatus = statusRank(b.category) - statusRank(a.category);
      if (byStatus !== 0) return byStatus;
    }
    return byDistanceThenName(a, b);
  });
}

/** Radius of "gauges near me" and "gauges near <place>". */
export const NEAR_RADIUS_KM = 40;
const MAX_NEAR_ROWS = 100;
const NEAREST_FALLBACK_ROWS = 5;

export interface NearbyResult {
  items: GaugeListItem[];
  /** How many gauges matched before the row limit was applied. */
  total: number;
  /** Nothing is within the radius: `items` are the nearest few, however far away they are. */
  beyondRadius: boolean;
}

export function nearbyItems(
  gauges: readonly GaugeStatus[],
  from: LatLon,
  opts: { radiusKm?: number; limit?: number; sort?: SortMode; nowMs?: number } = {},
): NearbyResult {
  const { radiusKm = NEAR_RADIUS_KM, limit = MAX_NEAR_ROWS, sort = 'status', nowMs = Date.now() } = opts;
  const all = gauges
    .filter(g => Number.isFinite(g.lat) && Number.isFinite(g.lon))
    .map(g => toListItem(g, nowMs, from));
  const within = all.filter(i => i.distanceKm !== null && i.distanceKm <= radiusKm);
  if (within.length > 0) {
    return { items: sortItems(within, sort).slice(0, limit), total: within.length, beyondRadius: false };
  }
  // Far from every gauge (outside Texas, say): show the closest ones with their distances
  // rather than an empty list that reads as "nothing to worry about".
  return {
    items: sortItems(all, 'distance').slice(0, NEAREST_FALLBACK_ROWS),
    total: Math.min(all.length, NEAREST_FALLBACK_ROWS),
    beyondRadius: true,
  };
}

export interface FavoritesResult {
  items: GaugeListItem[];
  /** Favorite ids the current data does not contain (retired gauge, or absent from a timeline snapshot). */
  missing: string[];
}

/** Starred gauges that are in `gauges`, worst first, plus the ids that are not. */
export function favoriteItems(
  gauges: Readonly<Record<string, GaugeStatus>>,
  ids: readonly string[],
  nowMs: number = Date.now(),
): FavoritesResult {
  const items: GaugeListItem[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const gauge = Object.hasOwn(gauges, id) ? gauges[id] : undefined;
    if (gauge) items.push(toListItem(gauge, nowMs));
    else missing.push(id);
  }
  return { items: sortItems(items, 'status'), missing };
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

/** Lowercase, accents removed, apostrophes dropped (O'Brien -> obrien), other punctuation as spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized === '' ? [] : normalized.split(' ');
}

// Abbreviations that appear in NWS gauge names and in how people type ("Ft Worth",
// "St. Hedwig", "nr Bulverde"). A typed token matches its partner as if it were the
// same word; it is an extra way to match, never a replacement for prefix matching.
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  ft: ['fort'],
  fort: ['ft'],
  mt: ['mount'],
  mount: ['mt'],
  st: ['saint'],
  saint: ['st'],
  nr: ['near'],
  near: ['nr'],
};

const SCORE_EXACT = 100;
const SCORE_PREFIX = 60;
const BONUS_ADJACENT = 25; // the typed words appear next to each other, in order ("san antonio")
const BONUS_STARTS_WITH = 15; // the first typed word is the first word of the name

function tokenScore(typed: string, token: string): number {
  if (token === typed || ALIASES[typed]?.includes(token)) return SCORE_EXACT;
  return token.startsWith(typed) ? SCORE_PREFIX : 0;
}

/**
 * How well `docTokens` answers `queryTokens`: 0 when any typed word matches nothing
 * (every word must match), otherwise higher is better. Exact words beat prefixes
 * ("hunt" ranks "at Hunt" above "near Huntsville"), and typed words that form a
 * phrase in the name ("san antonio") beat the same words scattered across it.
 */
export function scoreTokens(queryTokens: readonly string[], docTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  let total = 0;
  const positions: number[] = [];
  for (const typed of queryTokens) {
    let best = 0;
    let bestAt = -1;
    docTokens.forEach((token, at) => {
      const s = tokenScore(typed, token);
      if (s > best) {
        best = s;
        bestAt = at;
      }
    });
    if (best === 0) return 0;
    total += best;
    positions.push(bestAt);
  }
  let score = total / queryTokens.length;
  if (queryTokens.length > 1 && positions.every((p, i) => i === 0 || p === positions[i - 1] + 1)) score += BONUS_ADJACENT;
  if (positions[0] === 0) score += BONUS_STARTS_WITH;
  return Math.round(score);
}

export interface GaugeSearchEntry {
  gauge: GaugeStatus;
  tokens: string[];
}

/** Tokenize every gauge once (name words plus the id, so "HNTT2" finds its gauge). */
export function buildGaugeIndex(gauges: readonly GaugeStatus[]): GaugeSearchEntry[] {
  return gauges.map(gauge => ({ gauge, tokens: [...tokenize(gauge.name), ...tokenize(gauge.id)] }));
}

export interface SearchResult {
  items: GaugeListItem[];
  /** Matches before the row limit. */
  total: number;
}

/** Best match first; among equally good matches the worse flood status first, then fewer words, then name. */
export function searchGauges(
  index: readonly GaugeSearchEntry[],
  query: string,
  opts: { limit?: number; nowMs?: number; from?: LatLon | null } = {},
): SearchResult {
  const { limit = 30, nowMs = Date.now(), from = null } = opts;
  const typed = tokenize(query);
  if (typed.length === 0) return { items: [], total: 0 };
  const hits: { entry: GaugeSearchEntry; score: number; rank: number }[] = [];
  for (const entry of index) {
    const score = scoreTokens(typed, entry.tokens);
    if (score > 0) hits.push({ entry, score, rank: statusRank(listCategory(entry.gauge)) });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.rank - a.rank ||
      a.entry.tokens.length - b.entry.tokens.length ||
      collator.compare(a.entry.gauge.name, b.entry.gauge.name),
  );
  return {
    items: hits.slice(0, limit).map(h => toListItem(h.entry.gauge, nowMs, from)),
    total: hits.length,
  };
}

// ---------------------------------------------------------------------------
// Words for a row
// ---------------------------------------------------------------------------

/** 12.30 -> "12.3"; the data carries at most two decimals. */
export function formatStage(stage: number): string {
  return String(Number(stage.toFixed(2)));
}

function spokenUnit(unit: string, stage: number): string {
  if (unit === 'ft') return Math.abs(stage) === 1 ? 'foot' : 'feet';
  return unit;
}

const agoText = (ms: number) => (ms < 60_000 ? 'just now' : `${formatAge(ms)} ago`);

export interface ItemText {
  /** Visible detail line, in order. `warn` marks what must not be missed (a stale or untimed reading). */
  segments: { text: string; warn?: boolean }[];
  /** "12.3 mi", or null when the item has no distance. */
  distance: string | null;
  /** What a screen reader says for the row: name, status, stage, age, distance, favorite. */
  ariaLabel: string;
}

export interface DescribeOptions {
  /** The data is a timeline snapshot (history or forecast), not the live feed: no "ago", no stale flag. */
  snapshot?: boolean;
  favorite?: boolean;
  /** Formats an ISO time for snapshot rows; injectable so tests do not depend on the locale. */
  formatTime?: (iso: string) => string;
}

const defaultFormatTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// One phrase of a row, as shown and as spoken.
interface Piece {
  text: string;
  spoken: string;
  warn?: boolean;
}

function stagePiece(item: GaugeListItem): Piece | null {
  if (!item.hasReading) return null;
  const value = item.gauge.observedStage as number;
  const stage = formatStage(value);
  const unit = (item.gauge.unit ?? '').trim();
  return { text: unit ? `${stage} ${unit}` : stage, spoken: `${stage} ${spokenUnit(unit, value)}`.trim() };
}

function statusPiece(item: GaugeListItem, snapshot: boolean): Piece {
  if (item.category === 'not_defined') {
    // Without flood stages there is no category to report, and without a reading nothing to report at all.
    if (!item.hasReading) {
      return snapshot
        ? { text: 'No reading for this time', spoken: 'no reading for this time' }
        : { text: 'No current reading', spoken: 'no current reading' };
    }
    return { text: 'Flood stages not defined', spoken: 'flood stages not defined' };
  }
  // "Normal" with no flood stages to compare against is a statement about nothing: say so.
  const note = item.category === 'no_flooding' && !item.hasStages ? ' (no flood stages defined)' : '';
  const label = CATEGORY_LABELS[item.category] + note;
  return { text: label, spoken: label };
}

function whenPiece(item: GaugeListItem, snapshot: boolean, formatTime: (iso: string) => string): Piece | null {
  if (!item.hasReading) {
    return item.category === 'not_defined' ? null : { text: 'Stage unavailable', spoken: 'stage unavailable', warn: true };
  }
  if (snapshot) {
    if (item.ageMs === null || !item.gauge.observedAt) return null;
    const at = `at ${formatTime(item.gauge.observedAt)}`;
    return { text: at, spoken: at };
  }
  if (item.ageMs === null) return { text: 'Reading time unknown', spoken: 'reading time unknown', warn: true };
  if (item.stale) {
    const text = `Reading is ${formatAge(item.ageMs)} old`;
    return { text, spoken: text.toLowerCase(), warn: true };
  }
  const text = agoText(item.ageMs);
  return { text, spoken: text };
}

/**
 * The words for one row: "12.3 ft · Minor flood · 5 minutes ago". A stale reading says
 * "Reading is 3 hours old" instead of the age, and a gauge with no reading says so rather
 * than showing -999 or a status it has nothing to back up.
 */
export function describeItem(item: GaugeListItem, opts: DescribeOptions = {}): ItemText {
  const { snapshot = false, favorite = false, formatTime = defaultFormatTime } = opts;
  const stage = stagePiece(item);
  const status = statusPiece(item, snapshot);
  const when = whenPiece(item, snapshot, formatTime);
  const distance = item.distanceKm === null ? null : formatMiles(item.distanceKm);
  const spoken = [
    item.gauge.name,
    status.spoken,
    stage?.spoken,
    when?.spoken,
    item.distanceKm === null ? null : spokenMiles(item.distanceKm),
    favorite ? 'favorite' : null,
  ];
  return {
    segments: [stage, status, when].filter((p): p is Piece => p !== null).map(p => (p.warn ? { text: p.text, warn: true } : { text: p.text })),
    distance,
    ariaLabel: spoken.filter(Boolean).join(', '),
  };
}
