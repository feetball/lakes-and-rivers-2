'use client';

import { useDeviceLocation } from '@/hooks/useDeviceLocation';
import { EDGE_RIGHT, controlTop } from './controlSlots';

interface Props {
  // Called with the user's position once a fix is available.
  onLocated: (lat: number, lon: number) => void;
}

// "Center on me" control. The geolocation itself (Capacitor plugin in the apps,
// navigator.geolocation on the web) lives in src/lib/location.ts, shared with the gauge
// list's "Near me" tab, so one code path serves all three platforms.
export default function LocateButton({ onLocated }: Props) {
  const { busy, failure, locate } = useDeviceLocation({ failureClearMs: 4000 });

  return (
    <div
      style={{
        position: 'absolute',
        top: controlTop(0),
        right: EDGE_RIGHT,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {failure && (
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
          {failure.message}
        </span>
      )}
      <button
        type="button"
        onClick={() => { void locate(onLocated); }}
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
