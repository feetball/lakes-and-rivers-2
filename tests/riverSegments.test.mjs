// Unit tests for src/lib/riverSegments.ts (river re-segmentation): synthetic
// rivers for every rule, then the real waterways file for the Llano case.
// Run: pnpm test   (Node >= 22.18 strips the TypeScript types.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  GAP_M,
  MAX_ALONG_M,
  SNAP_M,
  hasFloodStages,
  segmentWaterways,
  segmentWaterwaysDetailed,
  stagedSignature,
  toRiverGauges,
} from '../src/lib/riverSegments.ts';

// ---- helpers ---------------------------------------------------------------

const LAT = 30;
const DLON_PER_KM = 1 / (111.32 * Math.cos((LAT * Math.PI) / 180)); // degrees of longitude per km at LAT
const lonAt = (km) => Math.round((-99 + km * DLON_PER_KM) * 1e5) / 1e5; // km east of -99.0
/** A W-E line from `fromKm` to `toKm` with a vertex every `step` km. */
function line(fromKm, toKm, step = 1) {
  const pts = [];
  for (let k = fromKm; k <= toKm + 1e-9; k += step) pts.push([lonAt(k), LAT]);
  return pts;
}
const gauge = (id, km, dLatM = 0, hasThresholds = true) => ({
  id,
  lat: LAT + dLatM / 110574,
  lon: lonAt(km),
  hasThresholds,
});
const feat = (coords, props = {}) => ({
  type: 'Feature',
  properties: { gaugeId: 'ORIG', name: 'Test River', ftype: 460, nhdId: null, ...props },
  geometry: Array.isArray(coords[0][0])
    ? { type: 'MultiLineString', coordinates: coords }
    : { type: 'LineString', coordinates: coords },
});
const fc = (...features) => ({ type: 'FeatureCollection', features });
const lines = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []);
const owners = (out) => out.features.map((f) => f.properties.gaugeId);
/** Gauge id of the output line that covers this position (km east of the start); null if none does. */
function ownerAt(out, km) {
  const lon = lonAt(km);
  for (const f of out.features) for (const c of lines(f.geometry)) {
    for (let i = 0; i < c.length - 1; i++) {
      if (Math.min(c[i][0], c[i + 1][0]) <= lon && lon <= Math.max(c[i][0], c[i + 1][0])) return f.properties.gaugeId;
    }
  }
  return null;
}
const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};
const totalKm = (out) => {
  let m = 0;
  for (const f of out.features) for (const c of lines(f.geometry)) for (let i = 1; i < c.length; i++) {
    m += Math.hypot((c[i][0] - c[i - 1][0]) / DLON_PER_KM, (c[i][1] - c[i - 1][1]) * 110.574);
  }
  return m;
};

// ---- synthetic cases -------------------------------------------------------

test('helpers: hasFloodStages / toRiverGauges / stagedSignature', () => {
  assert.equal(hasFloodStages(null), false);
  assert.equal(hasFloodStages({ action: -9999, minor: -999, moderate: null, major: null }), false);
  assert.equal(hasFloodStages({ action: null, minor: 18, moderate: null, major: null }), true);
  assert.equal(hasFloodStages({ action: 0, minor: null, moderate: null, major: null }), true);
  assert.equal(hasFloodStages({ action: NaN, minor: undefined }), false);
  const g = toRiverGauges([
    { id: 'B', lat: 1, lon: 2, thresholds: { action: 3, minor: null, moderate: null, major: null } },
    { id: 'A', lat: 1, lon: 2, thresholds: null },
    null,
  ]);
  assert.deepEqual(g.map((x) => [x.id, x.hasThresholds]), [['B', true], ['A', false]]);
  // order independent, ignores gauges without stages
  assert.equal(stagedSignature(g), stagedSignature([...g].reverse()));
  assert.equal(stagedSignature(g), 'B@1.00000,2.00000');
});

