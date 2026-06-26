import { NextResponse, after } from 'next/server';
import type { GaugesResponse } from '@/lib/types';
import { getCachedGauges, fallbackFromMeta } from '@/lib/gauges-fetch';
import { readGaugesBlob } from '@/lib/gauges-store';

// The NWPS list response is ~13 MB and the upstream fetch can take up to 60 s.
// We rely on getCachedGauges (Next.js data cache, shared across instances on
// Vercel) for fast reads. The cron at /api/cron/refresh-gauges keeps the
// cache warm. On the very first request after a fresh deploy — when the data
// cache is empty — we race the fetch against a short budget and fall back to
// the static gauge list if it doesn't return in time.
export const dynamic = 'force-dynamic';
// 60s is Vercel Hobby's cap; the upstream fetch is bounded below that
// (NWPS_TIMEOUT_MS, default 45s) so the post-response after() warm fits.
export const maxDuration = 60;

// Budget for getCachedGauges() to return on the user-facing fast path. A WARM
// read from the shared Data Cache (kept hot by /api/cron/refresh-gauges)
// resolves in well under a second, so any healthy request returns the live,
// cron-refreshed value almost immediately. We deliberately keep this SHORT:
// the NWPS upstream list is ~13 MB and routinely takes ~59 s or 504s at
// Vercel's 60 s function cap, so a cold read can't realistically win the race.
// Rather than make the user wait ~50 s only to fall back anyway, we give up
// after a few seconds, serve the build-time snapshot instantly, and let the
// fetch finish in the background (after()) to populate the cache for the next
// request — which the client re-polls for every 15 s while data is cold.
const READ_BUDGET_MS = Number(process.env.GAUGES_READ_BUDGET_MS) || 6_000;

export async function GET() {
  // Fast path: the snapshot written by the external refresher (docker
  // gauge-refresher → /api/gauges/ingest → Vercel Blob). This is the only path
  // that reliably carries LIVE data, because the slow NWPS fetch happens in the
  // container where there's no 60 s function cap. Read it first; a populated
  // blob means real, recent observations with no upstream round-trip here.
  const blob = await readGaugesBlob();
  if (blob && Object.keys(blob.gauges).length > 0) {
    return NextResponse.json(blob, {
      headers: {
        'Cache-Control': 'public, max-age=60',
        'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
        'X-Cache': 'BLOB',
      },
    });
  }

  const cachedPromise = getCachedGauges();
  try {
    const body = await Promise.race<GaugesResponse>([
      cachedPromise,
      new Promise<GaugesResponse>((_, rej) =>
        setTimeout(() => rej(new Error('read-budget')), READ_BUDGET_MS),
      ),
    ]);
    // Success path: let Vercel's edge cache hold the fresh response briefly so
    // many clients polling /api/gauges collapse into ~one origin hit per
    // minute. Only on the success path — see the fallback below.
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, max-age=60',
        'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch {
    // Cache empty + slow upstream — keep the fetch alive past response so the
    // data cache is populated for the next user, and serve fallback now.
    after(cachedPromise.catch(() => {}));
    try {
      const fb = await fallbackFromMeta();
      return NextResponse.json(fb, {
        headers: { 'Cache-Control': 'public, max-age=15', 'X-Cache': 'FALLBACK' },
      });
    } catch (e) {
      return NextResponse.json(
        { error: 'Failed to fetch gauge data', detail: String(e) },
        { status: 502 },
      );
    }
  }
}
