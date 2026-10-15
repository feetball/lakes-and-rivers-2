// Tests for src/lib/alerts-fetch.ts against REAL api.weather.gov captures in
// tests/fixtures/ (Texas flood alerts of 2026-10-02 11:39 UTC, archived warnings of
// 2026-10-01, and the forecast zones the watches name). Run: pnpm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  alertKind,
  alertLevel,
  alertsAt,
  alertsUrl,
  capPayload,
  compareAlerts,
  createMemoryStore,
  geometryBounds,
  getAlertsResponse,
  isAlertActive,
  joinZoneGeometry,
  normaliseAlerts,
  parseVtec,
  pointInGeometry,
  representativePoint,
  simplifyGeometry,
  simplifyRing,
  zoneUrl,
} from '../src/lib/alerts-fetch.ts';

const fx = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const LIVE = fx('nws-alerts-tx-2026-10-02.json');
const ARCHIVE = fx('nws-alerts-archive-2026-10-01.json');
const ZONES = fx('nws-zones-2026-10-02.json');
// 06:45 local: every alert in LIVE is still in effect.
const T0 = Date.parse('2026-10-02T11:45:00Z');
const noSleep = async () => {};

test('alertsUrl asks for active, actual flood events in Texas', () => {
  const u = new URL(alertsUrl());
  assert.equal(u.origin + u.pathname, 'https://api.weather.gov/alerts/active');
  assert.equal(u.searchParams.get('area'), 'TX');
  assert.equal(u.searchParams.get('status'), 'actual');
  assert.equal(u.searchParams.get('message_type'), 'alert,update');
  assert.equal(u.searchParams.get('event').split(',').length, 7);
  assert.match(u.searchParams.get('event'), /Flash Flood Warning/);
});

test('parseVtec reads the event key from a real VTEC string', () => {
  const v = parseVtec('/O.NEW.KFWD.FF.W.0091.261002T1125Z-261002T1400Z/');
  assert.equal(v.key, 'KFWD.FF.W.0091');
  assert.equal(v.action, 'NEW');
  assert.equal(v.phenomena, 'FF');
  assert.equal(v.significance, 'W');
  assert.equal(v.end, Date.UTC(2026, 9, 2, 14, 0));
  // "already in effect" is an all-zero start
  assert.equal(parseVtec('/O.EXT.KEWX.FL.W.0053.000000T0000Z-261003T0540Z/').begin, null);
  assert.equal(parseVtec('/T.NEW.KFWD.FF.W.0001.261002T1125Z-261002T1400Z/')?.productClass, 'T');
  assert.equal(parseVtec('not vtec'), null);
  assert.equal(parseVtec(undefined), null);
});

test('alertKind accepts only the seven flood events', () => {
  assert.equal(alertKind('Flash Flood Warning'), 'warning');
  assert.equal(alertKind('Flood Watch'), 'watch');
  assert.equal(alertKind('Flash Flood Watch'), 'watch');
  assert.equal(alertKind('Flood Advisory'), 'advisory');
  assert.equal(alertKind('Flash Flood Statement'), 'statement');
  assert.equal(alertKind('Tornado Warning'), null);
  assert.equal(alertKind('Coastal Flood Warning'), null);
});

