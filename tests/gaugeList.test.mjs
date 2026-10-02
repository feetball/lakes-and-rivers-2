// Unit tests for the gauge list logic (src/lib/gaugeList.ts, places.ts, mapFly.ts, backButton.ts)
// and the contrast of the list sheet's colors. Fixtures are real: tests/fixtures/gauges-live-sample.json
// is a trimmed GET /api/gauges (2026-10-02) and public/data/tx-places.json is the shipped places file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
  STATUS_RANK, buildGaugeIndex, describeItem, favoriteItems, formatMiles, haversineKm, listCategory,
  nearbyItems, normalizeText, searchGauges, sortItems, statusRank, toListItem,
} from '../src/lib/gaugeList.ts';
import { buildPlaceIndex, parsePlaces, placeHint, searchPlaces } from '../src/lib/places.ts';
import { flyTarget } from '../src/lib/mapFly.ts';
import { pushBackHandler, runBackHandler } from '../src/lib/backButton.ts';
import { COLORS, GRAPHICS_ON, TEXT_ON } from '../src/components/gaugeListTheme.ts';
import { controlTop } from '../src/components/controlSlots.ts';
import { CATEGORY_COLORS } from '../src/lib/floodStatus.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/gauges-live-sample.json', import.meta.url), 'utf8'));
const gauges = Object.values(fixture.gauges);
// "Now" is just after the captured snapshot so ages are deterministic.
const NOW = new Date(fixture.updatedAt).getTime() + 60_000;
const byId = id => fixture.gauges[id];
const withEdits = (id, edits) => ({ ...byId(id), ...edits });

const placeRows = JSON.parse(readFileSync(new URL('../public/data/tx-places.json', import.meta.url), 'utf8'));
const placeIndex = buildPlaceIndex(parsePlaces(placeRows));

test('fixture is the real feed shape', () => {
  assert.ok(gauges.length > 100);
  assert.ok(byId('HNTT2') && byId('KRRT2') && byId('DALT2'));
});

test('haversine: known distances and symmetry', () => {
  const austin = { lat: 30.2672, lon: -97.7431 };
  const sanAntonio = { lat: 29.4241, lon: -98.4936 };
  assert.ok(Math.abs(haversineKm(austin, sanAntonio) - 118) < 3);
  assert.equal(haversineKm(austin, austin), 0);
  assert.equal(haversineKm(austin, sanAntonio), haversineKm(sanAntonio, austin));
});

test('formatMiles', () => {
  assert.equal(formatMiles(0.05), '<0.1 mi');
  assert.equal(formatMiles(1.609344 * 2.34), '2.3 mi');
  assert.equal(formatMiles(1.609344 * 12.4), '12 mi');
});

test('status ranking: major > moderate > minor > action > normal > not defined', () => {
  const order = ['major', 'moderate', 'minor', 'action', 'no_flooding', 'not_defined'];
  for (let i = 1; i < order.length; i++) assert.ok(statusRank(order[i - 1]) > statusRank(order[i]), order[i]);
  assert.equal(statusRank('bogus'), STATUS_RANK.not_defined);
});

test('a "normal" gauge with no reading is not shown as normal', () => {
  assert.equal(listCategory(withEdits('HNTT2', { category: 'no_flooding', observedStage: null })), 'not_defined');
  assert.equal(listCategory(byId('HNTT2')), 'no_flooding');
  assert.equal(listCategory({ ...byId('HNTT2'), category: 'weird' }), 'not_defined');
});

test('status sort puts the worst first, then nearest, then name', () => {
  const items = gauges.map(g => toListItem(g, NOW));
  const sorted = sortItems(items, 'status');
  const ranks = sorted.map(i => statusRank(i.category));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
  assert.equal(sorted[0].category, 'moderate');
  const from = { lat: 32.78, lon: -97.35 };
  const near = sortItems(gauges.map(g => toListItem(g, NOW, from)), 'status').filter(i => i.category === 'moderate');
  const km = near.map(i => i.distanceKm);
  assert.deepEqual(km, [...km].sort((a, b) => a - b));
});

