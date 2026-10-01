#!/usr/bin/env node
// Builds the static web bundle that the Capacitor iOS/Android shells wrap,
// then copies it into the native projects.
//
//   pnpm mobile:build              # export + `cap sync` (ios + android)
//   pnpm mobile:export             # export only (--no-sync)
//   MOBILE_API_BASE=https://api.example.com pnpm mobile:build
//   NEXT_PUBLIC_VECTOR_TILE_URL=https://tiles.example.com/texas/{z}/{x}/{y}.mvt pnpm mobile:build
//   (or a raster provider: NEXT_PUBLIC_TILE_URL=... NEXT_PUBLIC_TILE_ATTRIBUTION=...)
//
// Why a script instead of plain `next build`: Next's `output: 'export'` refuses
// to build a project with dynamic API route handlers (every route under
// src/app/api is force-dynamic), and the mobile app doesn't ship a server —
// it talks to the hosted API (NEXT_PUBLIC_API_BASE, see src/lib/api.ts). So:
//
//   1. make sure public/data/* exists (same prebuild the web build runs);
//   2. hide src/app/api by renaming it to a private folder — a leading
//      underscore makes the App Router skip the directory entirely;
//   3. run `next build` with MOBILE_BUILD=1 (next.config.mjs switches to
//      output: 'export' and inlines the mobile constants);
//   4. restore src/app/api — always, including on build failure or Ctrl-C;
//   5. sanity-check out/ (index.html + the bundled waterways data);
//   6. `cap sync`, which copies out/ into ios/ and android/ and installs the
//      native plugin dependencies.

import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = resolve(ROOT, 'src/app/api');
// Underscore prefix = private folder, ignored by the App Router. The suffix
// makes it obvious what it is if a crashed build ever leaves it behind.
const HIDDEN_DIR = resolve(ROOT, 'src/app/_api.mobile-hidden');
const OUT_DIR = resolve(ROOT, 'out');

const args = new Set(process.argv.slice(2));
const SYNC = !args.has('--no-sync');

function log(msg) {
  console.log(`[mobile] ${msg}`);
}

function run(cmd, cmdArgs, extraEnv = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    // pnpm/npx are .cmd shims on Windows; a shell is needed to resolve them.
    shell: process.platform === 'win32',
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} exited with ${r.status ?? `signal ${r.signal}`}`);
  }
}

function hideApi() {
  if (existsSync(HIDDEN_DIR)) {
    if (existsSync(API_DIR)) {
      throw new Error(
        `both ${API_DIR} and ${HIDDEN_DIR} exist — a previous run was interrupted mid-restore. ` +
          `Inspect them, keep the real one as src/app/api, delete the other, and rerun.`,
      );
    }
    // A previous run crashed before restoring; the hidden dir IS the api dir.
    log('found a leftover hidden API dir from an interrupted run — reusing it');
    return;
  }
  if (!existsSync(API_DIR)) throw new Error(`${API_DIR} not found`);
  renameSync(API_DIR, HIDDEN_DIR);
  log('hid src/app/api for the static export');
}

function restoreApi() {
  if (!existsSync(HIDDEN_DIR)) return;
  if (existsSync(API_DIR)) {
    console.error(`[mobile] WARNING: ${API_DIR} reappeared during the build; leaving ${HIDDEN_DIR} in place for you to reconcile`);
    return;
  }
  renameSync(HIDDEN_DIR, API_DIR);
  log('restored src/app/api');
}

function mb(path) {
  return `${(statSync(path).size / 1_048_576).toFixed(1)} MB`;
}

function verifyOutput() {
  const required = ['index.html', 'data/waterways.geojson', 'data/gauges-meta.json'];
  for (const rel of required) {
    const p = resolve(OUT_DIR, rel);
    if (!existsSync(p)) throw new Error(`export is missing out/${rel}`);
  }
  // public/data also holds the brotli/gzip variants the web servers negotiate
  // (see /api/waterways). The app's local web view can't use them — it reads
  // the raw file with no Content-Encoding — so they'd be ~7.6 MB of dead
  // weight in every install. (The stores compress the binary on delivery, so
  // the raw 17 MB JSON costs far less over the wire than it looks here.)
  for (const rel of ['data/waterways.geojson.br', 'data/waterways.geojson.gz']) {
    const p = resolve(OUT_DIR, rel);
    if (existsSync(p)) rmSync(p);
  }
  log(`out/ ready — waterways.geojson ${mb(resolve(OUT_DIR, 'data/waterways.geojson'))}, gauges-meta.json ${mb(resolve(OUT_DIR, 'data/gauges-meta.json'))}`);
}

// Ctrl-C while `next build` runs: the child gets the same SIGINT and dies,
// spawnSync returns non-zero, and the finally block below restores the API
// dir. Without this handler Node's default SIGINT behaviour would exit the
// process immediately, skipping the restore.
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
process.on('SIGTERM', () => { interrupted = true; });

let exitCode = 0;
try {
  log('ensuring public/data is built (skips if present)');
  run('node', ['scripts/build-waterways-data.mjs', '--if-missing']);

  hideApi();
  try {
    log(`next build (static export) → API base: ${process.env.MOBILE_API_BASE || '(default, see next.config.mjs)'}`);
    run('pnpm', ['exec', 'next', 'build'], { MOBILE_BUILD: '1' });
  } finally {
    restoreApi();
  }

  verifyOutput();

  if (SYNC) {
    const hasIos = existsSync(resolve(ROOT, 'ios'));
    const hasAndroid = existsSync(resolve(ROOT, 'android'));
    if (!hasIos && !hasAndroid) {
      log('no ios/ or android/ project yet — run `pnpm exec cap add ios` / `pnpm exec cap add android`, then `pnpm mobile:sync`');
    } else {
      log('cap sync');
      run('pnpm', ['exec', 'cap', 'sync']);
    }
  }
  log('done');
} catch (err) {
  if (!interrupted) console.error(`[mobile] FAILED: ${err?.message ?? err}`);
  exitCode = interrupted ? 130 : 1;
}
process.exit(exitCode);
