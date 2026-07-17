import { NextResponse } from 'next/server';
import type { WebcamFramesResponse } from '@/lib/types';
import { fetchWebcamFrames, getWebcamsCached } from '@/lib/webcams';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RES_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
// Keyed by `${camId}:${limit}` — same camId requested with a different limit
// shouldn't be served a cached body with fewer frames than asked for.
const resCache = new Map<string, { body: WebcamFramesResponse; ts: number }>();

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(12, Math.max(1, Math.trunc(n)));
}

// Keep the keyspace bounded — camId is attacker-controlled (any string
// matching ID_RE), so without this a flood of distinct ids would grow the
// Map forever. Drop anything already expired, then evict the oldest entry
// if we're still at capacity.
function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of resCache) {
    if (now - entry.ts >= RES_TTL_MS) resCache.delete(key);
  }
  if (resCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = resCache.keys().next().value;
    if (oldestKey !== undefined) resCache.delete(oldestKey);
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !ID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid camera id' }, { status: 400 });
  }

  const url = new URL(req.url);
  const limit = clampLimit(url.searchParams.get('limit'));
  const key = `${id}:${limit}`;

  const cached = resCache.get(key);
  if (cached && Date.now() - cached.ts < RES_TTL_MS) {
    return NextResponse.json(cached.body, {
      headers: { 'Cache-Control': 'public, max-age=60', 'X-Cache': 'HIT' },
    });
  }

  // Confirm the id against the (shared, cached) camera list so we can (a)
  // reject unknown ids and (b) use the camera's real, already-validated
  // smallDir instead of always guessing the default S3 directory.
  let smallDir: string | undefined;
  let knownCamera = false;
  try {
    const { webcams } = await getWebcamsCached();
    const cam = webcams.find(w => w.id === id);
    if (!cam) {
      return NextResponse.json({ error: 'unknown camera' }, { status: 404 });
    }
    smallDir = cam.smallDir;
    knownCamera = true;
  } catch {
    // Camera list upstream is down too — fall back to the default-dir guess
    // below, but don't cache a response for an id we couldn't confirm.
  }

  try {
    const frames = await fetchWebcamFrames(id, limit, smallDir);
    const body: WebcamFramesResponse = { frames };
    if (knownCamera) {
      pruneCache();
      resCache.set(key, { body, ts: Date.now() });
    }
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, max-age=60', 'X-Cache': 'MISS' },
    });
  } catch {
    // Degrade quietly — the viewer sheet just shows no frames rather than an
    // error banner, since this backs a popup refresh, not the primary layer.
    return NextResponse.json(
      { frames: [] },
      { headers: { 'Cache-Control': 'public, max-age=15', 'X-Cache': 'FALLBACK' } },
    );
  }
}
