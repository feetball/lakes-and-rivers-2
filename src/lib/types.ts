export type FloodCategory =
  | 'no_flooding'
  | 'not_defined'
  | 'action'
  | 'minor'
  | 'moderate'
  | 'major';

// The NWS forecast crest for a gauge: the highest stage in its current forecast
// (NWPS reports "the highest forecast value from now on" in the gauge list).
export interface GaugeForecast {
  stage: number;
  unit: string | null;
  /** When that stage is forecast to occur (ISO 8601). */
  validTime: string;
  /** Flood category at that stage, resolved like the observed one. */
  category: FloodCategory;
  /**
   * When NWS issued the forecast. The NWPS gauge list does not say, so it is
   * normally absent here; /api/gauges/[id]/detail has the real time.
   */
  issuedAt?: string | null;
}

export interface GaugeStatus {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: FloodCategory;
  observedStage: number | null;
  observedAt: string | null;
  unit: string | null;
  thresholds: {
    action: number | null;
    minor: number | null;
    moderate: number | null;
    major: number | null;
  } | null;
  // Present only while NWS has a current forecast for this gauge (about 90 of
  // 723 Texas gauges at any time). Absent means "none in this snapshot" - not
  // proof that none exists: snapshots built without NWPS (the USGS fallback,
  // build-time meta) and older cached ones never carry it.
  forecast?: GaugeForecast | null;
}

export interface GaugesResponse {
  gauges: Record<string, GaugeStatus>;
  updatedAt: string;
}

export interface WaterwayProperties {
  gaugeId: string;
  name: string | null;
  ftype: number | null;
  nhdId: string | null;
}
