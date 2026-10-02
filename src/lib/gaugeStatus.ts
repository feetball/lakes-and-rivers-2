// Pure mapping from NWPS gauge rows (and the build-time meta) to GaugeStatus.
// Kept free of Next/Workers imports so tests/gaugeStatus.test.mjs can run it
// against real NWPS payloads; src/lib/gauges-fetch.ts does the fetching.
import type { FloodCategory, GaugeForecast, GaugeStatus } from './types';
import { categorizeByStage, hasValidThresholds, isValidStage } from './floodStatus';

// One gauge row of public/data/gauges-meta.json (see scripts/build-waterways-data.mjs).
export type GaugeMetaEntry = {
  id: string; name: string; lat: number; lon: number;
  usgsId: string | null;
  thresholds: GaugeStatus['thresholds'];
  unit: string | null;
  // Build-time observation snapshot. Lets the runtime fallback ship real
  // (stale) flood categories instead of "not_defined" until the live cache
  // populates. Optional because pre-observation builds may still be loaded.
  category?: FloodCategory;
  observedStage?: number | null;
  observedAt?: string | null;
};

// The parts of an NWPS gauge-list row we read (all optional: NWPS omits fields
// freely and the Worker must not trust the shape).
export type NwpsReading = {
  primary?: unknown; primaryUnit?: unknown; validTime?: unknown; floodCategory?: unknown;
};
export type NwpsRow = {
  lid?: string; name?: string; latitude?: number; longitude?: number;
  state?: { abbreviation?: string };
  ObservedFloodCategory?: unknown;
  flood?: { stageUnits?: unknown };
  status?: { observed?: NwpsReading; forecast?: NwpsReading };
};

const VALID: FloodCategory[] = ['no_flooding', 'not_defined', 'action', 'minor', 'moderate', 'major'];

// NWPS also emits operational strings (out_of_service, obs_not_current,
// fcst_not_current, low_threshold) that are not categories; they collapse to
// not_defined so nothing outside the FloodCategory union reaches the client.
export function normalizeCategory(raw: unknown): FloodCategory {
  return typeof raw === 'string' && (VALID as string[]).includes(raw)
    ? (raw as FloodCategory)
    : 'not_defined';
}

// NWPS often returns floodCategory: null even for gauges with a valid current
// observation and full set of thresholds. Without this, those gauges paint
// "No data" gray on the map even though the gauge sheet shows real values.
// When the upstream category is missing but we have both stage and thresholds,
// derive it ourselves via the same comparison NWS uses. A category NWPS did
// supply (including a real "no_flooding") always wins, and a gauge with no
// defined flood stage stays not_defined (see categorizeByStage).
export function resolveCategory(
  rawCategory: unknown,
  stage: number | null,
  thresholds: GaugeStatus['thresholds'],
): FloodCategory {
  const normalized = normalizeCategory(rawCategory);
  if (normalized !== 'not_defined') return normalized;
  if (stage === null || !thresholds) return normalized;
  return categorizeByStage(stage, thresholds);
}

// NWPS answers "no reading" with primary -999 and validTime
// "0001-01-01T00:00:00Z" (and an empty unit). Neither may reach the client:
// -999 would show as "Observed: -999 ft" with a blue "Normal" dot, and the
// year-1 time as a reading "739,000 days old".
function cleanStage(raw: unknown): number | null {
  return typeof raw === 'number' && isValidStage(raw) ? raw : null;
}

/** The ISO string if it is a real time (after 1970), else null. */
export function cleanTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? raw : null;
}

