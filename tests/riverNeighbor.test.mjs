// Tests for the "nearest gauge with flood stages on this river" lookup (src/lib/riverNeighbor.ts),
// which reads the owner of the river stretch under a gauge off the segmented waterways.
// Synthetic rivers for the rules, the real waterways + gauges-meta.json for what it finds in Texas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import './helpers/ts-imports.mjs';

const { findStagedNeighbor } = await import('../src/lib/riverNeighbor.ts');
const { MAX_ALONG_M, hasFloodStages, segmentWaterways, toRiverGauges } = await import('../src/lib/riverSegments.ts');

const LAT = 30;
const KM_PER_DEG_LON = 111.32 * Math.cos((LAT * Math.PI) / 180); // 96.4 km
const lon = (km) => -100 + km / KM_PER_DEG_LON; // a point `km` east of -100
const line = (gaugeId, fromKm, toKm, lat = LAT) => ({
  type: 'Feature',
  properties: { gaugeId, name: 'Test River' },
  geometry: { type: 'LineString', coordinates: [[lon(fromKm), lat], [lon(toKm), lat]] },
});
const fc = (...features) => ({ type: 'FeatureCollection', features });
const STAGES = { action: 5, minor: 8, moderate: 10, major: 15 };
const NONE = { action: null, minor: null, moderate: null, major: null };
const gauge = (id, km, thresholds = NONE, lat = LAT) => ({ id, lat, lon: lon(km), thresholds });
const index = (...gs) => Object.fromEntries(gs.map((g) => [g.id, g]));

test('a gauge without flood stages finds the flood-staged gauge that owns its stretch of river', () => {
  const n = gauge('N', 10);
  const s = gauge('S', 22, STAGES);
  const r = findStagedNeighbor(fc(line('S', 0, 40)), n, index(n, s));
  assert.equal(r.id, 'S');
  assert.ok(Math.abs(r.distanceKm - 12) < 0.05, `${r.distanceKm} km`);
});

test('a gauge that has flood stages needs no stand-in', () => {
  const a = gauge('A', 10, STAGES);
  const b = gauge('B', 22, STAGES);
  assert.equal(findStagedNeighbor(fc(line('B', 0, 40)), a, index(a, b)), null);
});

test('no neighbour when its own stretch still belongs to a gauge without flood stages (none reached it)', () => {
  const n = gauge('N', 10);
  const other = gauge('O', 25); // also without stages
  assert.equal(findStagedNeighbor(fc(line('N', 0, 40)), n, index(n, other)), null);
  assert.equal(findStagedNeighbor(fc(line('O', 0, 40)), n, index(n, other)), null);
});

test('no neighbour when the owner is unknown, or has no usable position', () => {
  const n = gauge('N', 10);
  assert.equal(findStagedNeighbor(fc(line('GHOST', 0, 40)), n, index(n)), null);
  const nowhere = { id: 'S', lat: Number.NaN, lon: Number.NaN, thresholds: STAGES };
  assert.equal(findStagedNeighbor(fc(line('S', 0, 40)), n, index(n, nowhere)), null);
});

test('no neighbour farther than 40 km (a straight line is never longer than the river)', () => {
  const n = gauge('N', 0);
  const near = gauge('S', MAX_ALONG_M / 1000 - 1, STAGES);
  const far = gauge('S', MAX_ALONG_M / 1000 + 1, STAGES);
  assert.equal(findStagedNeighbor(fc(line('S', -5, 60)), n, index(n, near))?.id, 'S');
  assert.equal(findStagedNeighbor(fc(line('S', -5, 60)), n, index(n, far)), null);
});

test('no neighbour for a gauge that is not on a mapped river (more than 750 m from every line)', () => {
  const s = gauge('S', 22, STAGES);
  const onIt = gauge('N', 10);
  const off = gauge('N', 10, NONE, LAT + 0.02); // 2.2 km north
  const river = fc(line('S', 0, 40));
  assert.equal(findStagedNeighbor(river, onIt, index(onIt, s))?.id, 'S');
  assert.equal(findStagedNeighbor(river, off, index(off, s)), null);
});

