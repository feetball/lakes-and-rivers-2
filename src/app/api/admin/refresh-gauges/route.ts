import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { revalidateTag } from 'next/cache';
import { ADMIN_COOKIE, verifySessionToken } from '@/lib/auth';
import { GAUGES_CACHE_TAG, getCachedGauges } from '@/lib/gauges-fetch';

// Admin-only force refresh. Same effect as the cron at
// /api/cron/refresh-gauges — invalidate the shared gauge cache tag and AWAIT a
// fresh upstream pull so the Data Cache is repopulated before we respond — but
// gated by the signed admin session cookie rather than CRON_SECRET. Lets an
// operator pull genuinely fresh NWPS data on demand instead of waiting for the
// next cron tick or the 30-min self-revalidate.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 60s is Vercel Hobby's cap; the awaited refresh is bounded by NWPS_TIMEOUT_MS
// (default 45s) so it completes within budget.
export const maxDuration = 60;

export async function POST() {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;
  if (!verifySessionToken(token, Date.now())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  revalidateTag(GAUGES_CACHE_TAG);
  try {
    const data = await getCachedGauges();
    console.log(`[admin] force-refreshed ${Object.keys(data.gauges).length} gauges at ${data.updatedAt}`);
    return NextResponse.json({
      ok: true,
      count: Object.keys(data.gauges).length,
      updatedAt: data.updatedAt,
    });
  } catch (err) {
    console.warn('[admin] force refresh failed:', err);
    return NextResponse.json({ ok: false, error: 'refresh failed', detail: String(err) }, { status: 502 });
  }
}
