import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
);

// MOBILE_BUILD=1 produces the static bundle the Capacitor iOS/Android shells
// wrap (set by scripts/build-mobile.mjs — don't set it by hand: the export
// only builds once src/app/api is hidden, which that script handles). The
// mobile bundle has no server of its own; it calls the hosted API at
// MOBILE_API_BASE, inlined below as NEXT_PUBLIC_API_BASE. See
// docs/mobile-app.md.
const MOBILE = process.env.MOBILE_BUILD === '1';
// Default API origin baked into the app. Override with MOBILE_API_BASE. Prefer
// a domain you own here — the value ships inside every installed copy, so
// moving the backend later means a store update unless the hostname is yours.
const DEFAULT_MOBILE_API_BASE = 'https://texas-flood-map.daniel-8d6.workers.dev';

// Opt-in: let `next dev` access Cloudflare bindings (ASSETS/R2/D1) through a
// local miniflare, for testing the Workers-specific code paths in dev:
//   CLOUDFLARE_DEV=1 pnpm dev
// Off by default because normal dev doesn't need it (src/lib/data-assets.ts
// reads from the local filesystem in Node) and it would make every dev/build
// config load spin up wrangler's workerd runtime.
if (process.env.CLOUDFLARE_DEV === '1') {
  const { initOpenNextCloudflareForDev } = await import('@opennextjs/cloudflare');
  await initOpenNextCloudflareForDev();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: MOBILE ? 'export' : 'standalone',
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ['leaflet', 'react-leaflet'],
  },
  // Server-only config. Static export has no server, and Next warns about
  // headers/tracing options it can't honour there, so leave them out.
  ...(MOBILE
    ? {}
    : {
        // The /api/waterways and /api/gauges/history routes read prebuilt files from
        // public/data at runtime via process.cwd(). Next's tracer can't see these
        // dynamic reads, so list them explicitly to guarantee they're bundled into
        // the serverless functions on Vercel (the standalone server already copies
        // all of public/ in postbuild, so this is the Vercel-path safety net).
        outputFileTracingIncludes: {
          '/api/waterways': ['./public/data/waterways.geojson.br', './public/data/waterways.geojson.gz'],
          '/api/gauges/history': ['./public/data/gauges-meta.json'],
          '/api/gauges/forecast': ['./public/data/gauges-meta.json'],
          '/api/gauges/[id]/records': ['./public/data/gauges-meta.json'],
          '/api/gauges/[id]/detail': ['./public/data/gauges-meta.json'],
          '/api/gauges': ['./public/data/gauges-meta.json'],
          // The cron route warms the SHARED Next Data Cache via getCachedGauges() ->
          // loadMeta(), which reads gauges-meta.json. Without tracing it here, the
          // cron function ENOENTs the file on Vercel and writes a thresholdless
          // result into the shared cache, re-graying every threshold-derived gauge.
          '/api/cron/refresh-gauges': ['./public/data/gauges-meta.json'],
        },
        // CORS for the mobile apps. Their web view runs at capacitor://localhost
        // (iOS) / https://localhost (Android), so every API call is cross-origin
        // and the browser refuses the response unless the server allows it. `*`
        // is fine here: these are public read-only data routes (plus the open
        // analytics beacon); the admin routes rely on a cookie, which `*`
        // deliberately can't carry cross-origin — and the same-origin web admin
        // is unaffected because CORS never applies to same-origin requests.
        // Also covers the preflight (OPTIONS) Next auto-answers for POST JSON.
        async headers() {
          return [
            {
              source: '/api/:path*',
              headers: [
                { key: 'Access-Control-Allow-Origin', value: '*' },
                { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
                { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
                { key: 'Access-Control-Max-Age', value: '86400' },
              ],
            },
          ];
        },
      }),
  // Inline package.json#version into the client bundle so the Legend can
  // show which release is loaded. Bumped via `pnpm release` before each
  // git push to main (Vercel auto-deploys on push).
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    ...(MOBILE
      ? {
          NEXT_PUBLIC_MOBILE: '1',
          NEXT_PUBLIC_API_BASE: (process.env.MOBILE_API_BASE || DEFAULT_MOBILE_API_BASE).replace(/\/+$/, ''),
        }
      : {}),
  },
};

export default nextConfig;
