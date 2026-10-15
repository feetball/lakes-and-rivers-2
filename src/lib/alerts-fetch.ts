// NWS flood alerts: everything behind GET /api/alerts, plus the geometry helpers the
// map uses to resolve a tap.
//
// One self-contained file on purpose. It runs unchanged on the Cloudflare Worker, in
// Node (dev, Docker, Vercel), in the browser (the tap handling in MapView) and under
// node:test: tests/alerts.test.mjs imports it directly, so no `@/` aliases, no runtime
// imports and only syntax Node can strip. Persistence is injected (AlertsStore); the R2
// binding lives in alerts-store.ts. A push-notification feature can reuse the exported
// normaliseAlerts, parseVtec, alertsAt and isAlertActive as they are.
//
// Source: https://api.weather.gov/alerts/active (public, no key). Warnings and
// advisories carry a small storm-based polygon; watches do not (geometry null, only the
// forecast zones they name), so those are joined with api.weather.gov/zones/... shapes.
import type { AlertGeometry, AlertKind, AlertLevel, AlertsResponse, NwsAlert } from './types';

export const NWS_API_BASE = 'https://api.weather.gov';
// NWS asks API clients to identify themselves and may block an anonymous one.
export const NWS_USER_AGENT = 'texas-flood-map (+https://txfloods.kuecker.us)';
export const ALERTS_SOURCE = 'api.weather.gov' as const;

// The event names this layer shows. The upstream query filters on them and
// normaliseAlerts checks again, so a changed query can never put (say) a Tornado
// Warning on a flood map.
export const FLOOD_EVENTS = [
  'Flash Flood Warning',
  'Flood Warning',
  'Flood Advisory',
  'Flood Watch',
  'Flash Flood Watch',
  'Flash Flood Statement',
  'Flood Statement',
] as const;

/** The upstream query: active, real (not test) flood alerts that touch Texas. */
export function alertsUrl(base: string = NWS_API_BASE): string {
  const events = FLOOD_EVENTS.map(encodeURIComponent).join(',');
  return `${base}/alerts/active?area=TX&status=actual&message_type=alert,update&event=${events}`;
}

// ---------------------------------------------------------------------------
// Small readers for untyped upstream JSON
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

// ISO 8601 in UTC, or null for anything that does not parse.
function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ---------------------------------------------------------------------------
// VTEC: the NWS's own event key
// ---------------------------------------------------------------------------

export interface Vtec {
  productClass: string; // O operational, T test, E experimental, X experimental VTEC
  action: string; // NEW CON EXT EXA EXB UPG CAN EXP COR ROU
  office: string; // KFWD
  phenomena: string; // FF flash flood, FA areal flood, FL river flood
  significance: string; // W warning, A watch, Y advisory, S statement
  etn: string; // event tracking number, 4 digits, restarts every year per office
  begin: number | null; // ms; null when already in effect (000000T0000Z)
  end: number | null; // ms
  key: string; // "KFWD.FF.W.0091": the same for every message about one event
}

const VTEC_RE = /\/([A-Z])\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.(\d{6}T\d{4}Z)-(\d{6}T\d{4}Z)\//;

