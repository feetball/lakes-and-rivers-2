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
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { unpackCache } from './unpack-cache.mjs';
import { loadOverrides, applyGaugeOverrides } from './apply-gauge-overrides.mjs';

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
// v4: host-resolution rewrite — prefer a NAMED host reach when the nearest is
// unnamed, and chain the river across reservoir reaches (FTYPE 558/334/566),
// not just 460. Fixes ~195 gauges that shipped no river or a 0 km stub.
const CACHE_VERSION = 4;
// Cache entries older than this are refetched. NHD flowline/waterbody geometry
// is effectively static (rivers don't move; NHDPlus HR publishes on a multi-
// year cadence) and CACHE_VERSION already busts the cache when our per-gauge
// schema changes — so the default is deliberately long (10 years). This is
// what keeps the committed tarball useful: with the old 30-day default every
// build past the first month refetched all ~700 gauges from NHD (10–20 min).
// Override with CACHE_TTL_DAYS=N to force periodic refetches.
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_DAYS) || 3650) * 24 * 3_600_000;
// Decimal places to keep on output coordinates. 5 dp ≈ 1.1 m on the ground —
// far finer than any zoom this statewide map supports, and it shrinks the
// shipped GeoJSON ~13% raw / ~20% gzip vs the 6 dp NHD returns. The cache
// stores full-precision geometry; rounding happens only at write time.
const OUTPUT_COORD_DP = Number(process.env.OUTPUT_COORD_DP) || 5;
// A gauge bundle that comes back empty is treated as a possible transient
// upstream failure (NHD slow response, NWPS hiccup) and retried on each
// subsequent build. After this many consecutive empty results we accept that
// the gauge legitimately has no nearby NHD coverage and stop probing — use
// --refresh to override.
const MAX_EMPTY_RETRIES = 5;

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
// Was 250 m, which combined with nearest-vertex picking caused gauges sitting
// just inside a large lake to grab an adjacent sliver polygon. pickWaterbody
// now prefers the polygon that CONTAINS the gauge, so a wider probe just gives
// it the candidates to choose from (the containment/size test, not the radius,
// decides the winner). HOST_WATERBODY_MAX bounds how many we pull.
const HOST_WATERBODY_RADIUS_M = 1000;
const HOST_WATERBODY_MAX = 12;
const HOST_RIVER_RADIUS_M = 40000;
const HOST_RIVER_MAX = 400;
// Cap number of gauges processed (useful for smoke tests).
const LIMIT = Number(process.env.GAUGE_LIMIT ?? 0) || Infinity;
// Parallel fetches to NHD. Higher = faster build; if NHD starts returning
// 429/503 the per-request retry will handle it. Override with NHD_CONCURRENCY=N.
const NHD_CONCURRENCY = Number(process.env.NHD_CONCURRENCY) || 24;

// The app's FloodCategory union (see src/lib/types.ts). NWPS emits extra
// operational strings we must not persist into meta as categories.
const VALID_CATEGORIES = new Set(['no_flooding', 'not_defined', 'action', 'minor', 'moderate', 'major']);

const NWPS_GAUGES_URL = 'https://api.water.noaa.gov/nwps/v1/gauges?state=TX';
const NWPS_GAUGE_DETAIL = (lid) => `https://api.water.noaa.gov/nwps/v1/gauges/${lid}`;
const NHD_BASE = 'https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer';
const FLOWLINE_LAYER = 3; // NetworkNHDFlowline
const WATERBODY_LAYER = 9; // NHDWaterbody

// Flowline FTYPEs that carry a river's course. 460=StreamRiver is the obvious
// one, but NHD threads a river THROUGH lakes/reservoirs as 558=ArtificialPath
// (and occasionally 566=Coastline/connector reaches), and 334=Connector
// bridges gaps. Restricting expansion to 460 (the old behaviour) left a hole
// wherever a gauge sat on an impoundment reach — e.g. the Colorado at San Saba
// and below Lake Buchanan — because the host reach was a 558 with no name, so
// nothing chained the named river across it. Expanding by name across all of
// these stitches the river back together through reservoirs.
const RIVER_FLOWLINE_FTYPES = [460, 558, 334, 566];
const RIVER_FTYPE_SQL = `FTYPE IN (${RIVER_FLOWLINE_FTYPES.join(', ')})`;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function fetchJson(url, { retries = 5, timeoutMs = 120_000, headers = { 'User-Agent': 'texas-flood-map/0.1' } } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers });
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

