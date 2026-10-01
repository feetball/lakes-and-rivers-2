'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, GeoJSON, CircleMarker, Tooltip, useMapEvents } from 'react-leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { GeoJSON as LeafletGeoJSON, Map as LeafletMap, PathOptions, Layer, LeafletMouseEvent } from 'leaflet';
import { useGaugeData } from '@/hooks/useGaugeData';
import { colorFor, CATEGORY_LABELS, STALE_DATA_MS, dataAgeMs, formatAge } from '@/lib/floodStatus';
import { apiUrl, IS_MOBILE } from '@/lib/api';
import Basemap from '@/components/Basemap';
import type { FloodCategory, GaugeStatus, WaterwayProperties } from '@/lib/types';
import Legend from './Legend';
import LocateButton from './LocateButton';
import GaugeSheet from './GaugeSheet';
import HoverHydrograph from './HoverHydrograph';
import TimelineSlider from './TimelineSlider';
import LoadingBanner from './LoadingBanner';
import DraggablePanel from './DraggablePanel';
import { track } from '@/lib/track';

// Below this zoom, hide stream/river lines and only paint waterbodies.
// Painting thousands of canvas polylines while panning the whole state is
// the dominant cost — punting them past the state-wide view keeps the map
// responsive without losing context (lakes still draw to anchor the geography).
const STREAM_MIN_ZOOM = 8;

// Center on Austin/central Texas. The default zoom matches STREAM_MIN_ZOOM
// so first-time visitors land with rivers already painted (the Colorado
// runs through the frame at this center+zoom).
const TX_CENTER: [number, number] = [30.27, -97.74];
const DEFAULT_ZOOM = STREAM_MIN_ZOOM;
const TX_BOUNDS: [[number, number], [number, number]] = [
  [25.8, -106.7],
  [36.6, -93.5],
];
const VIEW_KEY = 'tfm:view';
const LEGEND_VISIBLE_KEY = 'tfm:legend-visible';
const TIMELINE_VISIBLE_KEY = 'tfm:timeline-visible';

// Gauge dots. The store apps draw them larger and accept taps far from the dot
// itself: a fingertip can't reliably land inside an 11 px circle. The website
// keeps the compact dot (a mouse pointer is precise).
const GAUGE_RADIUS = IS_MOBILE ? 7 : 5;
const GAUGE_OUTLINE = IS_MOBILE ? 1.5 : 1;
// A tap within this many CSS px of a gauge's center opens it — a 48 px target,
// the Material minimum (Apple's is 44 pt). Gauges can sit closer together than
// that, so the NEAREST one wins rather than whichever dot happens to be on top.
const GAUGE_TAP_RADIUS = 24;

type SavedView = { lat: number; lon: number; zoom: number };
function loadView(): SavedView | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.lat === 'number' && typeof v?.lon === 'number' && typeof v?.zoom === 'number') {
      return v;
    }
  } catch {}
  return null;
}

// Defaults to visible when the key is missing or unparsable.
function loadVisible(key: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return true;
    return JSON.parse(raw) === true;
  } catch {
    return true;
  }
}

function saveVisible(key: string, visible: boolean) {
  try { window.localStorage.setItem(key, JSON.stringify(visible)); } catch {}
}

