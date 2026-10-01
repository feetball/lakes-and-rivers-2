import { put, get } from '@vercel/blob';
import type { GaugesResponse } from '@/lib/types';
import { getDataBucket } from '@/lib/r2-data';

// Where the latest processed gauge snapshot lives. An external worker (the
// local docker gauge-refresher) does the slow ~60 s NWPS fetch — which can't
// fit inside a serverless function budget — and POSTs the result to
// /api/gauges/ingest, which writes it here. /api/gauges then reads this
// snapshot for an instant, always-fresh response. The key is fixed and
// overwritten each refresh so reads always resolve the current snapshot.
//
// Storage backend, in order of preference:
//  1. Cloudflare R2 via the DATA_BUCKET binding (wrangler.jsonc) — used on
//     the Workers deploy; no tokens or third-party services involved.
//  2. Vercel Blob when BLOB_READ_WRITE_TOKEN is set — the Vercel/Docker path.
//     The store is PRIVATE: blobs are not publicly fetchable by URL, so reads
//     go through get(..., { access: 'private' }).
//  3. Neither configured: reads return null (callers fall back to build-time
//     meta) and writes throw so the ingest endpoint surfaces a clear error.
const SNAPSHOT_KEY = 'gauges/latest.json';

function hasBlobToken(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

// Persist a processed snapshot. Returns the stored key/URL. Throws if no
// backend is configured so the ingest endpoint can surface a clear error.
export async function writeGaugesBlob(data: GaugesResponse): Promise<string> {
  const bucket = await getDataBucket();
  if (bucket) {
    await bucket.put(SNAPSHOT_KEY, JSON.stringify(data));
    return SNAPSHOT_KEY;
  }
  if (!hasBlobToken()) {
    throw new Error(
      'no snapshot store configured: need the DATA_BUCKET R2 binding (Cloudflare) or BLOB_READ_WRITE_TOKEN (Vercel Blob)',
    );
  }
  const { url } = await put(SNAPSHOT_KEY, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    // No CDN cache on the blob itself — we want the freshest snapshot on every
    // read. /api/gauges applies its own short edge cache for fan-out.
    cacheControlMaxAge: 0,
  });
  return url;
}

// Read the latest snapshot, or null if none has been ingested yet (or no
// backend is configured). Never throws — callers fall back to the build-time
// meta.
export async function readGaugesBlob(): Promise<GaugesResponse | null> {
  try {
    const bucket = await getDataBucket();
    if (bucket) {
      const obj = await bucket.get(SNAPSHOT_KEY);
      if (!obj) return null; // nothing ingested yet
      return JSON.parse(await obj.text()) as GaugesResponse;
    }
  } catch {
    return null;
  }
  if (!hasBlobToken()) return null;
  try {
    const result = await get(SNAPSHOT_KEY, { access: 'private' });
    // null when the blob doesn't exist yet; 304 has no body (we don't send a
    // conditional request, so we only expect 200 here).
    if (!result || result.statusCode !== 200) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as GaugesResponse;
  } catch {
    return null;
  }
}
