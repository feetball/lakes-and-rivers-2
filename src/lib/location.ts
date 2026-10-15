// Device location, shared by the locate button and the "near me" list.
//
// It goes through the Capacitor Geolocation plugin, which maps to CoreLocation / Google
// Play services in the native apps (with the OS permission prompt: see the Info.plist /
// AndroidManifest notes in docs/mobile-app.md) and to navigator.geolocation on the web, so
// one code path serves all three. The plugin is imported lazily so the web bundle only pays
// for it on first use.
//
// A position fetched here is used on the device (to centre the map, to sort gauges by
// distance) and is never sent to our server. Two indirect traces, which the privacy policy
// (/privacy) and the iOS permission text must stay consistent with: after "centre on me"
// the map loads basemap tiles for that area like for any other view, and the map's
// last view (centre + zoom) is remembered in localStorage on the device (MapView's
// ViewPersister).

export interface DevicePosition {
  lat: number;
  lon: number;
}

export type LocationFailureKind = 'denied' | 'off' | 'unavailable' | 'timeout' | 'error';

export interface LocationFailure {
  kind: LocationFailureKind;
  /** Short, user-facing reason: the text the locate button shows. */
  message: string;
}

export type LocationPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export async function requestPosition(): Promise<DevicePosition> {
  const { Geolocation } = await import('@capacitor/geolocation');
  const pos = await Geolocation.getCurrentPosition({
    enableHighAccuracy: false, // a river is not a parking space; coarse is fine and faster
    timeout: 15_000,
    maximumAge: 60_000,
  });
  return { lat: pos.coords.latitude, lon: pos.coords.longitude };
}

/**
 * Whether asking for a position would prompt, succeed or be refused, without asking.
 * 'unknown' when the platform cannot say (no Permissions API in the browser).
 */
export async function checkLocationPermission(): Promise<LocationPermission> {
  try {
    const { Geolocation } = await import('@capacitor/geolocation');
    const status = await Geolocation.checkPermissions();
    const states = [status.location, status.coarseLocation];
    if (states.includes('granted')) return 'granted';
    if (states.every(s => s === 'denied')) return 'denied';
    return 'prompt';
  } catch {
    return 'unknown';
  }
}

// Short, user-facing reason a fix failed. Browser GeolocationPositionError carries a
// numeric code; the native plugin throws Errors with a message.
export function classifyLocationError(e: unknown): LocationFailure {
  const code = (e as { code?: number } | null)?.code;
  if (code === 1) return { kind: 'denied', message: 'Location permission denied' };
  if (code === 2) return { kind: 'unavailable', message: 'Location unavailable' };
  if (code === 3) return { kind: 'timeout', message: 'Location timed out' };
  const msg = (e as { message?: string } | null)?.message ?? '';
  if (/denied|permission/i.test(msg)) return { kind: 'denied', message: 'Location permission denied' };
  if (/not enabled|disabled|unavailable/i.test(msg)) return { kind: 'off', message: 'Location services are off' };
  return { kind: 'error', message: 'Couldn’t get your location' };
}
