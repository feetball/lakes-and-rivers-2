'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, GeoJSON, CircleMarker, Marker, Pane, Tooltip, useMapEvents } from 'react-leaflet';
import { Draggable, divIcon } from 'leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { GeoJSON as LeafletGeoJSON, Map as LeafletMap, PathOptions, Layer, LeafletMouseEvent } from 'leaflet';
import { useGaugeData } from '@/hooks/useGaugeData';
import { useSegmentedWaterways } from '@/hooks/useSegmentedWaterways';
import useWebcamData from '@/hooks/useWebcamData';
import { colorFor, displayCategory, CATEGORY_LABELS, STALE_DATA_MS, dataAgeMs, formatAge, type DisplayCategory } from '@/lib/floodStatus';
import { apiUrl, IS_MOBILE } from '@/lib/api';
import { camerasNear, partitionWebcams, webcamStatus, type Webcam } from '@/lib/webcams';
import Basemap from '@/components/Basemap';
import type { GaugeStatus, WaterwayProperties } from '@/lib/types';
import Legend from './Legend';
import LocateButton from './LocateButton';
import GaugeSheet from './GaugeSheet';
import GaugeListControl from './GaugeListControl';
import { ABOVE_SHEET, GAUGE_MIN_ZOOM, PLACE_MIN_ZOOM, flyToAtLeast } from '@/lib/mapFly';
import { pushBackHandler, runBackHandler } from '@/lib/backButton';
import WebcamSheet from './WebcamSheet';
import HoverHydrograph from './HoverHydrograph';
import TimelineSlider from './TimelineSlider';
import LoadingBanner from './LoadingBanner';
import DraggablePanel from './DraggablePanel';
import { track } from '@/lib/track';
import { LEGEND_ABOVE_TIMELINE_PX, useNarrowScreen } from '@/hooks/useNarrowScreen';
import { useAlerts } from '@/hooks/useAlerts';
import { alertLevel, alertsAt, geometryBounds } from '@/lib/alerts-fetch';
import AlertsLayer from './AlertsLayer';
import AlertSheet from './AlertSheet';
import AlertsListSheet from './AlertsListSheet';
import AlertsStatusChip from './AlertsStatusChip';
import type { AlertLevel, NwsAlert } from '@/lib/types';

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
const ALERTS_VISIBLE_KEY = 'tfm:layer-alerts';
const WEBCAMS_VISIBLE_KEY = 'tfm:webcams-visible';

// Gauge dots. The store apps draw them larger and accept taps far from the dot
// itself: a fingertip can't reliably land inside an 11 px circle. The website
// keeps the compact dot (a mouse pointer is precise).
const GAUGE_RADIUS = IS_MOBILE ? 7 : 5;
const GAUGE_OUTLINE = IS_MOBILE ? 1.5 : 1;
// Mobile apps only: a tap within this many CSS px of a gauge's center opens it
// (a 48 px circle, as easy to hit as Apple's 44 pt or Material's 48 dp target).
// Gauges can sit closer together than that, so the NEAREST one wins rather than
// whichever dot happens to be on top.
const GAUGE_TAP_RADIUS = 24;
// River cameras: a 44 px target (22 px radius) in the apps, the glyph itself (24 px chip)
// plus a little slack with a mouse. A gauge within GAUGE_TAP_RADIUS always wins, so a
// camera at a gauge's own site is opened from that gauge's sheet instead.
const WEBCAM_TAP_RADIUS = IS_MOBILE ? 22 : 14;
// Mobile apps only. Leaflet treats a finger that moves 3 px or more (|dx|+|dy|)
// between touch-down and touch-up as the start of a pan and calls preventDefault
// on the touchmove, which makes iOS cancel its own tap, so a fingertip that
// rolls a little as it lands loses the tap even on a dot. 10 matches Android's
// touch slop (8 dp) and iOS's native drag threshold (~10 pt); iOS's own tap
// limit is unpublished. Android never delivers movement inside its slop, so this
// is an iOS fix. The catch: a pan now starts moving only after 10 px of travel,
// and it applies to every drag in the app, mouse and trackpad included.
const TAP_SLOP_PX = 10;
if (IS_MOBILE) Draggable.mergeOptions({ clickTolerance: TAP_SLOP_PX });

