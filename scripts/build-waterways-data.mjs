#!/usr/bin/env node
// Builds public/data/waterways.geojson and public/data/gauges-meta.json.
// - Fetches all TX gauges from the NWPS API (api.water.noaa.gov).
// - For each gauge with flood thresholds, queries USGS NHDPlus HR for nearby
//   named flowlines (rivers/creeks) and waterbodies (lakes/reservoirs).
// - Tags every geometry with the nearest gauge id so the client can color
//   segments by that gauge's live flood category.
//
// Runs with `pnpm data:build`. The `--if-missing` flag makes prebuild a no-op
// when the data files already exist (skip long fetch on repeated builds).

import { writeFile, mkdir, access, rename, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackCache } from './unpack-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/data');
const WATERWAYS_OUT = resolve(OUT_DIR, 'waterways.geojson');
const GAUGES_OUT = resolve(OUT_DIR, 'gauges-meta.json');
const GAUGES_LIST_SEED = resolve(OUT_DIR, 'gauges-list.json');
// Per-gauge cache of the simplified NHD features + NWPS detail. Lives
// outside public/ so it isn't shipped to clients. Survives across builds —
// commit the directory if you want Docker image builds to skip the
// network round-trip too.
const CACHE_DIR = resolve(ROOT, 'data-cache/gauges');
// Bump when simplifyFeature / per-gauge schema changes, so old caches are
// ignored automatically without a manual purge.
const CACHE_VERSION = 3;
// Cache entries older than this are refetched. Override with CACHE_TTL_DAYS=N.
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_DAYS) || 30) * 24 * 3_600_000;

const ARGS = new Set(process.argv.slice(2));
const IF_MISSING = ARGS.has('--if-missing');
// `--refresh` (or REFRESH=1) ignores existing cache entries and refetches
// every gauge. Useful after upstream NHD/NWPS data updates.
const REFRESH = ARGS.has('--refresh') || process.env.REFRESH === '1';

// Each gauge claims only the river/lake it physically sits on. Two stages:
//   1. Identify the host: nearest flowline (HOST_PROBE_RADIUS_M) and any
//      lake the gauge sits in (HOST_WATERBODY_RADIUS_M).
//   2. If the host flowline has a GNIS name, fetch every reach with the
//      same name out to HOST_RIVER_RADIUS_M. Adjacent gauges on the same
//      river both pull overlapping coverage; the nearest-wins dedup
//      assigns each segment to exactly one gauge, so the boundary lands
//      roughly halfway between gauges.
const HOST_PROBE_RADIUS_M = 500;
const HOST_PROBE_MAX = 5;
const HOST_WATERBODY_RADIUS_M = 250;
const HOST_RIVER_RADIUS_M = 40000;
const HOST_RIVER_MAX = 400;
// Cap number of gauges processed (useful for smoke tests).
const LIMIT = Number(process.env.GAUGE_LIMIT ?? 0) || Infinity;
// Parallel fetches to NHD. Higher = faster build; if NHD starts returning
// 429/503 the per-request retry will handle it. Override with NHD_CONCURRENCY=N.
const NHD_CONCURRENCY = Number(process.env.NHD_CONCURRENCY) || 24;

