// Build-time switches shared by the web deploys and the Capacitor mobile apps.
//
// Everything here is a `process.env.NEXT_PUBLIC_*` read, which Next.js inlines
// as a string literal at build time — so the web bundle and the mobile bundle
// are the same source compiled with different constants (see next.config.mjs
// and scripts/build-mobile.mjs).

// Origin the API lives on.
//  - Web (Vercel / Cloudflare / Docker): '' — the API is same-origin, so every
//    call stays a relative `/api/...` URL, exactly as before.
//  - Mobile (Capacitor): the web bundle is served from inside the app binary
//    (capacitor://localhost on iOS, https://localhost on Android), so there is
//    no same-origin server. NEXT_PUBLIC_API_BASE points at the hosted
//    deployment — the Cloudflare Worker by default — and every `/api/...`
//    call becomes absolute. The API routes send CORS headers for this
//    (next.config.mjs → headers()).
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/+$/, '');

// True inside the iOS/Android builds. Used to drop web-only UI (the admin
// login in the legend) that has no business in a store app.
export const IS_MOBILE = process.env.NEXT_PUBLIC_MOBILE === '1';

/** Absolute (mobile) or relative (web) URL for an `/api/...` path. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

// Basemap tiles, two layers in this order of preference:
//
//  1. VECTOR_TILE_URL: our own Protomaps vector tiles (tiles-worker/, served from
//     tiles.kuecker.us) drawn by protomaps-leaflet. The default for EVERY build:
//     the website, `pnpm dev` and the store apps.
//  2. TILE_URL: a raster tile layer, OpenStreetMap's public servers by default.
//     It is the automatic fallback when (1) is unreachable or failing (see
//     src/components/Basemap.tsx), and the primary layer if VECTOR_TILE_URL is
//     set to an empty string.
//
// OSM's tile usage policy does not allow relying on its servers for a distributed
// app ("heavy use (e.g. distributing an app that uses tiles from
// openstreetmap.org)") and it blocks without notice and without an SLA. That is why
// the vector tiles are primary and OSM only catches an outage of ours. For a strict
// no-OSM build set NEXT_PUBLIC_TILE_FALLBACK=off; to use another raster provider
// as the fallback set NEXT_PUBLIC_TILE_URL and NEXT_PUBLIC_TILE_ATTRIBUTION. See
// docs/mobile-data-strategy.md for the options and costs.
export const TILE_URL =
  process.env.NEXT_PUBLIC_TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION =
  process.env.NEXT_PUBLIC_TILE_ATTRIBUTION
  || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * Our vector tile template. This hostname and path are compiled into every
 * shipped app: see "Contract" in tiles-worker/README.md before changing them.
 */
export const DEFAULT_VECTOR_TILE_URL = 'https://tiles.kuecker.us/texas/{z}/{x}/{y}.mvt';

// `??`, not `||`: an explicit empty NEXT_PUBLIC_VECTOR_TILE_URL= means "no vector
// tiles, raster only" (for example `NEXT_PUBLIC_VECTOR_TILE_URL= pnpm dev`).
export const VECTOR_TILE_URL = (process.env.NEXT_PUBLIC_VECTOR_TILE_URL ?? DEFAULT_VECTOR_TILE_URL).trim();

/** Switch to the raster layer automatically while the vector tile server is failing. */
export const TILE_FALLBACK = process.env.NEXT_PUBLIC_TILE_FALLBACK !== 'off';
