import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { recordEvent, analyticsEnabled, type TrackEvent } from '@/lib/analytics-store';

// Public, unauthenticated event sink for self-hosted analytics. The client
// posts small events (pageview, gauge_open) here; we derive a privacy-safe
// visitor hash server-side and append the event to Blob. Best-effort: any
// failure returns 204 so it never disturbs the page.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cap accepted event types so a malicious client can't flood arbitrary keys.
const ALLOWED_TYPES = new Set(['pageview', 'gauge_open']);

// Client IP from the platform-provided headers (Vercel sets x-forwarded-for /
// x-real-ip). Only ever used to derive the daily hash; never stored.
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

// Stable-per-day, non-reversible visitor id. Salting with the UTC day means the
// hash rotates every 24h, so it can count daily uniques but isn't a durable
// cross-day tracker. No IP or UA is ever persisted.
function visitorHash(ip: string, ua: string, day: string): string {
  return createHash('sha256').update(`${ip}|${ua}|${day}`).digest('hex').slice(0, 16);
}

// Reduce a referrer to its hostname; drop same-origin and empty referrers.
function referrerHost(ref: string | null, selfHost: string | null): string | undefined {
  if (!ref) return undefined;
  try {
    const h = new URL(ref).hostname;
    if (!h || h === selfHost) return undefined;
    return h;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request) {
  if (!analyticsEnabled()) return new NextResponse(null, { status: 204 });

  // The client sends the JSON with a text/plain Content-Type (see
  // src/lib/track.ts — it keeps the mobile apps' cross-origin beacon
  // preflight-free); Request.json() parses the body regardless of the type.
  let body: { type?: string; gaugeId?: string; platform?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const type = typeof body.type === 'string' ? body.type : '';
  if (!ALLOWED_TYPES.has(type)) return new NextResponse(null, { status: 204 });
  // Store apps identify themselves so the admin panel can split app users
  // from web visitors. Filed under `referrer` as app:ios / app:android — the
  // Referer header they send is just their local web-view origin, which is
  // meaningless, and this way the existing "Top referrers" table shows the
  // split with no schema change.
  const appPlatform = body.platform === 'ios' || body.platform === 'android' ? body.platform : null;

  const at = new Date().toISOString();
  const day = at.slice(0, 10);
  const ip = clientIp(req);
  const ua = req.headers.get('user-agent') ?? '';
  const selfHost = (() => {
    try {
      return new URL(req.url).hostname;
    } catch {
      return null;
    }
  })();

  const ev: TrackEvent = {
    type,
    at,
    visitor: visitorHash(ip, ua, day),
    referrer: appPlatform ? `app:${appPlatform}` : referrerHost(req.headers.get('referer'), selfHost),
    gaugeId: type === 'gauge_open' && typeof body.gaugeId === 'string' ? body.gaugeId.slice(0, 32) : undefined,
  };

  try {
    await recordEvent(ev, randomUUID());
  } catch {
    // Swallow — analytics must never break the page.
  }
  return new NextResponse(null, { status: 204 });
}
