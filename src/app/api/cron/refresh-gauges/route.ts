import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { GAUGES_CACHE_TAG, getCachedGauges } from '@/lib/gauges-fetch';

// Hit by Vercel Cron (configured in vercel.json) every 30 min. Invalidates
// the shared gauge cache and immediately re-populates it so the next user
// request lands on a warm cache. Vercel automatically attaches an
// `Authorization: Bearer ${CRON_SECRET}` header when CRON_SECRET is set
// in the project's env vars; we reject anything else to prevent abuse.
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
  try {
    const data = await getCachedGauges();
    return NextResponse.json({
      ok: true,
      gauges: Object.keys(data.gauges).length,
      updatedAt: data.updatedAt,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