test('distance sort is nearest first and does not mutate its input', () => {
  const from = { lat: 30.05, lon: -99.14 }; // Kerrville
  const items = gauges.map(g => toListItem(g, NOW, from));
  const copy = [...items];
  const sorted = sortItems(items, 'distance');
  assert.deepEqual(items, copy);
  assert.equal(sorted[0].gauge.id, 'KRRT2');
});

test('nearbyItems: 40 km radius, worst first; beyond-radius fallback is explicit', () => {
  const kerrville = { lat: 30.0474, lon: -99.1403 };
  const r = nearbyItems(gauges, kerrville, { nowMs: NOW });
  assert.equal(r.beyondRadius, false);
  assert.ok(r.items.length >= 3);
  assert.ok(r.items.every(i => i.distanceKm <= 40));
  assert.ok(r.items.some(i => i.gauge.id === 'KRRT2'));
  const far = nearbyItems(gauges, { lat: 40.7, lon: -74 }, { nowMs: NOW });
  assert.equal(far.beyondRadius, true);
  assert.equal(far.items.length, 5);
  assert.ok(far.items.every(i => i.distanceKm > 1000));
});

test('favoriteItems: worst first, retired ids reported not hidden', () => {
  const { items, missing } = favoriteItems(fixture.gauges, ['HNTT2', 'DALT2', 'GONE1', 'KRRT2'], NOW);
  assert.equal(items[0].gauge.id, 'DALT2'); // minor beats normal
  assert.deepEqual(missing, ['GONE1']);
  assert.deepEqual(favoriteItems({}, ['HNTT2'], NOW).missing, ['HNTT2']);
});

test('staleness uses the 90 minute threshold', () => {
  const g = byId('HNTT2');
  const at = ms => ({ ...g, observedAt: new Date(NOW - ms).toISOString() });
  assert.equal(toListItem(at(30 * 60_000), NOW).stale, false);
  assert.equal(toListItem(at(91 * 60_000), NOW).stale, true);
  assert.equal(toListItem({ ...g, observedAt: null }, NOW).stale, true);
  assert.equal(toListItem({ ...g, observedStage: null, observedAt: null }, NOW).stale, false);
});

test('normalizeText removes diacritics and apostrophes', () => {
  assert.equal(normalizeText('Cañón O’Brien'), 'canon obrien');
  assert.equal(normalizeText('  St. Hedwig '), 'st hedwig');
});

const search = q => searchGauges(buildGaugeIndex(gauges), q, { nowMs: NOW });
const ids = r => r.items.map(i => i.gauge.id);

test('search "kerrville" finds the Kerrville gauges and nothing unrelated', () => {
  const r = search('kerrville');
  assert.ok(ids(r).includes('KRRT2') && ids(r).includes('GRHT2'));
  assert.ok(r.items.every(i => /kerrville/i.test(i.gauge.name)));
});

test('search "hunt": exact word "Hunt" ranks above "Huntsville"', () => {
  const r = search('hunt');
  const iHunt = ids(r).indexOf('HNTT2');
  const iHuntsville = ids(r).indexOf('NEST2');
  assert.ok(iHunt >= 0 && iHuntsville >= 0 && iHunt < iHuntsville);
});

test('search "ft worth" matches Fort Worth through the abbreviation and ranks the phrase first', () => {
  const r = search('ft worth');
  assert.ok(ids(r).includes('FWHT2') && ids(r).includes('FWOT2'));
  assert.ok(r.items.every(i => /fort worth/i.test(i.gauge.name)), ids(r).join());
});

test('search "san antonio" needs both words', () => {
  const r = search('san antonio');
  assert.ok(r.items.length > 0);
  assert.ok(r.items.every(i => /san antonio/i.test(i.gauge.name)));
});

test('search by id, prefix, case, accents and junk', () => {
  assert.equal(ids(search('hntt2'))[0], 'HNTT2');
  assert.equal(ids(search('HNTT2'))[0], 'HNTT2');
  assert.ok(ids(search('kerrv')).includes('KRRT2'));
  assert.ok(ids(search('KÉRRVILLE')).includes('KRRT2'));
  assert.deepEqual(search('').items, []);
  assert.deepEqual(search('   ').items, []);
  assert.equal(search('zzzzqqq').total, 0);
});

test('search limit caps rows but reports the total', () => {
  const r = searchGauges(buildGaugeIndex(gauges), 'river', { limit: 5, nowMs: NOW });
  assert.equal(r.items.length, 5);
  assert.ok(r.total > 5);
});

