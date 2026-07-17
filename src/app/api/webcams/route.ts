import { NextResponse } from 'next/server';
import type { WebcamsResponse } from '@/lib/types';
import { getWebcamsCached } from '@/lib/webcams';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Thin wrapper — all caching/fallback logic lives in getWebcamsCached() so
// the frames route can share the same cached list (and a camera's real
// smallDir) instead of re-fetching upstream on every frame request.
export async function GET() {
  try {
    const { webcams, fetchedAt, source } = await getWebcamsCached();
    const body: WebcamsResponse = { webcams, updatedAt: new Date(fetchedAt).toISOString() };
    if (source === 'stale') {
      return NextResponse.json(body, {
        headers: { 'Cache-Control': 'public, max-age=15', 'X-Cache': 'FALLBACK' },
      });
    }
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
        'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': source === 'fresh' ? 'MISS' : 'HIT',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: 'webcams unavailable', detail: String(e) }, { status: 502 });
  }
}
