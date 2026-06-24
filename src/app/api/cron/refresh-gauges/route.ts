import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { GAUGES_CACHE_TAG, getCachedGauges } from '@/lib/gauges-fetch';

// Hit by an external scheduler (a docker sidecar — see docker-compose.yml)
// every 30 min. Invalidates the shared gauge cache and kicks off a background
// fetch via after(). Returns immediately so the caller doesn't time out: the
// NWPS upstream sometimes takes 60–120 s, which exceeds Vercel's function
// budget, but the response lands in <1 s. The actual repopulation runs on the
// post-response budget; if it fails, /api/gauges still serves the prior
// cached value, and the next cron tick (or any user request after the cache
// expires at 30 min) will retry.
//
// Auth: we require Authorization: Bearer ${CRON_SECRET}. Vercel Cron attaches
// this automatically when CRON_SECRET is set on the project; the docker
// sidecar passes the same value.
export const dynamic = 'force-dynamic';
// 60s is Vercel Hobby's cap; the awaited refresh below is bounded by
// NWPS_TIMEOUT_MS (default 45s) so it completes within budget.
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  // Invalidate the shared cache tag, then AWAIT the refetch within the function
  // budget. The previous after()-based approach deferred the fetch past the
  // response, where Vercel can freeze/kill the instance before it finishes —
  // leaving the cache stale and giving the caller a misleading "ok". Awaiting
  // guarantees the shared Data Cache is repopulated when we 200, and gives the
  // external pinger (docker sidecar / Vercel Cron) a real success/fail signal.
  revalidateTag(GAUGES_CACHE_TAG);
  try {
    const data = await getCachedGauges();
    console.log(`[cron] refreshed ${Object.keys(data.gauges).length} gauges at ${data.updatedAt}`);
    return NextResponse.json({ ok: true, status: 'refreshed', count: Object.keys(data.gauges).length });
  } catch (err) {
    console.warn('[cron] refresh failed:', err);
    return NextResponse.json({ ok: false, status: 'refresh failed', detail: String(err) }, { status: 502 });
  }
}
