#!/usr/bin/env node
// Extracts data-cache/gauges.tar.gz into data-cache/gauges/ if the loose
// directory is missing or empty. No-op when the loose dir already has files
// (so it doesn't clobber freshly-fetched cache entries) or when there's no
// tarball to unpack.
//
// Called automatically by build-waterways-data.mjs at startup so a fresh
// clone (or Docker build) gets the cache without any extra steps.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function unpackCache(opts = {}) {
  const { quiet = false } = opts;
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const PARENT = resolve(ROOT, 'data-cache');
  const DIR = resolve(PARENT, 'gauges');
  const TARBALL = resolve(PARENT, 'gauges.tar.gz');
  const log = (...args) => quiet || console.log(...args);

  const dirHasFiles = existsSync(DIR) && readdirSync(DIR).length > 0;
  if (dirHasFiles) {
    log(`[unpack-cache] data-cache/gauges/ already populated — skipping`);
    return { extracted: false };
  }
  if (!existsSync(TARBALL)) {
    log(`[unpack-cache] no tarball at data-cache/gauges.tar.gz — nothing to unpack`);
    return { extracted: false };
  }
  mkdirSync(DIR, { recursive: true });
  log(`[unpack-cache] extracting data-cache/gauges.tar.gz…`);
  execFileSync('tar', ['-xzf', TARBALL, '-C', PARENT], { stdio: quiet ? 'ignore' : 'inherit' });
  const count = readdirSync(DIR).length;
  log(`[unpack-cache] extracted ${count} gauge files into data-cache/gauges/`);
  return { extracted: true, count };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) unpackCache();