test('two gauges on one line split it at the midpoint', () => {
  const input = fc(feat(line(0, 20)));
  const { collection: out, stats } = segmentWaterwaysDetailed(input, [gauge('A', 5), gauge('B', 15)]);
  assert.equal(out.features.length, 2); // merged runs: one feature per owner, not one per vertex
  assert.deepEqual(owners(out).sort(), ['A', 'B']);
  assert.equal(ownerAt(out, 2), 'A');
  assert.equal(ownerAt(out, 9.5), 'A');
  assert.equal(ownerAt(out, 10.5), 'B');
  assert.equal(ownerAt(out, 18), 'B');
  // the cut is at 10 km: both sides contain it as an endpoint
  const cut = lonAt(10);
  const ends = out.features.flatMap((f) => lines(f.geometry).flatMap((c) => [c[0][0], c[c.length - 1][0]]));
  assert.ok(ends.some((e) => Math.abs(e - cut) < 2e-5));
  // no gap and no overlap: length is conserved
  assert.ok(Math.abs(totalKm(out) - totalKm(input)) < 0.01);
  assert.equal(stats.featuresChanged, 1);
  assert.equal(stats.featuresIn, 1);
  assert.equal(stats.featuresOut, 2);
});

test('cut falls inside a long segment: the boundary vertex is interpolated and shared', () => {
  const input = fc(feat([[lonAt(0), LAT], [lonAt(20), LAT]])); // one 20 km segment
  const out = segmentWaterways(input, [gauge('A', 4), gauge('B', 12)]); // midpoint at 8 km
  assert.equal(out.features.length, 2);
  const a = out.features.find((f) => f.properties.gaugeId === 'A').geometry.coordinates;
  const b = out.features.find((f) => f.properties.gaugeId === 'B').geometry.coordinates;
  assert.deepEqual(a[a.length - 1], b[0]); // join without a gap
  assert.ok(Math.abs(a[a.length - 1][0] - lonAt(8)) < 2e-5);
  assert.deepEqual(a[0], [lonAt(0), LAT]); // original end points keep their exact coordinates
  assert.deepEqual(b[b.length - 1], [lonAt(20), LAT]);
});

test('a gauge without flood stages is ignored when a flood-staged one is on the line', () => {
  const out = segmentWaterways(fc(feat(line(0, 20))), [gauge('NOSTAGE', 8, 0, false), gauge('S', 12)]);
  assert.deepEqual(owners(out), ['S']);
  // and a lone no-stage gauge changes nothing
  const input = fc(feat(line(0, 20)));
  const same = segmentWaterways(input, [gauge('NOSTAGE', 8, 0, false)]);
  assert.equal(same.features[0], input.features[0]);
});

test('the original owner competes like any other candidate', () => {
  const out = segmentWaterways(fc(feat(line(0, 20), { gaugeId: 'A' })), [gauge('A', 5), gauge('B', 15)]);
  assert.deepEqual(owners(out).sort(), ['A', 'B']);
  assert.equal(ownerAt(out, 2), 'A');
  assert.equal(ownerAt(out, 18), 'B');
  // a flood-staged owner that is NOT within SNAP_M of its river loses reach to one that is
  const lost = segmentWaterways(fc(feat(line(0, 20), { gaugeId: 'FAR' })), [gauge('FAR', 10, SNAP_M * 3), gauge('B', 15)]);
  assert.deepEqual(owners(lost), ['B']);
});

test('a gauge farther than SNAP_M from the line is ignored; one just inside is used', () => {
  const input = fc(feat(line(0, 20)));
  const far = segmentWaterways(input, [gauge('S', 10, SNAP_M + 60)]);
  assert.equal(far.features[0], input.features[0]);
  assert.deepEqual(owners(far), ['ORIG']);
  const near = segmentWaterways(input, [gauge('S', 10, SNAP_M - 60)]);
  assert.deepEqual(owners(near), ['S']);
});

test('MAX_ALONG_M: stretches farther than 40 km along the river from every candidate keep the original gauge', () => {
  assert.equal(MAX_ALONG_M, 40_000);
  const out = segmentWaterways(fc(feat(line(0, 80, 2))), [gauge('S', 10)]);
  assert.deepEqual(owners(out).sort(), ['ORIG', 'S']);
  assert.equal(ownerAt(out, 30), 'S'); // 20 km away
  assert.equal(ownerAt(out, 49), 'S'); // 39 km away
  assert.equal(ownerAt(out, 52), 'ORIG'); // 42 km away
  assert.equal(ownerAt(out, 78), 'ORIG');
  // the cut is at exactly 50 km
  const s = out.features.find((f) => f.properties.gaugeId === 'S').geometry.coordinates;
  const end = (Array.isArray(s[0][0]) ? s[s.length - 1] : s).slice(-1)[0];
  assert.ok(Math.abs(end[0] - lonAt(50)) < 3e-5);
});

