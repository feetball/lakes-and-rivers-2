// The logic behind the "River cameras" layer: USGS's streamgage cameras, shown as a
// photo on the map. The camera list comes from USGS's National Imagery Management
// System (NIMS); this file turns that list into what the map needs, decides which
// cameras are too old to show, and caches the list for the Worker that serves it.
//
// No React, Leaflet or path-alias imports and only syntax Node can strip, so
// tests/webcams.test.mjs runs this directly under Node with an injected fetch.
//
// What a camera is, and is not: every NIMS camera uploads a still photo every 15-60
// minutes (some only in daylight). They are not live video, the photos are not ours,
// and nothing here is official flood information. The UI says so.

export interface Webcam {
  /** NIMS camera id, e.g. "TX_Blanco_River_at_Wimberley". Safe to put in a URL path. */
  id: string;
  name: string;
  description: string | null;
  lat: number;
  lon: number;
  /** USGS site number the camera belongs to, when NIMS names one. */
  usgsId: string | null;
  /** NWS id of the gauge at the same site, or null when this app has no gauge there. See linkGauges. */
  gaugeId: string | null;
  /** When the newest photo was taken (ISO 8601, UTC), or null when NIMS lists none. */
  newestImageAt: string | null;
  /** That photo (a 720 px JPEG), or null when newestImageAt is. Always passes isAllowedImageUrl. */
  imageUrl: string | null;
  /** NIMS only schedules photos in daylight, so overnight the newest one is from the evening before. */
  daylightOnly: boolean;
  /** Minutes between photos, as NIMS schedules them. */
  intervalMin: number | null;
}

export interface WebcamsResponse {
  webcams: Webcam[];
  /** When this server last read the list from USGS (not when the photos were taken). */
  updatedAt: string;
}

/** fresh: shown plainly. stale: shown with a warning. offline: hidden from the map and counted. */
export type WebcamStatus = 'fresh' | 'stale' | 'offline';

/** A photo older than this carries a warning: it may not show what the river is doing now. */
export const WEBCAM_STALE_MS = 3 * 3_600_000;
/** A camera whose newest photo is older than this (or has none) is treated as offline. */
export const WEBCAM_OFFLINE_MS = 24 * 3_600_000;

const NIMS_CAMERAS_URL = 'https://api.waterdata.usgs.gov/nims/v0/cameras';
/** The one host photos are loaded from, in the apps and on the website. */
export const NIMS_IMAGE_HOST = 'usgs-nims-images.s3.amazonaws.com';
const USER_AGENT = 'texas-flood-map (+https://txfloods.kuecker.us)';

// Texas with a margin: a camera outside this box has a mistyped position, not a place we can show.
const LAT_RANGE: [number, number] = [25.5, 36.8];
const LON_RANGE: [number, number] = [-106.8, -93.3];

// ---------------------------------------------------------------------------
// Ids and photo URLs
// ---------------------------------------------------------------------------

/** Every Texas camera id is letters, digits and underscores (a few other states use parentheses). */
const CAMERA_ID_RE = /^[A-Za-z0-9_]{3,120}$/;

export function isValidCameraId(id: unknown): id is string {
  return typeof id === 'string' && CAMERA_ID_RE.test(id);
}

// The photo for a camera lives at <host>/720/<id>/<id>___<capture time>.jpg, with the
// time as UTC with dashes for colons: ...___2026-10-02T11-41-21Z.jpg. The \1 makes the
// folder and the file name agree on the camera, so one camera's URL cannot point at another's.
const IMAGE_URL_RE = new RegExp(
  `^https://${NIMS_IMAGE_HOST.replace(/\./g, '\\.')}/720/([A-Za-z0-9_]{3,120})/\\1___\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z\\.jpg$`,
);

/**
 * Is this exactly the URL of a camera photo on the USGS image host? The page only ever
 * puts a URL that passes into an <img>, and the server only ever builds ones that do:
 * nothing from the network (a camera list, an API response) is trusted to name a host.
 */
export function isAllowedImageUrl(url: unknown): url is string {
  return typeof url === 'string' && url.length <= 300 && IMAGE_URL_RE.test(url);
}

