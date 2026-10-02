// The two kinds of gray gauge must stay apart on the map: "No data" (slate: no reading) and
// "No flood stages" (tan: a reading, but NWS defines no stages). Numeric check, colour-blind
// viewers included (CIEDE2000 on Machado et al. simulations). Run: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_COLORS, CATEGORY_LABELS, CATEGORY_ORDER } from '../src/lib/floodStatus.ts';
import { ALERT_LEVELS, ALERT_STYLE } from '../src/lib/alertStyle.ts';
import { contrast, dE } from './helpers/color.mjs';

const LAND = '#e2dfda'; // Basemap.tsx EARTH_COLOR
const YOU = '#8b5cf6'; // "you are here" (globals.css)
const KINDS = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];

test('every status in the legend has a colour and a label, and the two grays are told apart', () => {
  assert.equal(CATEGORY_LABELS.not_defined, 'No data');
  assert.equal(CATEGORY_LABELS.no_stages, 'No flood stages');
  for (const c of CATEGORY_ORDER) assert.ok(CATEGORY_COLORS[c] && CATEGORY_LABELS[c], c);
  assert.equal(new Set(CATEGORY_ORDER).size, CATEGORY_ORDER.length);
  assert.ok(CATEGORY_ORDER.includes('no_stages') && CATEGORY_ORDER.includes('not_defined'));
});

test('"No flood stages" differs from every other status colour (dE >= 15 normal vision, >= 10 colour-blind)', () => {
  for (const [cat, color] of Object.entries(CATEGORY_COLORS)) {
    if (cat === 'no_stages') continue;
    for (const kind of KINDS) {
      const d = dE(CATEGORY_COLORS.no_stages, color, kind);
      assert.ok(d >= (kind === 'normal' ? 15 : 10), `no_stages vs ${cat} ${kind} dE ${d.toFixed(1)}`);
    }
  }
});

test('"No flood stages" is not the "you are here" violet nor any alert colour', () => {
  for (const kind of KINDS) {
    assert.ok(dE(CATEGORY_COLORS.no_stages, YOU, kind) >= (kind === 'normal' ? 15 : 10), `you ${kind}`);
    for (const l of ALERT_LEVELS) {
      assert.ok(dE(CATEGORY_COLORS.no_stages, ALERT_STYLE[l].color, kind) >= (kind === 'normal' ? 8 : 5), `${l} ${kind}`);
    }
  }
});

test('a "No flood stages" river line or dot can be seen on the land colour (at least 2:1, like the gray)', () => {
  assert.ok(contrast(CATEGORY_COLORS.no_stages, LAND) >= 2, contrast(CATEGORY_COLORS.no_stages, LAND).toFixed(2));
  assert.ok(contrast(CATEGORY_COLORS.no_stages, LAND) >= contrast(CATEGORY_COLORS.not_defined, LAND) * 0.9);
});
