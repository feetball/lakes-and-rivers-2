// "Which gauge WITH flood stages stands in for this river?" For a gauge NWS has no flood
// stages for, the nearest flood-staged gauge on the same river is the only official
// reference there is.
//
// It reads the answer off the re-segmented rivers (src/lib/riverSegments.ts), the same data
// that colours the map: the stretch of river under a gauge without flood stages is owned by
// the flood-staged gauge nearest ALONG THE RIVER (same river name, within MAX_ALONG_M). So the
// sheet and the map always agree on which gauge a stretch of river is coloured by, and this
// module needs no river network of its own. A stretch no flood-staged gauge reaches keeps an
// owner without flood stages, and then there is no neighbour: better none than a wrong one.
//
// Not known, so never said: whether the neighbour is upstream or downstream. The flowlines
// come in no particular direction (see riverSegments.ts) and gauges-meta.json has no
// upstream/downstream ids. The distance is a straight line, which is never more than the
// distance along the river.
//
// Pure module (no React / Next / Leaflet imports) so node:test can import it.

import type { FeatureCollection, Geometry } from 'geojson';
import { MAX_ALONG_M, SNAP_M, SOURCE_SLACK_M, hasFloodStages, type GaugeLike } from './riverSegments';

export interface RiverNeighbor {
  /** The flood-staged gauge. */
  id: string;
  /** Straight-line distance to it (km). */
  distanceKm: number;
}

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQ = 111_320;
const DEG = Math.PI / 180;

/** Straight-line metres between two points (equirectangular: exact enough under 100 km). */
function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  const dx = (bLon - aLon) * M_PER_DEG_LON_EQ * Math.cos(((aLat + bLat) / 2) * DEG);
  return Math.hypot(dx, dy);
}

/**
 * Closest approach (m) of the point to a polyline of [lon, lat] vertices, or Infinity when no
 * part of it is within `limitM`. Segments wholly beyond the limit on one side are skipped
 * before any maths: nearly all of them are, and this runs on every sheet that opens.
 */
function distanceToLine(lat: number, lon: number, line: ArrayLike<ArrayLike<number>>, limitM: number): number {
  const kx = M_PER_DEG_LON_EQ * Math.cos(lat * DEG);
  let bestSq = limitM * limitM;
  let found = false;
  let bx = (line[0][0] - lon) * kx;
  let by = (line[0][1] - lat) * M_PER_DEG_LAT;
  for (let i = 1; i < line.length; i++) {
    const ax = bx;
    const ay = by;
    bx = (line[i][0] - lon) * kx;
    by = (line[i][1] - lat) * M_PER_DEG_LAT;
    if ((ax > limitM && bx > limitM) || (ax < -limitM && bx < -limitM) || (ay > limitM && by > limitM) || (ay < -limitM && by < -limitM)) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx;
    const ey = ay + t * dy;
    const dSq = ex * ex + ey * ey;
    if (dSq <= bestSq) {
      bestSq = dSq;
      found = true;
    }
  }
  return found ? Math.sqrt(bestSq) : Infinity;
}

/**
 * The flood-staged gauge that owns the stretch of river `gauge` sits on, or null. `rivers`
 * must be the SEGMENTED waterways (segmentWaterways output; only the river lines are read, a
 * lake polygon says nothing: the build gives every pond to some nearby gauge); `gauges` supplies each owner's
 * position and thresholds (id -> gauge). Null when:
 *  - the gauge itself has flood stages (it needs no stand-in),
 *  - no river line passes within SNAP_M of it,
 *  - the stretch's owner has no flood stages, is unknown, or is farther than MAX_ALONG_M.
 * When several owners reach the spot (a confluence, or the cut between two gauges) the
 * nearest one wins.
 */
export function findStagedNeighbor(
  rivers: FeatureCollection<Geometry, object> | null | undefined,
  gauge: GaugeLike,
  gauges: Readonly<Record<string, GaugeLike | undefined>>,
): RiverNeighbor | null {
  if (!rivers || !Array.isArray(rivers.features)) return null;
  if (!Number.isFinite(gauge.lat) || !Number.isFinite(gauge.lon) || hasFloodStages(gauge.thresholds)) return null;

  const nearest = new Map<string, number>(); // owner id -> metres to the closest of its river lines
  let closest = Infinity;
  for (const f of rivers.features) {
    const geom = f?.geometry;
    if (!geom) continue;
    const owner = (f.properties as { gaugeId?: unknown } | null)?.gaugeId;
    if (typeof owner !== 'string') continue;
    const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : null;
    if (!lines) continue;
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2) continue;
      const d = distanceToLine(gauge.lat, gauge.lon, line, SNAP_M + SOURCE_SLACK_M);
      if (d < (nearest.get(owner) ?? Infinity)) nearest.set(owner, d);
      if (d < closest) closest = d;
    }
  }
  if (closest > SNAP_M) return null;

  let best: RiverNeighbor | null = null;
  for (const [id, d] of nearest) {
    if (d > closest + SOURCE_SLACK_M || id === gauge.id) continue;
    const g = gauges[id];
    if (!g || !hasFloodStages(g.thresholds) || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    const m = metres(gauge.lat, gauge.lon, g.lat, g.lon);
    if (m > MAX_ALONG_M) continue;
    if (!best || m < best.distanceKm * 1000 || (m === best.distanceKm * 1000 && id < best.id)) best = { id, distanceKm: m / 1000 };
  }
  return best;
}
