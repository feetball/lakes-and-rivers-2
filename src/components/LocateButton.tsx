'use client';

import { useState } from 'react';

interface Props {
  // Called with the user's position once a fix is available.
  onLocated: (lat: number, lon: number) => void;
}

// "Center on me" control. Goes through the Capacitor Geolocation plugin, which
// maps to CoreLocation / Google Play services in the native apps (with the OS
// permission prompt — see the Info.plist / AndroidManifest notes in
// docs/mobile-app.md) and to navigator.geolocation on the web, so one code
// path serves all three. The plugin is imported lazily so the web bundle
// only pays for it on the first tap.
export default function LocateButton({ onLocated }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function locate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { Geolocation } = await import('@capacitor/geolocation');
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: false, // a river is not a parking space; coarse is fine and faster
        timeout: 15_000,
        maximumAge: 60_000,
      });
      onLocated(pos.coords.latitude, pos.coords.longitude);
    } catch (e) {
      setError(describe(e));
      window.setTimeout(() => setError(null), 4000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 'calc(env(safe-area-inset-top, 0) + 12px)',
        right: 12,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {error && (
        <span
          role="status"
          style={{
            background: 'rgba(17,24,39,0.92)',
            color: '#fca5a5',
            border: '1px solid #374151',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 12,
            maxWidth: 220,
          }}
        >
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={locate}
        disabled={busy}
        aria-label="Center map on my location"
        title="Center map on my location"
        style={{
          width: 44, // Apple HIG / Material minimum touch target
          height: 44,
          borderRadius: 22,
          background: 'rgba(17,24,39,0.92)',
          backdropFilter: 'blur(6px)',
          color: busy ? '#6b7280' : '#e5e7eb',
          border: '1px solid #374151',
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          display: 'grid',
          placeItems: 'center',
          cursor: busy ? 'wait' : 'pointer',
          padding: 0,
        }}
      >
        {/* Crosshair icon — inline so there's no icon-font dependency. */}
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <line x1="12" y1="2" x2="12" y2="6" />
          <line x1="12" y1="18" x2="12" y2="22" />
          <line x1="2" y1="12" x2="6" y2="12" />
          <line x1="18" y1="12" x2="22" y2="12" />
        </svg>
      </button>
    </div>
  );
}

// Short, user-facing reason a fix failed. Browser GeolocationPositionError
// carries a numeric code; the native plugin throws Errors with a message.
function describe(e: unknown): string {
  const code = (e as { code?: number } | null)?.code;
  if (code === 1) return 'Location permission denied';
  if (code === 2) return 'Location unavailable';
  if (code === 3) return 'Location timed out';
  const msg = (e as { message?: string } | null)?.message ?? '';
  if (/denied|permission/i.test(msg)) return 'Location permission denied';
  if (/not enabled|disabled|unavailable/i.test(msg)) return 'Location services are off';
  return 'Couldn’t get your location';
}