// Reshape seed entries to match the NWPS list envelope (isUsable + downstream
// code only read lid/latitude/longitude + state.abbreviation).
function seedToTx(seed) {
  return seed.gauges.map(g => ({
    lid: g.lid,
    name: g.name,
    latitude: g.latitude,
    longitude: g.longitude,
    state: { abbreviation: 'TX' },
  }));
}

async function fetchGauges() {
  console.log('[1/3] Resolving TX gauge list…');
  const seed = await loadSeedList();
  // Default: use the committed seed when present. The build only needs
  // lid + coordinates per gauge — those don't change often, the seed is
  // refreshed daily by the running app's instrumentation hook, and the
  // live NWPS list endpoint regularly takes 60+ s (often 504s) which
  // exceeds Vercel's build budget. Use --refresh to force a live re-fetch.
  if (seed?.gauges?.length && !REFRESH) {
    const tx = seedToTx(seed);
    console.log(`      using seed from ${seed.fetchedAt ?? 'unknown time'} (${tx.length} TX gauges)`);
    return tx;
  }
  console.log('      fetching live from NWPS…');
  try {
    const data = await fetchJsonWithProgress(NWPS_GAUGES_URL, 'NWPS gauge list', { timeoutMs: 90_000, retries: 2 });
    const all = Array.isArray(data) ? data : data.gauges ?? [];
    // The NWPS ?state=TX query param is ignored server-side — filter locally.
    const tx = all.filter(g => g?.state?.abbreviation === 'TX');
    console.log(`      got ${all.length} US gauges, ${tx.length} in TX (live)`);
    return tx;
  } catch {
    console.warn('      live fetch failed; falling back to seed');
    if (seed?.gauges?.length) {
      const tx = seedToTx(seed);
      console.log(`      using seed from ${seed.fetchedAt ?? 'unknown time'} (${tx.length} TX gauges)`);
      return tx;
    }
    throw new Error('no live data and no gauges-list.json seed available');
  }
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
    outFields: 'GNIS_NAME,FTYPE,PERMANENT_IDENTIFIER,AREASQKM',
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

// Splits an array into chunks of at most `n` items each.
function chunk(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
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

    const isEmpty = !parsed.features?.length;
    const attempts = parsed.emptyAttempts ?? 0;
    const givenUp = isEmpty && attempts >= MAX_EMPTY_RETRIES;

    // Empty bundles below the retry cap are treated as a cache miss so the
    // next build refetches them.
    if (isEmpty && !givenUp) return null;

    // TTL applies to entries that are still in play. Once we've given up on
    // a gauge, ignore TTL so we don't re-probe it on every subsequent build.
    if (!givenUp && Date.now() - new Date(parsed.fetchedAt).getTime() > CACHE_TTL_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Returns the raw cached entry (ignoring TTL / empty-retry rules) so callers
// can read auxiliary state — primarily emptyAttempts — when deciding how to
// write a fresh fetch.
async function readGaugeCacheRaw(lid) {
  try {
    return JSON.parse(await readFile(cachePathFor(lid), 'utf8'));
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

// GNIS name off a feature, normalized. ArcGIS `f=geojson` lower-cases field
// names, so accept both casings.
function gnisName(feat) {
  const p = feat?.properties ?? {};
  return (p.gnis_name ?? p.GNIS_NAME ?? '').trim() || null;
}

// Ray-casting point-in-polygon against a single linear ring ([[lon,lat],...]).
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Does the gauge point fall inside this (Multi)Polygon? Outer ring contains,
// holes subtract — standard even-odd across all rings of the part.
function pointInPolygon(lon, lat, geom) {
  if (!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const rings of polys) {
    let inside = false;
    for (const ring of rings) if (pointInRing(lon, lat, ring)) inside = !inside;
    if (inside) return true;
  }
  return false;
}

// Pick the host WATERBODY for a gauge. nearest-vertex (pickNearest) is wrong
// here: NHD overlays a big lake with tiny unnamed sliver polygons whose edge
// can be closer to the gauge than the lake's, so the gauge ends up tagged with
// a 3 km² sliver instead of the 89 km² lake (this is why Lake Buchanan looked
// "missing" — we shipped the sliver, not the lake). Prefer, in order: a
// polygon that CONTAINS the gauge and is named; any polygon that contains it;
// then a named one; then nearest. Among ties, the larger polygon wins.
function pickWaterbody(features, lat, lon) {
  if (!features?.length) return null;
  const area = (f) => {
    const p = f.properties ?? {};
    return Number(p.areasqkm ?? p.AREASQKM ?? 0) || 0;
  };
  const contains = features.filter(f => pointInPolygon(lon, lat, f.geometry));
  const pool = contains.length ? contains : features;
  const named = pool.filter(gnisName);
  const candidates = named.length ? named : pool;
  // Largest among the best-tier candidates — the real lake, not a sliver.
  return candidates.reduce((best, f) => (area(f) > area(best) ? f : best), candidates[0]);
}

// Resolve the host river NAME for a gauge. The nearest reach is often unnamed
// even when it's part of a named river — a 558 ArtificialPath through a
// reservoir, or just an unnamed 460 reach within e.g. the Leon/Nueces/Rio
// Grande. So: take the nearest reach as the host geometry, but for the NAME we
// scan all probed candidates and pick the closest one that actually has a
// GNIS name. That name then drives the same-name expansion. Returns the host
// feature (for the unnamed-fallback case) and the resolved name separately.
function resolveHost(features, lat, lon) {
  const host = pickNearest(features, lat, lon);
  if (!host) return { host: null, name: null };
  // Prefer the nearest NAMED candidate's name for expansion. Sort candidates
  // by distance and take the first with a name.
  const named = (features ?? [])
    .filter(gnisName)
    .map(f => ({ f, d: nearestVertexDistSq(lat, lon, f.geometry) }))
    .sort((a, b) => a.d - b.d)[0];
  return { host, name: named ? gnisName(named.f) : gnisName(host) };
}

async function fetchGaugeBundle(g) {
  const lid = g.lid;
  const lat = g.latitude;
  const lon = g.longitude;
  const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };

  // Stage 1: probe the gauge location for its host waterway. We probe for any
  // river-carrying flowline (460 StreamRiver + 558/334/566 through-water
  // reaches) so a gauge sitting on a reservoir reach still finds a host, and
  // pull up to HOST_PROBE_MAX candidates so resolveHost can reach past an
  // unnamed nearest reach to the named river it belongs to.
  const [hostFlowJson, hostWbJson, detail] = await Promise.all([
    queryNhd(FLOWLINE_LAYER, point, HOST_PROBE_RADIUS_M, RIVER_FTYPE_SQL, HOST_PROBE_MAX).catch(() => null),
    // FTYPE 390=LakePond, 436=Reservoir. pickWaterbody picks the polygon that
    // contains the gauge (preferring named + largest), so we can afford a wider
    // probe and more candidates than the old nearest-vertex pick allowed.
    queryNhd(WATERBODY_LAYER, point, HOST_WATERBODY_RADIUS_M, 'FTYPE IN (390, 436)', HOST_WATERBODY_MAX).catch(() => null),
    fetchJson(NWPS_GAUGE_DETAIL(lid), { timeoutMs: 30_000, retries: 2 }).catch(() => null),
  ]);

  const { host: hostFlow, name: hostName } = resolveHost(hostFlowJson?.features, lat, lon);
  const hostWaterbody = pickWaterbody(hostWbJson?.features, lat, lon);

  // Stage 2: if we resolved a host name, pull every same-named reach within
  // range — across all river-carrying FTYPEs so the river stays connected
  // through reservoirs — so coverage extends toward adjacent gauges. When the
  // host truly has no name anywhere nearby, fall back to its single nearest
  // reach (we have no stable key to chain unnamed reaches together).
  let riverFeatures = [];
  if (hostName) {
    const safe = hostName.replace(/'/g, "''");
    const where = `GNIS_NAME = '${safe}' AND ${RIVER_FTYPE_SQL}`;
    const riverJson = await queryNhd(FLOWLINE_LAYER, point, HOST_RIVER_RADIUS_M, where, HOST_RIVER_MAX).catch(() => null);
    riverFeatures = riverJson?.features ?? [];
    // Guard: if the name-expansion somehow returned nothing (transient NHD
    // hiccup), still ship the host reach so the gauge isn't left blank.
    if (!riverFeatures.length && hostFlow) riverFeatures = [hostFlow];
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

// Round every coordinate in a GeoJSON geometry to `dp` decimal places, in
// place. Cuts shipped payload with no visible effect at this map's zooms (see
// OUTPUT_COORD_DP). JSON.stringify drops trailing zeros, so rounded values
// also serialize shorter (e.g. 30.316444 -> 30.31644 -> "30.31644").
function roundGeometry(geom, dp) {
  if (!geom?.coordinates) return;
  const f = 10 ** dp;
  const r = (a) => {
    if (typeof a[0] === 'number') {
      a[0] = Math.round(a[0] * f) / f;
      a[1] = Math.round(a[1] * f) / f;
      return;
    }
    for (const c of a) r(c);
  };
  r(geom.coordinates);
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

// USGS Instantaneous Values (parameter 00065 = gauge height, ft) — fallback
// source when the NWPS bulk observation list fails outright (NWPS routinely
// 504s on the ~13 MB TX list). Queries the same USGS site ids NWPS already
// resolved onto each gauge (m.usgsId, set in fetchGaugeBundle), batched at
// up to 100 sites/request. Returns a Map<lid, {category, observedStage,
// observedAt}> in the exact shape fetchObservations() produces from NWPS, so
// build()'s threshold-derivation loop (lines ~748-756) applies uniformly
// regardless of source: category is always seeded 'not_defined' here (USGS
// IV has no flood-category concept), and gets upgraded from m.thresholds by
// that same loop, or stays 'not_defined' if the gauge has none. Tolerates
// individual batch failures; returns an empty Map only if every batch fails
// or no gauge has a usgsId.
async function fetchUsgsIvObservations(gaugesMeta) {
  // usgsId -> [lid, ...] (normally one lid per usgsId, but don't assume).
  const lidsByUsgsId = new Map();
  for (const m of gaugesMeta) {
    if (!m.usgsId) continue;
    const lids = lidsByUsgsId.get(m.usgsId);
    if (lids) lids.push(m.id); else lidsByUsgsId.set(m.usgsId, [m.id]);
  }
  const siteIds = [...lidsByUsgsId.keys()];
  if (!siteIds.length) return new Map();

  const batches = chunk(siteIds, 100);
  const readingBySite = new Map(); // usgsId -> { stage, observedAt }
  let batchFailures = 0;

  for (const batch of batches) {
    const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${batch.join(',')}&parameterCd=00065&period=PT2H`;
    try {
      const data = await fetchJson(url, {
        timeoutMs: 30_000,
        retries: 2,
        headers: { 'User-Agent': 'texas-flood-map-build/1.0' },
      });
      const series = data?.value?.timeSeries ?? [];
      for (const ts of series) {
        const siteId = ts?.sourceInfo?.siteCode?.[0]?.value;
        if (!siteId) continue;
        const points = ts?.values?.[0]?.value ?? [];
        // Points come back in chronological order — walk backwards so the
        // first valid one found is the most recent.
        for (let i = points.length - 1; i >= 0; i--) {
          const v = Number(points[i]?.value);
          if (!Number.isFinite(v) || v <= -999) continue;
          readingBySite.set(siteId, { stage: v, observedAt: points[i].dateTime ?? null });
          break;
        }
      }
    } catch (e) {
      batchFailures++;
      console.warn(`      USGS IV batch failed (${batch.length} sites): ${e?.message ?? e}`);
    }
  }

  if (batchFailures === batches.length) return new Map();

  const obs = new Map();
  for (const [usgsId, lids] of lidsByUsgsId) {
    const r = readingBySite.get(usgsId);
    if (!r) continue;
    for (const lid of lids) {
      obs.set(lid, { category: 'not_defined', observedStage: r.stage, observedAt: r.observedAt });
    }
  }
  return obs;
}

// Pull current observations for every TX gauge in a single NWPS list call,
// keyed by lid. Embedded in gauges-meta.json so the runtime fallback can
// serve real (build-time-stale) flood categories instead of "No data" while
// the live cache warms up. Falls back to USGS Instantaneous Values (see
// fetchUsgsIvObservations) if the NWPS list fails outright, and only ships
// an empty Map — meta then falls back to "not_defined" as before — if that
// fallback also comes up empty.
async function fetchObservations(gaugesMeta) {
  console.log('[2.5/3] Fetching live observations from NWPS…');
  try {
    const data = await fetchJsonWithProgress(NWPS_GAUGES_URL, 'NWPS list (observations)', { timeoutMs: 90_000, retries: 2 });
    const all = Array.isArray(data) ? data : data.gauges ?? [];
    const obs = new Map();
    for (const g of all) {
      if (!g?.lid || g?.state?.abbreviation !== 'TX') continue;
      const observed = g.status?.observed;
      const cat = observed?.floodCategory ?? g.ObservedFloodCategory;
      obs.set(g.lid, {
        // Normalize to the app's FloodCategory union. NWPS also emits
        // operational strings (out_of_service, obs_not_current, low_threshold)
        // that aren't categories — collapse them to not_defined so meta never
        // ships a non-union value (which would paint gray with broken labels).
        // The derivation step below then upgrades not_defined from thresholds,
        // exactly mirroring the runtime resolveCategory() path.
        category: VALID_CATEGORIES.has(cat) ? cat : 'not_defined',
        observedStage: typeof observed?.primary === 'number' ? observed.primary : null,
        observedAt: observed?.validTime ?? null,
      });
    }
    console.log(`      observations for ${obs.size} TX gauges`);
    return { obs, source: 'nwps' };
  } catch (e) {
    console.warn(`      NWPS observations failed (${e?.message ?? e}); falling back to USGS IV…`);
    const obs = await fetchUsgsIvObservations(gaugesMeta);
    if (obs.size) return { obs, source: 'usgs' };
    console.warn('      USGS IV fallback failed too; shipping meta without live obs');
    return { obs, source: 'none' };
  }
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
      // Carry forward the prior empty-attempt counter so retries accumulate
      // across builds rather than resetting each run.
      const prior = await readGaugeCacheRaw(lid);
      bundle = await fetchGaugeBundle(g);
      const isEmpty = !bundle.features?.length;
      const emptyAttempts = isEmpty ? (prior?.emptyAttempts ?? 0) + 1 : 0;
      await writeGaugeCache(lid, {
        fetchedAt: new Date().toISOString(),
        emptyAttempts,
        ...bundle,
      });
      cacheMisses++;
      if (isEmpty && emptyAttempts >= MAX_EMPTY_RETRIES) {
        if (process.stdout.isTTY) process.stdout.write('\n');
        console.log(`      [${lid}] no data after ${emptyAttempts} attempts — won't retry`);
      }
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
  // Trim coordinate precision on the merged output. Done here (not in the
  // cache) so the cache keeps full-precision geometry and a future dp change
  // doesn't require a refetch.
  for (const f of merged) roundGeometry(f.geometry, OUTPUT_COORD_DP);

  const { obs, source: obsSource } = await fetchObservations(gaugesMeta);
  let withObs = 0;
  let latestObsAt = 0;
  for (const m of gaugesMeta) {
    const o = obs.get(m.id);
    if (!o) continue;
    // NWPS frequently leaves floodCategory null even when the gauge has a
    // valid stage + thresholds. Derive from thresholds in that case so the
    // meta-shipped fallback paints real colors instead of "no data".
    let category = o.category;
    if ((category === 'not_defined' || !category) && typeof o.observedStage === 'number' && m.thresholds) {
      const t = m.thresholds;
      const valid = (n) => typeof n === 'number' && n > -100;
      if (valid(t.major) && o.observedStage >= t.major) category = 'major';
      else if (valid(t.moderate) && o.observedStage >= t.moderate) category = 'moderate';
      else if (valid(t.minor) && o.observedStage >= t.minor) category = 'minor';
      else if (valid(t.action) && o.observedStage >= t.action) category = 'action';
      else category = 'no_flooding';
    }
    m.category = category;
    m.observedStage = o.observedStage;
    m.observedAt = o.observedAt;
    if (o.observedAt) {
      const t = Date.parse(o.observedAt);
      if (Number.isFinite(t) && t > latestObsAt) latestObsAt = t;
    }
    withObs++;
  }
  console.log(`      ${withObs}/${gaugesMeta.length} gauges have build-time observations${obsSource === 'usgs' ? ' (via USGS)' : ''}`);

  console.log('[3/3] Writing output files…');
  await mkdir(OUT_DIR, { recursive: true });
  // Correct any lake polygons the nearest-waterbody heuristic mis-tagged (see
  // public/data/gauge-overrides.json). Done here, just before write, so the
  // committed artifacts already reflect the corrections.
  const overrides = await loadOverrides();
  const ovChanges = applyGaugeOverrides(merged, overrides);
  if (ovChanges.length) {
    console.log(`      applied ${ovChanges.length} gauge override(s): ${ovChanges.map((c) => c.name).join(', ')}`);
  }
  const geojson = { type: 'FeatureCollection', features: merged };
  // observationsAt records the most recent observation time across the
  // shipped gauges so the runtime fallback can return that as updatedAt
  // instead of the epoch-0 sentinel — which keeps the "Loading live gauge
  // data" banner from firing when the fallback is in use.
  const metaPayload = {
    gauges: gaugesMeta,
    builtAt: new Date().toISOString(),
    observationsAt: latestObsAt > 0 ? new Date(latestObsAt).toISOString() : null,
  };
  const geojsonStr = JSON.stringify(geojson);
  // Write to a tmp path then rename, so a failed run can't wipe existing data.
  await writeFile(WATERWAYS_OUT + '.tmp', geojsonStr);
  await writeFile(GAUGES_OUT + '.tmp', JSON.stringify(metaPayload));
  await rename(WATERWAYS_OUT + '.tmp', WATERWAYS_OUT);
  await rename(GAUGES_OUT + '.tmp', GAUGES_OUT);
  const sizeMb = (geojsonStr.length / 1024 / 1024).toFixed(2);
  console.log(`      wrote ${WATERWAYS_OUT} (${sizeMb} MB)`);
  console.log(`      wrote ${GAUGES_OUT} (${gaugesMeta.length} gauges)`);

  // Precompress the waterways payload so /api/waterways can serve brotli/gzip
  // straight off disk (cheap, no per-request CPU). brotli ~halves gzip here.
  // Static files under public/ are only gzip-compressed by the Next standalone
  // server, so this is where the brotli win comes from.
  const buf = Buffer.from(geojsonStr, 'utf8');
  const br = brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  const gz = gzipSync(buf, { level: 9 });
  await writeFile(WATERWAYS_OUT + '.br', br);
  await writeFile(WATERWAYS_OUT + '.gz', gz);
  console.log(
    `      precompressed: br ${(br.length / 1048576).toFixed(2)} MB · gzip ${(gz.length / 1048576).toFixed(2)} MB`,
  );
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
