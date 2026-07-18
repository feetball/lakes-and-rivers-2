import { NextResponse, after } from 'next/server';
import type { GaugesResponse } from '@/lib/types';
import { getCachedGauges, fallbackFromMeta } from '@/lib/gauges-fetch';
import { readGaugesBlob } from '@/lib/gauges-store';

// The NWPS list response is ~13 MB and the upstream fetch can take up to 60 s.
// We rely on getCachedGauges (Next.js data cache, shared across instances on
// Vercel) for fast reads. The cron at /api/cron/refresh-gauges keeps the
// cache warm. On the very first request after a fresh deploy — when the data
// cache is empty — we race the fetch against a short budget and fall back to
// the static gauge list if it doesn't return in time.
export const dynamic = 'force-dynamic';
// 60s is Vercel Hobby's cap; the upstream fetch is bounded below that
// (NWPS_TIMEOUT_MS, default 45s) so the post-response after() warm fits.
export const maxDuration = 60;

// Budget for getCachedGauges() to return on the user-facing fast path. A WARM
// read from the shared Data Cache (kept hot by /api/cron/refresh-gauges)
// resolves in well under a second, so any healthy request returns the live,
// cron-refreshed value almost immediately. We deliberately keep this SHORT:
// the NWPS upstream list is ~13 MB and routinely takes ~59 s or 504s at
// Vercel's 60 s function cap, so a cold read can't realistically win the race.
// Rather than make the user wait ~50 s only to fall back anyway, we give up
// after a few seconds, serve the build-time snapshot instantly, and let the
// fetch finish in the background (after()) to populate the cache for the next
// request — which the client re-polls for every 15 s while data is cold.
const READ_BUDGET_MS = Number(process.env.GAUGES_READ_BUDGET_MS) || 6_000;

// How old a blob snapshot may be before we stop treating it as authoritative.
// The refresher writes every 30 min, so 90 min means it has missed 3 cycles —
// at that point the snapshot's flood categories can be dangerously wrong (a
// lake can rise through Action stage in hours), so we go back to trying the
// live upstream instead of short-circuiting on the blob forever.
const BLOB_FRESH_MS = Number(process.env.GAUGES_BLOB_FRESH_MS) || 90 * 60_000;

function snapshotMs(r: GaugesResponse | null): number {
  const t = r ? new Date(r.updatedAt).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

export async function GET() {
  // Fast path: the snapshot written by the external refresher (docker
  // gauge-refresher → /api/gauges/ingest → Vercel Blob). This is the only path
  // that reliably carries LIVE data, because the slow NWPS fetch happens in the
  // container where there's no 60 s function cap. Read it first; a populated
  // blob means real, recent observations with no upstream round-trip here.
  //
  // But only short-circuit on it while it's FRESH. If the refresher dies, the
  // blob otherwise wins every request forever and the map serves day-old
  // observations as confident flood statuses (e.g. a lake shown "Normal"/blue
  // while it has since risen past Action stage). A stale blob is kept only as
  // a fallback below — still better than the build-time meta snapshot.
  const blob = await readGaugesBlob();
  const blobUsable = !!blob && Object.keys(blob.gauges).length > 0;
  const blobAge = blobUsable ? Date.now() - snapshotMs(blob) : Infinity;
  if (blobUsable && blobAge < BLOB_FRESH_MS) {
    return NextResponse.json(blob, {
      headers: {
        'Cache-Control': 'public, max-age=60',
        'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
        'X-Cache': 'BLOB',
      },
    });
  }

  const cachedPromise = getCachedGauges();
  try {
    const live = await Promise.race<GaugesResponse>([
      cachedPromise,
      new Promise<GaugesResponse>((_, rej) =>
        setTimeout(() => rej(new Error('read-budget')), READ_BUDGET_MS),
      ),
    ]);
    // The data cache serves stale entries while revalidating in the
    // background, so a stale blob can still be newer than a "successful" cache
    // read — serve whichever snapshot is most recent.
    const body = blobUsable && snapshotMs(blob) > snapshotMs(live) ? blob! : live;
    // Success path: let Vercel's edge cache hold the fresh response briefly so
    // many clients polling /api/gauges collapse into ~one origin hit per
    // minute. Only on the success path — see the fallback below.
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, max-age=60',
        'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch {
    // Cache empty + slow upstream — keep the fetch alive past response so the
    // data cache is populated for the next user, and serve fallback now.
    after(cachedPromise.catch(() => {}));
    // A stale blob still beats the build-time meta snapshot: it's newer and
    // carries real observations. Short max-age so recovery is picked up fast.
    if (blobUsable) {
      return NextResponse.json(blob, {
        headers: { 'Cache-Control': 'public, max-age=15', 'X-Cache': 'BLOB-STALE' },
      });
    }
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
