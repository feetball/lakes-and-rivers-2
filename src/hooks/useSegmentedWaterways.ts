'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import { segmentWaterways, toRiverGauges, type GaugeLike, type RiverGauge } from '@/lib/riverSegments';

// react-leaflet's <GeoJSON> reads `data` only when the layer is created, so the
// segmented rivers must exist BEFORE it mounts. If no gauge list shows up within
// this long after the waterways load, the map draws the raw waterways instead and
// re-mounts once when the segmented data finally arrives.
export const SEGMENT_GRACE_MS = 3000;

export interface SegmentedWaterways<T> {
  /** What to hand to <GeoJSON>; null while we still wait for the gauge list (grace period). */
  data: T | null;
  /** Changes whenever `data` changes identity: use it in the GeoJSON `key`. */
  key: string;
}

/**
 * Re-owns river stretches by the nearest flood-staged gauge along the river
 * (see src/lib/riverSegments.ts).
 *
 * Thresholds are static, so the result depends only on the waterways and on WHICH
 * gauges have flood stages, never on live categories: live polling and the
 * live/historical/forecast switch return the same `data` object and cause no work.
 * The set of flood-staged gauges only ever grows (a historical snapshot that lacks a
 * gauge can't un-split a river), so after the first compute a change is rare.
 */
export function useSegmentedWaterways<T extends FeatureCollection<Geometry, object>>(
  waterways: T | null,
  gauges: readonly GaugeLike[],
): SegmentedWaterways<T> {
  const known = useRef(new Map<string, RiverGauge>());
  const version = useRef(0);

  // Version of the flood-staged gauge set; bumps only when a new staged gauge (or a moved one) appears.
  const stagedVersion = useMemo(() => {
    let changed = false;
    for (const g of toRiverGauges(gauges)) {
      if (!g.hasThresholds || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
      const prev = known.current.get(g.id);
      if (!prev || prev.lat !== g.lat || prev.lon !== g.lon) {
        known.current.set(g.id, g);
        changed = true;
      }
    }
    if (changed) version.current += 1;
    return version.current;
  }, [gauges]);

  const segmented = useMemo(
    () => (waterways && stagedVersion > 0 ? segmentWaterways(waterways, [...known.current.values()]) : null),
    // known is a ref that stagedVersion tracks
    [waterways, stagedVersion],
  );

  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (!waterways || segmented) return;
    const t = window.setTimeout(() => setGraceOver(true), SEGMENT_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [waterways, segmented]);

  if (segmented) return { data: segmented as T, key: `seg${stagedVersion}` };
  if (waterways && graceOver) return { data: waterways, key: 'raw' };
  return { data: null, key: 'wait' };
}
