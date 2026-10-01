// Copy public/ and .next/static into the standalone output so
// `node .next/standalone/server.js` can serve them (Next's standalone build
// deliberately excludes both). A Node script instead of `cp -r` so it works
// on Windows (cmd/PowerShell have no `cp`), macOS, and Linux alike.
import { cpSync, existsSync } from 'node:fs';

if (!existsSync('.next/standalone')) {
  // e.g. a build with `output: 'standalone'` disabled — nothing to do.
  console.log('[postbuild] .next/standalone not found, skipping asset copy');
  process.exit(0);
}

cpSync('public', '.next/standalone/public', { recursive: true });
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
console.log('[postbuild] copied public/ and .next/static into .next/standalone/');
