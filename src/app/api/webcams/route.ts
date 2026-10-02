import { NextResponse } from 'next/server';
import { readPublicDataText } from '@/lib/data-assets';
import { createWebcamSource, linkGauges, type GaugeSite, type WebcamsResponse } from '@/lib/webcams';

export const dynamic = 'force-dynamic';

// One source per Worker isolate: it keeps the parsed Texas list for 10 minutes, so a
// burst of phones costs one read of USGS's 230 KB national list, not one each.
const source = createWebcamSource();

// Which gauge each camera belongs to comes from the build-time gauge list (a camera and
// a gauge with the same USGS site number are the same place). It never changes between
// deploys, so it is read once per isolate; a failed read is retried on the next request.
let sites: GaugeSite[] | null = null;
async function gaugeSites(): Promise<GaugeSite[]> {
  if (sites) return sites;
  const text = await readPublicDataText('gauges-meta.json');
  if (!text) return [];
  const meta = JSON.parse(text) as { gauges?: Array<Partial<GaugeSite> & { id: string }> };
  const list: GaugeSite[] = [];
  for (const g of meta.gauges ?? []) {
    if (typeof g.id === 'string' && typeof g.lat === 'number' && typeof g.lon === 'number') {
      list.push({ id: g.id, lat: g.lat, lon: g.lon, usgsId: typeof g.usgsId === 'string' ? g.usgsId : null });
    }
  }
  if (list.length > 0) sites = list;
  return list;
}

export async function GET() {
  try {
    const { webcams, fetchedAt, source: from } = await source.load();
    const linked = linkGauges(webcams, await gaugeSites().catch(() => []));
    const body: WebcamsResponse = { webcams: linked, updatedAt: new Date(fetchedAt).toISOString() };
    // A list served because USGS is not answering is cached only briefly, so the app
    // goes back to asking as soon as USGS recovers; updatedAt tells the app how old it is.
    const cache =
      from === 'stale'
        ? 'public, max-age=60'
        : 'public, max-age=300, stale-while-revalidate=600';
    return NextResponse.json(body, { headers: { 'Cache-Control': cache, 'X-Webcams-Source': from } });
  } catch {
    // Not cached: the app shows "cameras unavailable", never an empty list.
    return NextResponse.json({ error: 'cameras unavailable' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
