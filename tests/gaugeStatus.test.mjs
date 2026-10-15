// Tests for the "honest gray" rule and the forecast crest carried in the gauge
// snapshot (src/lib/floodStatus.ts, src/lib/gaugeStatus.ts). Run: pnpm test
//
// The fixtures are REAL payloads captured from the live NWS API on 2026-10-02
// (tests/fixtures/nwps/README.md): rows of the NWPS gauge list and the matching
// rows of the build-time gauges-meta.json that shipped with the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/ts-imports.mjs';

const { CATEGORY_COLORS, CATEGORY_LABELS, categorizeByStage, colorFor, displayCategory, hasValidThresholds, isValidStage } =
  await import('../src/lib/floodStatus.ts');
const { cleanTime, extractForecast, gaugeFromNwpsEntry, normalizeCategory, repairMetaEntry, resolveCategory } =
  await import('../src/lib/gaugeStatus.ts');

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/nwps/${name}`, import.meta.url), 'utf8'));
const LIST = new Map(fixture('list-sample.json').gauges.map((g) => [g.lid, g]));
const META = new Map(fixture('gauges-meta-sample.json').gauges.map((m) => [m.id, m]));

// What loadMeta() hands to processNwpsList: a repaired row, thresholds as shipped.
const status = (lid) => gaugeFromNwpsEntry(LIST.get(lid), META.has(lid) ? repairMetaEntry(META.get(lid)) : undefined);

const NONE = { action: null, minor: null, moderate: null, major: null };
const SENTINELS = { action: -9999, minor: -9999, moderate: -9999, major: -9999 };
const AMARILLO = { action: 6, minor: 7, moderate: 10, major: 15 };

// ---------------------------------------------------------------------------
// categorizeByStage
// ---------------------------------------------------------------------------

test('categorizeByStage: no defined flood stage is not_defined (gray), never no_flooding', () => {
  for (const stage of [0, 1.77, 3.48, 4.6, 25, 5000]) {
    assert.equal(categorizeByStage(stage, NONE), 'not_defined', `stage ${stage}`);
    assert.equal(categorizeByStage(stage, SENTINELS), 'not_defined', `stage ${stage} (-9999 sentinels)`);
  }
});

test('categorizeByStage: a gauge with flood stages still resolves every category', () => {
  assert.equal(categorizeByStage(3.88, AMARILLO), 'no_flooding');
  assert.equal(categorizeByStage(6, AMARILLO), 'action');
  assert.equal(categorizeByStage(7, AMARILLO), 'minor');
  assert.equal(categorizeByStage(10, AMARILLO), 'moderate');
  assert.equal(categorizeByStage(15, AMARILLO), 'major');
  assert.equal(categorizeByStage(40, AMARILLO), 'major');
});

test('categorizeByStage: partial thresholds still cascade (Lake Abilene-style: only action defined)', () => {
  const t = META.get('ABIT2').thresholds; // real: action 2012.3, the rest undefined
  assert.deepEqual(t, { action: 2012.3, minor: null, moderate: null, major: null });
  assert.equal(categorizeByStage(1991.55, t), 'no_flooding');
  assert.equal(categorizeByStage(2012.3, t), 'action');
  assert.equal(categorizeByStage(2030, t), 'action');
});

test('categorizeByStage: a missing reading (-999) has no status', () => {
  assert.equal(categorizeByStage(-999, AMARILLO), 'not_defined');
  assert.equal(categorizeByStage(Number.NaN, AMARILLO), 'not_defined');
  assert.equal(isValidStage(-999), false);
  assert.equal(isValidStage(null), false);
  assert.equal(isValidStage(0), true);
  assert.equal(isValidStage(-2.5), true); // below datum zero is a real reading
});

test('hasValidThresholds', () => {
  assert.equal(hasValidThresholds(null), false);
  assert.equal(hasValidThresholds(undefined), false);
  assert.equal(hasValidThresholds(NONE), false);
  assert.equal(hasValidThresholds(SENTINELS), false);
  assert.equal(hasValidThresholds({ ...NONE, minor: 15 }), true);
  assert.equal(hasValidThresholds(AMARILLO), true);
});

// ---------------------------------------------------------------------------
// resolveCategory / normalizeCategory
// ---------------------------------------------------------------------------

test('resolveCategory: a category NWPS supplied wins, even "no_flooding" without thresholds on file', () => {
  // BCVT2 and NFLT2 are newer than the shipped meta: no thresholds on file, but NWPS has its own answer.
  assert.equal(resolveCategory('no_flooding', 2.09, null), 'no_flooding');
  assert.equal(resolveCategory('minor', 7.08, null), 'minor');
  assert.equal(resolveCategory('major', 24.67, AMARILLO), 'major');
  assert.equal(resolveCategory('not_defined', 52.59, null), 'not_defined');
});

test('resolveCategory: not_defined + no defined stage stays not_defined (HNFT2, GRHT2, LNXT2)', () => {
  assert.equal(resolveCategory('not_defined', 1.77, NONE), 'not_defined');
  assert.equal(resolveCategory(null, 3.48, NONE), 'not_defined');
  assert.equal(resolveCategory(undefined, 4.6, NONE), 'not_defined');
});

test('resolveCategory: a missing NWPS category is derived when the stage and the thresholds are known', () => {
  assert.equal(resolveCategory(null, 3.88, AMARILLO), 'no_flooding');
  assert.equal(resolveCategory(null, 8, AMARILLO), 'minor');
  assert.equal(resolveCategory('not_defined', 11, AMARILLO), 'moderate');
});

test('normalizeCategory: operational strings are not categories', () => {
  for (const raw of ['out_of_service', 'obs_not_current', 'fcst_not_current', 'low_threshold', null, 7]) {
    assert.equal(normalizeCategory(raw), 'not_defined', String(raw));
  }
  assert.equal(normalizeCategory('moderate'), 'moderate');
});

// ---------------------------------------------------------------------------
// gaugeFromNwpsEntry: real NWPS rows
// ---------------------------------------------------------------------------

test('the Guadalupe gauges with no flood stages (Hunt, Kerrville, Lynx Haven) are gray, with their reading kept', () => {
  for (const [lid, stage] of [['HNFT2', 1.77], ['GRHT2', 3.48], ['LNXT2', 4.6]]) {
    const g = status(lid);
    assert.equal(g.category, 'not_defined', lid);
    assert.equal(g.observedStage, stage, lid);
    assert.equal(g.unit, 'ft', lid);
    assert.deepEqual(g.thresholds, NONE, lid);
    assert.ok(!('forecast' in g), `${lid} has no forecast`);
  }
});

test('the same gauges resolve gray even through the OLD meta row that says no_flooding', () => {
  // The shipped gauges-meta.json has category "no_flooding" for all 721 gauges. It must not leak into any path.
  for (const lid of ['HNFT2', 'GRHT2', 'LNXT2', 'ANPT2']) {
    assert.equal(META.get(lid).category, 'no_flooding', `${lid} fixture is the old, wrong meta row`);
    assert.equal(repairMetaEntry(META.get(lid)).category, 'not_defined', lid);
  }
});

test('NWPS "no reading" rows (-999, year-1 time, empty unit) become a gray gauge with no reading', () => {
  for (const [lid, nwpsCategory] of [['CDPT2', 'obs_not_current'], ['BDLT2', 'out_of_service']]) {
    assert.equal(LIST.get(lid).status.observed.primary, -999, `${lid} raw row is the sentinel`);
    assert.equal(LIST.get(lid).status.observed.floodCategory, nwpsCategory);
    const g = status(lid);
    assert.equal(g.category, 'not_defined', lid);
    assert.equal(g.observedStage, null, lid);
    assert.equal(g.observedAt, null, lid);
    assert.equal(g.unit, 'ft', `${lid}: the empty unit of a missing reading falls back to the meta unit`);
    assert.ok(!('forecast' in g), lid);
  }
  // CDPT2 HAS flood stages: before the fix its -999 "reading" was categorized as a blue Normal.
  assert.equal(META.get('CDPT2').thresholds.action, 12);
});

test('gauges newer than the shipped meta keep the category NWPS reports (BCVT2 blue, NFLT2 gray)', () => {
  assert.equal(status('BCVT2').category, 'no_flooding');
  assert.equal(status('BCVT2').thresholds, null);
  assert.equal(status('NFLT2').category, 'not_defined');
  assert.equal(status('NFLT2').observedStage, 52.59);
});

test('gauges with flood stages are unchanged: NWPS category, derived category, low_threshold', () => {
  assert.equal(status('AMAT2').category, 'no_flooding');
  assert.equal(status('BKCT2').category, 'minor');
  assert.equal(status('BOQT2').category, 'major');
  assert.equal(status('CMKT2').category, 'moderate');
  assert.equal(status('KRRT2').category, 'no_flooding');
  assert.equal(status('ABIT2').category, 'no_flooding'); // only "action" defined, stage far below it
  // NWPS says low_threshold (low water): not a flood category, so it is derived from the stage.
  assert.equal(LIST.get('BRPT2').status.observed.floodCategory, 'low_threshold');
  assert.equal(status('BRPT2').category, 'no_flooding');
});

test('no gauge without a defined flood stage is blue unless NWPS itself said so', () => {
  for (const lid of LIST.keys()) {
    const g = status(lid);
    const nwps = normalizeCategory(LIST.get(lid).status.observed.floodCategory);
    if (!hasValidThresholds(g.thresholds) && nwps === 'not_defined') {
      assert.equal(g.category, 'not_defined', lid);
    }
  }
});

// ---------------------------------------------------------------------------
// Forecast crest in the snapshot
// ---------------------------------------------------------------------------

test('AMAT2 (Canadian River at Amarillo) carries the NWS forecast crest: 7.5 ft, Minor, 2026-10-03 06Z', () => {
  const g = status('AMAT2');
  assert.deepEqual(g.forecast, {
    stage: 7.5,
    unit: 'ft',
    validTime: '2026-10-03T06:00:00Z',
    category: 'minor',
  });
  // The gauge list has no issuance time, so the snapshot does not pretend to know it.
  assert.ok(!('issuedAt' in g.forecast));
});

test('forecast category: NWPS value kept, derived when absent, not_defined without flood stages', () => {
  assert.equal(status('BKCT2').forecast.category, 'action'); // observed already minor: kept as reported
  assert.deepEqual(status('BKCT2').forecast, { stage: 4.9, unit: 'ft', validTime: '2026-10-02T12:00:00Z', category: 'action' });
  assert.equal(status('KRRT2').forecast.category, 'no_flooding');
  // ANPT2 has a forecast (2.05 ft) but NWS defines no flood stage for it.
  assert.equal(status('ANPT2').forecast.stage, 2.05);
  assert.equal(status('ANPT2').forecast.category, 'not_defined');
  // A forecast whose category NWPS left blank is derived from the stage (synthetic edit of the AMAT2 row).
  const blank = structuredClone(LIST.get('AMAT2'));
  blank.status.forecast.floodCategory = null;
  assert.equal(gaugeFromNwpsEntry(blank, META.get('AMAT2')).forecast.category, 'minor');
});

test('"no current forecast" sentinels never produce a forecast', () => {
  for (const lid of ['HNFT2', 'CDPT2', 'BDLT2', 'BCVT2', 'ABIT2']) {
    assert.deepEqual(LIST.get(lid).status.forecast.primary < -100, true, `${lid} raw row carries the sentinel`);
    assert.equal(extractForecast(LIST.get(lid).status.forecast, null), null, lid);
    assert.ok(!('forecast' in status(lid)), lid);
  }
  assert.equal(extractForecast(undefined, null), null);
  assert.equal(extractForecast({ primary: 4.2, validTime: '0001-01-01T00:00:00Z', floodCategory: 'minor' }, null), null);
  assert.equal(extractForecast({ primary: 4.2, validTime: 'garbage' }, null), null);
});

test('forecast payload cost: about 90 bytes per gauge, and only for gauges that have one', () => {
  const bytes = JSON.stringify(status('AMAT2').forecast).length + ',"forecast":'.length;
  assert.ok(bytes < 120, `${bytes} bytes`);
  const withForecast = [...LIST.keys()].filter((lid) => 'forecast' in status(lid));
  assert.deepEqual(withForecast.sort(), ['AMAT2', 'ANPT2', 'BKCT2', 'BOQT2', 'CMKT2', 'KRRT2']);
});

// ---------------------------------------------------------------------------
// repairMetaEntry (build-time meta read by fallbackFromMeta and the USGS fallback)
// ---------------------------------------------------------------------------

test('repairMetaEntry: a -999 build-time reading is dropped and the gauge goes gray', () => {
  for (const lid of ['CDPT2', 'BDLT2']) {
    const r = repairMetaEntry(META.get(lid));
    assert.equal(r.category, 'not_defined', lid);
    assert.equal(r.observedStage, null, lid);
    assert.equal(r.observedAt, null, lid);
  }
});

test('repairMetaEntry: rows with flood stages and a real reading are left alone', () => {
  const amat = META.get('AMAT2');
  assert.deepEqual(repairMetaEntry(amat), amat);
  assert.deepEqual(repairMetaEntry(META.get('BKCT2')).thresholds, { action: 4, minor: 6, moderate: 8, major: 15 });
  assert.equal(repairMetaEntry(META.get('BKCT2')).category, 'no_flooding');
});

test('repairMetaEntry: only a derived "no_flooding" is distrusted; a real stored category survives', () => {
  const stored = { ...META.get('HNFT2'), category: 'minor' };
  assert.equal(repairMetaEntry(stored).category, 'minor');
  // older meta files carry no observation at all
  const bare = { ...META.get('AMAT2') };
  delete bare.category; delete bare.observedStage; delete bare.observedAt;
  const r = repairMetaEntry(bare);
  assert.equal(r.category, 'not_defined');
  assert.equal(r.observedStage, null);
});

// ---------------------------------------------------------------------------
// cleanTime
// ---------------------------------------------------------------------------

test('cleanTime: only real times survive', () => {
  assert.equal(cleanTime('2026-10-02T10:45:00Z'), '2026-10-02T10:45:00Z');
  assert.equal(cleanTime('0001-01-01T00:00:00Z'), null);
  assert.equal(cleanTime('1970-01-01T00:00:00.000Z'), null);
  assert.equal(cleanTime('not a date'), null);
  assert.equal(cleanTime(undefined), null);
  assert.equal(cleanTime(1759401900000), null);
});

// ---------------------------------------------------------------------------
// displayCategory: "no flood stages" is not "no data"
// ---------------------------------------------------------------------------

test('displayCategory: a reading with no defined flood stages is no_stages (tan), never no_data (gray) or Normal', () => {
  for (const lid of ['HNFT2', 'GRHT2', 'LNXT2']) {
    const g = status(lid);
    assert.equal(g.category, 'not_defined', `${lid}: the API category stays not_defined`);
    assert.equal(displayCategory(g), 'no_stages', lid);
    assert.equal(CATEGORY_LABELS[displayCategory(g)], 'No flood stages', lid);
    assert.notEqual(colorFor(displayCategory(g)), CATEGORY_COLORS.not_defined, lid);
    assert.notEqual(colorFor(displayCategory(g)), CATEGORY_COLORS.no_flooding, lid);
  }
});

test('displayCategory: a gauge that reports nothing stays no_data, with or without flood stages', () => {
  for (const lid of ['CDPT2', 'BDLT2']) {
    const g = status(lid);
    assert.equal(g.observedStage, null, lid);
    assert.equal(displayCategory(g), 'not_defined', lid);
  }
  assert.equal(displayCategory({ category: 'not_defined', observedStage: null, thresholds: AMARILLO }), 'not_defined');
  assert.equal(displayCategory({ category: 'not_defined', observedStage: -999, thresholds: NONE }), 'not_defined');
});

test('displayCategory: a "Normal" with no flood stages behind it becomes no_stages; a real Normal stays', () => {
  assert.equal(displayCategory({ category: 'no_flooding', observedStage: 2.1, thresholds: NONE }), 'no_stages');
  assert.equal(displayCategory({ category: 'no_flooding', observedStage: 2.1, thresholds: SENTINELS }), 'no_stages');
  assert.equal(displayCategory({ category: 'no_flooding', observedStage: 3.88, thresholds: AMARILLO }), 'no_flooding');
});

test('displayCategory: unknown thresholds (null) prove nothing, and a flood category is never replaced', () => {
  assert.equal(displayCategory({ category: 'not_defined', observedStage: 2.1, thresholds: null }), 'not_defined');
  assert.equal(displayCategory({ category: 'no_flooding', observedStage: 2.1, thresholds: null }), 'no_flooding');
  for (const category of ['action', 'minor', 'moderate', 'major']) {
    assert.equal(displayCategory({ category, observedStage: 12, thresholds: NONE }), category);
  }
});

test('displayCategory: only the gauges with a reading and no stages move; the rest of the sample is unchanged', () => {
  for (const lid of LIST.keys()) {
    const g = status(lid);
    const shown = displayCategory(g);
    if (shown === 'no_stages') {
      assert.ok(isValidStage(g.observedStage) && g.thresholds && !hasValidThresholds(g.thresholds), lid);
    } else {
      assert.equal(shown, g.category, lid);
    }
  }
});