const NWPS_GAUGES_URL = 'https://api.water.noaa.gov/nwps/v1/gauges?state=TX';
const NWPS_GAUGE_DETAIL = (lid) => `https://api.water.noaa.gov/nwps/v1/gauges/${lid}`;
const NHD_BASE = 'https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer';
const FLOWLINE_LAYER = 3; // NetworkNHDFlowline
const WATERBODY_LAYER = 9; // NHDWaterbody

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function fetchJson(url, { retries = 5, timeoutMs = 120_000 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'texas-flood-map/0.1' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      // Exponential-ish backoff: 2 s, 5 s, 10 s, 20 s, 40 s.
      const waitMs = [2_000, 5_000, 10_000, 20_000, 40_000][i] ?? 60_000;
      await new Promise(r => setTimeout(r, waitMs));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// Like fetchJson but streams the response and prints progress so the caller
// can see the request isn't hung. NWPS list spends ~60 s producing the
// response before any bytes arrive, then dumps ~13 MB quickly — so the
// progress line ticks on elapsed time first, then byte count.
async function fetchJsonWithProgress(url, label, { retries = 2, timeoutMs = 90_000 } = {}) {
  const isTty = !!process.stdout.isTTY;
  const fmtBytes = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const started = Date.now();
    let received = 0;
    let phase = 'connecting';
    let total = 0;
    let lastLogTs = 0;
    let lastLogBytes = -1;
    const tick = () => {
      const now = Date.now();
      const elapsed = ((now - started) / 1000).toFixed(1);
      const totalStr = total ? ` / ${fmtBytes(total)}` : '';
      const line = `      ${label} · attempt ${attempt}/${retries} · ${phase} · ${elapsed}s · ${fmtBytes(received)}${totalStr}`;
      if (isTty) {
        process.stdout.write(`\r${line}\x1b[K`);
        return;
      }
      // Non-TTY (CI / Docker logs): print on a steady cadence — every 10 s
      // while connecting, every ~1 MB while downloading.
      if (phase === 'connecting' && now - lastLogTs >= 10_000) {
        console.log(line); lastLogTs = now;
      } else if (phase === 'downloading' && (received - lastLogBytes >= 1_000_000 || lastLogBytes < 0)) {
        console.log(line); lastLogBytes = received; lastLogTs = now;
      }
    };
    const ticker = setInterval(tick, 500);
    tick();

    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'texas-flood-map/0.1', 'Accept-Encoding': 'gzip' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      phase = 'downloading';
      const cl = res.headers.get('content-length');
      if (cl) total = Number(cl);
      const reader = res.body?.getReader();
      if (!reader) {
        // No streaming available — fall back to plain text.
        const txt = await res.text();
        received = txt.length;
        tick();
        return JSON.parse(txt);
      }
      const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
      }
      tick();
      if (isTty) process.stdout.write('\n');
      const buf = Buffer.concat(chunks);
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      lastErr = e;
      if (isTty) process.stdout.write('\n');
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.warn(`      ${label} attempt ${attempt} failed after ${elapsed}s: ${e.message ?? e}`);
      if (attempt < retries) {
        const waitMs = [5_000, 15_000, 30_000][attempt - 1] ?? 60_000;
        console.warn(`      retrying in ${(waitMs / 1000) | 0}s…`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    } finally {
      clearInterval(ticker);
      clearTimeout(t);
    }
  }
  throw lastErr;
}

async function loadSeedList() {
  try {
    const raw = await readFile(GAUGES_LIST_SEED, 'utf8');
    const parsed = JSON.parse(raw);
    const gauges = Array.isArray(parsed?.gauges) ? parsed.gauges : [];
    return { gauges, fetchedAt: parsed?.fetchedAt };
  } catch {
    return null;
  }
}

async function fetchGauges() {
  console.log('[1/3] Fetching TX gauge list from NWPS…');
  // Try live first with a tight budget (2 attempts, 90 s each). NWPS often
  // returns 504 at the upstream nginx after 60 s; seed falls through fast.
  try {
    const data = await fetchJsonWithProgress(NWPS_GAUGES_URL, 'NWPS gauge list', { timeoutMs: 90_000, retries: 2 });
    const all = Array.isArray(data) ? data : data.gauges ?? [];
    // The NWPS ?state=TX query param is ignored server-side — filter locally.
    const tx = all.filter(g => g?.state?.abbreviation === 'TX');
    console.log(`      got ${all.length} US gauges, ${tx.length} in TX (live)`);
    return tx;
  } catch (e) {
    console.warn(`      live fetch failed; trying seed file`);
  }
  const seed = await loadSeedList();
  if (!seed?.gauges?.length) {
    throw new Error('no live data and no gauges-list.json seed available');
  }
  // Reshape seed entries to match the NWPS list envelope (isUsable + downstream
  // code only read lid/latitude/longitude + state.abbreviation).
  const tx = seed.gauges.map(g => ({
    lid: g.lid,
    name: g.name,
    latitude: g.latitude,
    longitude: g.longitude,
    state: { abbreviation: 'TX' },
  }));
  console.log(`      using seed from ${seed.fetchedAt ?? 'unknown time'} (${tx.length} TX gauges)`);
  return tx;
}

// A gauge is usable if it has the basics needed to place it on the map.
// We intentionally do NOT filter by current `floodCategory` — that field is
// frequently null for gauges that are offline at build time, and dropping
// them would leave their host waterway unrendered on the map.
function isUsable(g) {
  return typeof g?.lid === 'string'
    && typeof g?.latitude === 'number'
    && typeof g?.longitude === 'number';
}

async function queryNhd(layer, geometry, radiusM, extraWhere = '1=1', maxRecords = 200) {
  const params = new URLSearchParams({
    f: 'geojson',
    geometry: JSON.stringify(geometry),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(radiusM),
    units: 'esriSRUnit_Meter',
    where: extraWhere,
    outFields: 'GNIS_NAME,FTYPE,PERMANENT_IDENTIFIER',
    returnGeometry: 'true',
    // ~5 m in WGS84. Anything coarser collapses river curves to straight
    // chords whose endpoints don't line up with adjacent reaches, which
    // shows up on the map as a stream broken into disconnected line
    // fragments. ~5 m keeps reaches visually contiguous.
    maxAllowableOffset: '0.00005',
    geometryPrecision: '6',
    resultRecordCount: String(maxRecords),
  });
  const url = `${NHD_BASE}/${layer}/query?${params.toString()}`;
  return fetchJson(url, { timeoutMs: 45_000, retries: 2 });
}

async function pLimit(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = { error: String(e) }; }
    }
  });
  await Promise.all(runners);
  return out;
}

