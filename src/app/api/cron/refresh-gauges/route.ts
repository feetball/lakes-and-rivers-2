import { NextResponse, after } from 'next/server';
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
export const maxDuration = 90;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  revalidateTag(GAUGES_CACHE_TAG);
  after(
    getCachedGauges()
      .then(data => console.log(`[cron] refreshed ${Object.keys(data.gauges).length} gauges at ${data.updatedAt}`))
      .catch(err => console.warn('[cron] refresh failed:', err)),
  );
  return NextResponse.json({ ok: true, status: 'refresh scheduled' });
}
