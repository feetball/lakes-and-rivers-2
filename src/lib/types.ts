import type { MultiPolygon, Polygon } from 'geojson';

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

// ---------------------------------------------------------------------------
// NWS flood alerts (src/lib/alerts-fetch.ts turns api.weather.gov into this)
// ---------------------------------------------------------------------------

// What the product is, from its event name: "Flash Flood Warning" -> warning,
// "Flood Watch" -> watch, "Flood Advisory" -> advisory, "Flood Statement" ->
// statement (a statement continues an earlier warning).
export type AlertKind = 'warning' | 'watch' | 'advisory' | 'statement';

// How strongly the map draws it (src/lib/alertStyle.ts), strongest first. A
// Flash Flood Emergency is a Flash Flood Warning whose damage threat is
// CATASTROPHIC; "flash" is every other Flash Flood Warning; "warning" is a
// (river or areal) Flood Warning.
export type AlertLevel = 'emergency' | 'flash' | 'warning' | 'watch' | 'advisory';

// Where `geometry` came from: the alert's own storm-based polygon, the NWS
// forecast zones / counties it names (watches), or nowhere (a zone shape could
// not be fetched: the alert is still listed, just not drawn).
export type AlertGeometrySource = 'alert' | 'zones' | 'none';

export type AlertGeometry = Polygon | MultiPolygon;

export interface NwsAlert {
  // Stable across updates of the same event: the VTEC key "KFWD.FF.W.0091"
  // (office, phenomenon, significance, event tracking number); the NWS alert id
  // for the rare alert that has no VTEC.
  id: string;
  event: string;
  kind: AlertKind;
  // Impact-based tag on Flash Flood Warnings: "CONSIDERABLE" or "CATASTROPHIC"
  // (the latter is a Flash Flood Emergency). null when the warning has none.
  damageThreat: string | null;
  headline: string | null;
  description: string;
  instruction: string | null;
  areaDesc: string;
  senderName: string;
  // ISO 8601 (UTC). `ends` is the event's own end time, `expires` when this
  // message lapses; either can be null.
  sent: string;
  effective: string | null;
  expires: string | null;
  ends: string | null;
  // NWS zone / county codes, e.g. "TXZ195" or "TXC035".
  ugc: string[];
  geometry: AlertGeometry | null;
  geometrySource: AlertGeometrySource;
  // A weather.gov page for the place (the API's own `web` is just the site root).
  web: string;
}

export interface AlertsResponse {
  alerts: NwsAlert[];
  // When this server last read api.weather.gov successfully (ISO), not when the
  // NWS issued anything. null when nothing has ever been read.
  updatedAt: string | null;
  // true: `alerts` was read from the NWS just now. false: the NWS could not be
  // reached; `alerts` is the last good copy (`stale: true`, `updatedAt` says how
  // old) or empty (`error` says why).
  ok: boolean;
  source: 'api.weather.gov';
  stale?: boolean;
  error?: string;
}
