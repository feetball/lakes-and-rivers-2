// Where river-camera chips are drawn (src/lib/cameraLayout.ts): a camera under a gauge dot is
// moved beside it so it can be tapped. Synthetic spots for the rules, the real USGS camera
// sample and the real gauge list for what happens in Texas. Run: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import './helpers/ts-imports.mjs';

const { CHIP_PX, OFFSET_RINGS_PX, layoutCameras, offsetOf, projectPx } = await import('../src/lib/cameraLayout.ts');
const { linkGauges, normalizeWebcams } = await import('../src/lib/webcams.ts');

const GAUGE_RADIUS = 7; // the apps
const OPTS = { gaugeRadius: GAUGE_RADIUS };
const Z = 12;
const GAUGE_CLEAR = CHIP_PX / 2 + GAUGE_RADIUS + 3; // 22
const CHIP_CLEAR = CHIP_PX + 2; // 26

// A point `dx`, `dy` pixels (right, down) from lat/lon at zoom Z.
const [AX, AY] = projectPx(30.2672, -97.7431, Z);
const PX_PER_DEG_LAT = (256 * 2 ** Z) / 180; // ~ near the equator; only used to build nearby test points
function near(dxPx = 0, dyPx = 0) {
  // invert projectPx by Newton steps on a tiny window: good to a fraction of a pixel
  let lat = 30.2672, lon = -97.7431;
  for (let i = 0; i < 6; i++) {
    const [x, y] = projectPx(lat, lon, Z);
    lon += (AX + dxPx - x) * (360 / (256 * 2 ** Z));
    lat -= (AY + dyPx - y) / (PX_PER_DEG_LAT * 1.15);
  }
  return { lat, lon };
}
const px = (p) => projectPx(p.lat, p.lon, Z);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cam = (id, at = near(0, 0)) => ({ id, ...at });
const place = (c, offs) => { const o = offsetOf(offs, c.id); const [x, y] = px(c); return [x + o.dx, y + o.dy]; };

test('projectPx agrees with the standard slippy-map formulas', () => {
  const ref = (lat, lon, z) => {
    const n = 2 ** z * 256, r = (lat * Math.PI) / 180;
    return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
  };
  for (const [lat, lon, z] of [[0, 0, 0], [30.2672, -97.7431, 10], [29.7604, -95.3698, 13], [25.9, -97.4, 5], [36.5, -106.6, 14]]) {
    const [x, y] = projectPx(lat, lon, z), [rx, ry] = ref(lat, lon, z);
    assert.ok(Math.abs(x - rx) < 1e-6 * 2 ** z && Math.abs(y - ry) < 1e-6 * 2 ** z, `${lat},${lon} z${z}: ${x},${y} vs ${rx},${ry}`);
  }
  assert.deepEqual(projectPx(0, 0, 0).map(Math.round), [128, 128]);
});

test('a camera with no gauge dot near it stays where it is', () => {
  const far = near(200, 0);
  const offs = layoutCameras([cam('A')], [far], Z, OPTS);
  assert.equal(offs.size, 0);
  assert.deepEqual(offsetOf(offs, 'A'), { dx: 0, dy: 0 });
  assert.equal(layoutCameras([cam('A')], [], Z, OPTS).size, 0);
});

test('a camera under a gauge dot moves up and to the right, 28 px, into the clear', () => {
  const g = near(0, 0);
  const offs = layoutCameras([cam('A')], [g], Z, OPTS);
  const o = offsetOf(offs, 'A');
  assert.deepEqual(o, { dx: Math.round(28 * Math.SQRT1_2), dy: -Math.round(28 * Math.SQRT1_2) });
  assert.ok(dist(place(cam('A'), offs), px(g)) >= GAUGE_CLEAR);
});

test('the offset is in pixels, so it is the same at every zoom', () => {
  for (const zoom of [8, 11, 14]) {
    const pt = { lat: 30.2672, lon: -97.7431 };
    const o = offsetOf(layoutCameras([{ id: 'A', ...pt }], [pt], zoom, OPTS), 'A');
    assert.deepEqual(o, { dx: 20, dy: -20 }, `zoom ${zoom}`);
  }
});

test('a gauge in the preferred spot sends the chip to the next free one', () => {
  const g = near(0, 0);
  const blocker = near(20, -20); // exactly where up-right would land
  const o = offsetOf(layoutCameras([cam('A')], [g, blocker], Z, OPTS), 'A');
  assert.notDeepEqual(o, { dx: 20, dy: -20 });
  const offs = layoutCameras([cam('A')], [g, blocker], Z, OPTS);
  const spot = place(cam('A'), offs);
  for (const d of [g, blocker]) assert.ok(dist(spot, px(d)) >= GAUGE_CLEAR - 0.6, `${dist(spot, px(d))}`);
  assert.deepEqual(o, { dx: -20, dy: -20 }); // up-left is next in the order
});