function vtecTime(s: string): number | null {
  if (s.startsWith('000000T')) return null;
  const m = /^(\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  const t = Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(t) ? t : null;
}

/** Parse "/O.NEW.KFWD.FF.W.0091.261002T1125Z-261002T1400Z/"; null when it is not VTEC. */
export function parseVtec(raw: unknown): Vtec | null {
  const s = str(raw);
  const m = s ? VTEC_RE.exec(s) : null;
  if (!m) return null;
  return {
    productClass: m[1],
    action: m[2],
    office: m[3],
    phenomena: m[4],
    significance: m[5],
    etn: m[6],
    begin: vtecTime(m[7]),
    end: vtecTime(m[8]),
    key: `${m[3]}.${m[4]}.${m[5]}.${m[6]}`,
  };
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

export function alertKind(event: string): AlertKind | null {
  if (!(FLOOD_EVENTS as readonly string[]).includes(event)) return null;
  if (event.endsWith('Warning')) return 'warning';
  if (event.endsWith('Watch')) return 'watch';
  if (event.endsWith('Advisory')) return 'advisory';
  return 'statement';
}

/**
 * How strongly to draw an alert. A Flash Flood Emergency is a Flash Flood Warning
 * whose flashFloodDamageThreat is CATASTROPHIC (CONSIDERABLE is the lesser tag and
 * stays a plain flash flood warning). A statement continues a warning, so it takes
 * the level of the warning it continues.
 */
export function alertLevel(a: Pick<NwsAlert, 'event' | 'kind' | 'damageThreat'>): AlertLevel {
  if (a.kind === 'watch') return 'watch';
  if (a.kind === 'advisory') return 'advisory';
  if (a.event.startsWith('Flash Flood')) return a.damageThreat === 'CATASTROPHIC' ? 'emergency' : 'flash';
  return 'warning';
}

export const LEVEL_RANK: Record<AlertLevel, number> = { emergency: 5, flash: 4, warning: 3, watch: 2, advisory: 1 };

/** Strongest first, then newest first. */
export function compareAlerts(a: NwsAlert, b: NwsAlert): number {
  return (
    LEVEL_RANK[alertLevel(b)] - LEVEL_RANK[alertLevel(a)] ||
    Date.parse(b.sent) - Date.parse(a.sent) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Still in effect at `nowMs`? `ends` is the event's own end (VTEC), `expires` is when
 * this one message lapses, usually when the next statement is due. An event is over at
 * `ends`; a message that lapsed before `ends` (a river warning whose next statement is
 * late) is still the latest word on an event that has not ended, so it stays. With no
 * `ends`, `expires` decides.
 */
export function isAlertActive(a: Pick<NwsAlert, 'ends' | 'expires'>, nowMs: number): boolean {
  const end = a.ends ?? a.expires;
  if (!end) return true;
  const t = Date.parse(end);
  return !Number.isFinite(t) || t > nowMs;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type Pos = number[]; // GeoJSON [lon, lat]
type Ring = Pos[];
type PolyCoords = Ring[]; // outer ring, then holes

const validPos = (p: unknown): p is Pos =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

// A usable ring: >= 4 valid positions. An unclosed ring is closed.
function cleanRing(r: unknown): Ring | null {
  if (!Array.isArray(r) || r.length < 3 || !r.every(validPos)) return null;
  const ring: Ring = r.map((p: Pos) => [p[0], p[1]]);
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
  return ring.length >= 4 ? ring : null;
}

function cleanPolygon(c: unknown): PolyCoords | null {
  if (!Array.isArray(c) || c.length === 0) return null;
  const outer = cleanRing(c[0]);
  if (!outer) return null;
  const holes: Ring[] = [];
  for (const h of c.slice(1)) {
    const ring = cleanRing(h);
    if (ring) holes.push(ring);
  }
  return [outer, ...holes];
}

/**
 * Every valid polygon inside a GeoJSON geometry. Handles GeometryCollection because
 * the NWS really sends one for some zones (Coastal Harris, TXZ313). Anything that is
 * not a polygon is ignored.
 */
export function polygonsOf(geometry: unknown): PolyCoords[] {
  if (!isObj(geometry)) return [];
  if (geometry.type === 'Polygon') {
    const p = cleanPolygon(geometry.coordinates);
    return p ? [p] : [];
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.flatMap((c: unknown) => {
      const p = cleanPolygon(c);
      return p ? [p] : [];
    });
  }
  if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    return geometry.geometries.flatMap((g: unknown) => polygonsOf(g));
  }
  return [];
}

function toGeometry(polys: PolyCoords[]): AlertGeometry | null {
  if (polys.length === 0) return null;
  if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
  return { type: 'MultiPolygon', coordinates: polys };
}

const polysOfGeometry = (g: AlertGeometry): PolyCoords[] => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

// ---- bounds, point in polygon ----

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

// Geometry is immutable once built, so its box is computed once per object.
const boundsCache = new WeakMap<object, Bounds | null>();

export function geometryBounds(g: AlertGeometry): Bounds | null {
  if (boundsCache.has(g)) return boundsCache.get(g) ?? null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const poly of polysOfGeometry(g)) {
    for (const p of poly[0] ?? []) {
      if (p[1] < south) south = p[1];
      if (p[1] > north) north = p[1];
      if (p[0] < west) west = p[0];
      if (p[0] > east) east = p[0];
    }
  }
  const b = Number.isFinite(south) ? { south, west, north, east } : null;
  boundsCache.set(g, b);
  return b;
}

// Even-odd ray casting.
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and in none of the holes. `rings` is GeoJSON Polygon coordinates. */
export function pointInPolygon(lon: number, lat: number, rings: Ring[]): boolean {
  if (rings.length === 0 || !inRing(lon, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(lon, lat, rings[k])) return false;
  return true;
}

export function pointInGeometry(lon: number, lat: number, g: AlertGeometry): boolean {
  const b = geometryBounds(g);
  if (!b || lat < b.south || lat > b.north || lon < b.west || lon > b.east) return false;
  return polysOfGeometry(g).some(poly => pointInPolygon(lon, lat, poly));
}

/** The alerts drawn over a point, strongest first. Alerts with no outline never match. */
export function alertsAt(alerts: readonly NwsAlert[], lon: number, lat: number): NwsAlert[] {
  return alerts.filter(a => a.geometry !== null && pointInGeometry(lon, lat, a.geometry)).sort(compareAlerts);
}

const ringArea = (ring: Ring): number => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
};

/**
 * A point that is inside the geometry, for a "look here" link. The area centroid of the
 * largest polygon when it falls inside it; otherwise (a crescent, a bay) the middle of
 * the widest stretch of that polygon along the centroid's latitude.
 */
export function representativePoint(g: AlertGeometry): [number, number] | null {
  const polys = polysOfGeometry(g);
  let best: PolyCoords | null = null;
  let bestArea = -1;
  for (const p of polys) {
    const a = Math.abs(ringArea(p[0]));
    if (a > bestArea) {
      best = p;
      bestArea = a;
    }
  }
  if (!best) return null;
  const outer = best[0];
  const area = ringArea(outer);
  let cx = 0;
  let cy = 0;
  if (Math.abs(area) > 1e-12) {
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const f = outer[j][0] * outer[i][1] - outer[i][0] * outer[j][1];
      cx += (outer[j][0] + outer[i][0]) * f;
      cy += (outer[j][1] + outer[i][1]) * f;
    }
    cx /= 6 * area;
    cy /= 6 * area;
  } else {
    cx = outer[0][0];
    cy = outer[0][1];
  }
  if (pointInPolygon(cx, cy, best)) return [cx, cy];
  const xs: number[] = [];
  for (const ring of best) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > cy !== yj > cy) xs.push(((xj - xi) * (cy - yi)) / (yj - yi) + xi);
    }
  }
  xs.sort((a, b) => a - b);
  let widest: [number, number] | null = null;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (!widest || xs[i + 1] - xs[i] > widest[1] - widest[0]) widest = [xs[i], xs[i + 1]];
  }
  return widest ? [(widest[0] + widest[1]) / 2, cy] : [outer[0][0], outer[0][1]];
}

