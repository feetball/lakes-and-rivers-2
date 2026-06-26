#!/usr/bin/env node
// Applies the hand-verified gauge-id corrections in
// public/data/gauge-overrides.json to waterway features. Used in two places:
//
//   - build-waterways-data.mjs imports applyGaugeOverrides() and runs it over
//     the merged feature list before writing, so a fresh `pnpm data:build`
//     bakes the corrections in.
//   - Run directly (`node scripts/apply-gauge-overrides.mjs`) to patch the
//     ALREADY-BUILT public/data/waterways.geojson (and its .br/.gz variants)
//     in place, without re-running the slow NHD fetch.
//
// Keying is by the feature's `name` property (the lake/reservoir name), which
// is stable across rebuilds. Only Polygon/MultiPolygon (waterbody) features are
// retagged — the override map is about which lake a gauge measures.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/data');
const WATERWAYS = resolve(OUT_DIR, 'waterways.geojson');
const OVERRIDES = resolve(OUT_DIR, 'gauge-overrides.json');

/** Load the byName override map. Returns {} if the file is absent/malformed. */
export async function loadOverrides() {
  try {
    const parsed = JSON.parse(await readFile(OVERRIDES, 'utf8'));
    return parsed?.byName && typeof parsed.byName === 'object' ? parsed.byName : {};
  } catch {
    return {};
  }
}

/**
 * Retag features in place from a name->lid map. Mutates each matched feature's
 * properties.gaugeId. Returns the list of {name, from, to} changes applied.
 */
export function applyGaugeOverrides(features, byName) {
  const changes = [];
  for (const f of features) {
    const t = f?.geometry?.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
    const name = f?.properties?.name;
    if (!name || !(name in byName)) continue;
    const to = byName[name];
    const from = f.properties.gaugeId;
    if (from === to) continue;
    f.properties.gaugeId = to;
    changes.push({ name, from, to });
  }
  return changes;
}

// --- standalone in-place patch of the built artifacts ---
async function main() {
  const byName = await loadOverrides();
  const names = Object.keys(byName);
  if (names.length === 0) {
    console.log('[overrides] no overrides defined — nothing to do');
    return;
  }
  const geojson = JSON.parse(await readFile(WATERWAYS, 'utf8'));
  const changes = applyGaugeOverrides(geojson.features, byName);
  if (changes.length === 0) {
    console.log('[overrides] all features already match the override map — no change');
    return;
  }
  for (const c of changes) {
    console.log(`[overrides] ${c.name}: ${c.from} -> ${c.to}`);
  }
  const str = JSON.stringify(geojson);
  await writeFile(WATERWAYS, str);
  // Keep the precompressed variants /api/waterways serves in sync, else cached
  // clients would still get the stale gaugeId from the .br/.gz payload.
  const buf = Buffer.from(str, 'utf8');
  const br = brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  const gz = gzipSync(buf, { level: 9 });
  await writeFile(WATERWAYS + '.br', br);
  await writeFile(WATERWAYS + '.gz', gz);
  console.log(`[overrides] patched ${changes.length} feature(s) + recompressed .br/.gz`);
}

// Run main() only when invoked directly, not when imported by the build script.
if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