test('a MultiLineString: parts that join form one river, disconnected parts stay separate', () => {
  // three flowlines end to end (0-5, 5-10, 10-15), then a separate piece 30 km away (45-50)
  const parts = [line(10, 15), line(0, 5), line(5, 10)]; // deliberately out of order
  const joined = segmentWaterways(fc(feat(parts)), [gauge('S', 2)]);
  assert.deepEqual(owners(joined), ['S']); // reaches all three parts through the shared end points

  const split = segmentWaterways(fc(feat([...parts, line(45, 50)])), [gauge('S', 2)]);
  assert.deepEqual(owners(split).sort(), ['ORIG', 'S']);
  const orig = split.features.find((f) => f.properties.gaugeId === 'ORIG');
  assert.equal(lines(orig.geometry).length, 1);
  assert.equal(orig.geometry.type, 'LineString');
  assert.deepEqual(orig.geometry.coordinates[0], [lonAt(45), LAT]);
  const s = split.features.find((f) => f.properties.gaugeId === 'S');
  assert.equal(s.geometry.type, 'MultiLineString');
  assert.equal(lines(s.geometry).length, 3);
});

test('a reversed part still joins by its end points', () => {
  const out = segmentWaterways(fc(feat([line(0, 5), line(5, 10).reverse()])), [gauge('S', 1)]);
  assert.deepEqual(owners(out), ['S']);
});

test('small gaps between same-named flowlines are bridged, large ones and other rivers are not', () => {
  assert.equal(GAP_M, 1000);
  const gap = (km) => [line(0, 5), line(5 + km, 10 + km)];
  assert.deepEqual(owners(segmentWaterways(fc(feat(gap(0.4))), [gauge('S', 1)])), ['S']);
  assert.deepEqual(owners(segmentWaterways(fc(feat(gap(0.4))), [gauge('S', 1)], { gapM: 0 })).sort(), ['ORIG', 'S']);
  assert.deepEqual(owners(segmentWaterways(fc(feat(gap(3))), [gauge('S', 1)])).sort(), ['ORIG', 'S']);
  // a differently named river on the other side of a small gap is not claimed
  const out = segmentWaterways(fc(feat([line(0, 5)]), feat([line(5.4, 10)], { name: 'Other Creek', gaugeId: 'OTHER' })), [gauge('S', 1)]);
  assert.deepEqual(owners(out), ['S', 'OTHER']);
});

test('a tributary with another name is not claimed by a gauge on the main river', () => {
  // main: 0-10 km; tributary joins at 10 km and runs north-east
  const trib = [[lonAt(10), LAT], [lonAt(11), LAT + 0.01], [lonAt(12), LAT + 0.02]];
  const input = fc(feat(line(0, 10)), feat(trib, { name: 'Side Creek', gaugeId: 'TRIB' }));
  const out = segmentWaterways(input, [gauge('S', 5)]);
  assert.deepEqual(owners(out), ['S', 'TRIB']);
  assert.equal(out.features[1], input.features[1]); // untouched feature is the same object
  // an unnamed gauge-source (name null on both sides) joins anything
  const unnamed = segmentWaterways(fc(feat(line(0, 10), { name: null }), feat(trib, { name: null, gaugeId: 'T2' })), [gauge('S', 5)]);
  assert.deepEqual(owners(unnamed), ['S', 'S']); // both features are now S's
});

test('properties are copied, geometry only changes where owners change, lakes are untouched', () => {
  const lake = {
    type: 'Feature',
    properties: { gaugeId: 'LAKE', name: 'Lake X', ftype: 390, nhdId: '1' },
    geometry: { type: 'Polygon', coordinates: [[[-99, 30], [-98.9, 30], [-98.9, 30.1], [-99, 30]]] },
  };
  const point = { type: 'Feature', properties: { gaugeId: 'P' }, geometry: { type: 'Point', coordinates: [-99, 30] } };
  const input = fc(lake, feat(line(0, 20), { ftype: 558, nhdId: '42', extra: 'keep' }), point);
  const out = segmentWaterways(input, [gauge('A', 5), gauge('B', 15)]);
  assert.equal(out.features[0], lake);
  assert.equal(out.features[out.features.length - 1], point);
  for (const f of out.features.slice(1, -1)) {
    assert.equal(f.type, 'Feature');
    assert.equal(f.properties.name, 'Test River');
    assert.equal(f.properties.ftype, 558);
    assert.equal(f.properties.nhdId, '42');
    assert.equal(f.properties.extra, 'keep');
  }
  // every original vertex survives with exactly its original coordinates
  const all = new Set(out.features.slice(1, -1).flatMap((f) => lines(f.geometry).flat().map((p) => p.join(','))));
  for (const p of input.features[1].geometry.coordinates) assert.ok(all.has(p.join(',')));
  // coordinate order is preserved within every piece (west to east)
  for (const f of out.features.slice(1, -1)) for (const c of lines(f.geometry)) {
    for (let i = 1; i < c.length; i++) assert.ok(c[i][0] > c[i - 1][0]);
  }
});

