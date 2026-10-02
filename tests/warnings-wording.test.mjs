// The NWS overlay must never read as an official or guaranteed "alert" service. These tests read the
// source of every component that shows warnings and check the words a person sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['AlertSheet', 'AlertsListSheet', 'AlertsStatusChip', 'LegendLayers'].map(n => `src/components/${n}.tsx`);
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// Quoted strings and JSX text: what ends up on screen (or in an aria-label).
function visibleStrings(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2].replace(/\$\{[^}]*\}/g, ''));
  for (const m of code.matchAll(/>([^<>{}=;()]*[A-Za-z][^<>{}=;()]*)</g)) out.push(m[1].trim());
  return out;
}
// Technical values that are not shown: the AlertGeometrySource kind, ARIA role names.
const TECHNICAL = new Set(['alert']);

test('no user-visible string in the warnings UI says "alert(s)"', () => {
  for (const f of FILES) {
    const bad = visibleStrings(readFileSync(f, 'utf8')).filter(s => /alert/i.test(s) && !TECHNICAL.has(s) && !/^[.@/\w-]+$/.test(s));
    assert.deepEqual(bad, [], `${f}: ${bad.join(' | ')}`);
  }
});

test('the warnings UI says what it is: unofficial, sourced, not a substitute for weather.gov / NWS / local officials', () => {
  const sheet = readFileSync('src/components/AlertSheet.tsx', 'utf8');
  const legend = readFileSync('src/components/LegendLayers.tsx', 'utf8');
  const list = readFileSync('src/components/AlertsListSheet.tsx', 'utf8');
  const chip = readFileSync('src/components/AlertsStatusChip.tsx', 'utf8');
  assert.match(sheet, /Unofficial: this app is not affiliated with or endorsed by NOAA or the NWS, and is not a substitute for weather\.gov, the NWS or local officials/);
  assert.match(sheet, /Source: National Weather Service \(api\.weather\.gov\)/);
  assert.match(legend, /label="NWS flood warnings and watches"/);
  assert.match(legend, /Unofficial copy of NWS flood warnings and watches\. Not a substitute for weather\.gov, the NWS or local officials/);
  assert.match(list, /NWS flood warnings and watches \(\{alerts\.length\}\)/);
  // an empty list is never worded as an all-clear
  assert.match(list, /not an all-clear/i);
  assert.match(legend, /Not an all-clear/);
  // failure is visible
  assert.match(chip, /Flood warnings unavailable/);
  // issued / expires / updated N min ago
  assert.match(sheet, /label="Issued"/);
  assert.match(sheet, /alert\.ends \? 'Ends' : 'Expires'/);
  assert.match(sheet, /updatedText\(ageMs\)/);
});

test('the Legend and sheets stay wired to the same wording (ALERT_SOURCE_NOTE is shared)', () => {
  assert.match(readFileSync('src/components/AlertsListSheet.tsx', 'utf8'), /ALERT_SOURCE_NOTE/);
});
