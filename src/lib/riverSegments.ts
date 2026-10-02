// River re-segmentation: gives every stretch of river to the flood-staged gauge
// that is closest ALONG THE RIVER, instead of the single gauge the data build
// happened to attach to the whole feature.
//
// Why: scripts/build-waterways-data.mjs tags each river FEATURE with one gauge.
// A long river (the Llano) can be owned by a gauge 29 km away that has no flood
// stages, while a gauge sitting right on it (Mason, MLRT2, in Action) only gets
// a 2-point stub, so the river stays blue/gray around a gauge that is flooding.
//
// Pure module: no React / Next / Leaflet imports, so node:test can import it.
//
// Data shape (checked on the real file): a river feature is a MultiLineString
// whose parts are NHD flowlines (2-30 points each, in no particular order or
// direction) that join end-to-end, also ACROSS features that belong to
// different gauges. So "along the line" cannot be measured per part: this
// module links the parts into a network by their shared end points and
// measures distance along that network.
//
// Algorithm
//   1. Network: every line part is an edge between its first and last point
//      (nodes are end points rounded to 1e-5 deg, ~1 m).
//   2. Candidates: gauges with flood stages. Each is snapped to the line parts
//      within SNAP_M (point-to-segment distance); only the closest parts
//      (within SOURCE_SLACK_M of the closest NAMED one) become its sources.
//   3. A bounded Dijkstra from each candidate over the network, never longer
//      than MAX_ALONG_M, only through parts whose name matches the candidate's
//      river (unnamed parts match anything), so a gauge on the Llano does not
//      claim Beaver Creek just because the two meet.
//   4. Within every touched part each position goes to the candidate with the
//      smallest along-river distance (ties: smaller id). Where the winner
//      changes inside a segment the part is cut at the point where the two
//      distances are equal, so pieces join without gaps. Positions no
//      candidate reaches within MAX_ALONG_M keep the feature's original gauge.
//   5. Pieces are grouped per (source feature, gauge) into one LineString or
//      MultiLineString, so the feature count grows by the number of distinct
//      owners, not by the number of cuts.
// Polygons (lakes) and every feature no candidate reaches are returned as the
// same objects they came in (never copied, never mutated).

import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';

/** A gauge must be this close (m) to a line part to be a candidate for it. */
export const SNAP_M = 750;
/** A stretch of river farther than this (m, along the river) from every candidate keeps its original gauge. */
export const MAX_ALONG_M = 40_000;
/** Loose ends of same-named flowlines closer than this (m) are treated as joined (NHD gaps, reservoirs). */
export const GAP_M = 1000;
/** Parts within this many metres of the closest part also count as the gauge's position (side channels, stubs). */
export const SOURCE_SLACK_M = 150;

export interface RiverGauge {
  id: string;
  lat: number;
  lon: number;
  /** True when at least one of action/minor/moderate/major is a real number > -100. */
  hasThresholds: boolean;
}

export interface SegmentOptions {
  snapM?: number;
  maxAlongM?: number;
  sourceSlackM?: number;
  gapM?: number;
}

export interface SegmentStats {
  /** Line features (LineString + MultiLineString) in / out. */
  riverFeaturesIn: number;
  riverFeaturesOut: number;
  /** All features in / out. */
  featuresIn: number;
  featuresOut: number;
  /** Input river features whose geometry or owner changed. */
  featuresChanged: number;
  /** Line parts (flowlines) that were cut or re-owned. */
  partsTouched: number;
  /** Vertices that did not exist in the input (cut points; each cut adds one to each side). */
  addedVertices: number;
  /** Candidate gauges that found line parts to claim. */
  candidates: number;
}

/** True for a threshold that is a real stage value (-9999 / -999 / null / NaN mean undefined). */
export function isRealThreshold(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > -100;
}

/** True when at least one of the four flood stages is defined. */
export function hasFloodStages(
  t: { action?: unknown; minor?: unknown; moderate?: unknown; major?: unknown } | null | undefined,
): boolean {
  return !!t && (isRealThreshold(t.action) || isRealThreshold(t.minor) || isRealThreshold(t.moderate) || isRealThreshold(t.major));
}

