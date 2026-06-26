import { put, head } from '@vercel/blob';
import type { GaugesResponse } from '@/lib/types';

// Where the latest processed gauge snapshot lives in Vercel Blob. An external
// worker (the local docker gauge-refresher) does the slow ~60 s NWPS fetch —
// which can't fit inside a Vercel function — and POSTs the result to
// /api/gauges/ingest, which writes it here. /api/gauges then reads this blob
// for an instant, always-fresh response. The pathname is fixed and overwritten
// each refresh so the read URL is stable.
const BLOB_PATHNAME = 'gauges/latest.json';

function hasBlobToken(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

// Persist a processed snapshot. Returns the blob's public URL. Throws if the
// Blob token isn't configured so the ingest endpoint can surface a clear error.
export async function writeGaugesBlob(data: GaugesResponse): Promise<string> {
  if (!hasBlobToken()) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  const { url } = await put(BLOB_PATHNAME, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    // No CDN cache: we want the freshest snapshot on every read. /api/gauges
    // applies its own short edge cache for fan-out.
    cacheControlMaxAge: 0,
  });
  return url;
}

// Read the latest snapshot, or null if none has been ingested yet (or Blob is
// not configured). Never throws — callers fall back to the build-time meta.
export async function readGaugesBlob(): Promise<GaugesResponse | null> {
  if (!hasBlobToken()) return null;
  try {
    // head() resolves the current blob URL (it changes only if the store is
    // re-provisioned); fetch with no-store to bypass any intermediary cache.
    const meta = await head(BLOB_PATHNAME).catch(() => null);
    if (!meta?.url) return null;
    const res = await fetch(meta.url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as GaugesResponse;
  } catch {
    return null;
  }
}
