import { NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';

// Serves public/data/waterways.geojson with brotli/gzip negotiated from
// precompressed artifacts written at build time (see build-waterways-data.mjs).
// The Next standalone server only gzips static public/ files; routing the
// payload through here lets us ship brotli (~half the gzip size for this data)
// and set long-lived caching. The geometry only changes on redeploy, so we
// cache aggressively and revalidate with an ETag derived from file size+mtime.
export const dynamic = 'force-dynamic';

const DATA_DIR = resolve(process.cwd(), 'public/data');
const BASE = resolve(DATA_DIR, 'waterways.geojson');

type Variant = { path: string; encoding: string };

// In-memory per-instance cache of the encoded payloads + ETag. The files are
// immutable for the life of a deploy, so read them once.
let cached: { etag: string; variants: Record<string, Buffer>; raw: Buffer | null } | null = null;

async function load() {
  if (cached) return cached;
  const variants: Record<string, Buffer> = {};
  let etagSource = '';
  for (const v of [
    { path: `${BASE}.br`, encoding: 'br' },
    { path: `${BASE}.gz`, encoding: 'gzip' },
  ] as Variant[]) {
    try {
      const [buf, st] = await Promise.all([readFile(v.path), stat(v.path)]);
      variants[v.encoding] = buf;
      etagSource += `${v.encoding}:${st.size}:${st.mtimeMs};`;
    } catch {
      // artifact missing — fall through to the raw file
    }
  }
  let raw: Buffer | null = null;
  if (!etagSource) {
    try {
      const [buf, st] = await Promise.all([readFile(BASE), stat(BASE)]);
      raw = buf;
      etagSource = `raw:${st.size}:${st.mtimeMs}`;
    } catch {
      raw = null;
    }
  }
  cached = { etag: `"${Buffer.from(etagSource).toString('base64url').slice(0, 27)}"`, variants, raw };
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
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    ETag: data.etag,
    Vary: 'Accept-Encoding',
  });

  // NextResponse wants a Web BodyInit; expose the Node Buffer as a zero-copy
  // Uint8Array view. TS 5.7+ can't prove the backing store isn't a
  // SharedArrayBuffer, so cast — a Uint8Array is a valid runtime body.
  const view = (b: Buffer): BodyInit =>
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength) as unknown as BodyInit;

  if (data.variants.br && accept.includes('br')) {
    headers.set('Content-Encoding', 'br');
    return new NextResponse(view(data.variants.br), { headers });
  }
  if (data.variants.gzip && accept.includes('gzip')) {
    headers.set('Content-Encoding', 'gzip');
    return new NextResponse(view(data.variants.gzip), { headers });
  }
  // No matching precompressed variant. Prefer the raw file (Next gzips it on
  // the wire); otherwise send gzip — every real browser accepts it.
  if (data.raw) return new NextResponse(view(data.raw), { headers });
  headers.set('Content-Encoding', 'gzip');
  return new NextResponse(view(data.variants.gzip), { headers });
}
