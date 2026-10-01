// Serves Protomaps basemap tiles out of a single PMTiles archive in R2.
//
//   GET /{name}/{z}/{x}/{y}.mvt   vector tile (gzip, passed through as stored)
//   GET /{name}.json              TileJSON (bounds, zooms, attribution)
//   HEAD works like GET without a body; OPTIONS answers CORS preflights.
//
// PMTiles is a single-file tile archive: the Worker reads the header and a
// small directory with HTTP-range-style R2 reads, then the one tile it needs.
// Tiles are cached at the edge with the Cache API (see README.md).
//
// Written to also run under plain Node (explicit .ts import, no parameter
// properties) so test/worker.test.ts can drive the real handler.

import {
  Compression,
  EtagMismatch,
  PMTiles,
  ResolvedValueCache,
  type DecompressFunc,
  type RangeResponse,
  type Source,
} from 'pmtiles';
import { archiveAllowed, archiveKey, canonicalPath, checkOrigin, parseRoute } from './routes.ts';

class ArchiveNotFound extends Error {}

/** Internal marker for a tile body that is already compressed (see withHeaders). */
const TILE_ENCODING_HEADER = 'X-Tile-Encoding';

// A valid coordinate with no data (open water, outside the extract, beyond its
// zoom range) is a 204. Cache it briefly rather than for the week real tiles get,
// so a re-cut with wider coverage shows up within the hour.
const EMPTY_TILE_CACHE_CONTROL = 'public, max-age=3600';

// How long an isolate trusts its cached archive header. The pmtiles library only
// notices a replaced archive when a read that reaches R2 sees a different ETag;
// answers that never reach R2 (TileJSON, 204 for a zoom the old header lacked)
// would describe the old archive for as long as the isolate lives. Re-reading the
// 16 KB header once a minute bounds that to about a minute after an upload.
const HEADER_TTL_MS = 60_000;
const headerCheckedAt = new Map<string, number>();

// R2 reads fail transiently now and then; retry briefly before it becomes a 500.
const R2_RETRIES = 2;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function r2Get(
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number,
  etag: string | undefined,
): Promise<R2ObjectBody | R2Object | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await bucket.get(key, {
        range: { offset, length },
        // If the archive was replaced since we cached its directories, bail so
        // the library drops its cache and retries against the new file.
        onlyIf: etag ? { etagMatches: etag } : {},
      });
    } catch (e) {
      if (attempt >= R2_RETRIES) throw e;
      await sleep(40 * 4 ** attempt);
    }
  }
}

/** Reads byte ranges of one PMTiles object from R2. */
class R2Source implements Source {
  private readonly bucket: R2Bucket;
  private readonly key: string;

  constructor(bucket: R2Bucket, key: string) {
    this.bucket = bucket;
    this.key = key;
  }

  getKey() {
    return this.key;
  }

  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const obj = await r2Get(this.bucket, this.key, offset, length, etag);
    if (!obj) throw new ArchiveNotFound(this.key);
    if (!('body' in obj)) throw new EtagMismatch();
    return {
      data: await obj.arrayBuffer(),
      etag: obj.etag,
      cacheControl: obj.httpMetadata?.cacheControl,
    };
  }
}