test('describeItem: fresh, stale, unknown time, no reading, no stages', () => {
  const g = byId('DALT2');
  const fresh = describeItem(toListItem({ ...g, observedAt: new Date(NOW - 5 * 60_000).toISOString() }, NOW), { favorite: true });
  assert.match(fresh.ariaLabel, /^.+, Minor flood, [\d.]+ feet, 5 minutes ago, favorite$/);
  assert.ok(fresh.segments.every(s => !s.warn));
  const stale = describeItem(toListItem({ ...g, observedAt: new Date(NOW - 3 * 3_600_000).toISOString() }, NOW));
  assert.ok(stale.segments.some(s => s.warn && s.text === 'Reading is 3 hours old'));
  assert.match(stale.ariaLabel, /reading is 3 hours old/);
  const untimed = describeItem(toListItem({ ...g, observedAt: null }, NOW));
  assert.ok(untimed.segments.some(s => s.warn && /unknown/.test(s.text)));
  const none = describeItem(toListItem({ ...g, observedStage: null, observedAt: null, category: 'no_flooding' }, NOW));
  assert.ok(none.segments.some(s => /No current reading/.test(s.text)));
  assert.ok(!/Normal/.test(none.ariaLabel));
  const noStages = describeItem(toListItem({ ...byId('HNTT2'), thresholds: { action: null, minor: null, moderate: null, major: null } }, NOW));
  assert.ok(noStages.segments.some(s => s.text === 'No flood stages'));
  assert.ok(!/Normal|No data|No current reading/.test(noStages.ariaLabel));
  assert.match(noStages.ariaLabel, /no flood stages/);
  // Thresholds we do not have (null) are not "none defined": the old caveat on "Normal" stays.
  const unknown = describeItem(toListItem({ ...byId('HNTT2'), thresholds: null }, NOW));
  assert.ok(unknown.segments.some(s => /no flood stages defined/.test(s.text)));
});

test('a gauge with a reading but no flood stages is "no flood stages" in the list, not "no data"', () => {
  const none = { action: null, minor: null, moderate: null, major: null };
  assert.equal(listCategory(withEdits('HNTT2', { thresholds: none })), 'no_stages');
  assert.equal(listCategory(withEdits('HNTT2', { thresholds: none, category: 'not_defined' })), 'no_stages');
  assert.equal(listCategory(withEdits('HNTT2', { thresholds: none, observedStage: null, category: 'not_defined' })), 'not_defined');
  assert.equal(statusRank('no_stages'), STATUS_RANK.not_defined);
  assert.ok(CATEGORY_COLORS.no_stages && CATEGORY_COLORS.no_stages !== CATEGORY_COLORS.not_defined);
});

test('describeItem shows distance in miles', () => {
  const t = describeItem(toListItem(byId('KRRT2'), NOW, { lat: 30.0474, lon: -99.1403 }));
  assert.match(t.distance, /mi$/);
  assert.match(t.ariaLabel, /miles? away|less than a tenth/);
});

// ---- places ----

test('places file: shape, size, order', () => {
  assert.ok(statSync(new URL('../public/data/tx-places.json', import.meta.url)).size < 150 * 1024);
  assert.ok(placeRows.length > 1500);
  for (const row of placeRows) {
    assert.equal(row.length, 4);
    assert.equal(typeof row[0], 'string');
    assert.ok(row[1] > 25 && row[1] < 37 && row[2] > -107 && row[2] < -93, row.join());
    assert.ok(Number.isInteger(row[3]) && row[3] >= 0);
  }
  const pops = placeRows.map(r => r[3]);
  assert.deepEqual(pops, [...pops].sort((a, b) => b - a));
  assert.equal(placeRows[0][0], 'Houston');
});

test('parsePlaces rejects a truncated or wrong file', () => {
  assert.equal(parsePlaces(null), null);
  assert.equal(parsePlaces({}), null);
  assert.equal(parsePlaces(placeRows.slice(0, 20)), null);
  assert.equal(parsePlaces([['x', 'y']]), null);
});