test('normaliseAlerts on the live capture: one alert per event, strongest first', () => {
  const alerts = normaliseAlerts(LIVE, T0);
  // 19 messages; KHGX.FA.A.0006 (EXA + CON) and KFWD.FA.A.0007 (EXB + EXT) are split
  // watches, one event each.
  assert.equal(LIVE.features.length, 19);
  assert.equal(alerts.length, 17);
  assert.equal(new Set(alerts.map(a => a.id)).size, alerts.length);
  const order = alerts.map(a => alertLevel(a));
  const rank = { emergency: 5, flash: 4, warning: 3, watch: 2, advisory: 1 };
  for (let i = 1; i < order.length; i++) assert.ok(rank[order[i - 1]] >= rank[order[i]]);
  assert.equal(order[0], 'flash');

  const ffw = alerts.find(a => a.id === 'KFWD.FF.W.0091');
  assert.equal(ffw.event, 'Flash Flood Warning');
  assert.equal(ffw.kind, 'warning');
  assert.equal(ffw.geometrySource, 'alert');
  assert.ok(ffw.geometry && (ffw.geometry.type === 'Polygon' || ffw.geometry.type === 'MultiPolygon'));
  assert.equal(ffw.ends, '2026-10-02T14:00:00.000Z');
  assert.equal(ffw.senderName, 'NWS Fort Worth TX');
  assert.deepEqual(ffw.ugc.every(u => /^TXC\d{3}$/.test(u)), true);
  assert.equal(ffw.web, 'https://www.weather.gov/fwd/');
  assert.equal(ffw.damageThreat, null, 'this warning carries no impact tag');
  assert.equal(alertLevel(ffw), 'flash');

  // Watches carry no polygon, only zones, until joinZoneGeometry.
  const watch = alerts.find(a => a.id === 'KEWX.FA.A.0008');
  assert.equal(watch.kind, 'watch');
  assert.equal(watch.geometry, null);
  assert.equal(watch.geometrySource, 'none');
  assert.ok(watch.ugc.length > 20 && watch.ugc.every(u => /^TXZ\d{3}$/.test(u)));
  const watches = alerts.filter(a => a.kind === 'watch');
  assert.ok(watches.length >= 5 && watches.every(a => a.geometry === null), 'every watch is zone-only');
  assert.ok(alerts.filter(a => a.kind !== 'watch').every(a => a.geometry !== null), 'warnings and advisories have polygons');
});

test('a split watch merges into one alert with the union of its zones', () => {
  const msgs = LIVE.features.filter(f => /KHGX\.FA\.A\.0006/.test(f.properties.parameters.VTEC[0]));
  assert.equal(msgs.length, 2);
  const [a] = normaliseAlerts({ features: msgs }, T0);
  const all = new Set(msgs.flatMap(m => m.properties.geocode.UGC));
  assert.deepEqual(new Set(a.ugc), all);
  assert.equal(normaliseAlerts({ features: msgs }, T0).length, 1);
});

test('a Flash Flood Emergency is a flash flood warning with a CATASTROPHIC threat', () => {
  const base = { event: 'Flash Flood Warning', kind: 'warning' };
  assert.equal(alertLevel({ ...base, damageThreat: 'CATASTROPHIC' }), 'emergency');
  assert.equal(alertLevel({ ...base, damageThreat: 'CONSIDERABLE' }), 'flash');
  assert.equal(alertLevel({ ...base, damageThreat: null }), 'flash');
  assert.equal(alertLevel({ event: 'Flood Warning', kind: 'warning', damageThreat: null }), 'warning');
  assert.equal(alertLevel({ event: 'Flash Flood Statement', kind: 'statement', damageThreat: null }), 'flash');
});

test('expired alerts are dropped (ends, else expires)', () => {
  // 13:00Z = 08:00 local: the advisories that ended at 07:00, 07:45 and 08:00 are gone.
  const later = Date.parse('2026-10-02T13:00:00Z');
  const alerts = normaliseAlerts(LIVE, later);
  assert.equal(alerts.length, 14);
  assert.ok(!alerts.some(a => a.ends && Date.parse(a.ends) <= later));
  assert.equal(normaliseAlerts(LIVE, Date.parse('2026-10-04T00:00:00Z')).length, 0);

  const iso = s => new Date(s).toISOString();
  assert.equal(isAlertActive({ ends: iso(T0 + 1000), expires: null }, T0), true);
  assert.equal(isAlertActive({ ends: iso(T0), expires: null }, T0), false);
  // A message that lapsed before the event ends is still the latest word on it.
  assert.equal(isAlertActive({ ends: iso(T0 + 3_600_000), expires: iso(T0 - 1000) }, T0), true);
  assert.equal(isAlertActive({ ends: null, expires: iso(T0 - 1000) }, T0), false);
  assert.equal(isAlertActive({ ends: null, expires: null }, T0), true);
});

