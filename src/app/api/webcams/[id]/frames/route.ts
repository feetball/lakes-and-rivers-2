import { NextResponse } from 'next/server';
import type { WebcamFramesResponse } from '@/lib/types';
import { fetchWebcamFrames } from '@/lib/webcams';

export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RES_TTL_MS = 60 * 1000;
// Keyed by `${camId}:${limit}` — same camId requested with a different limit
// shouldn't be served a cached body with fewer frames than asked for.
const resCache = new Map<string, { body: WebcamFramesResponse; ts: number }>();

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(12, Math.max(1, Math.trunc(n)));
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

  try {
    const frames = await fetchWebcamFrames(id, limit);
    const body: WebcamFramesResponse = { frames };
    resCache.set(key, { body, ts: Date.now() });
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
