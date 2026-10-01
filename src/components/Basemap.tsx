'use client';

import { useEffect } from 'react';
import * as L from 'leaflet';
import type { Layer } from 'leaflet';
import { TileLayer, useMap } from 'react-leaflet';
import { TILE_URL, TILE_ATTRIBUTION, VECTOR_TILE_URL } from '@/lib/api';

// The map's background. Self-hosted Protomaps vector tiles when
// NEXT_PUBLIC_VECTOR_TILE_URL is set (tiles-worker/), otherwise the raster
// TILE_URL (OpenStreetMap by default).

// Each map tile is a canvas of 256 * devicePixelRatio px square. At 3x (recent
// iPhones) that is ~9 MB per tile and a few dozen on screen, enough to trip the
// iOS web view's canvas memory limit, so cap it: 2x is still sharp.
const MAX_DEVICE_PIXEL_RATIO = 2;

// Highest zoom the tile archive actually stores; past it the renderer re-draws
// the last level's geometry (overzoom). The renderer assumes 15, and asking for
// data the archive lacks gives blank tiles, so read the real value from the
// archive's TileJSON (.../texas.json beside .../texas/{z}/{x}/{y}.mvt). That also
// keeps apps already installed correct if the archive is re-cut at another zoom.
// If the lookup fails, 14 is the safe assumption: a lower value only costs detail.
const FALLBACK_MAX_DATA_ZOOM = 14;

async function archiveMaxZoom(tileUrl: string, signal: AbortSignal): Promise<number> {
  const m = tileUrl.match(/^(.*)\/\{z\}\/\{x\}\/\{y\}\.mvt$/);
  if (!m) return FALLBACK_MAX_DATA_ZOOM;
  try {
    const res = await fetch(`${m[1]}.json`, { signal });
    const maxzoom = (await res.json())?.maxzoom;
    return Number.isInteger(maxzoom) && maxzoom > 0 && maxzoom <= 15 ? maxzoom : FALLBACK_MAX_DATA_ZOOM;
  } catch {
    return FALLBACK_MAX_DATA_ZOOM;
  }
}

function VectorBasemap({ url }: { url: string }) {
  const map = useMap();

  useEffect(() => {
    let layer: Layer | undefined;
    let cancelled = false;
    const abort = new AbortController();
    // protomaps-leaflet extends a bare global `L` (it only imports Leaflet's
    // types). Leaflet sets window.L itself when loaded; make sure of it here so
    // the renderer can't end up running before, or without, that side effect.
    const w = window as unknown as { L?: unknown };
    w.L ??= L;
    // The renderer is loaded on demand so it stays out of builds that use raster tiles.
    Promise.all([import('protomaps-leaflet'), archiveMaxZoom(url, abort.signal)]).then(
      ([{ leafletLayer }, maxDataZoom]) => {
        if (cancelled) return;
        const l = leafletLayer({
          url,
          flavor: 'light',
          lang: 'en',
          maxZoom: 18,
          maxDataZoom,
          devicePixelRatio: Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO),
        });
        // protomaps-leaflet's declared type omits Leaflet's Layer methods.
        layer = l as unknown as Layer;
        map.addLayer(layer);
      },
    );
    return () => {
      cancelled = true;
      abort.abort();
      if (layer) map.removeLayer(layer);
    };
  }, [map, url]);

  return null;
}

export default function Basemap() {
  if (VECTOR_TILE_URL) return <VectorBasemap url={VECTOR_TILE_URL} />;
  return <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} maxZoom={18} />;
}