test('cancelled events and test messages never appear (archived capture)', () => {
  // 02:25Z Oct 2: KHGX.FF.W.0053 (NEW, ends 03:30Z) was cancelled at 02:19Z; its NEW message is
  // still in this feed but must not be drawn. KBRO.FF.W.0008 is genuinely active (ends 05:30Z).
  const t = Date.parse('2026-10-02T02:25:00Z');
  const ids = normaliseAlerts(ARCHIVE, t).map(a => a.id).sort();
  assert.deepEqual(ids, ['KBRO.FF.W.0008', 'KHGX.FF.W.0053'].filter(id => id !== 'KHGX.FF.W.0053'));
  // The same event with only its NEW message would be drawn:
  const onlyNew = { features: ARCHIVE.features.filter(f => /\.NEW\.KHGX/.test(f.properties.parameters.VTEC[0])) };
  assert.deepEqual(normaliseAlerts(onlyNew, t).map(a => a.id), ['KHGX.FF.W.0053']);
  const test = structuredClone(LIVE);
  test.features[0].properties.status = 'Test';
  assert.equal(normaliseAlerts(test, T0).length, 16);
  const tvtec = structuredClone(LIVE);
  tvtec.features[0].properties.parameters.VTEC = ['/T.NEW.KFWD.FF.W.0091.261002T1125Z-261002T1400Z/'];
  assert.equal(normaliseAlerts(tvtec, T0).length, 16);
});

test('non-flood events and garbage are ignored; a non-feed throws', () => {
  const x = structuredClone(LIVE);
  x.features[0].properties.event = 'Tornado Warning';
  assert.equal(normaliseAlerts(x, T0).length, 16);
  assert.equal(normaliseAlerts({ features: [null, 3, {}, { properties: {} }] }, T0).length, 0);
  assert.throws(() => normaliseAlerts('<html>', T0));
  assert.throws(() => normaliseAlerts({ title: 'error' }, T0));
  assert.throws(() => normaliseAlerts(null, T0));
});

const SQUARE = { type: 'Polygon', coordinates: [[[-98, 30], [-97, 30], [-97, 31], [-98, 31], [-98, 30]]] };
const DONUT = {
  type: 'Polygon',
  coordinates: [SQUARE.coordinates[0], [[-97.6, 30.4], [-97.4, 30.4], [-97.4, 30.6], [-97.6, 30.6], [-97.6, 30.4]]],
};

test('point in polygon: inside, outside, hole, multipolygon, real alert', () => {
  assert.equal(pointInGeometry(-97.5, 30.2, SQUARE), true);
  assert.equal(pointInGeometry(-96.5, 30.5, SQUARE), false);
  assert.equal(pointInGeometry(-97.5, 30.5, DONUT), false);
  assert.equal(pointInGeometry(-97.8, 30.5, DONUT), true);
  const multi = { type: 'MultiPolygon', coordinates: [SQUARE.coordinates, [[[-100, 32], [-99, 32], [-99, 33], [-100, 33], [-100, 32]]]] };
  assert.equal(pointInGeometry(-99.5, 32.5, multi), true);
  assert.equal(pointInGeometry(-98.5, 32.5, multi), false);

  const alerts = normaliseAlerts(LIVE, T0);
  const ffw = alerts.find(a => a.id === 'KFWD.FF.W.0091');
  const p = representativePoint(ffw.geometry);
  assert.ok(pointInGeometry(p[0], p[1], ffw.geometry), 'representative point is inside');
  const hit = alertsAt(alerts, p[0], p[1]);
  assert.ok(hit.some(a => a.id === ffw.id));
  assert.deepEqual(alertsAt(alerts, -80, 20), []);
  const b = geometryBounds(ffw.geometry);
  assert.ok(b.south < b.north && b.west < b.east);
});

test('alertsAt lists the strongest alert first', () => {
  const mk = (id, event, kind) => ({ id, event, kind, damageThreat: null, sent: '2026-10-02T11:00:00Z', geometry: SQUARE });
  const hit = alertsAt([mk('a', 'Flood Advisory', 'advisory'), mk('b', 'Flash Flood Warning', 'warning')].sort(compareAlerts), -97.5, 30.5);
  assert.deepEqual(hit.map(a => a.id), ['b', 'a']);
});