/** Minimal shape of a GaugeStatus / gauges-meta entry. */
export interface GaugeLike {
  id: string;
  lat: number;
  lon: number;
  thresholds?: { action?: unknown; minor?: unknown; moderate?: unknown; major?: unknown } | null;
}

/** Builds the `gauges` argument of segmentWaterways from GaugeStatus-like objects. */
export function toRiverGauges(list: Iterable<GaugeLike>): RiverGauge[] {
  const out: RiverGauge[] = [];
  for (const g of list) {
    if (!g || typeof g.id !== 'string') continue;
    out.push({ id: g.id, lat: g.lat, lon: g.lon, hasThresholds: hasFloodStages(g.thresholds) });
  }
  return out;
}

/**
 * Stable signature of the candidate set (flood-staged gauge ids and positions).
 * Thresholds are static, so a memo keyed on this does not change when live
 * categories change or when the timeline switches snapshots.
 */
export function stagedSignature(gauges: readonly RiverGauge[]): string {
  const parts: string[] = [];
  for (const g of gauges) {
    if (g.hasThresholds && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
      parts.push(`${g.id}@${g.lat.toFixed(5)},${g.lon.toFixed(5)}`);
    }
  }
  parts.sort();
  return parts.join('|');
}

// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQ = 111_320;
const DEG = Math.PI / 180;
const TIE_M = 0.5;
const MIN_PIECE_M = 3;
const CELL_DEG = 0.1;

type Props = Record<string, unknown>;

interface Part {
  feature: number; // index into the input features
  coords: Position[];
  name: string | null;
  startNode: number;
  endNode: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  off: number; // offset of this part's cumulative metres (from the first vertex) in the shared pool, -1 until computed
}

interface Cand {
  id: string;
  name: string | null;
  sources: Array<{ part: number; s: number }>;
}

/** One candidate's reach into one part. */
interface Opt {
  cand: number;
  dS: number; // along-river distance to the part's first node (Infinity if out of reach)
  dE: number; // ... to its last node
  onS: number; // position of the candidate on this very part, or NaN
}

function nodeKey(p: Position): number {
  return Math.round((p[0] + 180) * 1e5) * 2e7 + Math.round((p[1] + 90) * 1e5);
}

function segLen(a: Position, b: Position): number {
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  const dx = (b[0] - a[0]) * M_PER_DEG_LON_EQ * Math.cos(((a[1] + b[1]) / 2) * DEG);
  return Math.hypot(dx, dy);
}

/** Cumulative along-part metres of every vertex, computed lazily into one shared buffer. */
class CumPool {
  private buf: Float64Array;
  private top = 0;
  constructor(size: number) {
    this.buf = new Float64Array(Math.max(16, size));
  }
  /** Offset of the part's cumulative lengths in `buf` (index i = metres from the first vertex to vertex i). */
  at(p: Part): number {
    if (p.off >= 0) return p.off;
    const n = p.coords.length;
    const o = this.top;
    this.top += n;
    const b = this.buf;
    b[o] = 0;
    for (let i = 1; i < n; i++) b[o + i] = b[o + i - 1] + segLen(p.coords[i - 1], p.coords[i]);
    p.off = o;
    return o;
  }
  get data(): Float64Array {
    return this.buf;
  }
  length(p: Part): number {
    return this.buf[this.at(p) + p.coords.length - 1];
  }
}

/** Closest approach of a gauge to the part: distance (m) and position along the part (m). */
function snap(g: { lat: number; lon: number }, part: Part, pool: CumPool): { dist: number; s: number } {
  const cum = pool.data;
  const o = pool.at(part);
  const kx = M_PER_DEG_LON_EQ * Math.cos(g.lat * DEG);
  const c = part.coords;
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i < c.length - 1; i++) {
    const ax = (c[i][0] - g.lon) * kx;
    const ay = (c[i][1] - g.lat) * M_PER_DEG_LAT;
    const dx = (c[i + 1][0] - g.lon) * kx - ax;
    const dy = (c[i + 1][1] - g.lat) * M_PER_DEG_LAT - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      bestS = cum[o + i] + t * (cum[o + i + 1] - cum[o + i]);
    }
  }
  return { dist: best, s: bestS };
}

