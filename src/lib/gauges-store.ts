import { put, get } from '@vercel/blob';
import type { GaugesResponse } from '@/lib/types';

// Where the latest processed gauge snapshot lives in Vercel Blob. An external
// worker (the local docker gauge-refresher) does the slow ~60 s NWPS fetch —
// which can't fit inside a Vercel function — and POSTs the result to
// /api/gauges/ingest, which writes it here. /api/gauges then reads this blob
// for an instant, always-fresh response. The pathname is fixed and overwritten
// each refresh so reads always resolve the current snapshot.
//
// The store is PRIVATE: blobs are not publicly fetchable by URL, so reads go
// through get(..., { access: 'private' }) using the store's
// BLOB_READ_WRITE_TOKEN rather than a plain fetch of a public URL.
const BLOB_PATHNAME = 'gauges/latest.json';

function hasBlobToken(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

// Persist a processed snapshot. Returns the blob's URL. Throws if the Blob
// token isn't configured so the ingest endpoint can surface a clear error.
export async function writeGaugesBlob(data: GaugesResponse): Promise<string> {
  if (!hasBlobToken()) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  const { url } = await put(BLOB_PATHNAME, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    // No CDN cache on the blob itself — we want the freshest snapshot on every
    // read. /api/gauges applies its own short edge cache for fan-out.
    cacheControlMaxAge: 0,
  });
  return url;
}

// Read the latest snapshot, or null if none has been ingested yet (or Blob is
// not configured). Never throws — callers fall back to the build-time meta.
export async function readGaugesBlob(): Promise<GaugesResponse | null> {
  if (!hasBlobToken()) return null;
  try {
    const result = await get(BLOB_PATHNAME, { access: 'private' });
    // null when the blob doesn't exist yet; 304 has no body (we don't send a
    // conditional request, so we only expect 200 here).
    if (!result || result.statusCode !== 200) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as GaugesResponse;
  } catch {
    return null;
  }
}
