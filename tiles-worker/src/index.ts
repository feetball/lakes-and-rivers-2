// Serves Protomaps basemap tiles out of a single PMTiles archive in R2.
//
//   GET /{name}/{z}/{x}/{y}.mvt   vector tile (gzip, passed through as stored)
//   GET /{name}.json              TileJSON (bounds, zooms, attribution)
//
// PMTiles is a single-file tile archive: the Worker reads the header and a
// small directory with HTTP-range-style R2 reads, then the one tile it needs.
// Tiles are cached at the edge with the Cache API (see README.md).

import {
  Compression,
  EtagMismatch,
  PMTiles,
  ResolvedValueCache,
  type DecompressFunc,
  type RangeResponse,
  type Source,
} from 'pmtiles';
import { archiveKey, checkOrigin, parseRoute } from './routes';

class ArchiveNotFound extends Error {}

/** Internal marker for a tile body that is already compressed (see withHeaders). */
const TILE_ENCODING_HEADER = 'X-Tile-Encoding';

/** Reads byte ranges of one PMTiles object from R2. */
class R2Source implements Source {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
  ) {}

  getKey() {
    return this.key;
  }

  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, {
      range: { offset, length },
      // If the archive was replaced since we cached its directories, bail so
      // the library drops its cache and retries against the new file.
      onlyIf: etag ? { etagMatches: etag } : undefined,
    });
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
function withHeaders(resp: Response, extra: Headers): Response {
  const headers = new Headers(resp.headers);
  extra.forEach((v, k) => headers.set(k, v));
  const encoding = headers.get(TILE_ENCODING_HEADER);
  if (encoding) {
    headers.set('Content-Encoding', encoding);
    headers.delete(TILE_ENCODING_HEADER);
  }
  return new Response(resp.body, {
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
  const archive = new PMTiles(source, DIRECTORY_CACHE, passthrough);
  const header = await archive.getHeader();
  const tile = await archive.getZxy(z, x, y);

  const cacheControl = env.CACHE_CONTROL;
  // Valid coordinate with no data (open water, out of the extract's bbox or
  // zoom range). 204 is a successful empty tile for vector-tile clients.
  if (!tile) return new Response(null, { status: 204, headers: { 'Cache-Control': cacheControl } });

  const headers = new Headers({
    'Content-Type': 'application/vnd.mapbox-vector-tile',
    'Cache-Control': cacheControl,
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
  const archive = new PMTiles(source, DIRECTORY_CACHE, gunzip);
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
    if (!ok) return new Response('Origin not allowed', { status: 403 });
    const cors = corsHeaders(allowOrigin);

    if (request.method === 'OPTIONS') {
      cors.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      cors.set('Access-Control-Max-Age', '86400');
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, OPTIONS' } });
    }

    const route = parseRoute(url.pathname);
    if (!route) return withHeaders(new Response('Not found', { status: 404 }), cors);
    if (route.kind === 'root') {
      return withHeaders(new Response('Texas Flood Map basemap tiles\n'), cors);
    }

    // Edge cache, keyed on path only (ignores query strings and Origin).
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}${url.pathname}`);
    const cached = await cache.match(cacheKey);
    if (cached) return withHeaders(cached, cors);

    try {
      const resp =
        route.kind === 'tile'
          ? await serveTile(env, route.name, route.z, route.x, route.y)
          : await serveTileJson(env, request, route.name);
      // Only 200s: a cached 204 is pointless (no body, no R2 read to save).
      if (resp.status === 200) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return withHeaders(resp, cors);
    } catch (e) {
      if (e instanceof ArchiveNotFound) {
        return withHeaders(new Response('Archive not found', { status: 404 }), cors);
      }
      console.error('tile error', url.pathname, e);
      return withHeaders(new Response('Internal error', { status: 500 }), cors);
    }
  },
} satisfies ExportedHandler<Env>;