function ViewPersister() {
  const map = useMapEvents({
    moveend: () => {
      const c = map.getCenter();
      const view: SavedView = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
      try { window.localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {}
    },
  });
  return null;
}

function ZoomTracker({ onChange }: { onChange: (z: number) => void }) {
  const map = useMapEvents({
    zoomend: () => onChange(map.getZoom()),
  });
  return null;
}

// Mobile apps only: a tap that missed every layer (open ground near a dot)
// still opens the nearest gauge within reach. Taps that hit a layer are
// resolved by that layer's own click handler first — see `resolveTap`.
function TapTargets({ onTap }: { onTap: (e: MouseEvent) => void }) {
  useMapEvents({ click: (e) => onTap(e.originalEvent) });
  return null;
}

// The gauge whose center is closest to `point` (container px), if any lies
// within `radius`. Gauges with unusable coordinates produce NaN distances and
// are skipped by the comparison.
function nearestGauge(
  map: LeafletMap,
  point: { x: number; y: number },
  gauges: GaugeStatus[],
  radius: number,
): GaugeStatus | null {
  let best: GaugeStatus | null = null;
  let bestSq = radius * radius;
  for (const g of gauges) {
    const c = map.latLngToContainerPoint([g.lat, g.lon]);
    const sq = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
    if (sq <= bestSq) {
      best = g;
      bestSq = sq;
    }
  }
  return best;
}

type Waterways = FeatureCollection<Geometry, WaterwayProperties>;

export default function MapView() {
  const [waterways, setWaterways] = useState<Waterways | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GaugeStatus | null>(null);
  // Open a gauge sheet and record the open for analytics. Both click paths
  // (marker + waterway) go through here so tracking can't be forgotten on one.
  const selectGauge = (g: GaugeStatus) => {
    // Belt-and-suspenders: dismiss any pending/active hover preview so it
    // can never linger on top of the sheet we're about to open.
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverChart(null);
    setSelected(g);
    track({ type: 'gauge_open', gaugeId: g.id });
  };
  const [hoverChart, setHoverChart] = useState<{ gauge: GaugeStatus; x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  // Mobile-app tap resolution. Every tappable thing on the map (a gauge dot, a
  // river, a lake, open ground near a dot) reports through here, so one tap
  // opens exactly one gauge: the nearest gauge center within GAUGE_TAP_RADIUS,
  // else the gauge of the waterway that was tapped. Leaflet runs the layer's
  // click handler before the map's and hands both the same native event, so
  // the first to resolve a tap claims it and the other becomes a no-op.
  const handledTapsRef = useRef(new WeakSet<object>());
  const gaugeListRef = useRef<GaugeStatus[]>([]);
  const resolveTap = (ev: MouseEvent | undefined, fallback?: GaugeStatus) => {
    if (ev) {
      if (handledTapsRef.current.has(ev)) return;
      handledTapsRef.current.add(ev);
    }
    const map = mapRef.current;
    const near = ev && map
      ? nearestGauge(map, map.mouseEventToContainerPoint(ev), gaugeListRef.current, GAUGE_TAP_RADIUS)
      : null;
    const target = near ?? fallback;
    if (target) selectGauge(target);
  };
  // Android back button (hardware or gesture): close the open gauge sheet
  // first; with nothing open, hand the app to the launcher — the same thing
  // Android 12+ does for a root activity. Registering ANY listener replaces
  // Capacitor's default (which would navigate web-view history), so both
  // branches are ours to handle. Never fires on iOS or the web.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (!IS_MOBILE) return;
    let cancelled = false;
    let handle: { remove(): Promise<void> } | null = null;
    (async () => {
      const { App } = await import('@capacitor/app');
      if (cancelled) return;
      handle = await App.addListener('backButton', () => {
        if (selectedRef.current) {
          setSelected(null);
          return;
        }
        void App.minimizeApp();
      });
    })();
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, []);
  // null = live; ISO = historical snapshot.
  const [atIso, setAtIso] = useState<string | null>(null);
  const {
    data: gaugeData,
    error: gaugesError,
    isLoading: gaugesLoading,
    isValidating: gaugesValidating,
    mutate: refreshGauges,
  } = useGaugeData(atIso);
  const mapRef = useRef<LeafletMap | null>(null);
  // Where the user is, once they've tapped the locate button.
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const onLocated = (lat: number, lon: number) => {
    setUserPos([lat, lon]);
    const map = mapRef.current;
    if (!map) return;
    // Fly in close enough that rivers are painted, but never zoom OUT on
    // someone who's already looking closer. maxBounds keeps an out-of-state
    // fix from dragging the view off the Texas extent.
    map.flyTo([lat, lon], Math.max(map.getZoom(), STREAM_MIN_ZOOM + 2), { duration: 0.8 });
  };
  // Read once on mount so we don't re-center after the user pans.
  const [initialView] = useState<SavedView>(() => {
    const saved = loadView();
    return saved ?? { lat: TX_CENTER[0], lon: TX_CENTER[1], zoom: DEFAULT_ZOOM };
  });
  const [zoom, setZoom] = useState<number>(initialView.zoom);
  const geoJsonRef = useRef<LeafletGeoJSON | null>(null);
  const [legendVisible, setLegendVisible] = useState<boolean>(() => loadVisible(LEGEND_VISIBLE_KEY));
  const [timelineVisible, setTimelineVisible] = useState<boolean>(() => loadVisible(TIMELINE_VISIBLE_KEY));
  const hideLegend = () => { setLegendVisible(false); saveVisible(LEGEND_VISIBLE_KEY, false); };
  const showLegend = () => { setLegendVisible(true); saveVisible(LEGEND_VISIBLE_KEY, true); };
  // Hiding the timeline also snaps back to live — otherwise the map could be
  // left stuck on a historical snapshot with no visible control to leave it.
  const hideTimeline = () => { setTimelineVisible(false); saveVisible(TIMELINE_VISIBLE_KEY, false); setAtIso(null); };
  const showTimeline = () => { setTimelineVisible(true); saveVisible(TIMELINE_VISIBLE_KEY, true); };

  useEffect(() => {
    let aborted = false;
    // Load order is platform-aware:
    //  - Static /data/waterways.geojson is served straight from Vercel's edge
    //    CDN (compressed, globally cached, zero serverless cost) — the optimal
    //    path on Vercel and what we want for first paint.
    //  - /api/waterways is the fallback: on self-hosted standalone (whose
    //    server only gzips static files) it serves precompressed brotli
    //    (~1.8 MB vs ~3 MB gzip); it also covers any case where the static
    //    asset is unavailable. Whichever responds with valid JSON wins.
    //  - In the mobile apps the static file ships inside the app bundle, so
    //    the first request never touches the network; the fallback goes to
    //    the hosted API (apiUrl) in case the bundled copy is ever missing.
    const loadFrom = (url: string) =>
      fetch(url).then(r => {
        if (!r.ok) throw new Error(`waterways ${r.status}`);
        return r.json();
      });
    loadFrom('/data/waterways.geojson')
      .catch(() => loadFrom(apiUrl('/api/waterways')))
      .then(json => { if (!aborted) setWaterways(json); })
      .catch(err => { if (!aborted) setLoadError(String(err)); });
    return () => { aborted = true; };
  }, []);

  const gaugeMap = gaugeData?.gauges ?? {};
  // Keep a ref to the latest gauge map so style + tooltip callbacks can
  // read live data without forcing the GeoJSON layer to re-mount on every
  // status update (the previous styleKey approach rebuilt thousands of
  // canvas paths every tick).
  const gaugeMapRef = useRef(gaugeMap);
  gaugeMapRef.current = gaugeMap;

  const styleFeature = (feature?: Feature<Geometry, WaterwayProperties>): PathOptions => {
    const gid = feature?.properties?.gaugeId;
    const cat: FloodCategory | undefined = gid ? gaugeMapRef.current[gid]?.category : undefined;
    const isWaterbody = feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon';
    const color = colorFor(cat);
    return isWaterbody
      ? { color, weight: 1, fillColor: color, fillOpacity: 0.55 }
      : { color, weight: 2.5, opacity: 0.9 };
  };

  // Push fresh styles into the existing layer when gauge categories change,
  // instead of remounting the GeoJSON component.
  useEffect(() => {
    const layer = geoJsonRef.current;
    if (!layer) return;
    layer.setStyle(styleFeature as any);
    layer.eachLayer(child => {
      const f = (child as any).feature as Feature<Geometry, WaterwayProperties> | undefined;
      const gid = f?.properties?.gaugeId;
      const name = f?.properties?.name ?? 'Unnamed waterway';
      const g = gid ? gaugeMap[gid] : undefined;
      const label = g ? `${name} — ${CATEGORY_LABELS[g.category]}` : name;
      const tip = (child as any).getTooltip?.();
      if (tip) tip.setContent(label);
    });
  }, [gaugeMap]);

  // Drop tiny/minor stream segments below STREAM_MIN_ZOOM. Lakes always
  // render — they're cheap (one polygon each) and provide context.
  const filterFeature = (feature: Feature<Geometry, WaterwayProperties>): boolean => {
    const t = feature.geometry?.type;
    const isLine = t === 'LineString' || t === 'MultiLineString';
    if (!isLine) return true;
    return zoom >= STREAM_MIN_ZOOM;
  };

  const onEachFeature = (feature: Feature<Geometry, WaterwayProperties>, layer: Layer) => {
    const gid = feature.properties?.gaugeId;
    const name = feature.properties?.name ?? 'Unnamed waterway';
    const g = gid ? gaugeMapRef.current[gid] : undefined;
    const label = g ? `${name} — ${CATEGORY_LABELS[g.category]}` : name;
    layer.bindTooltip(label, { sticky: true, direction: 'top', opacity: 0.9 });
    layer.on('click', (e: LeafletMouseEvent) => {
      const live = gid ? gaugeMapRef.current[gid] : undefined;
      if (IS_MOBILE) resolveTap(e.originalEvent, live);
      else if (live) selectGauge(live);
    });
  };

  // Render every gauge we know about. Gauges with no thresholds (or no
  // current observation) come through as `not_defined` and render in gray —
  // they're still useful as "a gauge exists here" markers.
  const gaugeList = useMemo(() => Object.values(gaugeMap), [gaugeMap]);
  gaugeListRef.current = gaugeList;
  // id -> name, for friendly labels in the admin analytics panel.
  const gaugeNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of gaugeList) m[g.id] = g.name;
    return m;
  }, [gaugeList]);
  const categoryCounts = useMemo(() => {
    const counts: Record<FloodCategory, number> = {
      not_defined: 0, no_flooding: 0, action: 0, minor: 0, moderate: 0, major: 0,
    };
    for (const g of gaugeList) counts[g.category]++;
    return counts;
  }, [gaugeList]);

  // Age of the live snapshot being displayed. Only meaningful in live mode —
  // historical/forecast snapshots are old by design. SWR re-polls live data
  // every 10 min, so this re-evaluates regularly while the tab stays open.
  const liveDataAge = !atIso ? dataAgeMs(gaugeData?.updatedAt) : null;
  const liveDataStale = liveDataAge !== null && liveDataAge > STALE_DATA_MS;

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <MapContainer
        ref={mapRef}
        center={[initialView.lat, initialView.lon]}
        zoom={initialView.zoom}
        minZoom={5}
        maxBounds={TX_BOUNDS}
        maxBoundsViscosity={1}
        style={{ height: '100%', width: '100%' }}
        preferCanvas
        zoomControl={false}
      >
        <ViewPersister />
        <ZoomTracker onChange={setZoom} />
        {IS_MOBILE && <TapTargets onTap={resolveTap} />}
        <Basemap />
        {waterways && (
          <GeoJSON
            // Re-mount only when the underlying dataset changes or when the
            // stream-visibility threshold flips, so canvas paths aren't
            // rebuilt on every gauge tick.
            key={zoom >= STREAM_MIN_ZOOM ? 'with-streams' : 'lakes-only'}
            ref={geoJsonRef as any}
            data={waterways}
            style={styleFeature as any}
            filter={filterFeature as any}
            onEachFeature={onEachFeature as any}
          />
        )}
        {gaugeList.map(g => (
          <CircleMarker
            key={g.id}
            center={[g.lat, g.lon]}
            radius={GAUGE_RADIUS}
            pathOptions={{
              color: '#0b1220',
              weight: GAUGE_OUTLINE,
              fillColor: colorFor(g.category),
              fillOpacity: 1,
            }}
            eventHandlers={{
              click: (e) => (IS_MOBILE ? resolveTap(e.originalEvent, g) : selectGauge(g)),
              mouseover: (e) => {
                // Touch taps fire mouseover but never mouseout, so the hover
                // preview would otherwise get stuck open after a tap.
                if (window.matchMedia('(hover: none)').matches) return;
                const { clientX, clientY } = (e.originalEvent as MouseEvent) ?? { clientX: 0, clientY: 0 };
                const timer = window.setTimeout(() => {
                  setHoverChart({ gauge: g, x: clientX, y: clientY });
                }, 1000);
                hoverTimerRef.current = timer;
              },
              mouseout: () => {
                if (hoverTimerRef.current) {
                  window.clearTimeout(hoverTimerRef.current);
                  hoverTimerRef.current = null;
                }
                setHoverChart(null);
              },
            }}
          >
            <Tooltip direction="top" offset={[0, 1 - GAUGE_RADIUS]}>
              {g.name} — {CATEGORY_LABELS[g.category]}
            </Tooltip>
          </CircleMarker>
        ))}
        {userPos && (
          <CircleMarker
            center={userPos}
            radius={7}
            interactive={false}
            pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1 }}
          />
        )}
      </MapContainer>

      <LocateButton onLocated={onLocated} />
      {/* A refresh failed but we still have a snapshot (from an earlier poll
          or the persisted last-good copy): say so instead of silently showing
          old colors. Live mode only — history/forecast have their own loading
          states and nothing sensible to fall back to. */}
      {waterways && !atIso && gaugesError && gaugeData && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0) + 12px)',
            left: 12,
            right: 68, // clear the locate button
            zIndex: 1000,
            background: 'rgba(120,53,15,0.92)',
            backdropFilter: 'blur(6px)',
            color: '#fef3c7',
            border: '1px solid rgba(251,191,36,0.4)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12,
            lineHeight: 1.35,
          }}
        >
          Can&apos;t reach the server — showing gauge data from{' '}
          {new Date(gaugeData.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}.
        </div>
      )}

      {legendVisible && (
        <DraggablePanel
          storageKey="tfm:legend-pos"
          defaultAnchor={{
            bottom: 'calc(env(safe-area-inset-bottom, 0) + 12px)',
            left: 12,
          }}
          onHide={hideLegend}
        >
          <Legend
            counts={categoryCounts}
            updatedAt={gaugeData?.updatedAt}
            onRefresh={() => { refreshGauges(); }}
            refreshing={gaugesValidating}
            onForceRefreshed={() => { refreshGauges(); }}
            gaugeNames={gaugeNames}
          />
        </DraggablePanel>
      )}
      {timelineVisible && (
        <DraggablePanel
          storageKey="tfm:timeline-pos"
          defaultAnchor={{
            bottom: 'calc(env(safe-area-inset-bottom, 0) + 12px)',
            left: '50%',
            transform: 'translateX(-50%)',
          }}
          onHide={hideTimeline}
        >
          <TimelineSlider value={atIso} onChange={setAtIso} loading={gaugesValidating} />
        </DraggablePanel>
      )}
      {(!legendVisible || !timelineVisible) && (
        <div
          style={{
            position: 'absolute',
            right: 12,
            bottom: 'calc(env(safe-area-inset-bottom, 0) + 12px)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {!legendVisible && (
            <button
              type="button"
              onClick={showLegend}
              aria-label="Show legend"
              style={restoreButtonStyle}
            >
              Show legend
            </button>
          )}
          {!timelineVisible && (
            <button
              type="button"
              onClick={showTimeline}
              aria-label="Show timeline"
              style={restoreButtonStyle}
            >
              Show timeline
            </button>
          )}
        </div>
      )}
      {(!waterways || (gaugesLoading && !gaugeData) || (gaugeData?.updatedAt && new Date(gaugeData.updatedAt).getTime() === 0)) && (
        <LoadingBanner
          label={
            !waterways ? 'Loading rivers & lakes…'
              : atIso && new Date(atIso).getTime() > Date.now() ? 'Loading forecast gauge data…'
              : atIso ? 'Loading historical gauge data…'
              : 'Loading live gauge data…'
          }
          sublabel={
            !waterways ? 'Drawing the map…'
              : atIso && new Date(atIso).getTime() > Date.now() ? 'Fetching NWS forecast levels…'
              : atIso ? 'Fetching the selected snapshot…'
              : 'Live readings come from NWPS, which can be slow — fetching the latest…'
          }
        />
      )}
      {liveDataStale && liveDataAge !== null && (
        <div
          style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            maxWidth: 'calc(100vw - 24px)',
            background: 'rgba(120,53,15,0.92)', border: '1px solid #b45309',
            color: '#fde68a', padding: '8px 12px',
            borderRadius: 8, fontSize: 13, zIndex: 1000,
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          }}
        >
          ⚠ Gauge data is {formatAge(liveDataAge)} old — flood statuses may not
          reflect current conditions.
        </div>
      )}
      {loadError && (
        <div
          style={{
            position: 'absolute', top: 12, left: 12, right: 12,
            background: '#7f1d1d', color: '#fff', padding: '8px 12px',
            borderRadius: 8, fontSize: 13, zIndex: 1000,
          }}
        >
          Couldn&apos;t load waterways data ({loadError}). Run <code>pnpm data:build</code>.
        </div>
      )}
      {hoverChart && <HoverHydrograph gauge={hoverChart.gauge} x={hoverChart.x} y={hoverChart.y} />}
      {selected && <GaugeSheet gauge={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

const restoreButtonStyle: React.CSSProperties = {
  background: 'rgba(17,24,39,0.92)',
  backdropFilter: 'blur(6px)',
  color: '#e5e7eb',
  border: '1px solid #374151',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
};
