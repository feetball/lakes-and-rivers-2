import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, verifySessionToken } from '@/lib/auth';
import { getAnalyticsSummary, analyticsEnabled } from '@/lib/analytics-store';

// Admin-only read of the self-hosted analytics. Gated by the signed admin
// session cookie, same as /api/admin/refresh-gauges. Aggregates Blob-stored
// events into totals + a per-day series (and compacts finished days as a side
// effect — see analytics-store).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET() {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;
  if (!verifySessionToken(token, Date.now())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  if (!analyticsEnabled()) {
    return NextResponse.json({ ok: false, error: 'analytics not configured (no BLOB_READ_WRITE_TOKEN)' }, { status: 503 });
  }

  const today = new Date().toISOString().slice(0, 10);
  try {
    const summary = await getAnalyticsSummary(today);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json({ ok: false, error: 'analytics read failed', detail: String(err) }, { status: 502 });
  }
}
