'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, CircleMarker, Marker, Tooltip, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { GeoJSON as LeafletGeoJSON, PathOptions, Layer } from 'leaflet';
import { useGaugeData } from '@/hooks/useGaugeData';
import useWebcamData from '@/hooks/useWebcamData';
import { colorFor, CATEGORY_LABELS } from '@/lib/floodStatus';
import type { FloodCategory, GaugeStatus, WaterwayProperties, Webcam } from '@/lib/types';
import Legend from './Legend';
import GaugeSheet from './GaugeSheet';
import WebcamSheet from './WebcamSheet';
import HoverHydrograph from './HoverHydrograph';
import TimelineSlider from './TimelineSlider';
import LoadingBanner from './LoadingBanner';
import DraggablePanel from './DraggablePanel';
import { track } from '@/lib/track';

// Neutral chip (not a flood-status color) so it reads distinctly from gauge
// dots. Kept visually smaller/quieter than the 10px gauge markers.
const webcamIcon = L.divIcon({
  className: 'tfm-webcam-marker',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  html: `
    <svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="20" height="20" rx="5" fill="#e5e7eb" stroke="#0b1220" stroke-width="1.5"/>
      <path d="M6.5 8.2c0-.66.54-1.2 1.2-1.2h1.02c.34 0 .66-.16.86-.44l.5-.68c.19-.26.5-.42.82-.42h1.2c.32 0 .63.16.82.42l.5.68c.2.28.52.44.86.44h1.02c.66 0 1.2.54 1.2 1.2v5.1c0 .66-.54 1.2-1.2 1.2H7.7c-.66 0-1.2-.54-1.2-1.2V8.2z" fill="#0b1220"/>
      <circle cx="11" cy="10.8" r="2" fill="#e5e7eb"/>
    </svg>
  `,
});

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
const WEBCAMS_VISIBLE_KEY = 'tfm:webcams-visible';

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

type Waterways = FeatureCollection<Geometry, WaterwayProperties>;

export default function MapView() {
  const [waterways, setWaterways] = useState<Waterways | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GaugeStatus | null>(null);
  const [selectedWebcam, setSelectedWebcam] = useState<Webcam | null>(null);
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
    setSelectedWebcam(null); // sheets are exclusive — never stack
    setSelected(g);
    track({ type: 'gauge_open', gaugeId: g.id });
  };
  // Open a webcam sheet, mirroring selectGauge above.
  const selectWebcam = (w: Webcam) => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverChart(null);
    setSelected(null); // sheets are exclusive — never stack
    setSelectedWebcam(w);
    track({ type: 'webcam_open', webcamId: w.id });
  };
  const [hoverChart, setHoverChart] = useState<{ gauge: GaugeStatus; x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  // null = live; ISO = historical snapshot.
  const [atIso, setAtIso] = useState<string | null>(null);
  const {
    data: gaugeData,
    isLoading: gaugesLoading,
    isValidating: gaugesValidating,
    mutate: refreshGauges,
  } = useGaugeData(atIso);
  const { data: webcamData, error: webcamsError } = useWebcamData();
  const webcams = webcamData?.webcams ?? [];
  const webcamsUnavailable = !webcamData && !!webcamsError;
  // Read once on mount so we don't re-center after the user pans.
  const [initialView] = useState<SavedView>(() => {
    const saved = loadView();
    return saved ?? { lat: TX_CENTER[0], lon: TX_CENTER[1], zoom: DEFAULT_ZOOM };
  });
  const [zoom, setZoom] = useState<number>(initialView.zoom);
  const geoJsonRef = useRef<LeafletGeoJSON | null>(null);
  const [legendVisible, setLegendVisible] = useState<boolean>(() => loadVisible(LEGEND_VISIBLE_KEY));
  const [timelineVisible, setTimelineVisible] = useState<boolean>(() => loadVisible(TIMELINE_VISIBLE_KEY));
  const [webcamsVisible, setWebcamsVisible] = useState<boolean>(() => loadVisible(WEBCAMS_VISIBLE_KEY));
  const hideLegend = () => { setLegendVisible(false); saveVisible(LEGEND_VISIBLE_KEY, false); };
  const showLegend = () => { setLegendVisible(true); saveVisible(LEGEND_VISIBLE_KEY, true); };
  const toggleWebcams = () => {
    setWebcamsVisible(v => {
      const next = !v;
      saveVisible(WEBCAMS_VISIBLE_KEY, next);
      return next;
    });
  };
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
    const loadFrom = (url: string) =>
      fetch(url).then(r => {
        if (!r.ok) throw new Error(`waterways ${r.status}`);
        return r.json();
      });
    loadFrom('/data/waterways.geojson')
      .catch(() => loadFrom('/api/waterways'))
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
    layer.on('click', () => {
      const live = gid ? gaugeMapRef.current[gid] : undefined;
      if (live) selectGauge(live);
    });
  };

  // Render every gauge we know about. Gauges with no thresholds (or no
  // current observation) come through as `not_defined` and render in gray —
  // they're still useful as "a gauge exists here" markers.
  const gaugeList = useMemo(() => Object.values(gaugeMap), [gaugeMap]);
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

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <MapContainer
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
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={18}
        />
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
            radius={5}
            pathOptions={{
              color: '#0b1220',
              weight: 1,
              fillColor: colorFor(g.category),
              fillOpacity: 1,
            }}
            eventHandlers={{
              click: () => selectGauge(g),
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
            <Tooltip direction="top" offset={[0, -4]}>
              {g.name} — {CATEGORY_LABELS[g.category]}
            </Tooltip>
          </CircleMarker>
        ))}
        {webcamsVisible && webcams.map(w => (
          <Marker
            key={w.id}
            position={[w.lat, w.lon]}
            icon={webcamIcon}
            eventHandlers={{ click: () => selectWebcam(w) }}
          >
            <Tooltip direction="top" offset={[0, -10]}>{w.name} — webcam</Tooltip>
          </Marker>
        ))}
      </MapContainer>

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
            webcamsVisible={webcamsVisible}
            onToggleWebcams={toggleWebcams}
            webcamCount={webcams.length}
            webcamsUnavailable={webcamsUnavailable}
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
      {selectedWebcam && <WebcamSheet webcam={selectedWebcam} onClose={() => setSelectedWebcam(null)} />}
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