test('features no candidate reaches are returned as the same objects, in the same order', () => {
  const a = feat(line(0, 5), { gaugeId: 'X' });
  const b = feat(line(100, 105), { gaugeId: 'Y' });
  const out = segmentWaterways(fc(a, b), [gauge('S', 2)]);
  assert.equal(out.features.length, 2);
  assert.notEqual(out.features[0], a);
  assert.equal(out.features[1], b);
});

test('idempotent: running it on its own output changes nothing', () => {
  const input = fc(feat([line(10, 15), line(0, 5), line(5, 10), line(20, 25), line(15, 20)]), feat(line(60, 80, 2), { gaugeId: 'Z' }));
  const gs = [gauge('A', 3), gauge('B', 12), gauge('C', 22), gauge('D', 70)];
  const once = segmentWaterways(input, gs);
  const twice = segmentWaterways(once, gs);
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
  const thrice = segmentWaterways(twice, gs);
  assert.equal(JSON.stringify(thrice), JSON.stringify(once));
});

test('deterministic: gauge order does not matter, equal distances go to the smaller id', () => {
  const input = fc(feat(line(0, 20)));
  const a = segmentWaterways(input, [gauge('A', 5), gauge('B', 15), gauge('C', 10)]);
  const b = segmentWaterways(input, [gauge('C', 10), gauge('B', 15), gauge('A', 5)]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // two gauges at the same spot: the smaller id wins
  const tie = segmentWaterways(input, [gauge('Z', 10), gauge('M', 10)]);
  assert.deepEqual(owners(tie), ['M']);
});

test('the input is never mutated', () => {
  const input = deepFreeze(fc(feat([line(0, 10), line(10, 20)]), feat(line(40, 50), { gaugeId: 'Q' })));
  const gs = deepFreeze([gauge('A', 3), gauge('B', 17)]);
  assert.doesNotThrow(() => segmentWaterways(input, gs));
  const out = segmentWaterways(input, gs);
  assert.notEqual(out, input);
  assert.notEqual(out.features, input.features);
});

test('empty and garbage input never throws and degrades to "nothing changes"', () => {
  const gs = [gauge('A', 5)];
  assert.deepEqual(segmentWaterways(null, gs), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(segmentWaterways(undefined, gs), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(segmentWaterways({}, gs), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(segmentWaterways({ type: 'FeatureCollection', features: 'x' }, gs), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(segmentWaterways(fc(), gs).features, []);
  const input = fc(feat(line(0, 10)));
  for (const bad of [undefined, null, [], [null], [{}], [{ id: 5 }], [{ id: 'A', lat: NaN, lon: 1, hasThresholds: true }], 'nope']) {
    const out = segmentWaterways(input, bad);
    assert.equal(out.features.length, 1);
    assert.equal(out.features[0], input.features[0]);
  }
  const junk = fc(
    null,
    { type: 'Feature', properties: null, geometry: null },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: 'nope' } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[1, 2]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [['a', 'b'], ['c', 'd']] } },
    { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [null, [[NaN, 1], [2, 3]], 'x'] } },
    { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [] } },
    feat(line(0, 10)),
  );
  let out;
  assert.doesNotThrow(() => { out = segmentWaterways(junk, gs); });
  assert.ok(out.features.length >= junk.features.length - 1);
  // gauge with out-of-range coordinates
  assert.doesNotThrow(() => segmentWaterways(input, [{ id: 'A', lat: 999, lon: -999, hasThresholds: true }]));
});

test('few features: a 2-gauge river yields 2 features, not one per vertex', () => {
  const { stats } = segmentWaterwaysDetailed(fc(feat(line(0, 40, 0.5))), [gauge('A', 10), gauge('B', 30)]);
  assert.equal(stats.riverFeaturesIn, 1);
  assert.equal(stats.riverFeaturesOut, 2);
  assert.ok(stats.addedVertices <= 4);
});

// ---- real data -------------------------------------------------------------

const DATA = new URL('../public/data/', import.meta.url);
const haveData = existsSync(new URL('waterways.geojson', DATA)) && existsSync(new URL('gauges-meta.json', DATA));