// River camera glyph: a light chip with a dark camera, which no flood category uses, and
// bigger than a gauge dot so one at a gauge's own site shows as a ring around it. The
// marker is drawn under the gauge dots and takes no pointer events itself: taps are
// resolved on the map (see `resolveTap`) so they can never steal a gauge's tap.
const WEBCAM_GLYPH =
  '<path d="M6.5 8.2c0-.66.54-1.2 1.2-1.2h1.02c.34 0 .66-.16.86-.44l.5-.68c.19-.26.5-.42.82-.42h1.2c.32 0 .63.16.82.42l.5.68c.2.28.52.44.86.44h1.02c.66 0 1.2.54 1.2 1.2v5.1c0 .66-.54 1.2-1.2 1.2H7.7c-.66 0-1.2-.54-1.2-1.2V8.2z" fill="#0b1220"/><circle cx="11" cy="10.8" r="2" fill="#e5e7eb"/>';
const webcamIcon = (stale: boolean) =>
  divIcon({
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<svg width="24" height="24" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="1" width="20" height="20" rx="5" fill="${stale ? '#fde68a' : '#e5e7eb'}" stroke="${stale ? '#b45309' : '#0b1220'}" stroke-width="1.5"/>${WEBCAM_GLYPH}</svg>`,
  });
const WEBCAM_ICON = webcamIcon(false);
const WEBCAM_ICON_STALE = webcamIcon(true);

// "You are here". Deliberately not a plain dot: gauges are solid circles in
// the same size range and "Normal" is blue, so a blue dot read as another
// gauge. This is violet (no flood category uses it) with a white ring and a
// larger pulsing halo; the styling lives in globals.css (.user-location).
const USER_ICON = divIcon({
  className: 'user-location',
  html: '<span class="user-location__halo"></span><span class="user-location__dot"></span>',
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

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

// Falls back to `fallback` (visible, unless a layer says otherwise) when the key is missing or unparsable.
function loadVisible(key: string, fallback = true): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) === true;
  } catch {
    return fallback;
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

// A tap that missed every layer (open ground near a dot or a camera, or an alert
// outline) still opens the nearest gauge within reach (apps), camera or alert. Taps that
// hit a layer are resolved by that layer's own click handler first — see `resolveTap`.
function TapResolver({ onTap }: { onTap: (e: MouseEvent) => void }) {
  useMapEvents({ click: (e) => onTap(e.originalEvent) });
  return null;
}

// Native click events that `resolveTap` has already acted on (see there).
// Events are unique objects, so nothing needs cleaning up.
const handledTaps = new WeakSet<object>();

// The gauge (or camera) whose center is closest to `point` (container px), if any
// lies within `radius`. One whose marker is entirely off screen (`margin` is its
// size) is never a candidate, so a tap at the edge of the screen can't open one you
// can't see.
function nearestGauge<T extends { lat: number; lon: number }>(
  map: LeafletMap,
  point: { x: number; y: number },
  gauges: T[],
  radius: number,
  margin: number = GAUGE_RADIUS,
): T | null {
  const size = map.getSize();
  let best: T | null = null;
  let bestSq = radius * radius;
  for (const g of gauges) {
    const c = map.latLngToContainerPoint([g.lat, g.lon]);
    if (c.x < -margin || c.y < -margin || c.x > size.x + margin || c.y > size.y + margin) continue;
    const sq = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
    if (sq <= bestSq) {
      best = g;
      bestSq = sq;
    }
  }
  return best;
}

const EMPTY_ALERTS: NwsAlert[] = [];

type Waterways = FeatureCollection<Geometry, WaterwayProperties>;

export default function MapView() {
  const [waterways, setWaterways] = useState<Waterways | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GaugeStatus | null>(null);
  // The camera whose sheet is open, as of when it was tapped; `openWebcam` below is the same
  // camera from the newest list, so the sheet follows a refresh.
  const [selectedWebcam, setSelectedWebcam] = useState<Webcam | null>(null);
  // One sheet at a time: opening any of them (gauge, camera, alert, alert list) goes
  // through here first. The hover preview is dismissed too, so it can never linger on
  // top of the sheet we're about to open.
  const dismissSheets = () => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverChart(null);
    setSelected(null);
    setSelectedWebcam(null);
    setAlertSheet(null);
    setAlertsListOpen(false);
  };
  // Open a gauge sheet and record the open for analytics. Every path (marker, waterway,
  // list, camera sheet, shared link) goes through here so tracking can't be forgotten.
  const selectGauge = (g: GaugeStatus) => {
    dismissSheets();
    setSelected(g);
    track({ type: 'gauge_open', gaugeId: g.id });
  };
  // No analytics event: cameras add nothing to what the app collects.
  const selectWebcam = (w: Webcam) => {
    dismissSheets();
    setSelectedWebcam(w);
  };
  // What the open alert sheet shows: every alert at the tapped point, or one picked
  // from the list.
  const [alertSheet, setAlertSheet] = useState<NwsAlert[] | null>(null);
  const [alertsListOpen, setAlertsListOpen] = useState(false);
  const [hoverChart, setHoverChart] = useState<{ gauge: GaugeStatus; x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  // Tap resolution. Every tappable thing on the map (a gauge dot, a river, a
  // lake, a camera, an alert area, open ground near a dot) reports through here, so one tap
  // opens exactly one thing. In priority order: the nearest gauge center within
  // GAUGE_TAP_RADIUS (apps only), else the gauge dot that was hit directly (the
  // website), else the nearest river camera within WEBCAM_TAP_RADIUS (when the
  // layer is on), else the gauge of the waterway that was tapped, else an NWS warning or
  // watch outline containing the point (outlines are not interactive). Leaflet runs
  // the layer's click handler before the map's and hands both the same native
  // event, so the first to resolve a tap claims it (in `handledTaps`) and the
  // other becomes a no-op.
  const resolveTap = (ev: MouseEvent | undefined, hit: { gauge?: GaugeStatus; waterway?: GaugeStatus } = {}) => {
    if (ev) {
      if (handledTaps.has(ev)) return;
      handledTaps.add(ev);
    }
    const map = mapRef.current;
    const point = ev && map ? map.mouseEventToContainerPoint(ev) : null;
    const near = IS_MOBILE && map && point
      ? nearestGauge(map, point, Object.values(gaugeMapRef.current), GAUGE_TAP_RADIUS)
      : null;
    const gauge = near ?? hit.gauge;
    if (gauge) return selectGauge(gauge);
    const cam = map && point ? nearestGauge(map, point, shownWebcamsRef.current, WEBCAM_TAP_RADIUS, 12) : null;
    if (cam) {
      // Website: a river line drawn above a dot takes that dot's click, so a tap squarely on a
      // gauge dot that has a camera on top of it arrives here as a waterway hit. The dot still wins.
      const dot = !IS_MOBILE && map && point
        ? nearestGauge(map, point, Object.values(gaugeMapRef.current), GAUGE_RADIUS + GAUGE_OUTLINE)
        : null;
      return dot ? selectGauge(dot) : selectWebcam(cam);
    }
    if (hit.waterway) return selectGauge(hit.waterway);
    // Nothing gauge-like was hit: last, the tap may be inside an alert outline.
    if (map && point) {
      const at = map.containerPointToLatLng(point);
      openAlertsAt(at.lat, at.lng);
    }
  };
  // Android back button (hardware or gesture): close the topmost open sheet first
  // (they register in `backButton.ts`, newest first); with nothing open, hand the app
  // to the launcher — the same thing Android 12+ does for a root activity. Registering
  // ANY listener replaces Capacitor's default (which would navigate web-view history),
  // so both branches are ours to handle. Never fires on iOS or the web.
  const sheetOpen = selected !== null || selectedWebcam !== null || alertSheet !== null || alertsListOpen;
  // dismissSheets only touches state setters and a ref, so the first render's copy is fine.
  useEffect(() => (sheetOpen ? pushBackHandler(dismissSheets) : undefined), [sheetOpen]);
  useEffect(() => {
    if (!IS_MOBILE) return;
    let cancelled = false;
    let handle: { remove(): Promise<void> } | null = null;
    (async () => {
      const { App } = await import('@capacitor/app');
      if (cancelled) return;
      handle = await App.addListener('backButton', () => {
        if (runBackHandler()) return;
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
  // Alerts and camera photos describe right now, so both layers are hidden (with the
  // reason in the Legend) while the timeline shows another time.
  const live = atIso === null;
  const {
    data: gaugeData,
    error: gaugesError,
    isLoading: gaugesLoading,
    isValidating: gaugesValidating,
    mutate: refreshGauges,
  } = useGaugeData(atIso);
  // River cameras. The list is fetched whether or not the layer is on (about 20 KB, so a
  // gauge's sheet can offer its camera); `now` moves every minute so a photo that ages
  // past 3 h or 24 h changes state without waiting for the next poll.
  const { data: webcamData, error: webcamsError } = useWebcamData();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const { shown: shownWebcams, offline: offlineWebcams } = useMemo(
    () => partitionWebcams(webcamData?.webcams ?? [], now),
    [webcamData, now],
  );
  const openWebcam = selectedWebcam
    ? webcamData?.webcams.find(w => w.id === selectedWebcam.id) ?? selectedWebcam
    : null;
  const [webcamsVisible, setWebcamsVisible] = useState<boolean>(() => loadVisible(WEBCAMS_VISIBLE_KEY, false));
  const webcamsActive = webcamsVisible && live;
  // Leaving live (timeline on another time) hides the live-only layers, so their sheets go too.
  useEffect(() => {
    if (live) return;
    setSelectedWebcam(null);
    setAlertSheet(null);
    setAlertsListOpen(false);
  }, [live]);
  // Only cameras that are drawn can be tapped.
  const shownWebcamsRef = useRef<Webcam[]>([]);
  shownWebcamsRef.current = webcamsActive ? shownWebcams : [];
  const mapRef = useRef<LeafletMap | null>(null);
  // NWS flood warnings & watches (unofficial overlay). A per-viewer preference.
  const [alertsOn, setAlertsOn] = useState<boolean>(() => loadVisible(ALERTS_VISIBLE_KEY));
  const alertsActive = alertsOn && live;
  const alertsHook = useAlerts(alertsActive);
  const alertsReady = alertsActive && alertsHook.state.kind === 'ready';
  const drawnAlerts = alertsReady ? alertsHook.alerts : EMPTY_ALERTS;
  const alertsRef = useRef<NwsAlert[]>(EMPTY_ALERTS);
  alertsRef.current = drawnAlerts;
  const alertAgeMs = alertsHook.state.kind === 'ready' ? alertsHook.state.ageMs : null;
  const alertsStale = alertsHook.state.kind === 'ready' && alertsHook.state.stale;
  const alertsAsOf = alertsHook.updatedAt
    ? new Date(alertsHook.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  const alertsByLevel = useMemo(() => {
    const c: Record<AlertLevel, number> = { emergency: 0, flash: 0, warning: 0, watch: 0, advisory: 0 };
    for (const a of drawnAlerts) c[alertLevel(a)]++;
    return c;
  }, [drawnAlerts]);
  // Open the sheet for the alerts whose outline contains the point (strongest first).
  function openAlertsAt(lat: number, lon: number) {
    const hit = alertsAt(alertsRef.current, lon, lat);
    if (hit.length > 0) {
      dismissSheets();
      setAlertSheet(hit);
    }
  }
  // From the list: show the alert on the map above the sheet that is about to cover
  // the lower part of the screen, then open it.
  function pickAlert(a: NwsAlert) {
    const map = mapRef.current;
    const b = a.geometry ? geometryBounds(a.geometry) : null;
    if (map && b) {
      const below = map.getSize().y * 0.5;
      map.flyToBounds([[b.south, b.west], [b.north, b.east]], {
        paddingTopLeft: [24, 72],
        paddingBottomRight: [24, below],
        maxZoom: 11,
        duration: 0.8,
      });
    }
    dismissSheets();
    setAlertSheet([a]);
  }
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
  // Gauge list (favorites / near me / search): bring the picked gauge into the strip above
  // its sheet, then open the sheet like a map tap would. Never zooms out.
  const flyToGauge = (g: GaugeStatus) => {
    const map = mapRef.current;
    if (map) flyToAtLeast(map, g.lat, g.lon, { minZoom: GAUGE_MIN_ZOOM, landAt: ABOVE_SHEET });
    selectGauge(g);
  };
  const flyToPlace = (p: { lat: number; lon: number }) => {
    const map = mapRef.current;
    if (map) flyToAtLeast(map, p.lat, p.lon, { minZoom: PLACE_MIN_ZOOM });
  };
  // Shared links (https://txfloods.kuecker.us/?gauge=AMAT2) open that gauge's
  // sheet on the website, once the gauge list has loaded. The apps are not
  // served from a URL a link can point at, so they skip this. The parameter is
  // dropped afterwards so a reload or a copied address bar starts clean.
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (IS_MOBILE || deepLinkDone.current || !gaugeData?.gauges) return;
    deepLinkDone.current = true;
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('gauge');
    if (wanted === null) return;
    params.delete('gauge');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    const g = gaugeData.gauges[wanted.trim().toUpperCase()];
    if (!g) return;
    flyToGauge(g);
    // Runs once, when the first gauge list arrives (deepLinkDone), so the handlers can't go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gaugeData]);
  // Read once on mount so we don't re-center after the user pans.
  const [initialView] = useState<SavedView>(() => {
    const saved = loadView();
    return saved ?? { lat: TX_CENTER[0], lon: TX_CENTER[1], zoom: DEFAULT_ZOOM };
  });
  const [zoom, setZoom] = useState<number>(initialView.zoom);
  const geoJsonRef = useRef<LeafletGeoJSON | null>(null);
  const [legendVisible, setLegendVisible] = useState<boolean>(() => loadVisible(LEGEND_VISIBLE_KEY));
  const [timelineVisible, setTimelineVisible] = useState<boolean>(() => loadVisible(TIMELINE_VISIBLE_KEY));
  const narrowScreen = useNarrowScreen();
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
    const g = gid ? gaugeMapRef.current[gid] : undefined;
    const isWaterbody = feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon';
    const color = colorFor(g && displayCategory(g));
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
      const label = g ? `${name} — ${CATEGORY_LABELS[displayCategory(g)]}` : name;
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
    const label = g ? `${name} — ${CATEGORY_LABELS[displayCategory(g)]}` : name;
    layer.bindTooltip(label, { sticky: true, direction: 'top', opacity: 0.9 });
    layer.on('click', (e: LeafletMouseEvent) => {
      const live = gid ? gaugeMapRef.current[gid] : undefined;
      resolveTap(e.originalEvent, { waterway: live });
    });
  };

  // Render every gauge we know about. A gauge with no current observation comes
  // through as `not_defined` and renders gray ("No data"); one with a reading but
  // no NWS flood stages renders tan ("No flood stages", see displayCategory).
  // Either way it is still useful as a "a gauge exists here" marker.
  const gaugeList = useMemo(() => Object.values(gaugeMap), [gaugeMap]);
  // River re-segmentation (src/lib/riverSegments.ts): each stretch of river is owned by the nearest
  // flood-staged gauge along it. Depends only on the waterways and on which gauges HAVE flood stages,
  // not on live categories. Null until the gauge list is known (or a 3 s grace period passes).
  const { data: riverData, key: riverKey } = useSegmentedWaterways(waterways, gaugeList);
  // id -> name, for friendly labels in the admin analytics panel.
  const gaugeNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of gaugeList) m[g.id] = g.name;
    return m;
  }, [gaugeList]);
  const categoryCounts = useMemo(() => {
    const counts: Record<DisplayCategory, number> = {
      not_defined: 0, no_stages: 0, no_flooding: 0, action: 0, minor: 0, moderate: 0, major: 0,
    };
    for (const g of gaugeList) counts[displayCategory(g)]++;
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
        <TapResolver onTap={resolveTap} />
        <Basemap />
        <AlertsLayer alerts={drawnAlerts} />
        {riverData && (
          <GeoJSON
            // Re-mount only when the underlying dataset changes or when the
            // stream-visibility threshold flips, so canvas paths aren't
            // rebuilt on every gauge tick.
            key={`${zoom >= STREAM_MIN_ZOOM ? 'with-streams' : 'lakes-only'}-${riverKey}`}
            ref={geoJsonRef as any}
            data={riverData}
            style={styleFeature as any}
            filter={filterFeature as any}
            onEachFeature={onEachFeature as any}
          />
        )}
        {/* Below the canvas the waterways and gauge dots are drawn on (overlay pane, 400). */}
        <Pane name="webcams" style={{ zIndex: 399, pointerEvents: 'none' }}>
          {webcamsActive && shownWebcams.map(w => (
            <Marker
              key={w.id}
              pane="webcams"
              position={[w.lat, w.lon]}
              icon={webcamStatus(w, now) === 'stale' ? WEBCAM_ICON_STALE : WEBCAM_ICON}
              interactive={false}
              keyboard={false}
            />
          ))}
        </Pane>
        {gaugeList.map(g => (
          <CircleMarker
            key={g.id}
            center={[g.lat, g.lon]}
            radius={GAUGE_RADIUS}
            pathOptions={{
              color: '#0b1220',
              weight: GAUGE_OUTLINE,
              fillColor: colorFor(displayCategory(g)),
              fillOpacity: 1,
            }}
            eventHandlers={{
              click: (e) => {
                resolveTap(e.originalEvent, { gauge: g });
              },
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
            {/* Tip 1 px inside the top edge of the dot, whatever its size (-4 at radius 5). */}
            <Tooltip direction="top" offset={[0, 1 - GAUGE_RADIUS]}>
              {g.name} — {CATEGORY_LABELS[displayCategory(g)]}
            </Tooltip>
          </CircleMarker>
        ))}
        {userPos && (
          <Marker
            position={userPos}
            icon={USER_ICON}
            interactive={false}
            keyboard={false}
            zIndexOffset={1000}
          />
        )}
      </MapContainer>

      <LocateButton onLocated={onLocated} />
      <GaugeListControl
        gauges={gaugeData?.gauges}
        updatedAt={gaugeData?.updatedAt}
        loading={gaugesLoading}
        refreshFailed={!atIso && !!gaugesError}
        snapshot={atIso !== null}
        onPickGauge={flyToGauge}
        onPickPlace={flyToPlace}
        onOpen={dismissSheets}
      />
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

      {alertsActive && (
        <AlertsStatusChip
          state={alertsHook.state}
          top={
            (waterways && !atIso && gaugesError && gaugeData) || liveDataStale
              ? 'calc(env(safe-area-inset-top, 0px) + 76px)'
              : 'calc(env(safe-area-inset-top, 0px) + 12px)'
          }
        />
      )}

      {legendVisible && (
        <DraggablePanel
          storageKey="tfm:legend-pos"
          defaultAnchor={{
            // On a narrow screen the timeline spans almost the full width and would
            // sit on top of the legend (hiding its last rows, the layer toggles and
            // the "Updated" line), so the legend starts above it. Beside it, or
            // alone, it keeps the corner.
            bottom: `calc(env(safe-area-inset-bottom, 0) + ${narrowScreen && timelineVisible ? LEGEND_ABOVE_TIMELINE_PX : 12}px)`,
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
            alertsLayer={{
              enabled: alertsOn,
              onToggle: on => {
                setAlertsOn(on);
                saveVisible(ALERTS_VISIBLE_KEY, on);
                if (!on) { setAlertSheet(null); setAlertsListOpen(false); }
              },
              hiddenForTimeline: !live,
              state: alertsHook.state,
              count: drawnAlerts.length,
              byLevel: alertsByLevel,
              asOf: alertsAsOf,
              onOpenList: () => { dismissSheets(); setAlertsListOpen(true); },
            }}
            webcams={{
              enabled: webcamsVisible,
              onToggle: on => {
                setWebcamsVisible(on);
                saveVisible(WEBCAMS_VISIBLE_KEY, on);
                if (!on) setSelectedWebcam(null);
              },
              hiddenForTimeline: !live,
              shown: shownWebcams.length,
              offline: offlineWebcams.length,
              unavailable: !webcamData && !!webcamsError,
              loading: !webcamData && !webcamsError,
            }}
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
      {selected && (
        <GaugeSheet
          gauge={selected}
          onClose={() => setSelected(null)}
          webcam={(() => {
            const cam = live ? shownWebcams.find(w => w.gaugeId === selected.id) : undefined;
            return cam ? { name: cam.name, onOpen: () => selectWebcam(cam) } : undefined;
          })()}
        />
      )}
      {openWebcam && (() => {
        const gauge = openWebcam.gaugeId ? gaugeMap[openWebcam.gaugeId] : undefined;
        return (
          <WebcamSheet
            webcam={openWebcam}
            gaugeName={gauge?.name}
            onOpenGauge={gauge ? () => selectGauge(gauge) : undefined}
            siblings={camerasNear(openWebcam, shownWebcams)}
            onSelectSibling={selectWebcam}
            onClose={() => setSelectedWebcam(null)}
          />
        );
      })()}
      {alertSheet && (
        <AlertSheet
          key={alertSheet.map(a => a.id).join('|')}
          alerts={alertSheet}
          ageMs={alertAgeMs}
          stale={alertsStale}
          onClose={() => setAlertSheet(null)}
        />
      )}
      {alertsListOpen && (
        <AlertsListSheet
          alerts={drawnAlerts}
          ageMs={alertAgeMs}
          stale={alertsStale}
          asOf={alertsAsOf}
          onPick={pickAlert}
          onClose={() => setAlertsListOpen(false)}
        />
      )}
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
