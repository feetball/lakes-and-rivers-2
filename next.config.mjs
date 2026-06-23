import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ['leaflet', 'react-leaflet'],
  },
  // The /api/waterways and /api/gauges/history routes read prebuilt files from
  // public/data at runtime via process.cwd(). Next's tracer can't see these
  // dynamic reads, so list them explicitly to guarantee they're bundled into
  // the serverless functions on Vercel (the standalone server already copies
  // all of public/ in postbuild, so this is the Vercel-path safety net).
  outputFileTracingIncludes: {
    '/api/waterways': ['./public/data/waterways.geojson*'],
    '/api/gauges/history': ['./public/data/gauges-meta.json'],
    '/api/gauges': ['./public/data/gauges-meta.json'],
  },
  // Inline package.json#version into the client bundle so the Legend can
  // show which release is loaded. Bumped via `pnpm release` before each
  // git push to main (Vercel auto-deploys on push).
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
