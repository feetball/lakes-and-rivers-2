import { NextResponse } from 'next/server';
import type { WebcamsResponse } from '@/lib/types';
import { fetchWebcamsUpstream } from '@/lib/webcams';

export const dynamic = 'force-dynamic';

// Single-entry cache — the whole (small, ~few hundred camera) TX webcam list
// is one response, so a one-key {body, ts} var is enough (mirrors the
// resCache idiom in gauges/history/route.ts, just without a keyed Map since
// there's only ever one cache-worthy request shape here).
const RES_TTL_MS = 5 * 60 * 1000;
let resCache: { body: WebcamsResponse; ts: number } | null = null;

export async function GET() {
  if (resCache && Date.now() - resCache.ts < RES_TTL_MS) {
    return NextResponse.json(resCache.body, {
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
        'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': 'HIT',
      },
    });
  }

  try {
    const webcams = await fetchWebcamsUpstream();
    const body: WebcamsResponse = { webcams, updatedAt: new Date().toISOString() };
    resCache = { body, ts: Date.now() };
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
        'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': 'MISS',
      },
    });
  } catch (e) {
    // Upstream (both modern and legacy NIMS bases) failed — serve the last
    // good response if we have one rather than blanking the layer.
    if (resCache) {
      return NextResponse.json(resCache.body, {
        headers: { 'Cache-Control': 'public, max-age=15', 'X-Cache': 'FALLBACK' },
      });
    }
    return NextResponse.json({ error: 'webcams unavailable', detail: String(e) }, { status: 502 });
  }
}
