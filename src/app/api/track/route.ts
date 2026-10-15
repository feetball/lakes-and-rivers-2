import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { recordEvents, analyticsEnabled, getDailySalt, type TrackEvent } from '@/lib/analytics-store';

// Public, unauthenticated event sink for self-hosted analytics. The client
// batches small events (pageview, gauge_open) client-side and posts them here
// as a single array; we derive a privacy-safe visitor hash server-side and
// append the whole batch to Blob as one blob (one `put()` per batch, not per
// event). Best-effort: any failure returns 204 so it never disturbs the page.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cap accepted event types so a malicious client can't flood arbitrary keys.
const ALLOWED_TYPES = new Set(['pageview', 'gauge_open']);
// Cap batch size so a malicious client can't force one oversized blob write.
const MAX_EVENTS_PER_BATCH = 50;

// Client IP from the platform-provided headers (Vercel sets x-forwarded-for /
// x-real-ip). Only ever used to derive the daily hash; never stored.
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

// Stable-per-day visitor id for counting daily uniques. The salt is a random key
// per UTC day (getDailySalt) that is deleted once the day is compacted, so the hash
// rotates daily and cannot be recomputed from an IP afterwards; without it a hash of
// ip+ua+day could be brute-forced over the IPv4 space. No IP or UA is ever persisted.
function visitorHash(ip: string, ua: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${ip}|${ua}`).digest('hex').slice(0, 16);
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
  let body: {
    type?: string;
    gaugeId?: string;
    platform?: string;
    events?: Array<{ type?: string; gaugeId?: string; platform?: string }>;
  } = {};
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const incomingEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : [body];
  if (incomingEvents.length === 0) return new NextResponse(null, { status: 204 });

  // The whole batch shares one request context (one page, sent within a few
  // seconds), so a single timestamp/visitor/referrer for all events in it is
  // an acceptable approximation and keeps the write to one blob.
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
  // No salt (storage unreachable): record the events without a visitor id rather than
  // fall back to a guessable hash.
  const salt = await getDailySalt(day, randomUUID());
  const visitor = salt ? visitorHash(ip, ua, salt) : undefined;
  const referrer = referrerHost(req.headers.get('referer'), selfHost);

  const events: TrackEvent[] = [];
  for (const raw of incomingEvents) {
    const type = typeof raw?.type === 'string' ? raw.type : '';
    if (!ALLOWED_TYPES.has(type)) continue;
    // Store apps identify themselves so the admin panel can split app users
    // from web visitors. Filed under `referrer` as app:ios / app:android.
    const platform = raw.platform === 'ios' || raw.platform === 'android'
      ? raw.platform
      : body.platform === 'ios' || body.platform === 'android' ? body.platform : null;
    events.push({
      type,
      at,
      visitor,
      referrer: platform ? `app:${platform}` : referrer,
      gaugeId: type === 'gauge_open' && typeof raw?.gaugeId === 'string' ? raw.gaugeId.slice(0, 32) : undefined,
    });
  }
  if (events.length === 0) return new NextResponse(null, { status: 204 });

  try {
    await recordEvents(events, randomUUID());
  } catch {
    // Swallow — analytics must never break the page.
  }
  return new NextResponse(null, { status: 204 });
}