test('Douglas-Peucker keeps shape and drops detail', () => {
  const zig = [];
  for (let i = 0; i <= 100; i++) zig.push([-98 + i * 0.01, 30 + (i % 2 ? 0.0005 : 0)]);
  const ring = [...zig, [-97, 31], [-98, 31], zig[0]];
  const s = simplifyRing(ring, 0.002);
  assert.ok(s.length < 10, `simplified to ${s.length}`);
  assert.deepEqual(s[0], s[s.length - 1]);
  // a sliver that collapses is dropped
  assert.equal(simplifyRing([[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0]], 0.002), null);

  const z = ZONES.TXZ195.geometry;
  const before = JSON.stringify(z).length;
  const g = simplifyGeometry(z, 0.002);
  const after = JSON.stringify(g).length;
  assert.ok(after < before * 0.6, `${before} -> ${after} bytes`);
  // the outline still covers the same place
  const bb0 = geometryBounds(z), bb1 = geometryBounds(g);
  for (const k of ['south', 'north', 'west', 'east']) assert.ok(Math.abs(bb0[k] - bb1[k]) < 0.01);
  const c = representativePoint(z);
  assert.ok(pointInGeometry(c[0], c[1], g));
});

/** A fetch that answers zone URLs from the fixture and records the calls. */
function zoneFetch({ fail = new Set(), missing = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const code = url.split('/').pop();
    if (missing.has(code)) return new Response('{}', { status: 404 });
    if (fail.has(code) || !ZONES[code]) return new Response('boom', { status: 503 });
    return new Response(JSON.stringify(ZONES[code]), { status: 200 });
  };
  return { fetchImpl, calls };
}
const joinOpts = (over = {}) => ({
  store: createMemoryStore(),
  base: 'https://api.weather.gov',
  nowMs: T0,
  budgetMs: 2000,
  maxFetches: 50,
  concurrency: 4,
  timeoutMs: 1000,
  sleep: noSleep,
  ...over,
});
const fixtureWatch = (zones, id = 'KTEST.FA.A.0001') => ({
  id, event: 'Flood Watch', kind: 'watch', damageThreat: null, headline: null, description: '', instruction: null,
  areaDesc: 'test', senderName: 'NWS', sent: '2026-10-02T11:00:00Z', effective: null, expires: '2026-10-02T19:00:00Z',
  ends: '2026-10-02T19:00:00Z', ugc: zones, geometry: null, geometrySource: 'none', web: 'https://www.weather.gov/',
});

test('zone join gives a watch the outline of its zones, simplified and cached', async () => {
  const { fetchImpl, calls } = zoneFetch();
  const store = createMemoryStore();
  const watch = fixtureWatch(['TXZ195', 'TXZ196', 'OKZ001']);
  const r = await joinZoneGeometry([watch], joinOpts({ store, fetchImpl }));
  assert.equal(r.alerts[0].geometrySource, 'zones');
  assert.equal(r.alerts[0].geometry.type, 'MultiPolygon');
  assert.equal(r.alerts[0].geometry.coordinates.length, 2);
  // Oklahoma is not a Texas zone: never fetched
  assert.deepEqual(calls.sort(), ['https://api.weather.gov/zones/forecast/TXZ195', 'https://api.weather.gov/zones/forecast/TXZ196']);
  const full = JSON.stringify(ZONES.TXZ195.geometry).length + JSON.stringify(ZONES.TXZ196.geometry).length;
  assert.ok(JSON.stringify(r.alerts[0].geometry).length < full * 0.6);

  // second join: served from cache, no new requests
  const again = await joinZoneGeometry([watch], joinOpts({ store, fetchImpl }));
  assert.equal(calls.length, 2);
  assert.equal(again.alerts[0].geometrySource, 'zones');
  // outside the 7 day TTL it is fetched again
  await joinZoneGeometry([watch], joinOpts({ store, fetchImpl, nowMs: T0 + 8 * 86_400_000 }));
  assert.equal(calls.length, 4);
});

