'use client';

import { useCallback, useEffect, useState } from 'react';
import * as L from 'leaflet';
import type { Layer } from 'leaflet';
import { TileLayer, useMap } from 'react-leaflet';
import { TILE_URL, TILE_ATTRIBUTION, VECTOR_TILE_URL, TILE_FALLBACK } from '@/lib/api';
import {
  createHealthMonitor,
  createRetryBudget,
  createTileArchive,
  fetchArchiveInfo,
  probeRasterReachable,
  probeTileServer,
  recoveryDelayMs,
  type HealthMonitor,
  type LatLngBounds,
} from '@/lib/vectorTiles';

// The map's background layer: our own Protomaps vector tiles (tiles-worker/,
// tiles.kuecker.us) drawn by protomaps-leaflet, with the raster layer (OpenStreetMap
// by default) taking over automatically while our tile server is failing.
//
//   vector     -> raster      the TileJSON cannot be read, or the renderer fails to load, at once;
//                             or 4 tile requests fail in a row AND a fresh probe of the tile
//                             server also fails AND the raster layer is reachable
//   raster     -> recovering  a probe of the tile server succeeds (after 1, 2, 4, 8, 15 min)
//   recovering -> vector      the vector layer, mounted ON TOP of the raster one, has drawn its
//                             tiles; only then is the raster layer removed (no blank flash)
//   recovering -> raster      it fails to start, trips, or has not finished within 25 s
//
// Failures are counted from real requests (src/lib/vectorTiles.ts). Requests the map
// cancels itself on every zoom change are not failures, neither is being offline, and a
// 200 that is not a vector tile (compressed twice, an HTML portal page) is.

// Each map tile is a canvas of 256 * devicePixelRatio px square. At 3x (recent
// iPhones) that is ~9 MB per tile and a few dozen on screen, enough to trip the
// iOS web view's canvas memory limit, so cap it: 2x is still sharp.
const MAX_DEVICE_PIXEL_RATIO = 2;

// Highest zoom assumed to be stored in the archive when its TileJSON cannot say
// (renderer default is 15; asking for data the archive lacks gives blank tiles).
// Past the archive's max zoom the renderer re-draws the last level (overzoom).
const FALLBACK_MAX_DATA_ZOOM = 14;

// protomaps-leaflet paints this under every tile. The light flavor's default is a
// flat grey, which shows as a hard-edged band wherever there is no tile (outside
// the archive's box at low zoom, or a tile that failed): use its land colour.
const EARTH_COLOR = '#e2dfda';

// When 4 tile requests fail in a row, wait this long before looking at the server
// again: a single connection blip (Wi-Fi to cell hand-off, an iOS resume) fails a whole
// screenful at once and is over by then.
const CONFIRM_DELAY_MS = 1_500;

// A recovery attempt (the vector layer mounted above the raster one) that has not
// finished by now has failed.
const RECOVERY_TIMEOUT_MS = 25_000;

// Area for the random tile the server probes ask for. Anywhere inside the archive works
// (a tile outside it is a 204, which also counts as healthy); this is just inside
// TX_BOUNDS in MapView.tsx and the archive's bbox (tiles-worker/scripts/extract.sh).
const PROBE_BOUNDS: LatLngBounds = [[26, -106], [36, -94]];

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Resolves after ms, or as soon as the signal aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function RasterBasemap() {
  return <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} maxZoom={18} />;
}

