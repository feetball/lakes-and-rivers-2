'use client';

import { useRef, useState } from 'react';
import type { GaugeStatus } from '@/lib/types';
import type { Place } from '@/lib/places';
import GaugeListSheet from './GaugeListSheet';
import { EDGE_RIGHT, controlTop } from './controlSlots';

export interface GaugeListData {
  gauges: Record<string, GaugeStatus> | undefined;
  /** ISO time of the snapshot the gauges came from. */
  updatedAt: string | undefined;
  /** No data yet and a request is in flight. */
  loading: boolean;
  /** The last refresh failed (the gauges, if any, are the last good copy). */
  refreshFailed: boolean;
  /** The map is showing a timeline snapshot (history or forecast), not live data. */
  snapshot: boolean;
}

interface Props extends GaugeListData {
  onPickGauge: (gauge: GaugeStatus) => void;
  onPickPlace: (place: Place) => void;
  /** Called as the list opens, so the parent can close any other sheet (one at a time). */
  onOpen?: () => void;
}

// The list button under the Locate button (slot 1 in controlSlots.ts) and the sheet it opens.
export default function GaugeListControl({ onPickGauge, onPickPlace, onOpen, ...data }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    // The button stays mounted, so focus goes back to where the person started.
    buttonRef.current?.focus();
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { onOpen?.(); setOpen(true); }}
        aria-label="Gauge list: favorites, gauges near me and search"
        aria-haspopup="dialog"
        title="Favorites, gauges near me and search"
        style={{
          position: 'absolute',
          top: controlTop(1),
          right: EDGE_RIGHT,
          zIndex: 1000,
          width: 44,
          height: 44,
          borderRadius: 22,
          background: 'rgba(17,24,39,0.92)',
          border: '1px solid #374151',
          color: '#e5e7eb',
          cursor: 'pointer',
          display: 'grid',
          placeItems: 'center',
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          padding: 0,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden focusable="false">
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="4.5" cy="6" r="1" fill="currentColor" />
          <circle cx="4.5" cy="12" r="1" fill="currentColor" />
          <circle cx="4.5" cy="18" r="1" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <GaugeListSheet
          {...data}
          onClose={close}
          onPickGauge={g => { setOpen(false); onPickGauge(g); }}
          onPickPlace={onPickPlace}
        />
      )}
    </>
  );
}