test('where two flood-staged gauges meet at the gauge, the nearer one wins; a far river does not count', () => {
  const n = gauge('N', 20);
  const west = gauge('W', 5, STAGES); // 15 km
  const east = gauge('E', 28, STAGES); // 8 km
  const river = fc(line('W', 0, 20), line('E', 20, 40));
  assert.equal(findStagedNeighbor(river, n, index(n, west, east)).id, 'E');
  // a parallel river 5 km away with its own owner is not "this" river
  const other = gauge('P', 21, STAGES, LAT + 0.045);
  const two = fc(line('W', 0, 40), { ...line('P', 0, 40, LAT + 0.045) });
  assert.equal(findStagedNeighbor(two, n, index(n, west, other)).id, 'W');
});

test('lakes (polygons) are ignored: only river lines say which gauge a river belongs to', () => {
  const n = gauge('N', 10);
  const s = gauge('S', 22, STAGES);
  const pond = { type: 'Feature', properties: { gaugeId: 'N', name: null }, geometry: { type: 'Polygon', coordinates: [[[-100, 30], [-99.9, 30], [-99.9, 30.1], [-100, 30]]] } };
  assert.equal(findStagedNeighbor(fc(pond, line('S', 0, 40)), n, index(n, s)).id, 'S');
});

test('multi-part rivers and malformed input', () => {
  const n = gauge('N', 10);
  const s = gauge('S', 22, STAGES);
  const multi = { type: 'Feature', properties: { gaugeId: 'S' }, geometry: { type: 'MultiLineString', coordinates: [[[lon(-9), LAT], [lon(5), LAT]], [[lon(5), LAT], [lon(40), LAT]]] } };
  assert.equal(findStagedNeighbor(fc(multi), n, index(n, s)).id, 'S');
  for (const bad of [null, undefined, {}, { features: null }, fc({}), fc({ geometry: null }), fc({ properties: { gaugeId: 'S' }, geometry: { type: 'LineString', coordinates: [] } }), fc({ properties: { gaugeId: 'S' }, geometry: { type: 'Point', coordinates: [0, 0] } })]) {
    assert.equal(findStagedNeighbor(bad, n, index(n, s)), null);
  }
  assert.equal(findStagedNeighbor(fc(line('S', 0, 40)), { id: 'N', lat: Number.NaN, lon: 0, thresholds: NONE }, index(n, s)), null);
});

// ---- real data -------------------------------------------------------------

const DATA = new URL('../public/data/', import.meta.url);
const haveData = existsSync(new URL('waterways.geojson', DATA)) && existsSync(new URL('gauges-meta.json', DATA));

test('real data: Texas gauges without flood stages find the real gauge their river is coloured by', { skip: !haveData }, () => {
  const waterways = JSON.parse(readFileSync(new URL('waterways.geojson', DATA), 'utf8'));
  const meta = JSON.parse(readFileSync(new URL('gauges-meta.json', DATA), 'utf8')).gauges;
  const byId = Object.fromEntries(meta.map((g) => [g.id, g]));
  const rivers = segmentWaterways(waterways, toRiverGauges(meta));
  const find = (id) => findStagedNeighbor(rivers, byId[id], byId);

  // Llano River at CR 102 used to own the whole Llano; its stretch now belongs to Llano at Llano, 14 km away
  assert.equal(find('LRTT2').id, 'LLAT2');
  assert.ok(Math.abs(find('LRTT2').distanceKm - 14) < 2);
  // Guadalupe above Bear Creek is 3.6 km from Guadalupe at Kerrville (KRRT2)
  assert.equal(find('GRHT2').id, 'KRRT2');
  assert.ok(find('GRHT2').distanceKm < 5);
  // Austin creeks
  assert.equal(find('ASHT2').id, 'AHOT2'); // Shoal Creek
  assert.equal(find('BCCT2').id, 'ABTT2'); // Barton Creek
  // a staged gauge needs none; the North Fork at Hunt is on a river no flood-staged gauge reaches
  assert.equal(find('KRRT2'), null);
  assert.equal(find('HNFT2'), null);

  const none = meta.filter((g) => !hasFloodStages(g.thresholds));
  const found = none.map((g) => ({ g, n: find(g.id) })).filter((x) => x.n);
  assert.ok(found.length >= 50 && found.length < none.length, `${found.length} of ${none.length}`);
  for (const { g, n } of found) {
    assert.notEqual(n.id, g.id);
    assert.ok(hasFloodStages(byId[n.id].thresholds), `${g.id} -> ${n.id} has flood stages`);
    assert.ok(n.distanceKm > 0 && n.distanceKm <= MAX_ALONG_M / 1000, `${g.id} -> ${n.id} ${n.distanceKm} km`);
  }
});
