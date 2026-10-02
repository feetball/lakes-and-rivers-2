'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkLocationPermission,
  classifyLocationError,
  requestPosition,
  type LocationFailure,
  type LocationPermission,
} from '@/lib/location';

export interface DeviceFix {
  lat: number;
  lon: number;
  /** Date.now() when the fix arrived. */
  at: number;
}

interface Options {
  /** Clear `failure` this long after it appears (the locate button's toast). Left alone when unset. */
  failureClearMs?: number;
}

// One device-location request at a time, with its busy / failure state. The locate
// button and the "near me" list each use their own instance. Nothing here leaves the device.
export function useDeviceLocation({ failureClearMs }: Options = {}) {
  const [fix, setFix] = useState<DeviceFix | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LocationFailure | null>(null);
  const [permission, setPermission] = useState<LocationPermission>('unknown');
  const busyRef = useRef(false);
  const clearTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
  }, []);

  // `onFix` runs inside the same try as the request, so a throw there is reported as a failed fix.
  const locate = useCallback(
    async (onFix?: (lat: number, lon: number) => void): Promise<DeviceFix | null> => {
      if (busyRef.current) return null;
      busyRef.current = true;
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
      setBusy(true);
      setFailure(null);
      try {
        const next: DeviceFix = { ...(await requestPosition()), at: Date.now() };
        setFix(next);
        setPermission('granted');
        onFix?.(next.lat, next.lon);
        return next;
      } catch (e) {
        const reason = classifyLocationError(e);
        setFailure(reason);
        if (reason.kind === 'denied') setPermission('denied');
        if (failureClearMs) clearTimer.current = window.setTimeout(() => setFailure(null), failureClearMs);
        return null;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [failureClearMs],
  );

  const refreshPermission = useCallback(async (): Promise<LocationPermission> => {
    const state = await checkLocationPermission();
    setPermission(state);
    return state;
  }, []);

  return { fix, busy, failure, permission, locate, refreshPermission };
}