test('two cameras at one site get two different spots, a chip apart', () => {
  const g = near(0, 0);
  const cams = [cam('A'), cam('B')];
  const offs = layoutCameras(cams, [g], Z, OPTS);
  assert.equal(offs.size, 2);
  assert.ok(dist(place(cams[0], offs), place(cams[1], offs)) >= CHIP_CLEAR - 0.6);
  for (const c of cams) assert.ok(dist(place(c, offs), px(g)) >= GAUGE_CLEAR - 0.6);
});

test('a camera that is already clear stays put and the crowded ones work around it', () => {
  const g = near(0, 0);
  const clearCam = cam('Z', near(20, -20)); // 28 px from the gauge: clear, and where A would like to go
  const crowded = cam('A');
  const offs = layoutCameras([crowded, clearCam], [g], Z, OPTS);
  assert.equal(offs.has('Z'), false);
  assert.ok(dist(place(crowded, offs), place(clearCam, offs)) >= CHIP_CLEAR - 0.6);
});

test('the layout does not depend on the order cameras and gauges come in', () => {
  const g = [near(0, 0), near(5, 5), near(-30, 10), near(40, 40)];
  const c = [cam('C', near(1, 1)), cam('A'), cam('B', near(-29, 11))];
  const a = layoutCameras(c, g, Z, OPTS);
  const b = layoutCameras([...c].reverse(), [...g].reverse(), Z, OPTS);
  assert.deepEqual([...a].sort(), [...b].sort());
});

test('a dense cluster still gets the best spot there is, never a crash', () => {
  const dots = [];
  for (let x = -80; x <= 80; x += 12) for (let y = -80; y <= 80; y += 12) dots.push(near(x, y));
  const offs = layoutCameras([cam('A'), cam('B'), cam('C')], dots, Z, OPTS);
  const reach = OFFSET_RINGS_PX[OFFSET_RINGS_PX.length - 1] + 1;
  for (const [, o] of offs) assert.ok(Math.hypot(o.dx, o.dy) <= reach);
});

test('bad input: no cameras, no zoom, NaN positions', () => {
  assert.equal(layoutCameras([], [near()], Z, OPTS).size, 0);
  assert.equal(layoutCameras([cam('A')], [near()], Number.NaN, OPTS).size, 0);
  const offs = layoutCameras([{ id: 'X', lat: Number.NaN, lon: 0 }, cam('A')], [near(), { lat: Number.NaN, lon: Number.NaN }], Z, OPTS);
  assert.deepEqual([...offs.keys()], ['A']);
});

// ---- real data -------------------------------------------------------------

const DATA = new URL('../public/data/', import.meta.url);
const haveData = existsSync(new URL('gauges-meta.json', DATA));

test('real data: the USGS camera sample, at gauge sites, comes out clear of every gauge dot from zoom 11 up', { skip: !haveData }, () => {
  const meta = JSON.parse(readFileSync(new URL('gauges-meta.json', DATA), 'utf8')).gauges;
  const sample = JSON.parse(readFileSync(new URL('./fixtures/nims-cameras-sample.json', import.meta.url), 'utf8'));
  const cams = linkGauges(normalizeWebcams(sample, Date.parse('2026-10-02T13:00:00Z')), meta.map((g) => ({ id: g.id, lat: g.lat, lon: g.lon, usgsId: g.usgsId })));
  assert.ok(cams.length >= 10 && cams.some((c) => c.gaugeId), `${cams.length} cameras`);
  for (const zoom of [11, 12, 13, 14]) {
    const centers = (offs) => cams.map((c) => { const [x, y] = projectPx(c.lat, c.lon, zoom); const o = offsetOf(offs, c.id); return [x + o.dx, y + o.dy]; });
    const gp = meta.map((g) => projectPx(g.lat, g.lon, zoom));
    const nearest = (p) => Math.min(...gp.map((q) => dist(p, q)));
    const before = centers(new Map()).filter((p) => nearest(p) < 24).length;
    const offs = layoutCameras(cams, meta, zoom, OPTS);
    const after = centers(offs);
    assert.ok(before >= 5, `zoom ${zoom}: ${before} cameras were inside a gauge's tap zone`);
    for (const p of after) assert.ok(nearest(p) >= GAUGE_CLEAR - 0.01, `zoom ${zoom}: a chip is ${nearest(p).toFixed(1)} px from a gauge dot`);
    for (const c of cams.filter((x) => x.gaugeId)) assert.ok(offs.has(c.id), `zoom ${zoom}: ${c.id} at gauge ${c.gaugeId} was not moved`);
    for (let i = 0; i < after.length; i++) for (let j = i + 1; j < after.length; j++) assert.ok(dist(after[i], after[j]) >= CHIP_CLEAR - 0.01, `zoom ${zoom}: chips ${i} and ${j} overlap`);
  }
});
