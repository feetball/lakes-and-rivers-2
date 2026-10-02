// Moving the map for the gauge list: where a picked gauge or place should end up.

import type { Map as LeafletMap } from 'leaflet';

type FlyMap = Pick<LeafletMap, 'getZoom' | 'getSize' | 'project' | 'unproject' | 'flyTo'>;

/** Deep enough that rivers are painted (STREAM_MIN_ZOOM is 8) and a single gauge is easy to see. */
export const GAUGE_MIN_ZOOM = 11;
/** A town fills the screen at this zoom. */
export const PLACE_MIN_ZOOM = 10;
/**
 * The gauge sheet covers most of the lower screen, so a picked gauge lands this far down from
 * the top (as a fraction of the map height): in the open strip above the sheet, not under it.
 */
export const ABOVE_SHEET = 0.18;

export interface FlyOptions {
  minZoom: number;
  /** Where the target should appear, as a fraction of the map height from the top. Default 0.5: centered. */
  landAt?: number;
}

/** The view that shows (lat, lon) at `landAt`, at least `minZoom` and never further out than now. */
export function flyTarget(map: FlyMap, lat: number, lon: number, { minZoom, landAt = 0.5 }: FlyOptions) {
  // Never zoom OUT on someone who is already looking closer.
  const zoom = Math.max(map.getZoom(), minZoom);
  // To show the target above the middle, the map's centre goes below it by the difference.
  const shift = (0.5 - landAt) * map.getSize().y;
  const at = map.project([lat, lon], zoom);
  return { center: map.unproject([at.x, at.y + shift], zoom), zoom };
}

export function flyToAtLeast(map: FlyMap, lat: number, lon: number, opts: FlyOptions): void {
  const { center, zoom } = flyTarget(map, lat, lon, opts);
  map.flyTo(center, zoom, { duration: 0.8 });
}
