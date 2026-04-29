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
  // Inline package.json#version into the client bundle so the Legend can
  // show which release is loaded. Bumped via `pnpm release` before each
  // git push to main (Vercel auto-deploys on push).
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