/** Gunzip for archive internals (header/directories/metadata). */
const gunzip: DecompressFunc = async (buf, compression) => {
  if (compression === Compression.None || compression === Compression.Unknown) return buf;
  if (compression === Compression.Gzip) {
    const body = new Response(buf).body;
    if (!body) throw new Error('Failed to read response stream');
    return new Response(body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  throw new Error(`Unsupported PMTiles compression: ${compression}`);
};

/** Leave tile bytes compressed: we forward them with Content-Encoding instead. */
const passthrough: DecompressFunc = async (buf) => buf;

// Per-isolate cache of archive headers + directories (never tile bodies).
const DIRECTORY_CACHE = new ResolvedValueCache(64, undefined, gunzip);

function refreshHeaderIfStale(source: Source) {
  const key = source.getKey();
  const now = Date.now();
  const last = headerCheckedAt.get(key);
  if (last === undefined) {
    headerCheckedAt.set(key, now);
  } else if (now - last > HEADER_TTL_MS) {
    headerCheckedAt.set(key, now);
    void DIRECTORY_CACHE.invalidate(source);
  }
}

// Denied origins are worth knowing about (a hostname or allowlist change would otherwise
// silently send every client to its OSM fallback), but the Origin header is
// attacker-controlled: log each distinct one once per isolate, and cap how many.
const deniedLogged = new Set<string>();
const DENIED_LOG_CAP = 20;
function logDeniedOrigin(origin: string | null) {
  if (!origin || deniedLogged.size >= DENIED_LOG_CAP || deniedLogged.has(origin)) return;
  deniedLogged.add(origin);
  console.warn('origin not allowed:', origin.slice(0, 200));
}

function corsHeaders(allowOrigin: string | null): Headers {
  const h = new Headers();
  if (allowOrigin) h.set('Access-Control-Allow-Origin', allowOrigin);
  if (allowOrigin && allowOrigin !== '*') h.set('Vary', 'Origin');
  // Vector tiles are fetched with fetch(), so let the page read the encoding.
  h.set('Access-Control-Expose-Headers', 'Content-Encoding, Content-Length');
  return h;
}

// Tile bodies are already gzip (we forward the archive's bytes untouched). Two
// runtime behaviours would corrupt them, so Content-Encoding is only attached
// here, on the way out:
//  - the Cache API mishandles stored bodies that carry Content-Encoding (the
//    body comes back gzipped a second time), so tiles are cached as opaque bytes
//    tagged with the internal X-Tile-Encoding header instead;
//  - encodeBody "automatic" (the default) re-compresses any body that has a
//    Content-Encoding header, and `new Response(body, otherResponse)` does not
//    carry the setting over, so every response is rebuilt here with "manual".
function withHeaders(resp: Response, extra: Headers, head: boolean): Response {
  const headers = new Headers(resp.headers);
  extra.forEach((v, k) => headers.set(k, v));
  const encoding = headers.get(TILE_ENCODING_HEADER);
  if (encoding) {
    headers.set('Content-Encoding', encoding);
    headers.delete(TILE_ENCODING_HEADER);
  }
  return new Response(head ? null : resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
    encodeBody: 'manual',
  });
}

async function serveTile(
  env: Env,
  name: string,
  z: number,
  x: number,
  y: number,
): Promise<Response> {
  const source = new R2Source(env.BUCKET, archiveKey(env.PMTILES_PATH, name));
  refreshHeaderIfStale(source);
  const archive = new PMTiles(source, DIRECTORY_CACHE, passthrough);
  const tile = await archive.getZxy(z, x, y);

  // Valid coordinate with no data: a successful empty tile for vector-tile clients.
  if (!tile) return new Response(null, { status: 204, headers: { 'Cache-Control': EMPTY_TILE_CACHE_CONTROL } });

  // Read the header after getZxy: if the archive was just replaced, getZxy has
  // already refreshed it, so the compression decision uses the new header.
  const header = await archive.getHeader();
  const headers = new Headers({
    'Content-Type': 'application/vnd.mapbox-vector-tile',
    'Cache-Control': env.CACHE_CONTROL,
  });
  if (header.tileCompression === Compression.Gzip) {
    headers.set(TILE_ENCODING_HEADER, 'gzip');
  } else if (header.tileCompression !== Compression.None) {
    throw new Error(`Unsupported tile compression: ${header.tileCompression}`);
  }
  return new Response(tile.data, { headers });
}

async function serveTileJson(env: Env, request: Request, name: string): Promise<Response> {
  const source = new R2Source(env.BUCKET, archiveKey(env.PMTILES_PATH, name));
  refreshHeaderIfStale(source);
  const archive = new PMTiles(source, DIRECTORY_CACHE, gunzip);
  // getTileJson reads the cached header before the metadata. Reading the
  // metadata first lets the library notice a replaced archive (and refresh the
  // header) so the zoom range and bounds below are the new ones.
  await archive.getMetadata();
  const host = env.PUBLIC_HOSTNAME || new URL(request.url).host;
  const tileJson = await archive.getTileJson(`https://${host}/${name}`);
  return new Response(JSON.stringify(tileJson), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { ok, allowOrigin } = checkOrigin(request.headers.get('Origin'), env.ALLOWED_ORIGINS);
    if (!ok) {
      logDeniedOrigin(request.headers.get('Origin'));
      return new Response('Origin not allowed', { status: 403 });
    }
    const cors = corsHeaders(allowOrigin);

    if (request.method === 'OPTIONS') {
      cors.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      cors.set('Access-Control-Max-Age', '86400');
      return new Response(null, { status: 204, headers: cors });
    }
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
    }
    const respond = (resp: Response) => withHeaders(resp, cors, head);

    const route = parseRoute(url.pathname);
    if (!route) return respond(new Response('Not found', { status: 404 }));
    if (route.kind === 'root') return respond(new Response('Texas Flood Map basemap tiles\n'));
    if (!archiveAllowed(env.ALLOWED_ARCHIVES, route.name)) return respond(new Response('Not found', { status: 404 }));

    // Edge cache. The key is built from the parsed route and a fixed host, not
    // the raw URL, so port, query-string or spelling variants share one entry.
    const cache = caches.default;
    const cacheKey = new Request(`https://${env.PUBLIC_HOSTNAME || url.host}${canonicalPath(route)}`);
    const cached = await cache.match(cacheKey);
    if (cached) return respond(cached);

    try {
      const resp =
        route.kind === 'tile'
          ? await serveTile(env, route.name, route.z, route.x, route.y)
          : await serveTileJson(env, request, route.name);
      // Only 200s: an empty 204 has no body and no R2 read worth saving.
      if (resp.status === 200) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return respond(resp);
    } catch (e) {
      if (e instanceof ArchiveNotFound) {
        console.warn('archive not found in R2:', route.name);
        return respond(new Response('Archive not found', { status: 404 }));
      }
      console.error('tile error', url.pathname, e);
      return respond(new Response('Internal error', { status: 500 }));
    }
  },
} satisfies ExportedHandler<Env>;
