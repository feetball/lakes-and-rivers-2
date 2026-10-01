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

// Basemap tiles. The web deploy uses openstreetmap.org's public tile servers,
// which is fine for a low-traffic site but NOT for a distributed app: the OSM
// tile usage policy forbids "heavy use (e.g. distributing an app that uses
// tiles from openstreetmap.org)" without permission, and they block without
// notice. Point the store builds at a provider you control or pay for by
// setting NEXT_PUBLIC_VECTOR_TILE_URL (below) or NEXT_PUBLIC_TILE_URL /
// NEXT_PUBLIC_TILE_ATTRIBUTION at build time — see
// docs/mobile-data-strategy.md for the options and costs.
export const TILE_URL =
  process.env.NEXT_PUBLIC_TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION =
  process.env.NEXT_PUBLIC_TILE_ATTRIBUTION
  || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Self-hosted Protomaps vector basemap served by tiles-worker/ (a Z/X/Y
// template ending in .mvt, e.g. https://tiles.example.com/texas/{z}/{x}/{y}.mvt).
// When set it replaces the raster TILE_URL above and the map draws the tiles
// itself with protomaps-leaflet; its attribution is built in.
export const VECTOR_TILE_URL = process.env.NEXT_PUBLIC_VECTOR_TILE_URL || '';
