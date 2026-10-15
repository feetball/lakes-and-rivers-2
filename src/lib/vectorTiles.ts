// Pure helpers behind the self-hosted vector basemap (src/components/Basemap.tsx):
// a tile source that reports how real requests go, a failure monitor that decides
// when to give up on the tile server, the TileJSON lookup, reachability probes, and
// the timing rules (retry budget, recovery backoff).
//
// No React or Leaflet imports and only syntax Node can strip, so
// tests/vectorTiles.test.mjs runs this directly under Node with an injected fetch.

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (input, init) => fetch(input, init);

/** Highest zoom this code will believe an archive stores (Protomaps basemaps stop at 15). */
const MAX_ARCHIVE_ZOOM = 15;

/** A tile that takes longer than this counts as a failure (a black-holed network never answers). */
export const TILE_TIMEOUT_MS = 15_000;
/** The TileJSON is ~3 KB from the edge cache: if it takes this long the server is not usable. */
export const ARCHIVE_INFO_TIMEOUT_MS = 4_000;
export const PROBE_TIMEOUT_MS = 8_000;
/** Tile requests that fail in a row (no success in between) before we look at giving up on the server. */
export const MAX_CONSECUTIVE_FAILURES = 4;

/**
 * A vector tile is a protobuf message whose first field is `layers` (field 3,
 * length-delimited: tag byte 0x1a). Every non-empty tile in our archive starts with it.
 */
const MVT_LAYERS_TAG = 0x1a;

/** Aborts `ctrl` when any of the signals aborts; returns a function that removes the listeners. */
function linkSignals(ctrl: AbortController, signals: (AbortSignal | undefined)[]): () => void {
  const cleanups: (() => void)[] = [];
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      continue;
    }
    const onAbort = () => ctrl.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }
  return () => cleanups.forEach((c) => c());
}

// ---------------------------------------------------------------------------
// Tile source
// ---------------------------------------------------------------------------

/** What protomaps-leaflet's PmtilesSource calls on its archive: getZxy(z, x, y, signal). */
export interface TileArchive {
  getZxy(z: number, x: number, y: number, signal?: AbortSignal): Promise<{ data: ArrayBuffer } | undefined>;
}

export class TileFetchError extends Error {
  status: number;
  constructor(status: number, url: string, reason?: string) {
    super(reason ? `${reason}: ${url}` : `Tile request failed with HTTP ${status}: ${url}`);
    this.name = 'TileFetchError';
    this.status = status;
  }
}

export interface TileArchiveOptions {
  /** Z/X/Y template, e.g. https://tiles.example.com/texas/{z}/{x}/{y}.mvt */
  template: string;
  /**
   * Called once per real network request with whether it worked. Requests the
   * caller cancels (protomaps-leaflet aborts in-flight tiles on every zoom
   * change) are NOT reported: they say nothing about the server.
   */
  onResult: (ok: boolean) => void;
  /** Aborting this cancels every in-flight request (the layer was removed); also not reported. */
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchFn;
}

/**
 * Fetches vector tiles for protomaps-leaflet, which only ever asks its archive
 * object for getZxy(). Its own Z/X/Y path never checks the HTTP status (a 500
 * body would be parsed as a tile), never times out, and reports nothing. This does
 * all of that: 204 is an empty tile, any other non-2xx status throws, a 200 whose
 * body is not a vector tile throws (the monitor must see it: protomaps-leaflet would
 * only log a parse error and draw a blank tile, as when a server compresses a tile
 * twice or a captive portal answers with HTML), and the outcome of every request goes
 * to onResult.
 */