function nonEmpty(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

// status.forecast of an NWPS list row: the highest stage of the current NWS
// forecast, from now on. Gauges without a current forecast carry the same
// sentinels as a missing reading ({primary: -999, floodCategory:
// "fcst_not_current", validTime: "0001-01-01T00:00:00Z"}), which is how most of
// them (about 630 of 723) look, so those return null.
export function extractForecast(raw: NwpsReading | null | undefined, thresholds: GaugeStatus['thresholds']): GaugeForecast | null {
  const stage = cleanStage(raw?.primary);
  const validTime = cleanTime(raw?.validTime);
  if (!raw || stage === null || validTime === null) return null;
  return {
    stage,
    unit: nonEmpty(raw.primaryUnit),
    validTime,
    category: resolveCategory(raw.floodCategory, stage, thresholds),
  };
}

// One row of the NWPS gauge list -> our GaugeStatus. `meta` is the matching
// build-time row (flood thresholds live only there), if the gauge is in it.
export function gaugeFromNwpsEntry(g: NwpsRow, meta: GaugeMetaEntry | undefined): GaugeStatus {
  const obs = g.status?.observed;
  const stage = cleanStage(obs?.primary);
  const thresholds = meta?.thresholds ?? null;
  const status: GaugeStatus = {
    id: g.lid ?? '',
    name: g.name ?? g.lid ?? '',
    lat: g.latitude ?? 0,
    lon: g.longitude ?? 0,
    category: resolveCategory(obs?.floodCategory ?? g.ObservedFloodCategory, stage, thresholds),
    observedStage: stage,
    observedAt: stage === null ? null : cleanTime(obs?.validTime),
    unit: nonEmpty(obs?.primaryUnit) ?? nonEmpty(g.flood?.stageUnits) ?? meta?.unit ?? null,
    thresholds,
  };
  const forecast = extractForecast(g.status?.forecast, thresholds);
  // Omitted rather than null when there is none: it keeps the snapshot ~10 KB
  // smaller (about 630 gauges), and the client treats "absent" as "none".
  if (forecast) status.forecast = forecast;
  return status;
}

// The build-time meta carries a category and a reading per gauge for the
// fallback paths (fallbackFromMeta, the USGS fallback for gauges USGS did not
// answer). A meta built before the honest-gray fix has "no_flooding" for every
// gauge without flood stages (247 of 721 in the one that shipped) and -999 as
// the "reading" of gauges that had none, so repair each row on load instead of
// trusting the file: it can be months old, and rebuilding it is a manual step.
export function repairMetaEntry(m: GaugeMetaEntry): GaugeMetaEntry {
  const stage = cleanStage(m.observedStage);
  let category = normalizeCategory(m.category);
  if (stage === null || (category === 'no_flooding' && !hasValidThresholds(m.thresholds))) {
    category = 'not_defined';
  }
  return {
    ...m,
    category,
    observedStage: stage,
    observedAt: stage === null ? null : cleanTime(m.observedAt),
  };
}

// Snapshots outlive the code that wrote them: the phone's last-good copy in
// localStorage (tfm:last-gauges) and stored history snapshots were written by
// builds that shipped -999 "readings", a year-1 time and a blue "Normal" for
// gauges with no flood stages. Run every snapshot the client takes in through
// this, so a stale copy cannot repaint those as "Observed: -999 ft" or a
// reading "739,000 days old". Returns the same object when nothing needed fixing.
//
// `distrustNormal` also turns a "Normal" on a gauge with no flood stages gray.
// Only for copies saved by older builds: a live answer from the current server
// is trusted, since NWPS can legitimately say "no_flooding" for a gauge that is
// newer than the build-time meta (BCVT2 on 2026-10-02).
export function repairGaugeStatus(g: GaugeStatus, opts: { distrustNormal?: boolean } = {}): GaugeStatus {
  const stage = cleanStage(g.observedStage);
  const time = stage === null ? null : cleanTime(g.observedAt);
  let category = normalizeCategory(g.category);
  if (stage === null || (opts.distrustNormal && category === 'no_flooding' && !hasValidThresholds(g.thresholds))) {
    category = 'not_defined';
  }
  // A forecast only matters while it has a real stage and time; keep it as-is
  // then, drop it otherwise.
  const keepForecast = !!g.forecast && cleanStage(g.forecast.stage) !== null && cleanTime(g.forecast.validTime) !== null;
  if (
    stage === g.observedStage && time === g.observedAt && category === g.category &&
    keepForecast === !!g.forecast
  ) return g;
  const { forecast, ...rest } = g;
  return { ...rest, category, observedStage: stage, observedAt: time, ...(keepForecast && forecast ? { forecast } : {}) };
}

/** repairGaugeStatus over a whole gauge map (the same map when untouched). */
export function repairGauges(
  gauges: Record<string, GaugeStatus>,
  opts: { distrustNormal?: boolean } = {},
): Record<string, GaugeStatus> {
  let out: Record<string, GaugeStatus> | null = null;
  for (const [id, g] of Object.entries(gauges)) {
    const fixed = repairGaugeStatus(g, opts);
    if (fixed !== g) (out ??= { ...gauges })[id] = fixed;
  }
  return out ?? gauges;
}
