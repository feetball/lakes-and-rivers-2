import { NextResponse, after } from 'next/server';
import { getAlertsResponse } from '@/lib/alerts-fetch';
import { getAlertsStore } from '@/lib/alerts-store';
import type { AlertsResponse } from '@/lib/types';

// NWS flood warnings, watches and advisories for Texas, normalised and with an
// outline for every alert that has a shape (src/lib/alerts-fetch.ts). Phones poll
// this every two minutes; the edge cache and the 45 s server-side reuse keep the
// load on api.weather.gov to about one read a minute. CORS for the apps is added
// to every /api route in next.config.mjs.
export const dynamic = 'force-dynamic';

// Never throws and never answers with an HTML error page: whatever goes wrong the
// client gets an AlertsResponse with ok:false and a reason, so it can say so.
export async function GET() {
  try {
    const { status, body } = await getAlertsResponse({
      store: await getAlertsStore(),
      // Zone shapes still downloading when the budget runs out finish after the
      // response, so the next poll has them.
      waitUntil: p => {
        try {
          after(p);
        } catch {
          // outside a request scope: the zone fetches just are not awaited
        }
      },
    });
    return NextResponse.json(body, {
      status,
      headers: {
        'Cache-Control': body.ok
          ? 'public, max-age=60, stale-while-revalidate=120'
          : // A failure is retried soon, not held for a minute.
            'public, max-age=10',
      },
    });
  } catch (e) {
    console.error('[alerts] route failed', e);
    const body: AlertsResponse = {
      alerts: [],
      updatedAt: null,
      ok: false,
      source: 'api.weather.gov',
      error: 'alerts service error',
    };
    return NextResponse.json(body, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