test('a failed zone fetch never drops the alert and is not drawn half-way', async () => {
  const { fetchImpl } = zoneFetch({ fail: new Set(['TXZ196']) });
  const r = await joinZoneGeometry([fixtureWatch(['TXZ195', 'TXZ196'])], joinOpts({ fetchImpl }));
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].geometry, null);
  assert.equal(r.alerts[0].geometrySource, 'none');
  assert.deepEqual(r.missing, ['TXZ196']);
  // an expired cached shape stands in when the NWS is failing
  const store = createMemoryStore();
  const ok = zoneFetch();
  await joinZoneGeometry([fixtureWatch(['TXZ195'])], joinOpts({ store, fetchImpl: ok.fetchImpl }));
  const bad = zoneFetch({ fail: new Set(['TXZ195']) });
  const r2 = await joinZoneGeometry([fixtureWatch(['TXZ195'])], joinOpts({ store, fetchImpl: bad.fetchImpl, nowMs: T0 + 9 * 86_400_000 }));
  assert.equal(r2.alerts[0].geometrySource, 'zones');
});

test('zones are fetched at most once even when several watches share them', async () => {
  const { fetchImpl, calls } = zoneFetch();
  await joinZoneGeometry([fixtureWatch(['TXZ195'], 'a'), fixtureWatch(['TXZ195', 'TXZ196'], 'b')], joinOpts({ fetchImpl }));
  assert.equal(calls.length, 2);
  assert.equal(zoneUrl('TXC035'), 'https://api.weather.gov/zones/county/TXC035');
});

test('capPayload coarsens zone outlines before dropping any, and reports size', () => {
  const g = ZONES.TXZ195.geometry;
  const alerts = Array.from({ length: 12 }, (_, i) => ({ ...fixtureWatch(['TXZ195'], `w${i}`), geometry: g, geometrySource: 'zones' }));
  const full = JSON.stringify(alerts).length;
  const r = capPayload(alerts, Math.floor(full * 0.8));
  assert.ok(r.bytes <= full * 0.8);
  assert.ok(r.tolerance > 0.002);
  assert.deepEqual(r.stripped, []);
  assert.equal(r.alerts.length, 12);
  const tiny = capPayload(alerts, 5_000);
  assert.ok(tiny.stripped.length > 0);
  assert.equal(tiny.alerts.length, 12, 'alerts stay listed');
  assert.ok(tiny.alerts.every(a => a.geometry === null ? a.geometrySource === 'none' : true));
});

test('real zones: a GeometryCollection zone is handled and every simplified zone is small', async () => {
  const { fetchImpl } = zoneFetch();
  const codes = Object.keys(ZONES);
  const r = await joinZoneGeometry([fixtureWatch(codes)], joinOpts({ fetchImpl }));
  assert.equal(r.alerts[0].geometrySource, 'zones');
  assert.deepEqual(r.missing, []);
  // TXZ313 (Coastal Harris) is a GeometryCollection upstream, 35 KB raw
  const coastal = await joinZoneGeometry([fixtureWatch(['TXZ313'])], joinOpts({ fetchImpl }));
  assert.ok(['Polygon', 'MultiPolygon'].includes(coastal.alerts[0].geometry.type));
  assert.ok(JSON.stringify(coastal.alerts[0].geometry).length < 12_000);
  // 7 real zones: raw vs shipped bytes (the number reported in SUMMARY.md)
  const raw = codes.reduce((n, c) => n + JSON.stringify(ZONES[c].geometry).length, 0);
  const shipped = JSON.stringify(r.alerts[0].geometry).length;
  assert.ok(shipped < raw * 0.35, `${raw} -> ${shipped}`);
  assert.ok(shipped / codes.length < 6_000);
});

// ---- the whole read: /api/alerts behaviour ---------------------------------------

