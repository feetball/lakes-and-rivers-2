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

// USGS HIVIS/NIMS streamgage webcam, normalized for the client.
export interface Webcam {
  id: string; // NIMS camId, e.g. "TX_Blanco_River_at_Wimberley"
  name: string;
  description: string | null;
  lat: number;
  lon: number;
  nwisId: string | null; // associated USGS site number
  smallDir: string; // validated S3 directory this camera's stills live in
  imageUrl: string | null; // latest 720px still, derived from newestImageDT
  thumbUrl: string | null;
  hivisUrl: string; // human-facing HIVIS camera page
  hasTimelapse: boolean;
  newestImageAt: string | null; // ISO timestamp of the latest still
}

export interface WebcamsResponse {
  webcams: Webcam[];
  updatedAt: string;
}

export interface WebcamFrame {
  filename: string;
  url: string;
  takenAt: string | null;
}

export interface WebcamFramesResponse {
  frames: WebcamFrame[];
}