// ---- simplification (Douglas-Peucker) ----

/** Max distance, in degrees (~200 m), a zone outline may move when simplified. */
export const ZONE_TOLERANCE_DEG = 0.002;
const COORD_DECIMALS = 4; // ~11 m

const round = (n: number): number => Math.round(n * 10 ** COORD_DECIMALS) / 10 ** COORD_DECIMALS;

function sqSegDist(p: Pos, a: Pos, b: Pos): number {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

// Iterative so a 50,000-point coastline cannot overflow the stack.
function douglasPeucker(pts: Pos[], tol: number): Pos[] {
  const n = pts.length;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = sqSegDist(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/**
 * Simplify one closed ring; null when it collapses to nothing (a sliver smaller than
 * the tolerance). Douglas-Peucker needs two fixed ends, so the ring is cut at its first
 * vertex and the vertex farthest from it.
 */
export function simplifyRing(ring: Ring, tol: number): Ring | null {
  const open = ring.slice(0, -1);
  if (open.length < 3) return null;
  let far = 1;
  let farD = -1;
  for (let i = 1; i < open.length; i++) {
    const d = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const head = douglasPeucker(open.slice(0, far + 1), tol);
  const tail = douglasPeucker([...open.slice(far), open[0]], tol);
  const out: Pos[] = [];
  for (const p of [...head, ...tail.slice(1, -1)]) {
    const q = [round(p[0]), round(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]);
  return Math.abs(ringArea(out)) < tol * tol ? null : out;
}

export function simplifyPolygons(polys: PolyCoords[], tol: number): PolyCoords[] {
  const out: PolyCoords[] = [];
  for (const poly of polys) {
    const outer = simplifyRing(poly[0], tol);
    if (!outer) continue;
    const holes: Ring[] = [];
    for (const h of poly.slice(1)) {
      const ring = simplifyRing(h, tol);
      if (ring) holes.push(ring);
    }
    out.push([outer, ...holes]);
  }
  return out;
}

export function simplifyGeometry(g: AlertGeometry, tol: number): AlertGeometry | null {
  return toGeometry(simplifyPolygons(polysOfGeometry(g), tol));
}

// ---------------------------------------------------------------------------
// Normalising the upstream feed
// ---------------------------------------------------------------------------

// "KFWD" -> the Fort Worth office page; the fallback when there is no outline to
// point a map link at.
function officeLink(office: string | null): string {
  return office && /^K[A-Z]{3}$/.test(office) ? `https://www.weather.gov/${office.slice(1).toLowerCase()}/` : 'https://www.weather.gov/alerts';
}

interface Message {
  alert: NwsAlert;
  sentMs: number;
}

// A cancellation of an event (VTEC CAN, or a Cancel message): its key and when it was
// sent. The cancelled event's earlier messages can still be in the feed (live example:
// KHGX.FF.W.0053 has both its NEW and its CAN message), and must not be drawn.
function cancellation(feature: unknown): { id: string; sentMs: number } | null {
  if (!isObj(feature) || !isObj(feature.properties)) return null;
  const p = feature.properties;
  const vtec = strings((isObj(p.parameters) ? p.parameters : {}).VTEC).map(parseVtec).find(v => v !== null) ?? null;
  if (!vtec || vtec.productClass === 'T' || !(vtec.action === 'CAN' || str(p.messageType) === 'Cancel')) return null;
  const sentMs = Date.parse(str(p.sent) ?? '');
  return Number.isFinite(sentMs) ? { id: vtec.key, sentMs } : null;
}

// One feature -> one alert, or null when it is not an active flood alert for us.
function normaliseMessage(feature: unknown, nowMs: number): Message | null {
  if (!isObj(feature) || !isObj(feature.properties)) return null;
  const p = feature.properties;

  const event = str(p.event);
  const kind = event ? alertKind(event) : null;
  if (!event || !kind) return null;
  // A test message or a cancellation must never be drawn as a live warning.
  const status = str(p.status);
  if (status !== null && status !== 'Actual') return null;
  const messageType = str(p.messageType);
  if (messageType === 'Cancel' || messageType === 'Ack' || messageType === 'Error') return null;

  const params = isObj(p.parameters) ? p.parameters : {};
  const vtec = strings(params.VTEC).map(parseVtec).find(v => v !== null) ?? null;
  // CAN ends an event now; UPG replaces it with another product. (EXP is only the
  // heads-up that the end time is near, so it is judged by that time below.)
  if (vtec && (vtec.productClass === 'T' || vtec.action === 'CAN' || vtec.action === 'UPG')) return null;

  const ends = isoOrNull(p.ends);
  const expires = isoOrNull(p.expires);
  if (!isAlertActive({ ends, expires }, nowMs)) return null;

  const sent = isoOrNull(p.sent) ?? isoOrNull(p.effective) ?? new Date(nowMs).toISOString();
  const capId = str(p.id) ?? str(feature.id);
  const id = vtec ? vtec.key : capId;
  if (!id) return null;

  const geocode = isObj(p.geocode) ? p.geocode : {};
  let ugc = strings(geocode.UGC);
  if (ugc.length === 0) ugc = strings(p.affectedZones).map(u => u.slice(u.lastIndexOf('/') + 1)).filter(c => /^[A-Z]{2}[ZC]\d{3}$/.test(c));
  const geometry = toGeometry(polygonsOf(feature.geometry));
  const threat = strings(params.flashFloodDamageThreat)[0]?.toUpperCase() ?? null;

  const alert: NwsAlert = {
    id,
    event,
    kind,
    damageThreat: threat,
    headline: str(p.headline) ?? strings(params.NWSheadline)[0] ?? null,
    description: str(p.description) ?? '',
    instruction: str(p.instruction),
    areaDesc: str(p.areaDesc) ?? '',
    senderName: str(p.senderName) ?? str(p.sender) ?? 'National Weather Service',
    sent,
    effective: isoOrNull(p.effective),
    expires,
    ends,
    ugc: unique(ugc),
    geometry,
    geometrySource: geometry ? 'alert' : 'none',
    web: officeLink(vtec?.office ?? null),
  };
  return { alert, sentMs: Date.parse(sent) };
}

// A product can be split into several messages that share one VTEC key: each Flood
// Watch segment is its own message (live example: KHGX.FA.A.0006 arrives as an EXA
// message for 10 zones and a CON message for 5 more). They are one event, so the zones
// are unioned and the newest message supplies the text.
function mergeMessages(group: Message[]): NwsAlert {
  if (group.length === 1) return group[0].alert;
  const sorted = group.slice().sort((a, b) => b.sentMs - a.sentMs);
  const base = sorted[0].alert;
  const alerts = sorted.map(m => m.alert);
  const latest = (pick: (a: NwsAlert) => string | null): string | null =>
    alerts.map(pick).reduce<string | null>((best, v) => (v !== null && (best === null || Date.parse(v) > Date.parse(best)) ? v : best), null);
  const geometry = base.geometry ?? alerts.find(a => a.geometry !== null)?.geometry ?? null;
  return {
    ...base,
    areaDesc: unique(alerts.flatMap(a => a.areaDesc.split(';').map(s => s.trim()).filter(Boolean))).join('; '),
    ugc: unique(alerts.flatMap(a => a.ugc)),
    expires: latest(a => a.expires),
    ends: latest(a => a.ends),
    geometry,
    geometrySource: geometry ? 'alert' : 'none',
  };
}

/**
 * Turn the /alerts/active GeoJSON into our alerts: only active flood alerts, one per
 * event (see mergeMessages), strongest first. Throws when `input` is not an alert
 * feed at all: an error page that parsed as JSON must not read as "no alerts".
 */
export function normaliseAlerts(input: unknown, nowMs: number = Date.now()): NwsAlert[] {
  if (!isObj(input) || !Array.isArray(input.features)) throw new Error('unexpected response (not an alert feed)');
  const groups = new Map<string, Message[]>();
  const cancelled = new Map<string, number>();
  for (const f of input.features) {
    const c = cancellation(f);
    if (c) cancelled.set(c.id, Math.max(c.sentMs, cancelled.get(c.id) ?? 0));
  }
  for (const f of input.features) {
    const m = normaliseMessage(f, nowMs);
    if (!m || m.sentMs <= (cancelled.get(m.alert.id) ?? -Infinity)) continue;
    const g = groups.get(m.alert.id);
    if (g) g.push(m);
    else groups.set(m.alert.id, [m]);
  }
  return [...groups.values()].map(mergeMessages).sort(compareAlerts);
}

// ---------------------------------------------------------------------------
// Fetching with a timeout and one retry
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchJsonOptions {
  fetchImpl: FetchLike;
  timeoutMs: number;
  retries: number;
  sleep: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const statusOf = (e: unknown): number | null => (isObj(e) && typeof e.status === 'number' ? e.status : null);

/**
 * GET and parse JSON. Retries once on a network error, a timeout or a 5xx; never on a
 * 4xx (a 404 is an answer, and a 429 means back off, not hammer).
 */
export async function fetchJson(url: string, o: FetchJsonOptions): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
    try {
      const res = await o.fetchImpl(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/geo+json' },
      });
      if (!res.ok) throw httpError(res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const status = statusOf(e);
      if (status !== null && status < 500) break;
      if (attempt < o.retries) await o.sleep(400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** A short, user-safe reason a read failed (it goes into the response's `error`). */
export function describeError(e: unknown): string {
  const status = statusOf(e);
  if (status !== null) return `${ALERTS_SOURCE} answered HTTP ${status}`;
  if (isObj(e) && (e.name === 'AbortError' || e.name === 'TimeoutError')) return `${ALERTS_SOURCE} did not answer in time`;
  const msg = e instanceof Error ? e.message : '';
  return msg.startsWith('unexpected response') ? `${ALERTS_SOURCE} sent something unexpected` : `could not reach ${ALERTS_SOURCE}`;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------------------------------------------------------------------------
// Storage (injected): zone shapes and the last good response
// ---------------------------------------------------------------------------

export interface AlertsStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Per-process memory, oldest entry out first. The only store in Node and in dev. */
export function createMemoryStore(maxEntries = 600): AlertsStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, value) {
      map.delete(key); // re-insert so a rewritten key counts as the newest
      map.set(key, value);
      while (map.size > maxEntries) map.delete(map.keys().next().value as string);
    },
  };
}

/** Read `first`, then `second` (copying a hit forward); write both. */
export function layerStores(first: AlertsStore, second: AlertsStore): AlertsStore {
  return {
    async get(key) {
      const hit = await first.get(key);
      if (hit !== null) return hit;
      const slow = await second.get(key);
      if (slow !== null) await first.put(key, slow);
      return slow;
    },
    async put(key, value) {
      await Promise.all([first.put(key, value), second.put(key, value)]);
    },
  };
}

// ---------------------------------------------------------------------------
// Zone shapes for watches
// ---------------------------------------------------------------------------

export const isTexasZone = (code: string): boolean => /^TX[ZC]\d{3}$/.test(code);

/** TXZ195 is a forecast zone, TXC035 a county: they live under different paths. */
export function zoneUrl(code: string, base: string = NWS_API_BASE): string {
  return `${base}/zones/${code[2] === 'Z' ? 'forecast' : 'county'}/${code}`;
}

// A zone shape changes only when the NWS redraws its zones (a few times a year), and
// api.weather.gov itself says to cache it for a week. A zone it has no shape for is
// remembered for a few hours so it is not asked for again every minute.
const ZONE_TTL_MS = 7 * 24 * 3_600_000;
const ZONE_MISS_TTL_MS = 6 * 3_600_000;
const zoneKey = (code: string) => `alerts/zones/v1/${code}.json`;

interface ZoneEntry {
  fetchedAt: number;
  geometry: AlertGeometry | null; // null: the NWS has no shape for this zone
}

async function readZone(store: AlertsStore, code: string): Promise<ZoneEntry | null> {
  try {
    const raw = await store.get(zoneKey(code));
    if (!raw) return null;
    const j: unknown = JSON.parse(raw);
    if (isObj(j) && typeof j.fetchedAt === 'number' && (j.geometry === null || isObj(j.geometry))) {
      return { fetchedAt: j.fetchedAt, geometry: toGeometry(polygonsOf(j.geometry)) };
    }
  } catch {
    // an unreadable entry is just a miss
  }
  return null;
}

const zoneIsFresh = (z: ZoneEntry, nowMs: number): boolean => nowMs - z.fetchedAt < (z.geometry ? ZONE_TTL_MS : ZONE_MISS_TTL_MS);

export interface ZoneJoinOptions {
  store: AlertsStore;
  fetchImpl: FetchLike;
  base: string;
  nowMs: number;
  // Stop waiting for zone fetches after this long; they carry on in the background
  // (`pending`) and fill the cache for the next poll.
  budgetMs: number;
  // Network fetches allowed per call: a statewide watch can name 200 zones.
  maxFetches: number;
  concurrency: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

export interface ZoneJoinResult {
  alerts: NwsAlert[];
  pending: Promise<void> | null;
  fetched: number;
  missing: string[];
}

/**
 * Give every zone-only alert (a watch) an outline built from the Texas zones it names.
 * The shapes are simplified (Douglas-Peucker, ZONE_TOLERANCE_DEG) before they are cached
 * and sent. An alert whose zones are not all known stays in the list without an outline
 * (geometrySource "none"): a half-drawn watch would look like the rest of the area is
 * safe. A failed zone fetch never drops an alert. Non-Texas zones a watch also names
 * (Oklahoma, Louisiana) are not drawn: this is a Texas map.
 */
export async function joinZoneGeometry(alerts: NwsAlert[], o: ZoneJoinOptions): Promise<ZoneJoinResult> {
  const wanted = unique(alerts.filter(a => a.geometry === null).flatMap(a => a.ugc.filter(isTexasZone)));
  if (wanted.length === 0) return { alerts, pending: null, fetched: 0, missing: [] };

  const zones = new Map<string, AlertGeometry>();
  const missing: string[] = [];
  let fetched = 0;
  let allowance = o.maxFetches;

  const work = mapLimit(wanted, o.concurrency, async code => {
    const cached = await readZone(o.store, code);
    if (cached && zoneIsFresh(cached, o.nowMs)) {
      if (cached.geometry) zones.set(code, cached.geometry);
      else missing.push(code);
      return;
    }
    // Over the allowance, or the NWS is failing: an expired shape beats no shape.
    const fallBack = () => {
      if (cached?.geometry) zones.set(code, cached.geometry);
      else missing.push(code);
    };
    if (allowance <= 0) return fallBack();
    allowance--;
    try {
      const json = await fetchJson(zoneUrl(code, o.base), { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, retries: 1, sleep: o.sleep });
      const polys = simplifyPolygons(polygonsOf(isObj(json) ? json.geometry : null), ZONE_TOLERANCE_DEG);
      const entry: ZoneEntry = { fetchedAt: o.nowMs, geometry: toGeometry(polys) };
      fetched++;
      await o.store.put(zoneKey(code), JSON.stringify(entry)).catch(() => {});
      if (entry.geometry) zones.set(code, entry.geometry);
      else missing.push(code);
    } catch (e) {
      if (statusOf(e) === 404) {
        await o.store.put(zoneKey(code), JSON.stringify({ fetchedAt: o.nowMs, geometry: null })).catch(() => {});
        missing.push(code);
      } else {
        fallBack();
      }
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), o.budgetMs);
  });
  const outcome = await Promise.race([work.then(() => 'done' as const), timeout]);
  clearTimeout(timer);
  const pending = outcome === 'timeout' ? work.catch(() => {}) : null;

  const joined = alerts.map(a => {
    if (a.geometry !== null) return a;
    const codes = a.ugc.filter(isTexasZone);
    const shapes = codes.map(c => zones.get(c));
    if (codes.length === 0 || shapes.some(s => s === undefined)) return a;
    const polys = (shapes as AlertGeometry[]).flatMap(polysOfGeometry);
    return { ...a, geometry: toGeometry(polys), geometrySource: 'zones' as const };
  });
  return { alerts: joined, pending, fetched, missing };
}

// ---------------------------------------------------------------------------
// Payload size
// ---------------------------------------------------------------------------

// A busy day names a lot of zones (each a few KB), and phones poll this every two
// minutes, so the response is capped. Past the cap the zone outlines get coarser
// first; if that is not enough the biggest zone outlines are dropped (those alerts
// stay in the list, undrawn).
export const MAX_RESPONSE_BYTES = 600_000;

export interface CapResult {
  alerts: NwsAlert[];
  bytes: number;
  tolerance: number;
  stripped: string[];
}

export function capPayload(alerts: NwsAlert[], maxBytes: number = MAX_RESPONSE_BYTES): CapResult {
  const size = (xs: NwsAlert[]) => JSON.stringify(xs).length;
  let out = alerts;
  let bytes = size(out);
  let tolerance = ZONE_TOLERANCE_DEG;
  for (const tol of [0.004, 0.008, 0.016]) {
    if (bytes <= maxBytes) break;
    tolerance = tol;
    out = out.map(a => {
      if (a.geometrySource !== 'zones' || !a.geometry) return a;
      const g = simplifyGeometry(a.geometry, tol);
      return g ? { ...a, geometry: g } : a;
    });
    bytes = size(out);
  }
  const stripped: string[] = [];
  if (bytes > maxBytes) {
    const biggest = out
      .filter(a => a.geometrySource === 'zones' && a.geometry)
      .map(a => ({ id: a.id, len: JSON.stringify(a.geometry).length }))
      .sort((a, b) => b.len - a.len);
    for (const { id, len } of biggest) {
      if (bytes <= maxBytes) break;
      out = out.map(a => (a.id === id ? { ...a, geometry: null, geometrySource: 'none' as const } : a));
      bytes -= len;
      stripped.push(id);
    }
  }
  return { alerts: out, bytes, tolerance, stripped };
}

// The "Open on weather.gov" target: the point forecast page for a spot inside the
// outline lists the hazards in effect there and links to the full text. (The API's own
// `web` field is just http://www.weather.gov.)
function withMapLink(a: NwsAlert): NwsAlert {
  const p = a.geometry ? representativePoint(a.geometry) : null;
  return p ? { ...a, web: `https://forecast.weather.gov/MapClick.php?lat=${p[1].toFixed(4)}&lon=${p[0].toFixed(4)}` } : a;
}

// ---------------------------------------------------------------------------
// The whole read: cache, upstream, zones, last good
// ---------------------------------------------------------------------------

const LATEST_KEY = 'alerts/latest.json';
// Within this a stored read is served as is: many phones poll every two minutes, and
// api.weather.gov should see about one request a minute from us, not one per phone.
const FRESH_MS = 45_000;
// A last good copy older than this is not worth showing as a stand-in.
const MAX_STALE_MS = 6 * 3_600_000;

export interface AlertsDeps {
  fetchImpl?: FetchLike;
  store?: AlertsStore;
  now?: () => number;
  base?: string;
  sleep?: (ms: number) => Promise<void>;
  // Keeps zone fetches that outlive the response alive (Workers waitUntil, Next after).
  waitUntil?: (p: Promise<unknown>) => void;
  freshMs?: number;
  maxBytes?: number;
  zoneBudgetMs?: number;
  upstreamTimeoutMs?: number;
}

export interface AlertsResult {
  status: number;
  body: AlertsResponse;
}

interface Latest {
  fetchedAt: number;
  alerts: NwsAlert[];
}

const defaultStore = createMemoryStore();
// Phones that arrive together share one upstream read.
const inflight = new WeakMap<AlertsStore, Promise<AlertsResult>>();

async function readLatest(store: AlertsStore): Promise<Latest | null> {
  try {
    const raw = await store.get(LATEST_KEY);
    if (!raw) return null;
    const j: unknown = JSON.parse(raw);
    if (isObj(j) && typeof j.fetchedAt === 'number' && Array.isArray(j.alerts)) return { fetchedAt: j.fetchedAt, alerts: j.alerts as NwsAlert[] };
  } catch {
    // unreadable copy: same as none
  }
  return null;
}

/**
 * The response for GET /api/alerts. Never throws: when the NWS cannot be read it
 * answers with the last good copy flagged `ok: false, stale: true` (its `updatedAt` says
 * how old), or, with nothing to show, an explicit error and no alerts (HTTP 503).
 */
export function getAlertsResponse(deps: AlertsDeps = {}): Promise<AlertsResult> {
  const store = deps.store ?? defaultStore;
  const running = inflight.get(store);
  if (running) return running;
  const p = compute(store, deps).finally(() => inflight.delete(store));
  inflight.set(store, p);
  return p;
}

async function compute(store: AlertsStore, deps: AlertsDeps): Promise<AlertsResult> {
  const nowMs = (deps.now ?? Date.now)();
  const latest = await readLatest(store);
  const age = latest ? nowMs - latest.fetchedAt : Infinity;
  const body = (alerts: NwsAlert[], fetchedAt: number, extra: Partial<AlertsResponse>): AlertsResponse => ({
    alerts: alerts.filter(a => isAlertActive(a, nowMs)),
    updatedAt: new Date(fetchedAt).toISOString(),
    ok: true,
    source: ALERTS_SOURCE,
    ...extra,
  });

  if (latest && age >= 0 && age < (deps.freshMs ?? FRESH_MS)) return { status: 200, body: body(latest.alerts, latest.fetchedAt, {}) };

  try {
    const alerts = await readUpstream(store, deps, nowMs);
    return { status: 200, body: body(alerts, nowMs, {}) };
  } catch (e) {
    const error = describeError(e);
    console.warn(`[alerts] upstream read failed: ${error}${e instanceof Error ? ` (${e.message})` : ''}`);
    if (latest && age < MAX_STALE_MS) return { status: 200, body: body(latest.alerts, latest.fetchedAt, { ok: false, stale: true, error }) };
    return { status: 503, body: { alerts: [], updatedAt: null, ok: false, source: ALERTS_SOURCE, error } };
  }
}

async function readUpstream(store: AlertsStore, deps: AlertsDeps, nowMs: number): Promise<NwsAlert[]> {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? defaultSleep;
  const base = deps.base ?? NWS_API_BASE;
  const timeoutMs = deps.upstreamTimeoutMs ?? 7_000;

  const raw = await fetchJson(alertsUrl(base), { fetchImpl, timeoutMs, retries: 1, sleep });
  const parsed = normaliseAlerts(raw, nowMs);
  const joined = await joinZoneGeometry(parsed, {
    store,
    fetchImpl,
    base,
    nowMs,
    budgetMs: deps.zoneBudgetMs ?? 6_000,
    maxFetches: 80,
    concurrency: 6,
    timeoutMs: 6_000,
    sleep,
  });
  if (joined.pending) deps.waitUntil?.(joined.pending);
  const alerts = capPayload(joined.alerts, deps.maxBytes ?? MAX_RESPONSE_BYTES).alerts.map(withMapLink);
  await store.put(LATEST_KEY, JSON.stringify({ fetchedAt: nowMs, alerts } satisfies Latest)).catch(() => {});
  return alerts;
}
