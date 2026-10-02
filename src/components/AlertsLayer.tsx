'use client';

import { useMemo } from 'react';
import { GeoJSON, Pane } from 'react-leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { PathOptions } from 'leaflet';
import type { AlertLevel, NwsAlert } from '@/lib/types';
import { LEVEL_RANK, alertLevel } from '@/lib/alerts-fetch';
import { ALERT_STYLE } from '@/lib/alertStyle';

// NWS alert outlines, in a pane of their own (with their own canvas, because the map
// prefers canvas) just under the overlay pane that holds the waterways and the gauge
// dots, so nothing here can cover a gauge. Purely visual: the shapes are not
// interactive and never receive a tap. A tap on one is resolved by point-in-polygon
// in MapView, after gauges and waterways have had their say.
const ALERT_PANE = 'alerts';
const ALERT_PANE_Z = 390; // tiles 200, overlay (waterways, dots) 400

interface Props {
  alerts: NwsAlert[];
}

export default function AlertsLayer({ alerts }: Props) {
  const { data, signature } = useMemo(() => {
    // Weakest first, so the strongest outline is painted on top where they overlap.
    const drawn = alerts
      .filter(a => a.geometry !== null)
      .map(a => ({ a, level: alertLevel(a) }))
      .sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level]);
    const features: Feature<Geometry, { level: AlertLevel }>[] = drawn.map(({ a, level }) => ({
      type: 'Feature',
      properties: { level },
      geometry: a.geometry as Geometry,
    }));
    const data: FeatureCollection<Geometry, { level: AlertLevel }> = { type: 'FeatureCollection', features };
    return { data, signature: drawn.map(({ a }) => `${a.id}@${a.sent}:${a.geometrySource}`).join('|') };
  }, [alerts]);

  if (data.features.length === 0) return null;
  const style = (f?: Feature<Geometry, { level: AlertLevel }>): PathOptions => {
    const s = ALERT_STYLE[f?.properties.level ?? 'advisory'];
    return {
      color: s.color,
      weight: s.weight,
      opacity: 0.95,
      fillColor: s.color,
      fillOpacity: s.fillOpacity,
      dashArray: s.dashArray ?? undefined,
      lineJoin: 'round',
    };
  };
  return (
    <Pane name={ALERT_PANE} style={{ zIndex: ALERT_PANE_Z, pointerEvents: 'none' }}>
      {/* Re-mounted when the set of alerts changes (a few every couple of minutes at most). */}
      <GeoJSON key={signature} data={data} style={style as never} pane={ALERT_PANE} interactive={false} />
    </Pane>
  );
}