test('place search: kerrville, ft worth, san antonio', () => {
  assert.equal(searchPlaces(placeIndex, 'kerrville')[0].name, 'Kerrville');
  assert.equal(searchPlaces(placeIndex, 'ft worth')[0].name, 'Fort Worth');
  assert.equal(searchPlaces(placeIndex, 'san antonio')[0].name, 'San Antonio');
  assert.deepEqual(searchPlaces(placeIndex, ''), []);
});

test('place hint only for repeated names', () => {
  const kerrville = searchPlaces(placeIndex, 'kerrville')[0];
  assert.equal(placeHint(placeIndex, kerrville), null);
  const dupes = [...placeIndex.repeated];
  assert.ok(dupes.length > 0);
  const dup = placeIndex.places.find(p => normalizeText(p.name) === dupes[0]);
  assert.match(placeHint(placeIndex, dup) ?? '', /mi from /);
});

test('gauges near a place', () => {
  const kerrville = searchPlaces(placeIndex, 'kerrville')[0];
  const r = nearbyItems(gauges, kerrville, { nowMs: NOW });
  assert.ok(ids(r).includes('KRRT2'));
});

// ---- map movement ----

function fakeMap(zoom) {
  // Web Mercator at a given zoom: enough for flyTarget's project / unproject.
  const scale = z => 256 * 2 ** z;
  const project = ([lat, lon], z) => {
    const s = scale(z);
    const sin = Math.sin((lat * Math.PI) / 180);
    return { x: ((lon + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
  };
  const unproject = (pt, z) => {
    const [x, y] = Array.isArray(pt) ? pt : [pt.x, pt.y];
    const s = scale(z);
    const n = Math.PI - (2 * Math.PI * y) / s;
    return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng: (x / s) * 360 - 180 };
  };
  return { getZoom: () => zoom, getSize: () => ({ x: 393, y: 852 }), project, unproject, flyTo() {} };
}

test('flyTarget never zooms out and lands the target above the sheet', () => {
  assert.equal(flyTarget(fakeMap(6), 30, -99, { minZoom: 11 }).zoom, 11);
  assert.equal(flyTarget(fakeMap(14), 30, -99, { minZoom: 11 }).zoom, 14);
  const centered = flyTarget(fakeMap(11), 30, -99, { minZoom: 11 });
  assert.ok(Math.abs(centered.center.lat - 30) < 1e-6);
  const raised = flyTarget(fakeMap(11), 30, -99, { minZoom: 11, landAt: 0.18 });
  assert.ok(raised.center.lat < 30, 'map centre sits south of the gauge so the gauge shows near the top');
});

test('back handlers: newest first, unregistering restores the one beneath', () => {
  const calls = [];
  assert.equal(runBackHandler(), false);
  const offA = pushBackHandler(() => calls.push('a'));
  const offB = pushBackHandler(() => calls.push('b'));
  assert.equal(runBackHandler(), true);
  offB();
  runBackHandler();
  offA();
  assert.deepEqual(calls, ['b', 'a']);
  assert.equal(runBackHandler(), false);
});

test('control slots are 52 px apart under the safe area', () => {
  assert.equal(controlTop(0), 'calc(env(safe-area-inset-top, 0px) + 12px + 0px)');
  assert.equal(controlTop(1), 'calc(env(safe-area-inset-top, 0px) + 12px + 52px)');
  assert.equal(controlTop(2), 'calc(env(safe-area-inset-top, 0px) + 12px + 104px)');
});

// ---- contrast (WCAG 2.x) ----

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('every text color on its background is at least 4.5:1', () => {
  for (const [fg, bg] of TEXT_ON) assert.ok(contrast(COLORS[fg], COLORS[bg]) >= 4.5, `${fg} on ${bg}: ${contrast(COLORS[fg], COLORS[bg]).toFixed(2)}`);
});

test('icons and outlines are at least 3:1', () => {
  for (const [fg, bg] of GRAPHICS_ON) assert.ok(contrast(COLORS[fg], COLORS[bg]) >= 3, `${fg} on ${bg}: ${contrast(COLORS[fg], COLORS[bg]).toFixed(2)}`);
});

test('every status dot color is distinguishable from the sheet by its ring', () => {
  for (const [cat, color] of Object.entries(CATEGORY_COLORS)) assert.ok(color, cat);
  assert.ok(contrast(COLORS.dotRing, COLORS.panel) >= 3);
});
