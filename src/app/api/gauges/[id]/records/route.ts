import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

export const dynamic = 'force-dynamic';

// USGS Peak Streamflow service — decades-old, RDB-only (no JSON option), and
// never migrated to the waterservices.usgs.gov REST API like IV/DV data —
// it's still served from the legacy NWISWeb CGI host. Confirmed against
// USGS's own dataretrieval-python client (dataretrieval/nwis.py + rdb.py),
// which hits this same host/path.
// Returns each water year's peak discharge/stage on record for a site.
const USGS_PEAK = (siteNo: string) =>
  `https://nwis.waterdata.usgs.gov/nwis/peaks?site_no=${siteNo}&agency_cd=USGS&format=rdb`;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RECORDS = 8;
// Peak-flow records only update ~once per year after each water year closes
// (USGS finalizes the prior year's peaks in the following spring), so a long
// cache is safe and avoids hammering USGS for data that rarely changes.
const RES_TTL_MS = 24 * 3_600_000;

// Minimal meta shape — we only need the NWPS lid -> USGS site number mapping.
type MetaEntry = { id: string; usgsId: string | null };

let metaCache: Map<string, MetaEntry> | null = null;
async function loadMeta(): Promise<Map<string, MetaEntry>> {
  if (metaCache && metaCache.size > 0) return metaCache;
  try {
    const raw = await readFile(resolve(process.cwd(), 'public/data/gauges-meta.json'), 'utf8');
    const parsed = JSON.parse(raw) as { gauges: MetaEntry[] };
    metaCache = new Map(parsed.gauges.map(g => [g.id, { id: g.id, usgsId: g.usgsId }]));
  } catch (err) {
    // Same silent-failure mode as the history/forecast routes: no meta means
    // no usgsId means no records for anyone. Log loudly, don't cache the
    // empty result so a transient read error can recover.
    console.error('[gauges/records] failed to load gauges-meta.json — usgsId lookup unavailable:', err);
    return new Map();
  }
  return metaCache;
}

export interface FloodRecord {
  date: string;
  stage: number;
  isRecord: boolean;
}

export interface GaugeRecordsResponse {
  siteNo: string | null;
  records: FloodRecord[];
  updatedAt: string;
}

const resCache = new Map<string, { body: GaugeRecordsResponse; ts: number }>();

// A raw RDB "format" row looks like `5s\t15s\t8n\t...` — one token per
// column describing its width/type, not data. Detect it so we don't parse it
// as a real record.
const FORMAT_CELL = /^\d+[A-Za-z]$/;
function isFormatRow(cells: string[]): boolean {
  return cells.every(c => c === '' || FORMAT_CELL.test(c));
}

// Parse a USGS peak-flow RDB body into flood records, sorted descending by
// stage (highest crest first), deduped by date, capped at MAX_RECORDS.
function parsePeakRdb(text: string): FloodRecord[] {
  const lines = text.split('\n').filter(l => !l.startsWith('#') && l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split('\t').map(c => c.trim());
  const dtIdx = header.indexOf('peak_dt');
  const gageHtIdx = header.indexOf('gage_ht');
  if (dtIdx === -1 || gageHtIdx === -1) return [];

  // Row 1 after the header is the format row, not data — skip it.
  let dataStart = 1;
  const maybeFormat = lines[1].split('\t').map(c => c.trim());
  if (isFormatRow(maybeFormat)) dataStart = 2;

  const byDate = new Map<string, FloodRecord>();
  for (let i = dataStart; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const peakDt = cells[dtIdx]?.trim();
    const gageHtRaw = cells[gageHtIdx]?.trim();
    // gage_ht is frequently blank — many peaks recorded discharge only, with
    // no corresponding stage reading. Skip those; we only care about stage.
    if (!peakDt || !gageHtRaw) continue;
    const stage = Number(gageHtRaw);
    if (!Number.isFinite(stage)) continue;

    // peak_dt can be a partial date (e.g. "1998" or "1998-06") for old or
    // imprecise records — pass it through as-is rather than guessing a day.
    const existing = byDate.get(peakDt);
    if (!existing || stage > existing.stage) {
      byDate.set(peakDt, { date: peakDt, stage, isRecord: false });
    }
  }

  const records = Array.from(byDate.values()).sort((a, b) => b.stage - a.stage).slice(0, MAX_RECORDS);
  if (records.length > 0) records[0].isRecord = true;
  return records;
}

async function fetchPeakRecords(siteNo: string): Promise<FloodRecord[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USGS_PEAK(siteNo), {
      signal: ctl.signal,
      headers: { 'User-Agent': 'texas-flood-map/0.1' },
    });
    if (!res.ok) return []; // includes 404 — site has no peak-flow record on file
    const text = await res.text();
    if (!text.trim()) return [];
    return parsePeakRdb(text);
  } catch {
    return []; // timeout / network error — treat as no records for this request
  } finally {
    clearTimeout(t);
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'missing gauge id' }, { status: 400 });
  }

  const meta = await loadMeta();
  const entry = meta.get(id);
  const usgsId = entry?.usgsId;
  if (!usgsId) {
    // No USGS site mapped for this gauge — degrade gracefully rather than
    // error, matching how the history route treats gauges without a usgsId.
    const body: GaugeRecordsResponse = { siteNo: null, records: [], updatedAt: new Date().toISOString() };
    return NextResponse.json(body, { headers: { 'X-Cache': 'MISS' } });
  }

  const cached = resCache.get(usgsId);
  if (cached && Date.now() - cached.ts < RES_TTL_MS) {
    return NextResponse.json(cached.body, { headers: { 'X-Cache': 'HIT' } });
  }

  const records = await fetchPeakRecords(usgsId);
  const body: GaugeRecordsResponse = { siteNo: usgsId, records, updatedAt: new Date().toISOString() };
  resCache.set(usgsId, { body, ts: Date.now() });
  return NextResponse.json(body, {
    // Records almost never change (only ~once/year), so a longer edge cache
    // than the 60s used by history/forecast is appropriate here.
    headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400', 'X-Cache': 'MISS' },
  });
}