// onUnavailable / onReady must be stable (the parent passes useCallback ones): the
// layer is only rebuilt when the map or the tile URL changes. No onUnavailable means
// the fallback is switched off (NEXT_PUBLIC_TILE_FALLBACK=off): keep drawing whatever
// vector tiles we can get.
function VectorBasemap({
  url,
  onUnavailable,
  onReady,
}: {
  url: string;
  onUnavailable?: () => void;
  onReady: () => void;
}) {
  const map = useMap();

  useEffect(() => {
    let cancelled = false;
    let layer: Layer | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let removeListeners: (() => void) | undefined;
    // Aborted when this layer goes away: cancels the TileJSON lookup, the probes and
    // every tile request still in flight.
    const abort = new AbortController();
    const retry = createRetryBudget();
    let okTiles = 0;
    let loaded = false;
    let readyFired = false;
    let rerender = () => {};

    const giveUp = (why: string) => {
      if (cancelled) return;
      if (!onUnavailable) {
        console.warn(`Basemap: ${why}; the tile fallback is off, so the vector tiles stay`);
        return;
      }
      console.warn(`Basemap: ${why}; switching to the fallback tiles`);
      onUnavailable();
    };

    // Four failed tile requests in a row is a hint, not proof: one connection blip fails
    // a whole screenful at once, and if the internet is down the fallback layer cannot
    // load either (swapping would replace a map that is still drawn with a blank one).
    // So look first: the tile server must still fail a fresh probe, and the fallback
    // must be reachable.
    const confirmThenGiveUp = async (monitor: HealthMonitor) => {
      if (!onUnavailable) {
        // Fallback off (NEXT_PUBLIC_TILE_FALLBACK=off): nothing to switch to, and the
        // reachability probe below would contact the raster provider, which is exactly
        // what that setting promises never to do. Just say so, once.
        giveUp('tile requests keep failing');
        return;
      }
      await wait(CONFIRM_DELAY_MS, abort.signal);
      if (cancelled) return;
      if (await probeTileServer(url, { bounds: PROBE_BOUNDS, signal: abort.signal })) {
        if (!cancelled) monitor.reset();
        return;
      }
      if (cancelled) return;
      if (!(await probeRasterReachable(TILE_URL, { signal: abort.signal }))) {
        if (cancelled) return;
        console.warn('Basemap: the tile server and the fallback are both unreachable; keeping the vector tiles');
        monitor.reset();
        return;
      }
      giveUp('tile requests keep failing');
    };

    const maybeReady = () => {
      if (readyFired || cancelled || !loaded || okTiles === 0) return;
      readyFired = true;
      onReady();
    };

    // protomaps-leaflet extends a bare global `L` (it only imports Leaflet's
    // types). Leaflet sets window.L itself when loaded; make sure of it here so
    // the renderer can't end up running before, or without, that side effect.
    const w = window as unknown as { L?: unknown };
    w.L ??= L;

    // The renderer is loaded on demand so it stays out of builds that use raster tiles.
    Promise.all([
      import('protomaps-leaflet'),
      fetchArchiveInfo(url, { fallbackMaxZoom: FALLBACK_MAX_DATA_ZOOM, signal: abort.signal, isOffline }),
    ])
      .then(([{ leafletLayer }, info]) => {
        if (cancelled) return;
        if (info.status !== 'ok' && onUnavailable) return giveUp(info.reason);

        const monitor: HealthMonitor = createHealthMonitor({
          // Offline failures say nothing about our server (and OSM would fail too).
          ignoreFailures: isOffline,
          onUnhealthy: () => void confirmThenGiveUp(monitor),
        });
        const archive = createTileArchive({
          template: url,
          signal: abort.signal,
          onResult: (ok) => {
            if (cancelled) return;
            monitor.record(ok);
            if (ok) {
              okTiles += 1;
              retry.reset();
              maybeReady();
            } else if (!retryTimer && !isOffline()) {
              // The renderer never retries a failed tile by itself: draw them again after a
              // delay, a few times (8, 16, 32 s), so one bad tile cannot loop forever.
              const delay = retry.next();
              if (delay !== null) {
                retryTimer = setTimeout(() => {
                  retryTimer = undefined;
                  if (!cancelled) rerender();
                }, delay);
              }
            }
          },
        });

        const l = leafletLayer({
          // protomaps-leaflet's PmtilesSource only ever calls archive.getZxy(), so
          // our own tile source stands in for a PMTiles object. Its string-URL path
          // never checks the HTTP status, times out or reports failures.
          url: archive as never,
          flavor: 'light',
          lang: 'en',
          maxZoom: 18,
          maxDataZoom: info.status === 'ok' ? info.maxZoom : FALLBACK_MAX_DATA_ZOOM,
          devicePixelRatio: Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO),
        });
        l.backgroundColor = EARTH_COLOR;
        rerender = () => l.rerenderTiles();
        // 'load' = every visible tile has been drawn. protomaps-leaflet's tiles call done()
        // even when their data failed, hence the okTiles check in maybeReady.
        l.on('load', () => {
          loaded = true;
          maybeReady();
        });
        // protomaps-leaflet's declared type omits Leaflet's Layer methods.
        layer = l as unknown as Layer;
        map.addLayer(layer);

        // Back online after a spell offline: draw the tiles that failed meanwhile again.
        window.addEventListener('online', rerender);
        removeListeners = () => window.removeEventListener('online', rerender);
      })
      .catch((e: unknown) =>
        // Typically the renderer's lazy chunk failing to load (flaky connection).
        giveUp(`the vector basemap failed to start (${e instanceof Error ? e.message : String(e)})`),
      );

    return () => {
      cancelled = true;
      abort.abort();
      clearTimeout(retryTimer);
      removeListeners?.();
      if (layer) map.removeLayer(layer);
    };
  }, [map, url, onUnavailable, onReady]);

  return null;
}

