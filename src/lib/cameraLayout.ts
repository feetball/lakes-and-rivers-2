// Where to draw each river-camera chip so it can be tapped.
//
// Most cameras sit at a gauge's own site (27 of the 44 shown on 2026-10-02), so at any
// zoom their chip lands under the gauge dot, and the dot's tap zone (24 px in the apps)
// always won: such a camera could only be opened from its gauge's sheet. Here a camera whose
// chip would sit on or near a gauge dot is drawn a fixed number of PIXELS away from its true
// position, joined to it by a short line, in the free spot nearest to it. The offset is in
// pixels, not metres, so it is the same at every zoom and is worked out again whenever the
// zoom changes. MapView draws the chip there and taps are matched against that spot.
//
// Pure module (no React / Leaflet imports) so node:test can import it.

/** Side of a camera chip on the map (px). */
export const CHIP_PX = 24;

/** Distances (px) from the true position that a displaced chip may take, nearest first. */
export const OFFSET_RINGS_PX = [28, 36, 46];

// Directions to try on each ring, in order of preference: up-right first (a chip above and to
// the right of a dot is out of the way of the finger that taps the dot). x right, y down.
const DIAG = Math.SQRT1_2;
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [DIAG, -DIAG], [-DIAG, -DIAG], [DIAG, DIAG], [-DIAG, DIAG],
  [0, -1], [1, 0], [-1, 0], [0, 1],
];

export interface CameraOffset {
  /** Pixels to the right of the camera's true position (negative: left). */
  dx: number;
  /** Pixels below it (negative: above). */
  dy: number;
}

export interface LayoutOptions {
  /** Radius of a gauge dot on the map (px): 7 in the apps, 5 on the website. */
  gaugeRadius: number;
}

/** Web-Mercator pixel position at `zoom`, the same projection Leaflet draws with (256 px tiles). */
export function projectPx(lat: number, lon: number, zoom: number): [number, number] {
  const scale = 256 * 2 ** zoom;
  const sin = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * Math.PI) / 180)));
  return [((lon + 180) / 360) * scale, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale];
}

interface Spot {
  x: number;
  y: number;
}

const dist = (a: Spot, b: Spot) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The offsets for the cameras that need one, by camera id (a camera that is not in the map is
 * drawn where it is). A camera stays put when its chip would be clear of every gauge dot. Else
 * it takes the first spot, nearest ring first, that is clear of every gauge dot and of every
 * other chip; where nothing is clear (a dense cluster) the spot with the most room. Cameras are
 * handled in id order, so the same input always gives the same layout.
 */
export function layoutCameras(
  cameras: ReadonlyArray<{ id: string; lat: number; lon: number }>,
  gauges: ReadonlyArray<{ lat: number; lon: number }>,
  zoom: number,
  { gaugeRadius }: LayoutOptions,
): Map<string, CameraOffset> {
  const out = new Map<string, CameraOffset>();
  if (cameras.length === 0 || !Number.isFinite(zoom)) return out;

  // A chip clears a dot when their edges are 3 px apart; two chips clear each other at 2 px.
  const gaugeClear = CHIP_PX / 2 + gaugeRadius + 3;
  const chipClear = CHIP_PX + 2;
  const reach = OFFSET_RINGS_PX[OFFSET_RINGS_PX.length - 1] + gaugeClear;

  const dots: Spot[] = [];
  for (const g of gauges) {
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    const [x, y] = projectPx(g.lat, g.lon, zoom);
    dots.push({ x, y });
  }
  const sorted = cameras
    .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map(c => {
      const [x, y] = projectPx(c.lat, c.lon, zoom);
      return { id: c.id, x, y };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Only the dots within reach of a camera can matter to it.
  const nearDots = (c: Spot) => dots.filter(d => Math.abs(d.x - c.x) <= reach && Math.abs(d.y - c.y) <= reach);
  const roomAt = (p: Spot, dotsNear: Spot[], placed: Spot[]) => {
    let g = Infinity;
    for (const d of dotsNear) g = Math.min(g, dist(p, d));
    let c = Infinity;
    for (const q of placed) c = Math.min(c, dist(p, q));
    return { g, c, ok: g >= gaugeClear && c >= chipClear };
  };

  const placed: Spot[] = [];
  // First the cameras that are already clear: they never move, and the others work around them.
  const crowded: Array<{ id: string; x: number; y: number; dotsNear: Spot[] }> = [];
  for (const cam of sorted) {
    const dotsNear = nearDots(cam);
    if (roomAt(cam, dotsNear, placed).ok) placed.push({ x: cam.x, y: cam.y });
    else crowded.push({ ...cam, dotsNear });
  }
  for (const cam of crowded) {
    let best: { off: CameraOffset; score: number } | null = null;
    let chosen: CameraOffset | null = null;
    search: for (const ring of OFFSET_RINGS_PX) {
      for (const [ux, uy] of DIRECTIONS) {
        const off = { dx: Math.round(ux * ring), dy: Math.round(uy * ring) };
        const room = roomAt({ x: cam.x + off.dx, y: cam.y + off.dy }, cam.dotsNear, placed);
        if (room.ok) {
          chosen = off;
          break search;
        }
        const score = Math.min(room.g / gaugeClear, room.c / chipClear);
        if (!best || score > best.score) best = { off, score };
      }
    }
    const off = chosen ?? best?.off;
    if (!off) continue;
    out.set(cam.id, off);
    placed.push({ x: cam.x + off.dx, y: cam.y + off.dy });
  }
  return out;
}

/**
 * The offset to use for a camera when matching a tap: (0, 0) when it is drawn where it is.
 */
export function offsetOf(offsets: ReadonlyMap<string, CameraOffset>, id: string): CameraOffset {
  return offsets.get(id) ?? { dx: 0, dy: 0 };
}