function upstream({ alertsStatus = 200, alertsBody = LIVE } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.match(init.headers['User-Agent'], /texas-flood-map/);
    assert.match(init.headers.Accept, /geo\+json/);
    if (url.includes('/alerts/active')) return new Response(JSON.stringify(alertsBody), { status: alertsStatus });
    const code = url.split('/').pop();
    // Only 7 zones were captured; any other zone code gets a captured shape as a stand-in.
    return new Response(JSON.stringify(ZONES[code] ?? ZONES.TXZ195), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('getAlertsResponse: success, then reuse inside the fresh window, then stale fallback', async () => {
  const store = createMemoryStore();
  let now = T0;
  const up = upstream();
  const deps = () => ({ store, fetchImpl: up.fetchImpl, now: () => now, sleep: noSleep });
  const r1 = await getAlertsResponse(deps());
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true);
  assert.equal(r1.body.source, 'api.weather.gov');
  assert.equal(r1.body.alerts.length, 17);
  assert.equal(r1.body.updatedAt, new Date(T0).toISOString());
  assert.ok(r1.body.alerts.some(a => a.geometrySource === 'zones'), 'a watch got zone geometry');
  assert.ok(r1.body.alerts.every(a => /^https:\/\//.test(a.web)));
  const alertCalls = () => up.calls.filter(u => u.includes('/alerts/active')).length;
  assert.equal(alertCalls(), 1);

  now += 20_000;
  await getAlertsResponse(deps());
  assert.equal(alertCalls(), 1, 'served from the last read');

  // NWS goes down: the last good copy comes back flagged, never an exception
  now += 5 * 60_000;
  const down = upstream({ alertsStatus: 503 });
  const r3 = await getAlertsResponse({ ...deps(), fetchImpl: down.fetchImpl });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.ok, false);
  assert.equal(r3.body.stale, true);
  assert.equal(r3.body.updatedAt, new Date(T0 + 20_000 - 20_000).toISOString());
  assert.ok(r3.body.alerts.length > 0);
  assert.ok(r3.body.error);
  // retried once, then gave up
  assert.equal(down.calls.length, 2);
});

test('getAlertsResponse with no last good copy returns an explicit error, not an empty all-clear', async () => {
  const down = upstream({ alertsStatus: 500 });
  const r = await getAlertsResponse({ store: createMemoryStore(), fetchImpl: down.fetchImpl, now: () => T0, sleep: noSleep });
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.updatedAt, null);
  assert.deepEqual(r.body.alerts, []);
  assert.match(r.body.error, /api\.weather\.gov/);

  // an error page that happens to be JSON is also a failure, not "no alerts"
  const odd = upstream({ alertsBody: { title: 'Server Error' } });
  const r2 = await getAlertsResponse({ store: createMemoryStore(), fetchImpl: odd.fetchImpl, now: () => T0, sleep: noSleep });
  assert.equal(r2.body.ok, false);
  assert.match(r2.body.error, /unexpected/);

  // a network exception too
  const r3 = await getAlertsResponse({ store: createMemoryStore(), fetchImpl: async () => { throw new TypeError('network'); }, now: () => T0, sleep: noSleep });
  assert.equal(r3.body.ok, false);
});

test('an upstream that really has no alerts is ok with an empty list', async () => {
  const up = upstream({ alertsBody: { type: 'FeatureCollection', features: [] } });
  const r = await getAlertsResponse({ store: createMemoryStore(), fetchImpl: up.fetchImpl, now: () => T0, sleep: noSleep });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.alerts, []);
});

test('a stored copy is re-checked for expiry when served', async () => {
  const store = createMemoryStore();
  let now = T0;
  const up = upstream();
  await getAlertsResponse({ store, fetchImpl: up.fetchImpl, now: () => now, sleep: noSleep });
  now = Date.parse('2026-10-02T13:00:00Z');
  const down = upstream({ alertsStatus: 503 });
  const r = await getAlertsResponse({ store, fetchImpl: down.fetchImpl, now: () => now, sleep: noSleep });
  assert.equal(r.body.stale, true);
  assert.ok(r.body.alerts.every(a => Date.parse(a.ends ?? a.expires) > now));
});