// Renders nothing; while the fallback is showing, watches for the tile server to come back.
function RecoveryProbe({ url, delayMs, onHealthy }: { url: string; delayMs: number; onHealthy: () => void }) {
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();

    const schedule = (ms: number) => {
      timer = setTimeout(tick, ms);
    };
    async function tick() {
      timer = undefined;
      if (stopped) return;
      // No point probing from a background tab; the visibilitychange handler checks on return.
      if (document.visibilityState === 'hidden') return schedule(delayMs);
      inFlight = true;
      const ok = await probeTileServer(url, { bounds: PROBE_BOUNDS, signal: abort.signal });
      inFlight = false;
      if (stopped) return;
      if (ok) return onHealthy();
      schedule(delayMs);
    }

    // Connectivity just came back, or the user returned to the tab: check now rather
    // than waiting out the delay.
    const checkSoon = () => {
      if (inFlight || stopped || document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      schedule(0);
    };
    window.addEventListener('online', checkSoon);
    document.addEventListener('visibilitychange', checkSoon);
    schedule(delayMs);

    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      window.removeEventListener('online', checkSoon);
      document.removeEventListener('visibilitychange', checkSoon);
    };
  }, [url, delayMs, onHealthy]);

  return null;
}

// A recovery attempt that has not finished by RECOVERY_TIMEOUT_MS has failed.
function RecoveryTimeout({ onTimeout }: { onTimeout: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onTimeout, RECOVERY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [onTimeout]);
  return null;
}

type Mode = 'vector' | 'raster' | 'recovering';

export default function Basemap() {
  // `failed` counts recovery attempts that failed since the last success: it lengthens
  // the wait before the next one, so a marginal link cannot flap between the layers.
  const [state, setState] = useState<{ mode: Mode; failed: number }>({ mode: 'vector', failed: 0 });
  const { mode, failed } = state;

  // Stable callbacks that decide from the current state, so the vector layer is not
  // rebuilt when the mode changes (it stays mounted from 'recovering' to 'vector').
  const giveUp = useCallback(
    () => setState((s) => ({ mode: 'raster', failed: s.mode === 'recovering' ? s.failed + 1 : s.failed })),
    [],
  );
  const ready = useCallback(() => setState((s) => (s.mode === 'recovering' ? { mode: 'vector', failed: 0 } : s)), []);
  const startRecovery = useCallback(() => setState((s) => (s.mode === 'raster' ? { ...s, mode: 'recovering' } : s)), []);

  if (!VECTOR_TILE_URL) return <RasterBasemap />;

  // Fixed child positions: the vector layer keeps its place (and its instance) across
  // 'recovering' -> 'vector'. Layers added later draw on top, so in 'recovering' the
  // vector layer covers the raster one tile by tile as it paints.
  return (
    <>
      {mode !== 'vector' && <RasterBasemap />}
      {mode !== 'raster' && (
        <VectorBasemap url={VECTOR_TILE_URL} onUnavailable={TILE_FALLBACK ? giveUp : undefined} onReady={ready} />
      )}
      {mode === 'raster' && <RecoveryProbe url={VECTOR_TILE_URL} delayMs={recoveryDelayMs(failed)} onHealthy={startRecovery} />}
      {mode === 'recovering' && <RecoveryTimeout onTimeout={giveUp} />}
    </>
  );
}