export function createTileArchive(opts: TileArchiveOptions): TileArchive {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const timeoutMs = opts.timeoutMs ?? TILE_TIMEOUT_MS;

  return {
    async getZxy(z, x, y, signal) {
      const url = opts.template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      const ctrl = new AbortController();
      let timedOut = false;
      const unlink = linkSignals(ctrl, [signal, opts.signal]);
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);

      try {
        const resp = await doFetch(url, { signal: ctrl.signal });
        if (resp.status === 204) {
          opts.onResult(true);
          return undefined;
        }
        if (!resp.ok) throw new TileFetchError(resp.status, url);
        const data = await resp.arrayBuffer();
        if (data.byteLength > 0 && new Uint8Array(data, 0, 1)[0] !== MVT_LAYERS_TAG) {
          throw new TileFetchError(resp.status, url, 'Response is not a vector tile');
        }
        opts.onResult(true);
        return { data };
      } catch (e) {
        // The caller cancelled, or the layer was removed: not a server failure. Rethrow
        // the AbortError untouched (protomaps-leaflet recognises it by name and stays quiet).
        if (signal?.aborted || opts.signal?.aborted) throw e;
        opts.onResult(false);
        if (timedOut) throw new DOMException(`Tile request timed out after ${timeoutMs} ms: ${url}`, 'TimeoutError');
        throw e;
      } finally {
        clearTimeout(timer);
        unlink();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Failure monitor
// ---------------------------------------------------------------------------

export interface HealthMonitor {
  record(ok: boolean): void;
  /** Forget the failures and re-arm (after a trip that turned out to be a false alarm). */
  reset(): void;
}

/**
 * Calls onUnhealthy (once per arming) after maxConsecutiveFailures failed requests
 * with no success in between. Any success resets the count, so a stray 500 or a
 * flaky tile never trips it, while a dead or blocked server does within the first
 * screenful of tiles. It only says "look at this": the caller decides whether to
 * act. ignoreFailures() lets the caller discount failures that say nothing about
 * our server (the device is offline).
 */
export function createHealthMonitor(opts: {
  onUnhealthy: () => void;
  maxConsecutiveFailures?: number;
  ignoreFailures?: () => boolean;
}): HealthMonitor {
  const limit = opts.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
  let failures = 0;
  let tripped = false;
  return {
    record(ok) {
      if (tripped) return;
      if (ok) {
        failures = 0;
        return;
      }
      if (opts.ignoreFailures?.()) return;
      failures += 1;
      if (failures >= limit) {
        tripped = true;
        opts.onUnhealthy();
      }
    },
    reset() {
      failures = 0;
      tripped = false;
    },
  };
}

// ---------------------------------------------------------------------------
// TileJSON lookup
// ---------------------------------------------------------------------------

/** .../texas/{z}/{x}/{y}.mvt -> .../texas.json (the Worker's TileJSON), or null for other layouts. */
export function archiveInfoUrl(template: string): string | null {
  const m = template.match(/^(.*)\/\{z\}\/\{x\}\/\{y\}\.mvt$/);
  return m ? `${m[1]}.json` : null;
}

export type ArchiveInfo = { status: 'ok'; maxZoom: number } | { status: 'unavailable'; reason: string };

/**
 * Asks the tile server for the archive's highest stored zoom. The renderer
 * assumes 15 and gets blank tiles asking for data the archive lacks, so this value
 * matters; it also keeps apps already installed correct if the archive is re-cut at
 * another zoom. It doubles as the first health check: an unreachable server, a
 * non-2xx answer, a timeout, or a non-JSON body (a captive portal) is 'unavailable'.
 * A readable answer with a missing or implausible maxzoom still counts as 'ok', with
 * fallbackMaxZoom: the server works, only its metadata is odd.
 *
 * If the network itself is down (isOffline()), nothing can be said about the server and
 * tiles cached from earlier sessions may still be drawable, so that is 'ok' at
 * fallbackMaxZoom rather than a reason to give up.
 */
export async function fetchArchiveInfo(
  template: string,
  opts: {
    fallbackMaxZoom: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    isOffline?: () => boolean;
    fetchImpl?: FetchFn;
  },
): Promise<ArchiveInfo> {
  const url = archiveInfoUrl(template);
  if (!url) return { status: 'ok', maxZoom: opts.fallbackMaxZoom };
  if (opts.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };

  const doFetch = opts.fetchImpl ?? defaultFetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const unlink = linkSignals(ctrl, [opts.signal]);
  const timeoutMs = opts.timeoutMs ?? ARCHIVE_INFO_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  try {
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok) return { status: 'unavailable', reason: `HTTP ${res.status} from ${url}` };
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { status: 'unavailable', reason: `${url} did not return JSON` };
    }
    const maxzoom = (body as { maxzoom?: unknown } | null)?.maxzoom;
    const valid = typeof maxzoom === 'number' && Number.isInteger(maxzoom) && maxzoom > 0 && maxzoom <= MAX_ARCHIVE_ZOOM;
    return { status: 'ok', maxZoom: valid ? maxzoom : opts.fallbackMaxZoom };
  } catch (e) {
    if (opts.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (opts.isOffline?.()) return { status: 'ok', maxZoom: opts.fallbackMaxZoom };
    const why = timedOut ? `timed out after ${timeoutMs} ms` : e instanceof Error ? e.message : String(e);
    return { status: 'unavailable', reason: `${url} unreachable (${why})` };
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

// ---------------------------------------------------------------------------
// Reachability probes
// ---------------------------------------------------------------------------

/** [[south, west], [north, east]] in degrees: the shape of Leaflet's bounds and of TX_BOUNDS. */
export type LatLngBounds = [[number, number], [number, number]];

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z);
}

/** A random tile at zoom z inside the bounds. */
export function randomTileIn(bounds: LatLngBounds, z: number, rand: () => number = Math.random): { z: number; x: number; y: number } {
  const [[south, west], [north, east]] = bounds;
  const x0 = lonToTileX(west, z);
  const x1 = lonToTileX(east, z);
  const y0 = latToTileY(north, z);
  const y1 = latToTileY(south, z);
  return {
    z,
    x: x0 + Math.floor(rand() * (x1 - x0 + 1)),
    y: y0 + Math.floor(rand() * (y1 - y0 + 1)),
  };
}

/**
 * Is the tile server healthy? Fetches one random mid-zoom tile inside the bounds,
 * bypassing the browser cache. Random on purpose: a fixed tile would be answered from
 * an edge or HTTP cache even while the origin (R2) is down. A 204 or a 200 whose body
 * is a vector tile counts as healthy.
 */
export async function probeTileServer(
  template: string,
  opts: { bounds: LatLngBounds; signal?: AbortSignal; timeoutMs?: number; fetchImpl?: FetchFn; rand?: () => number },
): Promise<boolean> {
  const { z, x, y } = randomTileIn(opts.bounds, 12, opts.rand);
  const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const doFetch = opts.fetchImpl ?? defaultFetch;
  if (opts.signal?.aborted) return false;
  const ctrl = new AbortController();
  const unlink = linkSignals(ctrl, [opts.signal]);
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (res.status === 204) return true;
    if (!res.ok) return false;
    // Same rule as for real tiles: a 200 that is not a vector tile (an HTML portal page,
    // a double-compressed body) is not a healthy server.
    const data = await res.arrayBuffer();
    return data.byteLength > 0 && new Uint8Array(data, 0, 1)[0] === MVT_LAYERS_TAG;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/** A raster tile URL template (Leaflet's {s}/{z}/{x}/{y}) filled in with the world tile. */
export function rasterProbeUrl(template: string): string {
  return template.replace('{s}', 'a').replace('{z}', '0').replace('{x}', '0').replace('{y}', '0').replace('{r}', '');
}

/**
 * Can the raster fallback be reached at all? Used before swapping to it: if the
 * internet is down, swapping would replace a map that is still drawn with one that
 * cannot load. A no-cors request settles for ANY HTTP answer and rejects only when
 * the network fails, so no CORS headers are needed and the answer's body is never read.
 */
export async function probeRasterReachable(
  template: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: FetchFn } = {},
): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  if (opts.signal?.aborted) return false;
  const ctrl = new AbortController();
  const unlink = linkSignals(ctrl, [opts.signal]);
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    await doFetch(rasterProbeUrl(template), { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

// ---------------------------------------------------------------------------
// Timing rules
// ---------------------------------------------------------------------------

export const RECOVERY_BASE_MS = 60_000;
export const RECOVERY_MAX_MS = 15 * 60_000;

/**
 * How long to wait before the next check that the tile server is back, given how
 * many recovery attempts have already failed: 1, 2, 4, 8, then 15 minutes. A marginal
 * link therefore cannot flap between the layers every minute.
 */
export function recoveryDelayMs(failedRecoveries: number): number {
  return Math.min(RECOVERY_BASE_MS * 2 ** Math.max(0, failedRecoveries), RECOVERY_MAX_MS);
}

/**
 * Bounded retries for tiles that failed (the renderer never retries by itself):
 * next() gives the delay before drawing the failed tiles again, 8 s then 16 s then
 * 32 s, and null once the budget is spent so a persistently bad tile cannot cause an
 * endless loop; reset() when a request succeeds.
 */
export function createRetryBudget(opts: { max?: number; baseMs?: number } = {}) {
  const max = opts.max ?? 3;
  const baseMs = opts.baseMs ?? 8_000;
  let used = 0;
  return {
    next(): number | null {
      if (used >= max) return null;
      const delay = baseMs * 2 ** used;
      used += 1;
      return delay;
    },
    reset() {
      used = 0;
    },
  };
}
