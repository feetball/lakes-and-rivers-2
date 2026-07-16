import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import { IS_WORKERD, readPublicData } from '@/lib/data-assets';

// Serves public/data/waterways.geojson with brotli/gzip negotiated from
// precompressed artifacts written at build time (see build-waterways-data.mjs).
// Primarily a fallback for self-hosted standalone (whose server only gzips
// static files) — the client prefers the static CDN asset on Vercel/Cloudflare.
// The route reads request headers (Accept-Encoding / If-None-Match) so it's
// dynamic, but we set CDN-Cache-Control with s-maxage so the edge caches the
// response per-encoding and we don't pay a function invocation on every
// request. ETag (content hash) gives cheap 304 revalidation. We deliberately
// don't set `dynamic = 'force-dynamic'` — that opts out of the edge cache.

// In-memory per-instance cache of the encoded payloads + ETag. The files are
// immutable for the life of a deploy, so read them once. `identity` is the
// uncompressed body, computed lazily (from the raw file if present, else by
// inflating the gzip variant) so clients that accept no compression still get
// a correctly-labeled response.
let cached: { etag: string; variants: Record<string, Buffer>; raw: Buffer | null; identity?: Buffer | null } | null = null;

// Resolve an uncompressed body without requiring the (untraced on Vercel) raw
// file to be present: prefer raw, otherwise inflate gzip once and memoize.
function identityBody(data: NonNullable<typeof cached>): Buffer | null {
  if (data.identity !== undefined) return data.identity;
  if (data.raw) { data.identity = data.raw; return data.identity; }
  data.identity = data.variants.gzip ? gunzipSync(data.variants.gzip) : null;
  return data.identity;
}

async function load() {
  if (cached) return cached;
  const variants: Record<string, Buffer> = {};
  // Hash the actual bytes for the ETag — works identically on Node (fs) and
  // Cloudflare (ASSETS binding), where there are no mtimes to key off.
  const hash = createHash('sha1');
  let raw: Buffer | null = null;
  if (IS_WORKERD) {
    // workerd owns response compression: a hand-rolled Content-Encoding on a
    // pre-compressed body is ignored/stripped (encodeBody defaults to
    // 'automatic'), so clients would receive compressed bytes labeled
    // identity. Serve the uncompressed body and let the runtime negotiate
    // gzip/brotli with the client itself. (This route barely runs on
    // Cloudflare anyway — the client prefers the static /data asset.)
    raw = await readPublicData('waterways.geojson');
    if (raw) hash.update('raw').update(raw);
  } else {
    for (const v of [
      { file: 'waterways.geojson.br', encoding: 'br' },
      { file: 'waterways.geojson.gz', encoding: 'gzip' },
    ]) {
      const buf = await readPublicData(v.file);
      if (!buf) continue; // artifact missing — fall through to the raw file
      variants[v.encoding] = buf;
      hash.update(v.encoding).update(buf);
    }
    if (Object.keys(variants).length === 0) {
      raw = await readPublicData('waterways.geojson');
      if (raw) hash.update('raw').update(raw);
    }
  }
  cached = { etag: `"${hash.digest('base64url').slice(0, 27)}"`, variants, raw };
  return cached;
}

export async function GET(req: Request) {
  const data = await load();
  if (!data.raw && Object.keys(data.variants).length === 0) {
    return NextResponse.json(
      { error: 'waterways data not built — run `pnpm data:build`' },
      { status: 503 },
    );
  }

  // Honour conditional requests so revalidation is a cheap 304.
  if (req.headers.get('if-none-match') === data.etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: data.etag } });
  }

  const accept = req.headers.get('accept-encoding') ?? '';
  const headers = new Headers({
    'Content-Type': 'application/geo+json; charset=utf-8',
    // Browser cache (max-age) + Vercel edge cache (CDN-Cache-Control). The
    // geometry only changes on redeploy, so the edge can hold it for a day and
    // serve stale while revalidating. Without s-maxage/CDN-Cache-Control every
    // cold client would invoke the function.
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    'CDN-Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
    ETag: data.etag,
    Vary: 'Accept-Encoding',
  });

  // NextResponse wants a Web BodyInit; expose the Node Buffer as a zero-copy
  // Uint8Array view. TS 5.7+ can't prove the backing store isn't a
  // SharedArrayBuffer, so cast — a Uint8Array is a valid runtime body.
  const view = (b: Buffer): BodyInit =>
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength) as unknown as BodyInit;

  // Serve the best variant the client actually accepts, always with a matching
  // Content-Encoding. Never label a body with an encoding the client didn't ask
  // for (that yields an undecodable response for identity/non-gzip clients).
  if (data.variants.br && accept.includes('br')) {
    headers.set('Content-Encoding', 'br');
    return new NextResponse(view(data.variants.br), { headers });
  }
  if (data.variants.gzip && accept.includes('gzip')) {
    headers.set('Content-Encoding', 'gzip');
    return new NextResponse(view(data.variants.gzip), { headers });
  }
  // Client accepts neither br nor gzip (identity, or a stripping proxy): send
  // the uncompressed body with no Content-Encoding.
  const body = identityBody(data);
  if (body) return new NextResponse(view(body), { headers });
  return NextResponse.json(
    { error: 'waterways data not available in a servable encoding' },
    { status: 503 },
  );
}
