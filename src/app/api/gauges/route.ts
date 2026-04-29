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
export const maxDuration = 90;

const COLD_BUDGET_MS = 4_000;

export async function GET() {
  const cachedPromise = getCachedGauges();
  try {
    const body = await Promise.race<GaugesResponse>([
      cachedPromise,
      new Promise<GaugesResponse>((_, rej) =>
        setTimeout(() => rej(new Error('cold-budget')), COLD_BUDGET_MS),
      ),
    ]);
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, max-age=60' },
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
