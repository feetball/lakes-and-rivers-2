// Tests for the gauge-detail normalisation behind /api/gauges/[id]/detail
// (src/lib/gaugeDetail.ts) and the snapshot repair (src/lib/gaugeStatus.ts).
// Fixtures are REAL NWPS responses captured 2026-10-02 (tests/fixtures/nwps/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/ts-imports.mjs';

const {
  buildDetail, computeTrend, downsample, forecastCrest, normalizeImpacts, normalizeRecord,
  normalizeSeries, resolveGaugeId, OBSERVED_MAX_POINTS,
} = await import('../src/lib/gaugeDetail.ts');
const { repairGaugeStatus, repairGauges } = await import('../src/lib/gaugeStatus.ts');

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/nwps/${name}`, import.meta.url), 'utf8'));
const AMAT2 = { record: fx('AMAT2-record.json'), observed: fx('AMAT2-observed-tail.json'), forecast: fx('AMAT2-forecast.json') };
const BKCT2_OBS = fx('BKCT2-observed-tail.json');
const BOQT2_OBS = fx('BOQT2-observed-tail.json');
const NO_FORECAST = fx('no-forecast.json');
const T = (iso) => Date.parse(iso);
// Shortly after the newest AMAT2 reading in the fixture (2026-10-02T12:30Z).
const AMAT2_NOW = T('2026-10-02T12:40:00Z');

// ---------------------------------------------------------------------------
// Gauge id validation
// ---------------------------------------------------------------------------

test('resolveGaugeId: known ids resolve, case-insensitively, to the canonical id', () => {
  const known = new Set(['AMAT2', 'HNFT2']);
  assert.equal(resolveGaugeId('AMAT2', known), 'AMAT2');
  assert.equal(resolveGaugeId('hnft2', known), 'HNFT2');
});

test('resolveGaugeId: unknown or malformed ids never reach the upstream URL', () => {
  const known = new Set(['AMAT2']);
  for (const bad of ['ZZZZ9', '', 'AMAT', 'AMAT22', 'AMAT2/stageflow', '../AMAT', 'AMAT2?x=1', 'AMAT2\n', ' AMAT2', 'AMAT%32', null, undefined, 42, ['AMAT2']]) {
    assert.equal(resolveGaugeId(bad, known), null, String(bad));
  }
  assert.equal(resolveGaugeId('AMAT2', new Set()), null);
});

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

test('normalizeSeries: AMAT2 forecast (real) is 20 ordered points peaking at 7.5 ft on 2026-10-03 06Z', () => {
  const s = normalizeSeries(AMAT2.forecast);
  assert.equal(s.points.length, 20);
  assert.equal(s.unit, 'ft');
  assert.equal(s.issuedAt, '2026-10-02T07:13:00Z');
  assert.ok(s.points.every((p, i) => i === 0 || p.t > s.points[i - 1].t));
  const crest = forecastCrest(s.points, T('2026-10-02T12:40:00Z'));
  assert.deepEqual(crest, { t: T('2026-10-03T06:00:00Z'), v: 7.5 });
});

test('normalizeSeries: NWPS "no forecast" (200, empty data, year-1 issuedTime) is an empty series', () => {
  const s = normalizeSeries(NO_FORECAST);
  assert.deepEqual(s.points, []);
  assert.equal(s.issuedAt, null);
});

test('normalizeSeries: the -9999 no-value rows in the real BOQT2 series are dropped', () => {
  const raw = BOQT2_OBS.data;
  assert.ok(raw.some((r) => r.primary < -100), 'fixture should contain a sentinel row');
  const s = normalizeSeries(BOQT2_OBS);
  assert.equal(s.points.length, raw.filter((r) => r.primary > -100).length);
  assert.ok(s.points.every((p) => p.v > -100));
});

test('normalizeSeries: garbage rows, repeats and bad times are ignored', () => {
  const s = normalizeSeries({
    issuedTime: '2026-10-02T00:00:00Z',
    primaryUnits: 'ft',
    data: [
      null, 'x', {}, { validTime: 'nope', primary: 3 }, { validTime: '0001-01-01T00:00:00Z', primary: 3 },
      { validTime: '2026-10-02T01:00:00Z', primary: '3' }, { validTime: '2026-10-02T01:00:00Z', primary: NaN },
      { validTime: '2026-10-02T02:00:00Z', primary: 4 }, { validTime: '2026-10-02T01:00:00Z', primary: 3 },
      { validTime: '2026-10-02T02:00:00Z', primary: 4.5 },
    ],
  });
  assert.deepEqual(s.points, [{ t: T('2026-10-02T01:00:00Z'), v: 3 }, { t: T('2026-10-02T02:00:00Z'), v: 4.5 }]);
  assert.deepEqual(normalizeSeries(null).points, []);
  assert.deepEqual(normalizeSeries({ data: 'x' }).points, []);
});

test('forecastCrest: only values from now on count; an expired forecast has no crest', () => {
  const pts = [{ t: 1000, v: 9 }, { t: 2000, v: 5 }, { t: 3000, v: 6 }];
  assert.deepEqual(forecastCrest(pts, 1500), { t: 3000, v: 6 });
  assert.equal(forecastCrest(pts, 4000), null);
  assert.equal(forecastCrest([], 0), null);
});

// ---------------------------------------------------------------------------
// Downsampling
// ---------------------------------------------------------------------------

test('downsample: a real 60 h, 15-minute AMAT2 series shrinks to about the cap and keeps its extremes', () => {
  const pts = normalizeSeries(AMAT2.observed).points;
  assert.ok(pts.length > 200);
  const out = downsample(pts, OBSERVED_MAX_POINTS);
  assert.ok(out.length <= OBSERVED_MAX_POINTS + 4 && out.length >= OBSERVED_MAX_POINTS / 2, String(out.length));
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
  const max = (a) => Math.max(...a.map((p) => p.v));
  const min = (a) => Math.min(...a.map((p) => p.v));
  assert.equal(max(out), max(pts));
  assert.equal(min(out), min(pts));
  assert.ok(out.every((p, i) => i === 0 || p.t > out[i - 1].t));
});

test('downsample: a spike (BOQT2 flash rise) survives, short series pass through unchanged', () => {
  const pts = Array.from({ length: 400 }, (_, i) => ({ t: i * 900_000, v: i === 200 ? 30 : 3 }));
  assert.ok(downsample(pts, 96).some((p) => p.v === 30));
  const few = pts.slice(0, 10);
  assert.equal(downsample(few, 96), few);
  assert.deepEqual(downsample([], 96), []);
});

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

const series = (startIso, stepMin, values) =>
  values.map((v, i) => ({ t: T(startIso) + i * stepMin * 60_000, v }));

test('computeTrend: AMAT2 right now is steady (3.88 -> 3.94 ft over 2 h)', () => {
  const r = computeTrend(normalizeSeries(AMAT2.observed).points, AMAT2_NOW);
  assert.equal(r.trend, 'steady');
  assert.ok(Math.abs(r.trendFtPerHour) < 0.05, String(r.trendFtPerHour));
});

test('computeTrend: BKCT2 (real) is falling at a measurable rate', () => {
  const pts = normalizeSeries(BKCT2_OBS).points;
  const last = pts[pts.length - 1].t;
  const r = computeTrend(pts, last + 10 * 60_000);
  assert.equal(r.trend, 'falling');
  assert.ok(r.trendFtPerHour < -0.1 && r.trendFtPerHour > -1.5, String(r.trendFtPerHour));
});

test('computeTrend: synthetic rise, and the steady band is symmetric', () => {
  const rising = series('2026-10-02T00:00:00Z', 15, Array.from({ length: 13 }, (_, i) => 5 + i * 0.1)); // 0.4 ft/h
  const r = computeTrend(rising, rising[12].t);
  assert.equal(r.trend, 'rising');
  assert.equal(r.trendFtPerHour, 0.4);
  const flat = series('2026-10-02T00:00:00Z', 15, Array.from({ length: 13 }, (_, i) => 5 + (i % 2) * 0.02));
  assert.equal(computeTrend(flat, flat[12].t).trend, 'steady');
});

test('computeTrend: no honest answer from stale, sparse or gappy data (BOQT2 real series)', () => {
  const pts = normalizeSeries(BOQT2_OBS).points;
  const last = pts[pts.length - 1].t;
  // Newest reading is 24.67 ft after an 8-hour hole: cannot say rising or falling.
  assert.deepEqual(computeTrend(pts, last + 5 * 60_000), { trendFtPerHour: null, trend: null });
  const fresh = series('2026-10-02T00:00:00Z', 15, Array.from({ length: 13 }, (_, i) => 5 + i * 0.1));
  // Reading is 2 h old: no "current" trend.
  assert.equal(computeTrend(fresh, fresh[12].t + 2 * 3_600_000).trend, null);
  // Three readings only.
  assert.equal(computeTrend(fresh.slice(-3), fresh[12].t).trend, null);
  // Four readings squeezed into 45 minutes.
  assert.equal(computeTrend(series('2026-10-02T00:00:00Z', 15, [1, 2, 3, 4]), T('2026-10-02T00:50:00Z')).trend, null);
  assert.deepEqual(computeTrend([], 0), { trendFtPerHour: null, trend: null });
});

// ---------------------------------------------------------------------------
// Record: impacts and crests
// ---------------------------------------------------------------------------

test('normalizeRecord: AMAT2 impacts are NWS statements, highest stage first', () => {
  const r = normalizeRecord(AMAT2.record);
  assert.equal(r.unit, 'ft');
  assert.deepEqual(r.impacts.map((i) => i.stage), [25, 17, 15, 10, 7]);
  assert.match(r.impacts[0].statement, /surface of the bridge/);
});

test('normalizeRecord: AMAT2 crests - 5 highest on record (with the record 25 ft in 1904), 5 most recent', () => {
  const { crests } = normalizeRecord(AMAT2.record);
  assert.equal(crests.historic.length, 5);
  assert.deepEqual(crests.historic[0], { date: '1904-10-01', stage: 25 });
  assert.deepEqual(crests.historic.map((c) => c.stage), [25, 24, 15.7, 15.2, 13.1]);
  assert.equal(crests.recent.length, 5);
  assert.equal(crests.recent[0].date, '2025-05-06');
  assert.ok(crests.recent.every((c, i) => i === 0 || c.date <= crests.recent[i - 1].date));
});

test('normalizeRecord: a gauge with no impacts and few crests (HNFT2, real) yields empty impacts, not an error', () => {
  const r = normalizeRecord(fx('HNFT2-record.json'));
  assert.deepEqual(r.impacts, []);
  assert.equal(r.crests.historic.length, 3);
  assert.equal(r.crests.recent.length, 3);
});

test('normalizeRecord: a lake (ABIT2, real) keeps elevation-style stages in its impacts', () => {
  const r = normalizeRecord(fx('ABIT2-record.json'));
  assert.deepEqual(r.impacts.map((i) => i.stage), [2024, 2018, 2009.7]);
});

test('normalizeRecord: old-datum, sentinel and malformed rows are dropped; text is cleaned', () => {
  const r = normalizeRecord({
    timeZone: 'CST6CDT',
    flood: {
      impacts: [
        { stage: 10, statement: '  Road\u0000 floods.\n\nSecond line  ' }, { stage: -9999, statement: 'x' },
        { stage: 12, statement: '' }, { stage: 'a', statement: 'x' }, null, { stage: 8, statement: 'z'.repeat(2000) },
      ],
      crests: {
        recent: [
          { occurredTime: '2025-05-06T02:45:00Z', stage: 5, olddatum: false },
          { occurredTime: '2025-05-06T02:45:00Z', stage: 5, olddatum: false },
          { occurredTime: '1990-01-01T00:00:00Z', stage: 9, olddatum: true },
          { occurredTime: '0001-01-01T00:00:00Z', stage: 9 }, { occurredTime: '2020-01-01T00:00:00Z', stage: -999 },
        ],
        historic: [],
      },
    },
  });
  assert.equal(r.impacts.length, 2);
  assert.equal(r.impacts[0].statement, 'Road floods. Second line');
  assert.equal(r.impacts[1].statement.length, 600);
  // 02:45Z on May 6 is still May 5 in Texas.
  assert.deepEqual(r.crests.recent, [{ date: '2025-05-05', stage: 5 }]);
  assert.deepEqual(normalizeImpacts(undefined), []);
  assert.deepEqual(normalizeRecord(null).crests, { recent: [], historic: [] });
});

// ---------------------------------------------------------------------------
// buildDetail
// ---------------------------------------------------------------------------

test('buildDetail: AMAT2 end to end, small payload', () => {
  const d = buildDetail('AMAT2', AMAT2, AMAT2_NOW);
  assert.equal(d.ok, true);
  assert.deepEqual(d.sources, { record: true, observed: true, forecast: true });
  assert.equal(d.unit, 'ft');
  assert.equal(d.forecastIssuedAt, '2026-10-02T07:13:00Z');
  assert.equal(d.observedAt, '2026-10-02T12:30:00.000Z');
  assert.equal(d.trend, 'steady');
  assert.ok(d.observed.length <= OBSERVED_MAX_POINTS + 4);
  assert.ok(d.observed.every((p) => p.t >= AMAT2_NOW - 48 * 3_600_000));
  assert.equal(d.forecast.length, 20);
  assert.equal(d.updatedAt, '2026-10-02T12:40:00.000Z');
  const bytes = JSON.stringify(d).length;
  assert.ok(bytes < 12_000, `payload ${bytes} bytes`);
});

test('buildDetail: HNFT2 (Guadalupe at Hunt, no flood stages) still gets readings, a steady trend and an empty forecast', () => {
  const observed = fx('HNFT2-observed-tail.json');
  const now = Date.parse(observed.data[observed.data.length - 1].validTime) + 5 * 60_000;
  const d = buildDetail('HNFT2', { record: fx('HNFT2-record.json'), observed, forecast: NO_FORECAST }, now);
  assert.equal(d.ok, true);
  assert.equal(d.trend, 'steady');
  assert.deepEqual(d.forecast, []);
  assert.deepEqual(d.impacts, []);
  assert.ok(d.observed.length > 50);
});

test('buildDetail: a gauge without a forecast is a successful, empty forecast (not a failure)', () => {
  const d = buildDetail('AMAT2', { ...AMAT2, forecast: NO_FORECAST }, AMAT2_NOW);
  assert.equal(d.sources.forecast, true);
  assert.deepEqual(d.forecast, []);
  assert.equal(d.forecastIssuedAt, null);
});

test('buildDetail: failed upstream requests are marked missing, never read as "none"', () => {
  const partial = buildDetail('AMAT2', { ...AMAT2, forecast: null }, AMAT2_NOW);
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.sources, { record: true, observed: true, forecast: false });
  const none = buildDetail('AMAT2', { record: null, observed: null, forecast: null }, AMAT2_NOW);
  assert.equal(none.ok, false);
  assert.deepEqual(none.sources, { record: false, observed: false, forecast: false });
  assert.deepEqual(none.observed, []);
  assert.equal(none.trend, null);
  assert.equal(none.unit, null);
});

// ---------------------------------------------------------------------------
// Snapshot repair (old localStorage copies)
// ---------------------------------------------------------------------------

const gauge = (over) => ({
  id: 'X', name: 'X', lat: 1, lon: 2, category: 'no_flooding', observedStage: 4, observedAt: '2026-10-02T12:00:00Z',
  unit: 'ft', thresholds: { action: 6, minor: 7, moderate: 10, major: 15 }, ...over,
});

test('repairGaugeStatus: a healthy gauge is returned untouched (same object)', () => {
  const g = gauge({});
  assert.equal(repairGaugeStatus(g), g);
  const f = gauge({ forecast: { stage: 7.5, unit: 'ft', validTime: '2026-10-03T06:00:00Z', category: 'minor' } });
  assert.equal(repairGaugeStatus(f), f);
});

test('repairGaugeStatus: an old snapshot\'s -999 reading and year-1 time become "no reading", gray', () => {
  const r = repairGaugeStatus(gauge({ observedStage: -999, observedAt: '0001-01-01T00:00:00Z', unit: '' }));
  assert.equal(r.observedStage, null);
  assert.equal(r.observedAt, null);
  assert.equal(r.category, 'not_defined');
});

test('repairGaugeStatus: with distrustNormal an old blue "Normal" with no flood stages goes gray; a gauge with stages stays blue', () => {
  const none = { action: null, minor: null, moderate: null, major: null };
  const old = { distrustNormal: true };
  assert.equal(repairGaugeStatus(gauge({ thresholds: none }), old).category, 'not_defined');
  assert.equal(repairGaugeStatus(gauge({ thresholds: null }), old).category, 'not_defined');
  assert.equal(repairGaugeStatus(gauge({ thresholds: none }), old).observedStage, 4);
  assert.equal(repairGaugeStatus(gauge({}), old).category, 'no_flooding');
});

test('repairGaugeStatus: a live answer\'s "Normal" is trusted without distrustNormal (BCVT2: real stages, newer than the meta)', () => {
  const g = gauge({ thresholds: null });
  assert.equal(repairGaugeStatus(g), g);
});

test('repairGaugeStatus: a forecast with sentinel values is dropped', () => {
  const r = repairGaugeStatus(gauge({ forecast: { stage: -999, unit: '', validTime: '0001-01-01T00:00:00Z', category: 'not_defined' } }));
  assert.equal('forecast' in r, false);
});

test('repairGauges: returns the same map when nothing needs fixing, a repaired copy otherwise', () => {
  const ok = { A: gauge({}) };
  assert.equal(repairGauges(ok), ok);
  const mixed = { A: gauge({}), B: gauge({ observedStage: -999 }) };
  const fixed = repairGauges(mixed);
  assert.notEqual(fixed, mixed);
  assert.equal(fixed.A, mixed.A);
  assert.equal(fixed.B.observedStage, null);
  assert.equal(mixed.B.observedStage, -999, 'input not mutated');
});