test('real data: the Llano River around Mason (MLRT2, Action) is owned by MLRT2', { skip: !haveData }, () => {
  const waterways = JSON.parse(readFileSync(new URL('waterways.geojson', DATA), 'utf8'));
  const meta = JSON.parse(readFileSync(new URL('gauges-meta.json', DATA), 'utf8')).gauges;
  const gauges = toRiverGauges(meta);
  const byId = new Map(meta.map((g) => [g.id, g]));
  const mlrt2 = byId.get('MLRT2');
  assert.ok(mlrt2 && hasFloodStages(mlrt2.thresholds));
  const { collection: out, stats } = segmentWaterwaysDetailed(waterways, gauges);

  const km = (g) => {
    let m = 0;
    for (const c of lines(g)) for (let i = 1; i < c.length; i++) {
      const dy = (c[i][1] - c[i - 1][1]) * 110.574;
      const dx = (c[i][0] - c[i - 1][0]) * 111.32 * Math.cos(((c[i][1] + c[i - 1][1]) / 2) * Math.PI / 180);
      m += Math.hypot(dx, dy);
    }
    return m;
  };
  const dist = (g, p) => Math.hypot((p[0] - g.lon) * 111.32 * Math.cos(g.lat * Math.PI / 180), (p[1] - g.lat) * 110.574);

  // MLRT2 owns a real reach of the Llano that passes right by the gauge
  const llano = out.features.filter((f) => f.properties.gaugeId === 'MLRT2' && f.properties.name === 'Llano River');
  assert.ok(llano.length >= 1, 'MLRT2 must own part of the Llano River');
  const reach = llano.reduce((n, f) => n + km(f.geometry), 0);
  assert.ok(reach > 20 && reach < 60, `MLRT2 reach ${reach.toFixed(1)} km`);
  const nearest = Math.min(...llano.flatMap((f) => lines(f.geometry).flat()).map((p) => dist(mlrt2, p)));
  assert.ok(nearest < 0.3, `reach passes ${nearest.toFixed(2)} km from the gauge`);
  // the gauge without flood stages that used to own the whole river keeps almost none of it
  const lrtt2 = out.features.filter((f) => f.properties.gaugeId === 'LRTT2' && f.properties.name === 'Llano River');
  assert.ok(lrtt2.reduce((n, f) => n + km(f.geometry), 0) < 5);

  // a reach given to a NEW owner is never more than 40 km (straight line, + snap slack) from that gauge
  const { origin } = segmentWaterwaysDetailed(waterways, gauges);
  let reowned = 0;
  out.features.forEach((f, k) => {
    const src = waterways.features[origin[k]];
    if (!/LineString/.test(f.geometry.type) || src.properties.gaugeId === f.properties.gaugeId) return;
    const g = byId.get(f.properties.gaugeId);
    reowned++;
    assert.ok(hasFloodStages(g.thresholds), `${g.id} has flood stages`);
    for (const p of lines(f.geometry).flat()) {
      assert.ok(dist(g, p) <= MAX_ALONG_M / 1000 + 1, `${g.id} owns a point ${dist(g, p).toFixed(1)} km away`);
    }
  });
  assert.ok(reowned > 100, `${reowned} re-owned reaches`);

  // honest gray improves: less river is owned by gauges without flood stages, none is lost
  const unstaged = (fs) => fs.filter((f) => /LineString/.test(f.geometry?.type)).filter((f) => !hasFloodStages(byId.get(f.properties.gaugeId)?.thresholds)).reduce((n, f) => n + km(f.geometry), 0);
  const total = (fs) => fs.filter((f) => /LineString/.test(f.geometry?.type)).reduce((n, f) => n + km(f.geometry), 0);
  assert.ok(unstaged(out.features) < unstaged(waterways.features) - 1000, 'at least 1000 km stop being gray');
  assert.ok(Math.abs(total(out.features) - total(waterways.features)) / total(waterways.features) < 1e-4, 'river length is conserved');

  // lakes and everything else are the very same objects
  const polys = waterways.features.filter((f) => /Polygon/.test(f.geometry.type));
  const outPolys = out.features.filter((f) => /Polygon/.test(f.geometry.type));
  assert.equal(outPolys.length, polys.length);
  assert.ok(polys.every((p, i) => p === outPolys[i]));
  assert.ok(stats.featuresOut < stats.featuresIn * 1.3, 'feature count stays bounded');
});
