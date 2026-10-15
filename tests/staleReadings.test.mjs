// Old readings must not look current (src/lib/floodStatus.ts displayCategory, src/lib/gaugeList.ts),
// and every reading says where it came from (GaugeStatus.source). Run: pnpm test
//
// Real case behind this, 2026-10-15: New Year Creek near Brenham (NYBT2) last reported ~20 days
// earlier and still drew a blue "Normal" dot, while the legend says gray means "no recent reading".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/ts-imports.mjs';

const { NO_RECENT_READING_MS, STALE_DATA_MS, displayCategory } = await import('../src/lib/floodStatus.ts');
const { describeItem, listCategory, searchGauges, buildGaugeIndex, toListItem } = await import('../src/lib/gaugeList.ts');
const { gaugeFromNwpsEntry, repairMetaEntry } = await import('../src/lib/gaugeStatus.ts');

const live = JSON.parse(readFileSync(new URL('./fixtures/gauges-live-sample.json', import.meta.url), 'utf8'));
const NOW = new Date(live.updatedAt).getTime() + 60_000;
const HOUR = 3_600_000;
const at = (msBeforeNow) => new Date(NOW - msBeforeNow).toISOString();
const g = (id, edits = {}) => ({ ...live.gauges[id], ...edits });
const NONE = { action: null, minor: null, moderate: null, major: null };

test('the cutoff sits above the sheet/list warning, so gauges reporting every few hours stay coloured', () => {
  assert.equal(NO_RECENT_READING_MS, 6 * HOUR);
  assert.ok(NO_RECENT_READING_MS > STALE_DATA_MS);
});

test('without a reference time displayCategory is unchanged (old callers, stored snapshots)', () => {
  assert.equal(displayCategory(g('KRRT2', { observedAt: at(30 * 24 * HOUR) })), 'no_flooding');
});

test('an old or untimed "Normal" turns gray; a recent one stays blue', () => {
  assert.equal(displayCategory(g('KRRT2', { observedAt: at(5 * HOUR) }), NOW), 'no_flooding');
  assert.equal(displayCategory(g('KRRT2', { observedAt: at(NO_RECENT_READING_MS) }), NOW), 'no_flooding');
  assert.equal(displayCategory(g('KRRT2', { observedAt: at(NO_RECENT_READING_MS + 60_000) }), NOW), 'not_defined');
  assert.equal(displayCategory(g('KRRT2', { observedAt: at(20 * 24 * HOUR) }), NOW), 'not_defined');
  assert.equal(displayCategory(g('KRRT2', { observedAt: null }), NOW), 'not_defined');
  assert.equal(displayCategory(g('KRRT2', { observedAt: '1970-01-01T00:00:00.000Z' }), NOW), 'not_defined');
});

test('an old "No flood stages" (tan) turns gray too', () => {
  const tan = g('HNTT2', { thresholds: NONE });
  assert.equal(displayCategory({ ...tan, observedAt: at(HOUR) }, NOW), 'no_stages');
  assert.equal(displayCategory({ ...tan, observedAt: at(7 * HOUR) }, NOW), 'not_defined');
});

test('a flood colour is never grayed, however old', () => {
  for (const category of ['action', 'minor', 'moderate', 'major']) {
    assert.equal(displayCategory(g('DALT2', { category, observedAt: at(30 * 24 * HOUR) }), NOW), category);
    assert.equal(displayCategory(g('DALT2', { category, observedAt: null }), NOW), category);
  }
});

test('timeline: judged against the snapshot time, and forecast times (in the future) are not old', () => {
  const snapshotMs = NOW - 3 * 24 * HOUR;
  const then = g('KRRT2', { observedAt: new Date(snapshotMs - 20 * 60_000).toISOString() });
  assert.equal(displayCategory(then, snapshotMs), 'no_flooding');
  assert.equal(displayCategory(then, NOW), 'not_defined');
  const forecast = g('KRRT2', { observedAt: new Date(NOW + 30 * HOUR).toISOString() });
  assert.equal(displayCategory(forecast, NOW + 30 * HOUR), 'no_flooding');
  assert.equal(displayCategory(forecast, NOW), 'no_flooding');
});

test('list: an old "Normal" is listed gray as "No recent reading" with its age', () => {
  const old = g('KRRT2', { observedAt: at(20 * 24 * HOUR) });
  assert.equal(listCategory(old, NOW), 'not_defined');
  const text = describeItem(toListItem(old, NOW));
  assert.ok(text.segments.some(s => s.text === 'No recent reading'), JSON.stringify(text.segments));
  assert.ok(text.segments.some(s => s.warn && s.text === 'Reading is 20 days old'));
  assert.ok(!/Normal/.test(text.ariaLabel));
  // Between the list's 90-minute warning and the 6-hour cutoff: still Normal, with the warning.
  const warned = describeItem(toListItem(g('KRRT2', { observedAt: at(3 * HOUR) }), NOW));
  assert.ok(warned.segments.some(s => s.text === 'Normal'));
  assert.ok(warned.segments.some(s => s.warn && s.text === 'Reading is 3 hours old'));
});

test('list: a gauge with stages but no thresholds left is still "Flood stages not defined" when its reading is recent', () => {
  const gray = g('HNTT2', { category: 'not_defined', thresholds: null, observedAt: at(HOUR) });
  const text = describeItem(toListItem(gray, NOW));
  assert.ok(text.segments.some(s => s.text === 'Flood stages not defined'), JSON.stringify(text.segments));
});

test('search ranks an old "Normal" as no data, below a current one', () => {
  const gauges = [g('KRRT2', { observedAt: at(20 * 24 * HOUR) }), g('HNTT2', { observedAt: at(HOUR) })];
  const r = searchGauges(buildGaugeIndex(gauges), 'guadalupe', { nowMs: NOW });
  const cats = Object.fromEntries(r.items.map(i => [i.gauge.id, i.category]));
  assert.equal(cats.KRRT2, 'not_defined');
  assert.equal(cats.HNTT2, 'no_flooding');
});

test('source: NWPS rows with a reading say "nws"; rows without one say nothing', () => {
  const list = JSON.parse(readFileSync(new URL('./fixtures/nwps/list-sample.json', import.meta.url), 'utf8')).gauges;
  const meta = new Map(JSON.parse(readFileSync(new URL('./fixtures/nwps/gauges-meta-sample.json', import.meta.url), 'utf8')).gauges.map(m => [m.id, m]));
  let withReading = 0;
  for (const row of list) {
    const s = gaugeFromNwpsEntry(row, meta.has(row.lid) ? repairMetaEntry(meta.get(row.lid)) : undefined);
    if (s.observedStage === null) assert.ok(!('source' in s), row.lid);
    else { assert.equal(s.source, 'nws', row.lid); withReading++; }
  }
  assert.ok(withReading > 0);
  const blank = { ...list[0], status: { ...list[0].status, observed: { ...list[0].status.observed, primary: -999 } } };
  assert.ok(!('source' in gaugeFromNwpsEntry(blank, undefined)));
});