/** UTC milliseconds of an ISO 8601 timestamp, or null. Without a zone the time is read as UTC, not local. */
export function parseUtc(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const s = iso.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return null;
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** The URL of the photo a camera took at `capturedAt`, or null when the id or time is unusable. */
export function imageUrlFor(id: string, capturedAt: string): string | null {
  const ms = parseUtc(capturedAt);
  if (ms === null || !isValidCameraId(id)) return null;
  const stamp = `${new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
  return `https://${NIMS_IMAGE_HOST}/720/${id}/${id}___${stamp}.jpg`;
}

// ---------------------------------------------------------------------------
// The NIMS list -> Webcam[]
// ---------------------------------------------------------------------------

/** NIMS stamps a photo when it is ingested; one more than a day ahead of this server's clock is a bad stamp. */
const FUTURE_TOLERANCE_MS = 24 * 3_600_000;
const EARLIEST_PHOTO_MS = Date.UTC(2000, 0, 1);

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function inRange(n: number, [lo, hi]: [number, number]): boolean {
  return Number.isFinite(n) && n >= lo && n <= hi;
}

/**
 * Texas cameras from NIMS's national list (about 1,350 cameras, 1.3 MB), in the shape the
 * map uses. Cameras NIMS hides, and entries that cannot be placed or named safely, are
 * dropped; a camera with no usable photo time is kept (the map counts it as offline).
 * `nowMs` only rejects absurd future timestamps.
 */
export function normalizeWebcams(raw: unknown, nowMs: number = Date.now()): Webcam[] {
  if (!Array.isArray(raw)) return [];
  const out: Webcam[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;
    if (c.stateAbrv !== 'TX' || c.hideCam === true) continue;
    const id = c.camId;
    if (!isValidCameraId(id)) continue;
    // NIMS sends coordinates as strings, and the longitude under the key "lng".
    const lat = Number(c.lat);
    const lon = Number(c.lng);
    if (!inRange(lat, LAT_RANGE) || !inRange(lon, LON_RANGE)) continue;

    let newestImageAt: string | null = null;
    const taken = parseUtc(c.newestImageDT);
    if (taken !== null && taken >= EARLIEST_PHOTO_MS && taken <= nowMs + FUTURE_TOLERANCE_MS) {
      newestImageAt = new Date(taken).toISOString();
    }
    const ingest = (c.ingest && typeof c.ingest === 'object' ? c.ingest : {}) as Record<string, unknown>;
    const interval = Number(ingest.intr);

    out.push({
      id,
      name: cleanText(c.camName, 80) ?? id.replace(/_/g, ' '),
      description: cleanText(c.camDesc, 160),
      lat,
      lon,
      // NIMS has placeholders such as "888888"; real USGS site numbers are 8-15 digits.
      usgsId: typeof c.nwisId === 'string' && /^\d{8,15}$/.test(c.nwisId) ? c.nwisId : null,
      gaugeId: null,
      newestImageAt,
      imageUrl: newestImageAt ? imageUrlFor(id, newestImageAt) : null,
      daylightOnly: ingest.period === 'daylight',
      intervalMin: Number.isInteger(interval) && interval >= 1 && interval <= 240 ? interval : null,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Checks a /api/webcams response before the map believes it: anything that is not what
 * normalizeWebcams produces is dropped, so a bad response can neither crash the layer nor
 * put an arbitrary URL in an <img>. Throws when the body is not a camera list at all, or
 * has entries and none of them are usable; the layer then reports "unavailable" instead
 * of "0 cameras".
 */
export function parseWebcamsResponse(json: unknown): WebcamsResponse {
  const body = json as { webcams?: unknown; updatedAt?: unknown } | null;
  if (!body || !Array.isArray(body.webcams) || typeof body.updatedAt !== 'string') {
    throw new Error('not a camera list');
  }
  const webcams: Webcam[] = [];
  for (const entry of body.webcams) {
    const w = entry as Partial<Record<keyof Webcam, unknown>> | null;
    if (!w || typeof w !== 'object') continue;
    const { id, lat, lon, newestImageAt, imageUrl } = w;
    if (!isValidCameraId(id) || typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (!inRange(lat, LAT_RANGE) || !inRange(lon, LON_RANGE)) continue;
    const taken = parseUtc(newestImageAt);
    webcams.push({
      id,
      name: cleanText(w.name, 80) ?? id.replace(/_/g, ' '),
      description: cleanText(w.description, 160),
      lat,
      lon,
      usgsId: typeof w.usgsId === 'string' && /^\d{8,15}$/.test(w.usgsId) ? w.usgsId : null,
      gaugeId: typeof w.gaugeId === 'string' && /^[A-Za-z0-9]{3,12}$/.test(w.gaugeId) ? w.gaugeId : null,
      newestImageAt: taken === null ? null : new Date(taken).toISOString(),
      imageUrl: taken !== null && isAllowedImageUrl(imageUrl) ? imageUrl : null,
      daylightOnly: w.daylightOnly === true,
      intervalMin: typeof w.intervalMin === 'number' && w.intervalMin >= 1 && w.intervalMin <= 240 ? w.intervalMin : null,
    });
  }
  if (body.webcams.length > 0 && webcams.length === 0) throw new Error('no usable cameras in the list');
  return { webcams, updatedAt: body.updatedAt };
}

// ---------------------------------------------------------------------------
// Camera <-> gauge
// ---------------------------------------------------------------------------

export interface GaugeSite {
  id: string;
  lat: number;
  lon: number;
  usgsId: string | null;
}

/** Metres between two points (haversine). */
export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A camera and a gauge with the same USGS site number are the same site however far apart
// their coordinates are (Bardwell Lake's are 470 m apart); the cap only catches a typo.
const SAME_SITE_MAX_M = 3_000;
// A gauge with no USGS site number on file can still be the same site: Zacate Creek at Jacaman
// Road has a camera 5 m away and no number. Only gauges without a number qualify (one with a
// different number is a different site), and only within this distance.
const SAME_SPOT_M = 30;

/**
 * Sets each camera's gaugeId to the gauge at the same site: by USGS site number first
 * (the nearest one when two gauges share a number), else the nearest gauge with no number
 * within 30 m. Returns copies; a camera with no gauge keeps null.
 */
export function linkGauges(webcams: Webcam[], gauges: GaugeSite[]): Webcam[] {
  const byUsgsId = new Map<string, GaugeSite[]>();
  const unnumbered: GaugeSite[] = [];
  for (const g of gauges) {
    if (!g.usgsId) {
      unnumbered.push(g);
      continue;
    }
    const list = byUsgsId.get(g.usgsId);
    if (list) list.push(g);
    else byUsgsId.set(g.usgsId, [g]);
  }
  const nearest = (w: Webcam, candidates: GaugeSite[], maxM: number): GaugeSite | null => {
    let best: GaugeSite | null = null;
    let bestM = maxM;
    for (const g of candidates) {
      const m = distanceM(w.lat, w.lon, g.lat, g.lon);
      if (m <= bestM) {
        best = g;
        bestM = m;
      }
    }
    return best;
  };
  return webcams.map((w) => {
    const match =
      (w.usgsId ? nearest(w, byUsgsId.get(w.usgsId) ?? [], SAME_SITE_MAX_M) : null) ??
      nearest(w, unnumbered, SAME_SPOT_M);
    return { ...w, gaugeId: match ? match.id : null };
  });
}

/** Other cameras within `radiusM` of this one (two NIMS cameras can share a spot), nearest first. */
export function camerasNear(cam: Webcam, all: Webcam[], radiusM = 150): Webcam[] {
  return all
    .filter((w) => w.id !== cam.id)
    .map((w) => ({ w, m: distanceM(cam.lat, cam.lon, w.lat, w.lon) }))
    .filter((x) => x.m <= radiusM)
    .sort((a, b) => a.m - b.m || (a.w.id < b.w.id ? -1 : 1))
    .map((x) => x.w);
}

// ---------------------------------------------------------------------------
// How old a photo is
// ---------------------------------------------------------------------------

/** Age of a camera's newest photo in ms, or null when it has none. A clock running ahead of USGS's reads as 0. */
export function webcamAgeMs(w: Pick<Webcam, 'newestImageAt'>, nowMs: number): number | null {
  const taken = parseUtc(w.newestImageAt);
  return taken === null ? null : Math.max(0, nowMs - taken);
}

export function webcamStatus(w: Pick<Webcam, 'newestImageAt'>, nowMs: number): WebcamStatus {
  const age = webcamAgeMs(w, nowMs);
  if (age === null || age > WEBCAM_OFFLINE_MS) return 'offline';
  return age > WEBCAM_STALE_MS ? 'stale' : 'fresh';
}

/** The cameras the map draws (fresh or stale) and the ones it hides because they are offline. */
export function partitionWebcams(webcams: Webcam[], nowMs: number): { shown: Webcam[]; offline: Webcam[] } {
  const shown: Webcam[] = [];
  const offline: Webcam[] = [];
  for (const w of webcams) (webcamStatus(w, nowMs) === 'offline' ? offline : shown).push(w);
  return { shown, offline };
}

/** "just now", "12 min ago", "2 h 10 min ago", "1 d 3 h ago", "9 days ago". Rounds down, never up. */
export function formatPhotoAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h ago` : `${hours} h ${minutes % 60} min ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return hours % 24 === 0 ? '1 d ago' : `1 d ${hours % 24} h ago`;
  return days < 365 ? `${days} days ago` : 'over a year ago';
}

/**
 * When a photo was taken, in the viewer's own time zone with its name: "Mon 3:42 PM CDT".
 * Past a week the weekday would be ambiguous, so it becomes a date: "Sep 24, 3:42 PM CDT".
 * `locale` and `timeZone` are for tests; the app passes neither.
 */
export function formatPhotoTime(
  iso: string,
  opts: { nowMs?: number; locale?: string; timeZone?: string } = {},
): string {
  const taken = parseUtc(iso);
  if (taken === null) return '';
  const recent = (opts.nowMs ?? Date.now()) - taken < 6 * 86_400_000;
  return new Intl.DateTimeFormat(opts.locale, {
    ...(recent ? { weekday: 'short' } : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: opts.timeZone,
  }).format(new Date(taken));
}

// ---------------------------------------------------------------------------
// Reading the list from USGS, with a cache (server side)
// ---------------------------------------------------------------------------

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebcamSourceOptions {
  fetchImpl?: FetchFn;
  now?: () => number;
  /** How long a list is served without asking USGS again. */
  ttlMs?: number;
  /** How long a list may be served after USGS stops answering. Past this it is an error, not old news. */
  staleMaxMs?: number;
  /** After a failed refresh, how long to serve the old list without asking USGS again. */
  retryMs?: number;
  timeoutMs?: number;
}

export interface WebcamLoad {
  webcams: Webcam[];
  /** When this list was read from USGS (epoch ms). */
  fetchedAt: number;
  /** cache: still fresh. fresh: just read. stale: USGS is not answering and this is the last good list. */
  source: 'cache' | 'fresh' | 'stale';
}

// The national list is 1.3 MB of JSON; a body several times that is not the list.
const MAX_BODY_CHARS = 8_000_000;

/**
 * The camera list, read from USGS at most once per `ttlMs` per Worker isolate (10 minutes: a
 * camera photographs every 15-60), shared by concurrent requests, and kept as a fallback
 * for `staleMaxMs` when USGS is down. An empty Texas list counts as a failure: showing
 * "no cameras" because an upstream hiccup emptied the list would read as a fact.
 */
export function createWebcamSource(opts: WebcamSourceOptions = {}) {
  const {
    fetchImpl = (input, init) => fetch(input, init),
    now = () => Date.now(),
    ttlMs = 10 * 60_000,
    staleMaxMs = 12 * 3_600_000,
    retryMs = 60_000,
    timeoutMs = 10_000,
  } = opts;
  let cached: { webcams: Webcam[]; fetchedAt: number } | null = null;
  let retryAt = 0;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(NIMS_CAMERAS_URL, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`NIMS answered ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) throw new Error('NIMS answered with an oversized body');
      const webcams = normalizeWebcams(JSON.parse(text), now());
      if (webcams.length === 0) throw new Error('NIMS list has no Texas cameras');
      cached = { webcams, fetchedAt: now() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function load(): Promise<WebcamLoad> {
    const t = now();
    if (cached && t - cached.fetchedAt < ttlMs) return { ...cached, source: 'cache' };
    if (cached && t < retryAt && t - cached.fetchedAt < staleMaxMs) return { ...cached, source: 'stale' };
    try {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
      return { ...(cached as NonNullable<typeof cached>), source: 'fresh' };
    } catch (err) {
      retryAt = now() + retryMs;
      if (cached && now() - cached.fetchedAt < staleMaxMs) return { ...cached, source: 'stale' };
      throw err;
    }
  }

  return { load };
}
