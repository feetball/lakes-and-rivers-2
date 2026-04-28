'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, CircleMarker, Tooltip, useMapEvents } from 'react-leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { GeoJSON as LeafletGeoJSON, PathOptions, Layer } from 'leaflet';
import { useGaugeData } from '@/hooks/useGaugeData';
import { CATEGORY_ORDER, colorFor, CATEGORY_LABELS } from '@/lib/floodStatus';
import type { FloodCategory, GaugeStatus, WaterwayProperties } from '@/lib/types';
import Legend from './Legend';
import GaugeSheet from './GaugeSheet';
import HoverHydrograph from './HoverHydrograph';
import TimelineSlider from './TimelineSlider';
import LoadingBanner from './LoadingBanner';

// Below this zoom, hide stream/river lines and only paint waterbodies.
// Painting thousands of canvas polylines while panning the whole state is
// the dominant cost — punting them past the state-wide view keeps the map
// responsive without losing context (lakes still draw to anchor the geography).
const STREAM_MIN_ZOOM = 8;

// Center on Texas.
const TX_CENTER: [number, number] = [31.0, -99.5];
const TX_BOUNDS: [[number, number], [number, number]] = [
  [25.8, -106.7],
  [36.6, -93.5],
];
const VIEW_KEY = 'tfm:view';

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
  const [hoverChart, setHoverChart] = useState<{ gauge: GaugeStatus; x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  // null = live; ISO = historical snapshot.
  const [atIso, setAtIso] = useState<string | null>(null);
  const { data: gaugeData, isLoading: gaugesLoading, isValidating: gaugesValidating } = useGaugeData(atIso);
  // Read once on mount so we don't re-center after the user pans.
  const [initialView] = useState<SavedView>(() => {
    const saved = loadView();
    return saved ?? { lat: TX_CENTER[0], lon: TX_CENTER[1], zoom: 6 };
  });
  const [zoom, setZoom] = useState<number>(initialView.zoom);
  const geoJsonRef = useRef<LeafletGeoJSON | null>(null);

  useEffect(() => {
    let aborted = false;
    fetch('/data/waterways.geojson')
      .then(r => {
        if (!r.ok) throw new Error(`waterways ${r.status}`);
        return r.json();
      })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (live) setSelected(live);
    });
  };

  // Render every gauge we know about. Gauges with no thresholds (or no
  // current observation) come through as `not_defined` and render in gray —
  // they're still useful as "a gauge exists here" markers.
  const gaugeList = useMemo(() => Object.values(gaugeMap), [gaugeMap]);
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
              click: () => setSelected(g),
              mouseover: (e) => {
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
      </MapContainer>

      <Legend counts={categoryCounts} updatedAt={gaugeData?.updatedAt} />
      <TimelineSlider value={atIso} onChange={setAtIso} loading={gaugesValidating} />
      {(!waterways || (gaugesLoading && !gaugeData) || (gaugeData?.updatedAt && new Date(gaugeData.updatedAt).getTime() === 0)) && (
        <LoadingBanner
          label={
            !waterways ? 'Loading rivers & lakes…'
              : atIso ? 'Loading historical gauge data…'
              : 'Loading live gauge data…'
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
          Couldn't load waterways data ({loadError}). Run <code>pnpm data:build</code>.
        </div>
      )}
      {hoverChart && <HoverHydrograph gauge={hoverChart.gauge} x={hoverChart.x} y={hoverChart.y} />}
      {selected && <GaugeSheet gauge={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
