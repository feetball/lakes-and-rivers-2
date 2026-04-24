#!/usr/bin/env node
// Bundles the per-gauge NHD cache into a single tarball that's much friendlier
// to commit than 700+ loose JSON files. Run after `pnpm data:build` (or
// `data:build:refresh`) when you want to ship updated cache data.
//
// The tarball lives at data-cache/gauges.tar.gz; the loose data-cache/gauges/
// directory is gitignored. unpack-cache.mjs (also called automatically by
// build-waterways-data.mjs) extracts the tarball into the loose dir on demand.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REL_DIR = 'gauges';
const PARENT = resolve(ROOT, 'data-cache');
const DIR = resolve(PARENT, REL_DIR);
const TARBALL = resolve(PARENT, 'gauges.tar.gz');

if (!existsSync(DIR) || readdirSync(DIR).length === 0) {
  console.error(`[pack-cache] no cache to pack at ${DIR} — run pnpm data:build first`);
  process.exit(1);
}

const fileCount = readdirSync(DIR).length;
console.log(`[pack-cache] packing ${fileCount} gauge files…`);
// Sort entries so the resulting tarball is byte-stable (helps git diffs).
// Use --mtime for the same reason — without a fixed mtime the tarball
// changes every run.
execFileSync('tar', [
  '--sort=name',
  '--mtime=2020-01-01',
  '--owner=0', '--group=0', '--numeric-owner',
  '-czf', TARBALL,
  '-C', PARENT, REL_DIR,
], { stdio: 'inherit' });

const size = statSync(TARBALL).size;
console.log(`[pack-cache] wrote ${TARBALL} (${(size / 1024 / 1024).toFixed(2)} MB)`);
