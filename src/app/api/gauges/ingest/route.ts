import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import type { GaugesResponse } from '@/lib/types';
import { processNwpsList, GAUGES_CACHE_TAG } from '@/lib/gauges-fetch';
import { writeGaugesBlob } from '@/lib/gauges-store';

// Receives a gauge snapshot from an external worker (the local docker
// gauge-refresher) and stores it in Vercel Blob for /api/gauges to serve.
//
// Why this exists: NWPS's ~13 MB TX list takes ~59 s and routinely 504s at
// Vercel's 60 s function cap, so the in-function refresh
// (/api/cron/refresh-gauges) can never win the race and the live cache stays
// cold forever. Moving the slow FETCH into a container with no time limit
// fixes that — the container does the fetch, then POSTs the result here. The
// only work this endpoint does is parse + store, which is fast.
//
// Auth: requires Authorization: Bearer ${CRON_SECRET} (same secret the cron
// refresher already uses). Refuses if CRON_SECRET is unset so an open ingest
// endpoint can't be used to poison the map.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Body may be either the raw NWPS list (an array, or { gauges: [...] }) — the
// natural thing for the container to forward — or an already-processed
// GaugesResponse ({ gauges: { lid: {...} }, updatedAt }).
function isProcessed(body: any): body is GaugesResponse {
  return body && typeof body === 'object' && body.gauges && !Array.isArray(body.gauges)
    && typeof body.updatedAt === 'string';
}

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'CRON_SECRET not configured; ingest disabled' },
      { status: 503 },
    );
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  let snapshot: GaugesResponse;
  try {
    if (isProcessed(body)) {
      snapshot = body;
    } else {
      const list: any[] = Array.isArray(body) ? body : body?.gauges ?? [];
      if (!Array.isArray(list) || list.length === 0) {
        return NextResponse.json(
          { ok: false, error: 'expected NWPS list array or processed GaugesResponse' },
          { status: 400 },
        );
      }
      snapshot = await processNwpsList(list);
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `processing failed: ${e}` }, { status: 500 });
  }

  const count = Object.keys(snapshot.gauges).length;
  if (count === 0) {
    // Don't overwrite a good snapshot with an empty one (e.g. the worker got a
    // non-TX or malformed list). Reject so the refresher logs a failure.
    return NextResponse.json({ ok: false, error: 'snapshot has 0 gauges; refusing to store' }, { status: 422 });
  }

  try {
    await writeGaugesBlob(snapshot);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `blob write failed: ${e}` }, { status: 500 });
  }

  // Invalidate the in-function cache so any code path still reading it picks up
  // fresh data on next miss.
  revalidateTag(GAUGES_CACHE_TAG);
  return NextResponse.json({ ok: true, stored: count, updatedAt: snapshot.updatedAt });
}
