// Geometry of the gauge sheet's inline-SVG hydrograph, kept free of React so the
// scale rules (what is drawn, where the flood lines sit) are testable.
import type { DetailPoint } from './gaugeDetail';
import type { Thresholds } from './floodStatus';
import { isValidStage } from './floodStatus';

export const CHART = { w: 360, h: 176, left: 38, right: 10, top: 10, bottom: 24 } as const;

export type FloodLine = { key: 'action' | 'minor' | 'moderate' | 'major'; stage: number; y: number };

export interface HydrographLayout {
  x0: number; x1: number;       // time domain, epoch ms
  y0: number; y1: number;       // stage domain
  observedPath: string;
  forecastPath: string;
  nowX: number | null;
  lines: FloodLine[];           // flood stages inside the stage domain, drawn as lines
  xTicks: { x: number; t: number }[];
  yTicks: { y: number; v: number }[];
}

const MIN_SPAN = 1; // a river holding steady must not zoom into noise

/**
 * Stage domain: every drawn value, plus the flood stages worth showing. A flood
 * line is drawn when the data reaches or passes it, and the lowest one still
 * above the data joins the domain (so "how far from Action" is visible) unless
 * that would squash the data into the bottom quarter of the plot.
 */
export function stageDomain(values: number[], thresholds: Thresholds | null | undefined): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  const stages = thresholds
    ? ([thresholds.action, thresholds.minor, thresholds.moderate, thresholds.major]
        .filter((n): n is number => typeof n === 'number' && isValidStage(n)))
    : [];
  const dataHi = hi;
  const next = Math.min(...stages.filter(s => s > dataHi), Infinity);
  if (Number.isFinite(next) && next - lo <= 4 * (dataHi - lo)) hi = next;
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

/** Round tick values (1, 2 or 5 times a power of ten) inside [lo, hi], about `count` of them. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * pow).find(st => st >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number((Math.round(v / step) * step).toPrecision(12)));
  return out;
}

export function layoutHydrograph(opts: {
  observed: DetailPoint[];
  forecast: DetailPoint[];
  thresholds: Thresholds | null | undefined;
  nowMs: number;
}): HydrographLayout | null {
  const { observed, thresholds, nowMs } = opts;
  // The forecast starts when NWS issued it, which can be hours before now and
  // overlaps the observed line; draw only what is still ahead (a little back so
  // the dashed line joins the solid one).
  const forecast = opts.forecast.filter(p => p.t >= nowMs - 2 * 3_600_000);
  const all = [...observed, ...forecast];
  if (all.length < 2) return null;
  const x0 = Math.min(...all.map(p => p.t));
  const x1 = Math.max(...all.map(p => p.t), nowMs);
  const [y0, y1] = stageDomain(all.map(p => p.v), thresholds);
  const pw = CHART.w - CHART.left - CHART.right;
  const ph = CHART.h - CHART.top - CHART.bottom;
  const X = (t: number) => CHART.left + ((t - x0) / (x1 - x0 || 1)) * pw;
  const Y = (v: number) => CHART.top + (1 - (v - y0) / (y1 - y0)) * ph;
  const path = (pts: DetailPoint[]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const lines: FloodLine[] = [];
  for (const key of ['action', 'minor', 'moderate', 'major'] as const) {
    const s = thresholds?.[key];
    if (typeof s === 'number' && isValidStage(s) && s >= y0 && s <= y1) lines.push({ key, stage: s, y: Y(s) });
  }
  return {
    x0, x1, y0, y1,
    observedPath: observed.length > 1 ? path(observed) : '',
    forecastPath: forecast.length > 1 ? path(forecast) : '',
    nowX: nowMs >= x0 && nowMs <= x1 ? X(nowMs) : null,
    lines,
    xTicks: [0, 1, 2, 3].map(i => ({ x: CHART.left + (pw * i) / 3, t: x0 + ((x1 - x0) * i) / 3 })),
    yTicks: niceTicks(y0, y1, 4).map(v => ({ y: Y(v), v })),
  };
}