function simplifyFeature(feat, gaugeId) {
  // Strip heavy props; keep only what the UI uses. ArcGIS's `f=geojson`
  // output lower-cases field names, so read both casings to be safe.
  const props = feat.properties ?? {};
  const name = props.gnis_name ?? props.GNIS_NAME ?? null;
  const ftype = props.ftype ?? props.FTYPE ?? null;
  const nhdId = props.permanent_identifier ?? props.PERMANENT_IDENTIFIER ?? null;
  return {
    type: 'Feature',
    geometry: feat.geometry,
    properties: {
      gaugeId,
      name: name || null,
      ftype: ftype ?? null,
      nhdId: nhdId ?? null,
    },
  };
}

function cachePathFor(lid) {
  return resolve(CACHE_DIR, `${lid}.json`);
}

async function readGaugeCache(lid) {
  if (REFRESH) return null;
  try {
    const raw = await readFile(cachePathFor(lid), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CACHE_VERSION) return null;
    if (!parsed?.fetchedAt) return null;
    if (Date.now() - new Date(parsed.fetchedAt).getTime() > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeGaugeCache(lid, payload) {
  await mkdir(CACHE_DIR, { recursive: true });
  const p = cachePathFor(lid);
  const body = JSON.stringify({ version: CACHE_VERSION, ...payload });
  await writeFile(p + '.tmp', body);
  await rename(p + '.tmp', p);
}

// Squared planar distance from a gauge point to the nearest vertex of a
// geometry. Coordinate-space (lon/lat) — not metric — but monotonic, which
// is all the nearest-wins dedup needs.
function nearestVertexDistSq(lat, lon, geom) {
  let min = Infinity;
  const visit = (line) => {
    for (const c of line) {
      const dx = c[0] - lon;
      const dy = c[1] - lat;
      const d = dx * dx + dy * dy;
      if (d < min) min = d;
    }
  };
  if (!geom) return min;
  if (geom.type === 'LineString') visit(geom.coordinates);
  else if (geom.type === 'MultiLineString') for (const l of geom.coordinates) visit(l);
  else if (geom.type === 'Polygon') for (const r of geom.coordinates) visit(r);
  else if (geom.type === 'MultiPolygon') for (const p of geom.coordinates) for (const r of p) visit(r);
  else if (geom.type === 'Point') visit([geom.coordinates]);
  return min;
}

function pickNearest(features, lat, lon) {
  if (!features?.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const f of features) {
    const d = nearestVertexDistSq(lat, lon, f.geometry);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

async function fetchGaugeBundle(g) {
  const lid = g.lid;
  const lat = g.latitude;
  const lon = g.longitude;
  const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };

  // Stage 1: probe the gauge location for its host waterway.
  const [hostFlowJson, hostWbJson, detail] = await Promise.all([
    queryNhd(FLOWLINE_LAYER, point, HOST_PROBE_RADIUS_M, '1=1', HOST_PROBE_MAX).catch(() => null),
    // FTYPE 390=LakePond, 436=Reservoir. Tight radius — only a lake the
    // gauge actually sits on/in counts as a host waterbody.
    queryNhd(WATERBODY_LAYER, point, HOST_WATERBODY_RADIUS_M, 'FTYPE IN (390, 436)', 5).catch(() => null),
    fetchJson(NWPS_GAUGE_DETAIL(lid), { timeoutMs: 30_000, retries: 2 }).catch(() => null),
  ]);

  const hostFlow = pickNearest(hostFlowJson?.features, lat, lon);
  const hostWaterbody = pickNearest(hostWbJson?.features, lat, lon);
  const hostName = (hostFlow?.properties?.gnis_name ?? hostFlow?.properties?.GNIS_NAME ?? '').trim() || null;

  // Stage 2: if the host has a name, pull every same-named reach within
  // range so coverage extends toward adjacent gauges. Unnamed hosts only
  // contribute their single nearest segment — we don't have a stable key
  // to chain unnamed reaches together.
  let riverFeatures = [];
  if (hostName) {
    const safe = hostName.replace(/'/g, "''");
    const where = `GNIS_NAME = '${safe}' AND FTYPE = 460`;
    const riverJson = await queryNhd(FLOWLINE_LAYER, point, HOST_RIVER_RADIUS_M, where, HOST_RIVER_MAX).catch(() => null);
    riverFeatures = riverJson?.features ?? [];
  } else if (hostFlow) {
    riverFeatures = [hostFlow];
  }

  const features = [];
  for (const f of riverFeatures) features.push(simplifyFeature(f, lid));
  if (hostWaterbody) features.push(simplifyFeature(hostWaterbody, lid));
  const cats = detail?.flood?.categories;
  // NWPS uses -9999 (and sometimes -999) as a sentinel for thresholds that
  // aren't defined for a gauge. Storing the sentinel verbatim makes
  // categorizeByStage flag every observation as a flood, so normalize to
  // null at write time.
  const cleanStage = (s) => (typeof s === 'number' && s > -100 ? s : null);
  const meta = {
    id: lid,
    name: g.name,
    lat, lon,
    usgsId: detail?.usgsId || g.usgsId || null,
    reachId: detail?.reachId || g.reachId || null,
    thresholds: cats
      ? {
          action: cleanStage(cats.action?.stage),
          minor: cleanStage(cats.minor?.stage),
          moderate: cleanStage(cats.moderate?.stage),
          major: cleanStage(cats.major?.stage),
        }
      : null,
    unit: detail?.flood?.stageUnits || 'ft',
  };
  return { features, meta };
}

// Stitch all LineString reaches sharing (gaugeId, name) into one MultiLine
// Feature. NHDPlus splits a single river into many small reach segments;
// rendering them as separate Leaflet paths makes the river look like a chain
// of disconnected fragments at zoom levels where the per-segment stroke
// joins become visible. One MultiLineString per river per gauge fixes that
// and shrinks the output too.
function mergeFlowlinesByName(features) {
  const out = [];
  const groups = new Map();
  for (const f of features) {
    const t = f.geometry?.type;
    const name = f.properties?.name;
    const gid = f.properties?.gaugeId;
    if ((t !== 'LineString' && t !== 'MultiLineString') || !name || !gid) {
      // Pass-through for waterbodies and unnamed reaches (no safe key to
      // stitch by — keep them as-is).
      out.push(f);
      continue;
    }
    const key = `${gid} ${name}`;
    let group = groups.get(key);
    if (!group) {
      group = { gaugeId: gid, name, ftype: f.properties?.ftype ?? null, lines: [] };
      groups.set(key, group);
    }
    if (t === 'LineString') group.lines.push(f.geometry.coordinates);
    else for (const line of f.geometry.coordinates) group.lines.push(line);
  }
  for (const g of groups.values()) {
    out.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: g.lines },
      properties: { gaugeId: g.gaugeId, name: g.name, ftype: g.ftype, nhdId: null },
    });
  }
  return out;
}

async function build() {
  // If a tarball is committed but loose cache files aren't, restore them
  // before any per-gauge cache lookups. Skipped automatically when the
  // loose dir already has files, so a freshly-fetched gauge isn't clobbered.
  unpackCache({ quiet: false });

  const gauges = await fetchGauges();
  const usable = gauges.filter(isUsable).slice(0, LIMIT === Infinity ? gauges.length : LIMIT);
  console.log(`      ${usable.length} usable gauges (with lid + coordinates)`);

  console.log(`[2/3] Building per-gauge data (cache: ${REFRESH ? 'forced refresh' : 'enabled, ttl ' + (CACHE_TTL_MS / 86_400_000).toFixed(0) + ' d'})`);
  // Nearest-wins dedup: the same NHD reach often falls inside the host-
  // river radius of multiple adjacent gauges. Track the closest gauge to
  // each reach and only keep that gauge's copy, so the painted segment
  // boundary lands roughly halfway between neighbouring gauges.
  const bestByNhd = new Map(); // nhdId -> { d, feature }
  const unkeyed = [];
  const gaugesMeta = [];
  let processed = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  await pLimit(usable, NHD_CONCURRENCY, async (g) => {
    const lid = g.lid;
    let bundle = await readGaugeCache(lid);
    if (bundle) {
      cacheHits++;
    } else {
      bundle = await fetchGaugeBundle(g);
      await writeGaugeCache(lid, { fetchedAt: new Date().toISOString(), ...bundle });
      cacheMisses++;
    }

    const gLat = bundle.meta?.lat ?? g.latitude;
    const gLon = bundle.meta?.lon ?? g.longitude;
    for (const f of bundle.features) {
      const id = f.properties?.nhdId;
      if (!id) { unkeyed.push(f); continue; }
      const d = nearestVertexDistSq(gLat, gLon, f.geometry);
      const prev = bestByNhd.get(id);
      if (!prev || d < prev.d) bestByNhd.set(id, { d, feature: f });
    }
    gaugesMeta.push(bundle.meta);

    processed++;
    const pct = ((processed / usable.length) * 100).toFixed(1);
    const line = `      ${processed}/${usable.length} (${pct}%) · cache ${cacheHits} hit / ${cacheMisses} miss · ${bestByNhd.size + unkeyed.length} feats · last: ${lid}`;
    // Single-line progress — overwrite when possible, otherwise log periodically.
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${line}\x1b[K`);
    } else if (processed % 25 === 0 || processed === usable.length) {
      console.log(line);
    }
  });
  if (process.stdout.isTTY) process.stdout.write('\n');

  const features = [...unkeyed];
  for (const v of bestByNhd.values()) features.push(v.feature);
  console.log(`      cache: ${cacheHits} hits / ${cacheMisses} misses (${((cacheHits / usable.length) * 100).toFixed(0)}% hit rate)`);
  console.log(`      total features: ${features.length}`);
  const merged = mergeFlowlinesByName(features);
  console.log(`      after merge by name: ${merged.length} features`);
  console.log('[3/3] Writing output files…');
  await mkdir(OUT_DIR, { recursive: true });
  const geojson = { type: 'FeatureCollection', features: merged };
  // Write to a tmp path then rename, so a failed run can't wipe existing data.
  await writeFile(WATERWAYS_OUT + '.tmp', JSON.stringify(geojson));
  await writeFile(GAUGES_OUT + '.tmp', JSON.stringify({ gauges: gaugesMeta, builtAt: new Date().toISOString() }));
  await rename(WATERWAYS_OUT + '.tmp', WATERWAYS_OUT);
  await rename(GAUGES_OUT + '.tmp', GAUGES_OUT);
  const sizeMb = (JSON.stringify(geojson).length / 1024 / 1024).toFixed(2);
  console.log(`      wrote ${WATERWAYS_OUT} (${sizeMb} MB)`);
  console.log(`      wrote ${GAUGES_OUT} (${gaugesMeta.length} gauges)`);
}

async function main() {
  if (IF_MISSING && (await exists(WATERWAYS_OUT)) && (await exists(GAUGES_OUT))) {
    console.log('data files already present — skipping (remove --if-missing to force rebuild)');
    return;
  }
  await build();
}

main().catch(err => {
  console.error('data build failed:', err);
  process.exit(1);
});