// Minimal binary min-heap of (distance, node) pairs.
class Heap {
  private d: number[] = [];
  private n: number[] = [];
  get size() {
    return this.d.length;
  }
  push(dist: number, node: number) {
    const d = this.d;
    const n = this.n;
    let i = d.length;
    d.push(dist);
    n.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p] <= dist) break;
      d[i] = d[p];
      n[i] = n[p];
      i = p;
    }
    d[i] = dist;
    n[i] = node;
  }
  topD = 0;
  topN = 0;
  /** Removes the smallest entry; it is left in topD / topN. */
  pop(): void {
    const d = this.d;
    const n = this.n;
    this.topD = d[0];
    this.topN = n[0];
    const ld = d.pop() as number;
    const ln = n.pop() as number;
    const len = d.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= len) break;
        if (c + 1 < len && d[c + 1] < d[c]) c++;
        if (d[c] >= ld) break;
        d[i] = d[c];
        n[i] = n[c];
        i = c;
      }
      d[i] = ld;
      n[i] = ln;
    }
  }
}

/** A candidate may flow through a part when the river names agree (an unnamed side matches anything). */
function nameOk(candName: string | null, partName: string | null): boolean {
  return candName === null || partName === null || candName === partName;
}

export interface SegmentResult {
  collection: FeatureCollection<Geometry, Props>;
  stats: SegmentStats;
  /** For every output feature, the index of the input feature it came from. */
  origin: number[];
}

const ZERO_STATS: SegmentStats = {
  riverFeaturesIn: 0,
  riverFeaturesOut: 0,
  featuresIn: 0,
  featuresOut: 0,
  featuresChanged: 0,
  partsTouched: 0,
  addedVertices: 0,
  candidates: 0,
};

/** Same as segmentWaterways, plus counters (used by the tests and the verification script). */
export function segmentWaterwaysDetailed(
  collection: FeatureCollection<Geometry, Props>,
  gauges: readonly RiverGauge[],
  options: SegmentOptions = {},
): SegmentResult {
  try {
    return segmentCore(collection, gauges, options);
  } catch {
    // Malformed input must never break the map: hand the features back untouched.
    const features = collection && Array.isArray(collection.features) ? collection.features : [];
    return {
      collection: { ...(collection && typeof collection === 'object' ? collection : { type: 'FeatureCollection' as const }), features: features.slice() },
      stats: { ...ZERO_STATS, featuresIn: features.length, featuresOut: features.length },
      origin: features.map((_, i) => i),
    };
  }
}

