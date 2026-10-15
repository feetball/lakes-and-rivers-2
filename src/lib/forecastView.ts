// What the gauge sheet's Forecast block says, decided in one place so the
// honest cases are testable: a forecast, no forecast, an expired one, and "we
// could not find out" are four different statements and must never blur.
import type { FloodCategory, GaugeStatus } from './types';
import { categorizeByStage } from './floodStatus';
import { forecastCrest, type GaugeDetail } from './gaugeDetail';

// NWS refreshes a forecast at least daily for the gauges that have one; older
// than this and it may no longer describe what the river is doing.
export const FORECAST_STALE_MS = 24 * 3_600_000;

export type ForecastView =
  | { kind: 'loading' }
  // NWS has no current forecast for this gauge (confirmed by NWPS).
  | { kind: 'none' }
  // The detail request failed and the gauge list carries no forecast: unknown.
  | { kind: 'unavailable' }
  // NWS forecast values exist but every one is already in the past.
  | { kind: 'expired'; issuedAt: string | null }
  | {
      kind: 'crest';
      stage: number;
      unit: string | null;
      /** When the crest is forecast (epoch ms). */
      t: number;
      category: FloodCategory;
      /** ISO; null while only the gauge list (which lacks it) has answered. */
      issuedAt: string | null;
      stale: boolean;
    };

type DetailState = { data: GaugeDetail | undefined; failed: boolean };

/**
 * `gauge` is the snapshot row (it may carry the list's forecast crest, which is
 * there before the detail request returns); `detail` is the per-gauge answer.
 * When both exist the detail wins: it is fresher and carries the issue time.
 */
export function viewForecast(gauge: GaugeStatus, detail: DetailState, nowMs: number): ForecastView {
  const d = detail.data;
  if (d?.ok && d.sources.forecast) {
    if (d.forecast.length === 0) return { kind: 'none' };
    const crest = forecastCrest(d.forecast, nowMs);
    if (!crest) return { kind: 'expired', issuedAt: d.forecastIssuedAt };
    return {
      kind: 'crest',
      stage: crest.v,
      unit: d.unit ?? gauge.unit,
      t: crest.t,
      category: gauge.thresholds ? categorizeByStage(crest.v, gauge.thresholds) : 'not_defined',
      issuedAt: d.forecastIssuedAt,
      stale: d.forecastIssuedAt !== null && nowMs - Date.parse(d.forecastIssuedAt) > FORECAST_STALE_MS,
    };
  }
  const f = gauge.forecast;
  if (f) {
    const t = Date.parse(f.validTime);
    if (Number.isFinite(t) && t >= nowMs) {
      return {
        kind: 'crest', stage: f.stage, unit: f.unit ?? gauge.unit, t, category: f.category,
        issuedAt: f.issuedAt ?? null, stale: false,
      };
    }
  }
  return detail.failed || (d && !d.sources.forecast) ? { kind: 'unavailable' } : { kind: 'loading' };
}
