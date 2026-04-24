export type FloodCategory =
  | 'no_flooding'
  | 'not_defined'
  | 'action'
  | 'minor'
  | 'moderate'
  | 'major';

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