function segmentCore(
  collection: FeatureCollection<Geometry, Props>,
  gauges: readonly RiverGauge[],
  options: SegmentOptions,
): SegmentResult {
  if (!collection || typeof collection !== 'object' || !Array.isArray(collection.features)) {
    return { collection: { type: 'FeatureCollection', features: [] }, stats: { ...ZERO_STATS }, origin: [] };
  }
  const features: Feature<Geometry, Props>[] = collection.features;
  const snapM = options.snapM ?? SNAP_M;
  const maxAlong = options.maxAlongM ?? MAX_ALONG_M;
  const slack = options.sourceSlackM ?? SOURCE_SLACK_M;
  const gapM = options.gapM ?? GAP_M;

  const stats: SegmentStats = { ...ZERO_STATS, featuresIn: features.length };
  const unchanged = (): SegmentResult => {
    stats.featuresOut = features.length;
    stats.riverFeaturesOut = stats.riverFeaturesIn;
    return { collection: { ...collection, features: features.slice() }, stats, origin: features.map((_, i) => i) };
  };

  // Candidate gauges: flood-staged, valid position, unique id, sorted by id.
  const seen = new Set<string>();
  const staged: RiverGauge[] = [];
  if (Array.isArray(gauges)) {
    for (const g of gauges) {
      if (!g || typeof g.id !== 'string' || !g.hasThresholds) continue;
      if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon) || seen.has(g.id)) continue;
      seen.add(g.id);
      staged.push(g);
    }
  }
  staged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 1. Line parts with bounding boxes (one pass over the vertices; invalid lines are skipped).
  const parts: Part[] = [];
  const partOf = new Map<number, number>(); // fi * 1e6 + line index -> part index
  let totalVertices = 0;
  for (let fi = 0; fi < features.length; fi++) {
    const geom = features[fi]?.geometry;
    if (!geom) continue;
    let lines: unknown[] | null = null;
    if (geom.type === 'LineString') lines = [geom.coordinates];
    else if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates)) lines = geom.coordinates;
    if (!lines) continue;
    stats.riverFeaturesIn++;
    const rawName = features[fi].properties?.name;
    const name = typeof rawName === 'string' && rawName ? rawName : null;
    for (let li = 0; li < lines.length; li++) {
      const c = lines[li];
      if (!Array.isArray(c) || c.length < 2) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      // No per-vertex validation here (this loop dominates the cold start). A NaN vertex is ignored by the
      // box and poisons its distances (so it never wins); anything that throws is caught in the wrapper.
      for (let i = 0; i < c.length; i++) {
        const q = c[i];
        const x = q[0];
        const y = q[1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const e0 = c[0];
      const e1 = c[c.length - 1];
      if (!(Math.abs(e0[0]) <= 180 && Math.abs(e0[1]) <= 90 && Math.abs(e1[0]) <= 180 && Math.abs(e1[1]) <= 90)) continue;
      partOf.set(fi * 1e6 + li, parts.length);
      totalVertices += c.length;
      parts.push({
        feature: fi, coords: c as Position[], name,
        startNode: nodeKey(c[0]), endNode: nodeKey(c[c.length - 1]),
        minX, maxX, minY, maxY, off: -1,
      });
    }
  }
  if (staged.length === 0 || parts.length === 0) return unchanged();
  const pool = new CumPool(totalVertices);

  // 2. Gauge grid -> for every part, the gauges within snapM of it. Parts whose
  // expanded box holds no candidate gauge are skipped without touching their vertices.
  let gx0 = Infinity;
  let gx1 = -Infinity;
  let gy0 = Infinity;
  let gy1 = -Infinity;
  for (const g of staged) {
    if (g.lon < gx0) gx0 = g.lon;
    if (g.lon > gx1) gx1 = g.lon;
    if (g.lat < gy0) gy0 = g.lat;
    if (g.lat > gy1) gy1 = g.lat;
  }
  const GW = Math.floor((gx1 - gx0) / CELL_DEG) + 1;
  const GH = Math.floor((gy1 - gy0) / CELL_DEG) + 1;
  const head = new Int32Array(GW * GH).fill(-1);
  const next = new Int32Array(staged.length).fill(-1);
  for (let i = staged.length - 1; i >= 0; i--) {
    const cell = Math.floor((staged[i].lon - gx0) / CELL_DEG) * GH + Math.floor((staged[i].lat - gy0) / CELL_DEG);
    next[i] = head[cell];
    head[cell] = i;
  }
  const nearParts: Array<Array<{ part: number; dist: number; s: number }>> = staged.map(() => []);
  const mLat = snapM / M_PER_DEG_LAT;
  const mLonMax = snapM / (M_PER_DEG_LON_EQ * Math.max(0.2, Math.cos(Math.max(Math.abs(gy0), Math.abs(gy1)) * DEG)));
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    if (p.maxX < gx0 - mLonMax || p.minX > gx1 + mLonMax || p.maxY < gy0 - mLat || p.minY > gy1 + mLat) continue;
    const mLon = snapM / (M_PER_DEG_LON_EQ * Math.max(0.2, Math.cos(((p.minY + p.maxY) / 2) * DEG)));
    const x0 = Math.max(0, Math.floor((p.minX - mLon - gx0) / CELL_DEG));
    const x1 = Math.min(GW - 1, Math.floor((p.maxX + mLon - gx0) / CELL_DEG));
    const y0 = Math.max(0, Math.floor((p.minY - mLat - gy0) / CELL_DEG));
    const y1 = Math.min(GH - 1, Math.floor((p.maxY + mLat - gy0) / CELL_DEG));
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let gi = head[cx * GH + cy]; gi >= 0; gi = next[gi]) {
          const g = staged[gi];
          if (g.lon < p.minX - mLon || g.lon > p.maxX + mLon || g.lat < p.minY - mLat || g.lat > p.maxY + mLat) continue;
          const r = snap(g, p, pool);
          if (r.dist <= snapM) nearParts[gi].push({ part: pi, dist: r.dist, s: r.s });
        }
      }
    }
  }

  // 3. Candidates with their source parts.
  const cands: Cand[] = [];
  for (let gi = 0; gi < staged.length; gi++) {
    const near = nearParts[gi];
    if (near.length === 0) continue;
    near.sort((a, b) => a.dist - b.dist || a.part - b.part);
    const named = near.find(n => parts[n.part].name !== null);
    const name = named ? parts[named.part].name : null;
    const ref = (named ?? near[0]).dist;
    const sources = near
      .filter(n => n.dist <= ref + slack && nameOk(name, parts[n.part].name))
      .map(n => ({ part: n.part, s: n.s }));
    if (sources.length === 0) continue;
    cands.push({ id: staged[gi].id, name, sources });
  }
  stats.candidates = cands.length;
  if (cands.length === 0) return unchanged();

  // 4. Network (CSR adjacency: node -> incident parts) + bounded Dijkstra per candidate.
  const nodeId = new Map<number, number>();
  const idOf = (k: number) => {
    let v = nodeId.get(k);
    if (v === undefined) {
      v = nodeId.size;
      nodeId.set(k, v);
    }
    return v;
  };
  const sNode = new Int32Array(parts.length);
  const eNode = new Int32Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    sNode[i] = idOf(parts[i].startNode);
    eNode[i] = idOf(parts[i].endNode);
  }
  const nNodes = nodeId.size;
  const adjStart = new Int32Array(nNodes + 1);
  for (let i = 0; i < parts.length; i++) {
    adjStart[sNode[i] + 1]++;
    if (eNode[i] !== sNode[i]) adjStart[eNode[i] + 1]++;
  }
  for (let i = 0; i < nNodes; i++) adjStart[i + 1] += adjStart[i];
  const adjList = new Int32Array(adjStart[nNodes]);
  const fill = adjStart.slice(0, nNodes);
  for (let i = 0; i < parts.length; i++) {
    adjList[fill[sNode[i]]++] = i;
    if (eNode[i] !== sNode[i]) adjList[fill[eNode[i]]++] = i;
  }
  const partLen = (i: number) => pool.length(parts[i]);

  // Bridges: the NHD data has many small gaps (and reservoirs) between flowlines of one river. Every
  // loose end is joined to the nearest loose end of ANOTHER, name-compatible part within gapM.
  const bridges = new Map<number, Array<{ to: number; d: number; name: string | null }>>();
  if (gapM > 0) {
    const ends: Array<{ node: number; x: number; y: number; part: number }> = [];
    for (let n = 0; n < nNodes; n++) {
      if (adjStart[n + 1] - adjStart[n] !== 1) continue;
      const pi = adjList[adjStart[n]];
      const c = parts[pi].coords;
      const q = sNode[pi] === n ? c[0] : c[c.length - 1];
      ends.push({ node: n, x: q[0], y: q[1], part: pi });
    }
    const cell = 0.05;
    const hash = new Map<number, number[]>();
    ends.forEach((e, i) => {
      const k = Math.floor((e.x + 180) / cell) * 100_000 + Math.floor((e.y + 90) / cell);
      const a = hash.get(k);
      if (a) a.push(i);
      else hash.set(k, [i]);
    });
    const added = new Set<number>();
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i];
      const kx = M_PER_DEG_LON_EQ * Math.cos(e.y * DEG);
      const rx = Math.ceil(gapM / (kx * cell));
      const ry = Math.ceil(gapM / (M_PER_DEG_LAT * cell));
      const cx = Math.floor((e.x + 180) / cell);
      const cy = Math.floor((e.y + 90) / cell);
      let best = -1;
      let bd = gapM;
      for (let ix = cx - rx; ix <= cx + rx; ix++) {
        for (let iy = cy - ry; iy <= cy + ry; iy++) {
          const list = hash.get(ix * 100_000 + iy);
          if (!list) continue;
          for (const j of list) {
            const o = ends[j];
            if (o.part === e.part || !nameOk(parts[e.part].name, parts[o.part].name)) continue;
            const d = Math.hypot((o.x - e.x) * kx, (o.y - e.y) * M_PER_DEG_LAT);
            if (d < bd || (d === bd && best >= 0 && o.node < ends[best].node)) {
              bd = d;
              best = j;
            }
          }
        }
      }
      if (best < 0) continue;
      const o = ends[best];
      const key = Math.min(e.node, o.node) * nNodes + Math.max(e.node, o.node);
      if (added.has(key)) continue;
      added.add(key);
      const name = parts[e.part].name ?? parts[o.part].name;
      const add = (a: number, b: number) => {
        const l = bridges.get(a);
        const item = { to: b, d: bd, name };
        if (l) l.push(item);
        else bridges.set(a, [item]);
      };
      add(e.node, o.node);
      add(o.node, e.node);
    }
  }

  const onPart = new Map<number, Array<{ cand: number; s: number }>>();
  // node -> the candidates that reached it and their along-river distance (parallel arrays)
  const nodeCand: Array<number[] | undefined> = new Array(nNodes);
  const nodeDist: Array<number[] | undefined> = new Array(nNodes);
  const touched = new Uint8Array(parts.length); // parts a candidate can reach or sits on
  const stamp = new Int32Array(nNodes); // = candidate index + 1 while dcur holds that candidate's distance
  const dcur = new Float64Array(nNodes);
  const heap = new Heap();
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    const visited: number[] = [];
    const relax = (node: number, d: number) => {
      if (d > maxAlong) return;
      if (stamp[node] !== ci + 1) {
        stamp[node] = ci + 1;
        dcur[node] = d;
        visited.push(node);
      } else if (d < dcur[node]) dcur[node] = d;
      else return;
      heap.push(d, node);
    };
    for (const src of c.sources) {
      relax(sNode[src.part], src.s);
      relax(eNode[src.part], partLen(src.part) - src.s);
      touched[src.part] = 1;
      const a = onPart.get(src.part);
      if (a) a.push({ cand: ci, s: src.s });
      else onPart.set(src.part, [{ cand: ci, s: src.s }]);
    }
    while (heap.size) {
      heap.pop();
      const d = heap.topD;
      const node = heap.topN;
      if (d > dcur[node]) continue;
      for (let k = adjStart[node]; k < adjStart[node + 1]; k++) {
        const pi = adjList[k];
        if (!nameOk(c.name, parts[pi].name)) continue;
        relax(sNode[pi] === node ? eNode[pi] : sNode[pi], d + partLen(pi));
      }
      const br = bridges.get(node);
      if (br) for (const b of br) if (nameOk(c.name, b.name)) relax(b.to, d + b.d);
    }
    for (const node of visited) {
      const a = nodeCand[node];
      if (a) {
        a.push(ci);
        (nodeDist[node] as number[]).push(dcur[node]);
      } else {
        nodeCand[node] = [ci];
        nodeDist[node] = [dcur[node]];
      }
      for (let k = adjStart[node]; k < adjStart[node + 1]; k++) touched[adjList[k]] = 1;
    }
  }

  // 5. Per touched part: assign positions, cut, collect the pieces.
  interface Piece { label: string; coords: Position[] }
  const piecesOf = new Map<number, Piece[]>(); // part index -> pieces (only parts whose owner/geometry changed)
  const origOf = (fi: number): string => String(features[fi].properties?.gaugeId ?? '');

  for (let pi = 0; pi < parts.length; pi++) {
    if (!touched[pi]) continue;
    const part = parts[pi];
    const c = part.coords;
    const orig = origOf(part.feature);
    const sList = nodeCand[sNode[pi]];
    const eList = nodeCand[eNode[pi]];
    const onList = onPart.get(pi);
    // Fast path: when every candidate that can reach this part is its current owner, nothing changes.
    let foreign = false;
    if (sList) for (const ci of sList) if (cands[ci].id !== orig && nameOk(cands[ci].name, part.name)) foreign = true;
    if (!foreign && eList) for (const ci of eList) if (cands[ci].id !== orig && nameOk(cands[ci].name, part.name)) foreign = true;
    if (!foreign && onList) for (const on of onList) if (cands[on.cand].id !== orig) foreign = true;
    if (!foreign) continue;

    const cum = pool.data;
    const co = pool.at(part);
    const L = cum[co + c.length - 1];
    const opts: Opt[] = [];
    const opt = (ci: number) => {
      for (const o of opts) if (o.cand === ci) return o;
      const o: Opt = { cand: ci, dS: Infinity, dE: Infinity, onS: NaN };
      opts.push(o);
      return o;
    };
    if (sList) sList.forEach((ci, k) => { if (nameOk(cands[ci].name, part.name)) opt(ci).dS = (nodeDist[sNode[pi]] as number[])[k]; });
    if (eList) eList.forEach((ci, k) => { if (nameOk(cands[ci].name, part.name)) opt(ci).dE = (nodeDist[eNode[pi]] as number[])[k]; });
    if (onList) for (const on of onList) opt(on.cand).onS = on.s;
    opts.sort((x, y) => x.cand - y.cand); // cands are sorted by id, so ties go to the smaller id
    const value = (o: Opt, p: number) => Math.min(o.dS + p, o.dE + (L - p), o.onS === o.onS ? Math.abs(p - o.onS) : Infinity);

    // Winner at position p along the part: index into opts, -1 = keep the original gauge.
    const pick = (p: number): number => {
      let best = -1;
      let bv = maxAlong;
      for (let k = 0; k < opts.length; k++) {
        const v = value(opts[k], p);
        if (v < bv || (v === bv && best < 0)) {
          bv = v;
          best = k;
        }
      }
      // A candidate within TIE_M of the best that is already this part's owner keeps it (a cut point is
      // an exact tie, so without this a second run would flip the vertex on the cut).
      if (best >= 0 && cands[opts[best].cand].id !== orig) {
        for (let k = 0; k < opts.length; k++) {
          if (cands[opts[k].cand].id === orig && value(opts[k], p) <= bv + TIE_M) return k;
        }
      }
      return best;
    };
    const labelOf = (w: number) => (w < 0 ? orig : cands[opts[w].cand].id);
    const win = new Int32Array(c.length);
    let allOrig = true;
    for (let i = 0; i < c.length; i++) {
      win[i] = pick(cum[co + i]);
      if (win[i] >= 0 && labelOf(win[i]) !== orig) allOrig = false;
    }
    if (allOrig) continue;

    const pieces: Piece[] = [];
    let cur: Position[] = [c[0]];
    let curW = win[0];
    for (let i = 0; i < c.length - 1; i++) {
      const a = c[i];
      const b = c[i + 1];
      const wb = win[i + 1];
      if (labelOf(curW) === labelOf(wb)) {
        cur.push(b);
        continue;
      }
      // Cut where the winner changes: bisect on position (the distance functions have kinks, so no closed form).
      const labA = labelOf(curW);
      let lo = cum[co + i];
      let hi = cum[co + i + 1];
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        if (labelOf(pick(mid)) === labA) lo = mid;
        else hi = mid;
      }
      const span = cum[co + i + 1] - cum[co + i];
      let t = span > 0 ? ((lo + hi) / 2 - cum[co + i]) / span : 0.5;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let cut: Position | null = null;
      if (t > 0 && t < 1) {
        const q: Position = [
          Math.round((a[0] + t * (b[0] - a[0])) * 1e5) / 1e5,
          Math.round((a[1] + t * (b[1] - a[1])) * 1e5) / 1e5,
        ];
        if (q[0] === a[0] && q[1] === a[1]) t = 0;
        else if (q[0] === b[0] && q[1] === b[1]) t = 1;
        else cut = q;
      }
      if (cut) {
        cur.push(cut);
        pieces.push({ label: labelOf(curW), coords: cur });
        cur = [cut, b];
      } else if (t === 0) {
        pieces.push({ label: labelOf(curW), coords: cur });
        cur = [a, b];
      } else {
        cur.push(b);
        pieces.push({ label: labelOf(curW), coords: cur });
        cur = [b];
      }
      curW = wb;
    }
    pieces.push({ label: labelOf(curW), coords: cur });

    // A sliver (cut points are rounded to ~1 m) joins the neighbouring piece instead of becoming a feature of its own.
    if (pieces.length > 1) {
      for (let k = 0; k < pieces.length; k++) {
        let len = 0;
        for (let q = 1; q < pieces[k].coords.length; q++) len += segLen(pieces[k].coords[q - 1], pieces[k].coords[q]);
        if (len < MIN_PIECE_M) pieces[k].label = k > 0 ? pieces[k - 1].label : pieces[k + 1].label;
      }
    }
    // Drop zero-length pieces; merge neighbours that ended up with the same label.
    const kept: Piece[] = [];
    for (const pc of pieces) {
      if (pc.coords.length < 2) continue;
      const f = pc.coords[0];
      if (pc.coords.every(q => q[0] === f[0] && q[1] === f[1])) continue;
      const last = kept[kept.length - 1];
      if (last && last.label === pc.label) last.coords = last.coords.concat(pc.coords.slice(1));
      else kept.push(pc);
    }
    if (kept.length === 0) continue;
    if (kept.length === 1 && kept[0].label === orig && kept[0].coords.length === c.length) continue; // nothing actually changed
    piecesOf.set(pi, kept);
    stats.partsTouched++;
    let n = 0;
    for (const pc of kept) n += pc.coords.length;
    stats.addedVertices += n - c.length;
  }

  // 6. Rebuild changed features; everything else passes through as the same object.
  const changed = new Set<number>();
  for (const pi of piecesOf.keys()) changed.add(parts[pi].feature);
  const out: Feature<Geometry, Props>[] = [];
  const origin: number[] = [];
  for (let fi = 0; fi < features.length; fi++) {
    const f = features[fi];
    if (!changed.has(fi)) {
      out.push(f);
      origin.push(fi);
      continue;
    }
    const orig = origOf(fi);
    const geom = f.geometry as Geometry;
    const lines: unknown[] = geom.type === 'LineString' ? [geom.coordinates] : (geom as { coordinates: unknown[] }).coordinates;
    const groups = new Map<string, unknown[]>();
    const add = (label: string, coords: unknown) => {
      const g = groups.get(label);
      if (g) g.push(coords);
      else groups.set(label, [coords]);
    };
    for (let li = 0; li < lines.length; li++) {
      const pi = partOf.get(fi * 1e6 + li);
      const pcs = pi === undefined ? undefined : piecesOf.get(pi);
      if (pcs) for (const pc of pcs) add(pc.label, pc.coords);
      else add(orig, lines[li]);
    }
    for (const [label, ls] of groups) {
      const geometry = (ls.length === 1
        ? { type: 'LineString', coordinates: ls[0] }
        : { type: 'MultiLineString', coordinates: ls }) as Geometry;
      out.push({ ...f, properties: { ...(f.properties ?? {}), gaugeId: label }, geometry });
      origin.push(fi);
    }
  }
  stats.featuresChanged = changed.size;
  stats.featuresOut = out.length;
  stats.riverFeaturesOut = out.reduce((n, f) => n + (f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString' ? 1 : 0), 0);
  return { collection: { ...collection, features: out }, stats, origin };
}

/**
 * Re-owns river stretches by along-river nearest flood-staged gauge. Returns a
 * new FeatureCollection; the input is never mutated, and features that no
 * candidate reaches are returned as the same objects.
 */
export function segmentWaterways<P = Props>(
  collection: FeatureCollection<Geometry, P>,
  gauges: readonly RiverGauge[],
  options?: SegmentOptions,
): FeatureCollection<Geometry, P> {
  return segmentWaterwaysDetailed(collection as unknown as FeatureCollection<Geometry, Props>, gauges, options).collection as unknown as FeatureCollection<Geometry, P>;
}
