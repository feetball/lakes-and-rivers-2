// Numeric check of the alert palette (src/lib/alertStyle.ts): readable against the
// basemap, unlike the gauge colours and unlike each other, including for colour-blind
// viewers (CIEDE2000 on Machado et al. simulations). Run: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_LEVELS, ALERT_STYLE } from '../src/lib/alertStyle.ts';
import { contrast, dE } from './helpers/color.mjs';

const LAND = '#e2dfda'; // Basemap.tsx EARTH_COLOR
// src/lib/floodStatus.ts CATEGORY_COLORS (incl. the tan "no flood stages") plus the "you are here" violet (globals.css).
const GAUGE = { nodata: '#94a3b8', nostages: '#a18e72', normal: '#2563eb', action: '#eab308', minor: '#f97316', moderate: '#dc2626', major: '#7f1d1d', you: '#8b5cf6' };
const KINDS = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];

test('every alert outline is at least 4.5:1 against the land colour', () => {
  for (const l of ALERT_LEVELS) assert.ok(contrast(ALERT_STYLE[l].color, LAND) >= 4.5, `${l} ${contrast(ALERT_STYLE[l].color, LAND).toFixed(2)}`);
});

test('levels differ by colour (dE >= 5, all vision types) or, for the same hue family, by weight', () => {
  for (const kind of KINDS) {
    for (let i = 0; i < ALERT_LEVELS.length; i++) {
      for (let j = i + 1; j < ALERT_LEVELS.length; j++) {
        const a = ALERT_STYLE[ALERT_LEVELS[i]], b = ALERT_STYLE[ALERT_LEVELS[j]];
        const d = dE(a.color, b.color, kind);
        if (d < 5) assert.ok(Math.abs(a.weight - b.weight) >= 1 && a.dashArray === b.dashArray, `${ALERT_LEVELS[i]}~${ALERT_LEVELS[j]} ${kind} dE ${d.toFixed(1)}`);
      }
    }
  }
});

test('no alert colour is close to a gauge colour (dE >= 8 for normal vision, >= 5 for colour-blind)', () => {
  for (const l of ALERT_LEVELS) {
    for (const [name, g] of Object.entries(GAUGE)) {
      for (const kind of KINDS) {
        const d = dE(ALERT_STYLE[l].color, g, kind);
        assert.ok(d >= (kind === 'normal' ? 8 : 5), `${l} vs ${name} ${kind} dE ${d.toFixed(1)}`);
      }
    }
  }
});

test('stronger alerts are drawn heavier; only watches and advisories are dashed', () => {
  const w = ALERT_LEVELS.map(l => ALERT_STYLE[l].weight);
  for (let i = 1; i < w.length; i++) assert.ok(w[i - 1] > w[i]);
  assert.equal(ALERT_STYLE.flash.dashArray, null);
  assert.ok(ALERT_STYLE.watch.dashArray && ALERT_STYLE.advisory.dashArray);
  assert.notEqual(ALERT_STYLE.watch.dashArray, ALERT_STYLE.advisory.dashArray);
});
