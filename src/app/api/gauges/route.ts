import { NextResponse, after } from 'next/server';
import type { GaugesResponse } from '@/lib/types';
import { getCachedGauges, fallbackFromMeta } from '@/lib/gauges-fetch';

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

// Budget for getCachedGauges() to return. A WARM read from the shared Data
// Cache (kept hot by /api/cron/refresh-gauges) resolves in well under a
// second, so any healthy request returns the live, cron-refreshed value. The
// fallback path below exists only for the genuinely COLD case — an empty Data
// Cache racing a ~45 s NWPS fetch on a fresh deploy — so we give the read most
// of the function budget before giving up. The previous 4 s budget was too
// tight: it lost the race even on warm-but-not-instant reads (e.g. right after
// the cron's revalidateTag forced a revalidation), so EVERY request fell back
// to the stale build-time snapshot and the UI froze at the build timestamp.
const READ_BUDGET_MS = 50_000;

export async function GET() {
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
