// What the gauge sheet says about the forecast, and the hydrograph scale rules
// (src/lib/forecastView.ts, src/lib/hydrographLayout.ts, src/lib/timeFormat.ts).
// Uses the real AMAT2 / HNFT2 NWPS fixtures (tests/fixtures/nwps/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/ts-imports.mjs';

const { buildDetail } = await import('../src/lib/gaugeDetail.ts');
const { viewForecast, FORECAST_STALE_MS } = await import('../src/lib/forecastView.ts');
const { layoutHydrograph, niceTicks, stageDomain, CHART } = await import('../src/lib/hydrographLayout.ts');
const { relativeTime, formatCalendarDate } = await import('../src/lib/timeFormat.ts');

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/nwps/${name}`, import.meta.url), 'utf8'));
const AMAT2_RAW = { record: fx('AMAT2-record.json'), observed: fx('AMAT2-observed-tail.json'), forecast: fx('AMAT2-forecast.json') };
const NOW = Date.parse('2026-10-02T12:40:00Z');
const AMARILLO = { action: 6, minor: 7, moderate: 10, major: 15 };
const NONE = { action: null, minor: null, moderate: null, major: null };
const gauge = (over = {}) => ({
  id: 'AMAT2', name: 'Canadian River at Amarillo', lat: 35.4, lon: -101.9, category: 'no_flooding',
  observedStage: 3.94, observedAt: '2026-10-02T12:30:00Z', unit: 'ft', thresholds: AMARILLO, ...over,
});
const detail = (over = {}) => buildDetail('AMAT2', { ...AMAT2_RAW, ...over }, NOW);

// ---------------------------------------------------------------------------
// viewForecast
// ---------------------------------------------------------------------------

test('viewForecast: AMAT2 from the detail - crest 7.5 ft, Minor, issue time known', () => {
  const v = viewForecast(gauge(), { data: detail(), failed: false }, NOW);
  assert.equal(v.kind, 'crest');
  assert.equal(v.stage, 7.5);
  assert.equal(v.t, Date.parse('2026-10-03T06:00:00Z'));
  assert.equal(v.category, 'minor');
  assert.equal(v.issuedAt, '2026-10-02T07:13:00Z');
  assert.equal(v.stale, false);
});

test('viewForecast: the gauge list\'s crest shows at once, before the detail has loaded', () => {
  const g = gauge({ forecast: { stage: 7.5, unit: 'ft', validTime: '2026-10-03T06:00:00Z', category: 'minor' } });
  const v = viewForecast(g, { data: undefined, failed: false }, NOW);
  assert.equal(v.kind, 'crest');
  assert.equal(v.category, 'minor');
  assert.equal(v.issuedAt, null);
});

test('viewForecast: loading, and "unavailable" (not "none") when the request failed', () => {
  assert.equal(viewForecast(gauge(), { data: undefined, failed: false }, NOW).kind, 'loading');
  assert.equal(viewForecast(gauge(), { data: undefined, failed: true }, NOW).kind, 'unavailable');
  // The forecast request alone failed while record and observed arrived.
  assert.equal(viewForecast(gauge(), { data: detail({ forecast: null }), failed: false }, NOW).kind, 'unavailable');
});

test('viewForecast: NWPS saying "no forecast" is "none" - and wins over a stale list entry', () => {
  const empty = detail({ forecast: fx('no-forecast.json') });
  assert.equal(viewForecast(gauge(), { data: empty, failed: false }, NOW).kind, 'none');
  const g = gauge({ forecast: { stage: 7.5, unit: 'ft', validTime: '2026-10-03T06:00:00Z', category: 'minor' } });
  assert.equal(viewForecast(g, { data: empty, failed: false }, NOW).kind, 'none');
});

test('viewForecast: a forecast that is entirely in the past is expired; one issued 24 h+ ago is flagged stale', () => {
  const later = Date.parse('2026-10-08T00:00:00Z');
  const d = buildDetail('AMAT2', AMAT2_RAW, later);
  assert.equal(viewForecast(gauge(), { data: d, failed: false }, later).kind, 'expired');
  // Issued 07:13Z; a day and a minute later, with a crest still ahead.
  const d2 = detail();
  const at = Date.parse('2026-10-02T07:13:00Z') + FORECAST_STALE_MS + 60_000;
  d2.forecast = [{ t: at + 3_600_000, v: 8 }];
  const v = viewForecast(gauge(), { data: d2, failed: false }, at);
  assert.equal(v.kind, 'crest');
  assert.equal(v.stale, true);
});

test('viewForecast: a gauge without flood stages gets no flood category for its forecast crest', () => {
  const v = viewForecast(gauge({ thresholds: NONE }), { data: detail(), failed: false }, NOW);
  assert.equal(v.kind, 'crest');
  assert.equal(v.category, 'not_defined');
});

// ---------------------------------------------------------------------------
// Hydrograph scale
// ---------------------------------------------------------------------------

test('stageDomain: AMAT2 (3.9 ft steady, Action 6) shows the next flood stage above the data, not the far ones', () => {
  const [lo, hi] = stageDomain([3.8, 3.9, 3.94], AMARILLO);
  assert.ok(hi >= 6 && hi < 7, String(hi));
  assert.ok(lo < 3.8);
});

test('stageDomain: a flood stage far above the data is left off rather than flattening the line', () => {
  const [, hi] = stageDomain([3.8, 3.9, 4.0], { action: 40, minor: 50, moderate: null, major: null });
  assert.ok(hi < 6, String(hi));
});

test('stageDomain: a flat series gets a minimum span; no flood stages means data only', () => {
  const [lo, hi] = stageDomain([5, 5, 5], NONE);
  assert.ok(hi - lo >= 1);
  const [lo2, hi2] = stageDomain([2, 9], null);
  assert.ok(lo2 < 2 && hi2 > 9 && hi2 < 10);
});

test('layoutHydrograph: AMAT2 (real: a 10 ft Moderate crest on Sep 30, now 3.9 ft) draws both series, all four flood lines and "now"', () => {
  const d = detail();
  const l = layoutHydrograph({ observed: d.observed, forecast: d.forecast, thresholds: AMARILLO, nowMs: NOW });
  assert.ok(l);
  assert.match(l.observedPath, /^M/);
  assert.match(l.forecastPath, /^M/);
  assert.deepEqual(l.lines.map((x) => x.key), ['action', 'minor', 'moderate', 'major']);
  assert.ok(l.nowX !== null && l.nowX > CHART.left && l.nowX < CHART.w - CHART.right);
  assert.ok(l.lines.every((x) => x.y >= CHART.top && x.y <= CHART.h - CHART.bottom));
  // Higher stages are higher on the page (smaller y).
  assert.ok(l.lines[0].y > l.lines[1].y && l.lines[1].y > l.lines[2].y && l.lines[2].y > l.lines[3].y);
  assert.ok(l.yTicks.length >= 3 && l.yTicks.every((t) => Number.isInteger(t.v) && t.y >= CHART.top && t.y <= CHART.h - CHART.bottom));
});

test('layoutHydrograph: nothing to draw with fewer than two points', () => {
  assert.equal(layoutHydrograph({ observed: [{ t: 1, v: 1 }], forecast: [], thresholds: null, nowMs: 2 }), null);
  assert.equal(layoutHydrograph({ observed: [], forecast: [], thresholds: null, nowMs: 2 }), null);
});

test('layoutHydrograph: no flood lines for a gauge without flood stages', () => {
  const d = detail();
  const l = layoutHydrograph({ observed: d.observed, forecast: d.forecast, thresholds: NONE, nowMs: NOW });
  assert.deepEqual(l.lines, []);
});

// ---------------------------------------------------------------------------
// Time text
// ---------------------------------------------------------------------------

test('relativeTime: future and past, in the app\'s existing age words', () => {
  assert.equal(relativeTime(NOW + 17 * 3_600_000, NOW), 'in 17 hours');
  assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), '3 hours ago');
  assert.equal(relativeTime(NOW - 20_000, NOW), 'just now');
  assert.equal(relativeTime(NOW + 45 * 60_000, NOW), 'in 45 minutes');
});

test('formatCalendarDate: a calendar date is not shifted by the viewer\'s time zone', () => {
  assert.match(formatCalendarDate('1904-10-01'), /1904/);
  assert.match(formatCalendarDate('1904-10-01'), /\b1\b/);
  assert.equal(formatCalendarDate('garbage'), 'garbage');
});

test('niceTicks: round values inside the range', () => {
  assert.deepEqual(niceTicks(2.1, 15.7, 4), [5, 10, 15]);
  assert.deepEqual(niceTicks(3.5, 6.5, 4), [4, 5, 6]);
  assert.deepEqual(niceTicks(2005.2, 2024.8, 4), [2010, 2015, 2020]);
  assert.deepEqual(niceTicks(0.1, 0.9, 4), [0.2, 0.4, 0.6, 0.8]);
});
