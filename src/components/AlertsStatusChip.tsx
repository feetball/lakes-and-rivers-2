'use client';

import type { AlertsState } from '@/lib/alerts-view';
import { CLEAR_OF_CONTROLS_RIGHT, EDGE_LEFT } from './controlSlots';

// Shown on the map (not only in the Legend, which can be hidden) when the warnings
// layer is on but cannot be trusted: an empty overlay must never read as "no warnings".
export default function AlertsStatusChip({ state, top }: { state: AlertsState; top: string }) {
  const stale = state.kind === 'ready' && state.stale;
  if (state.kind !== 'unavailable' && !stale) return null;
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        top,
        left: EDGE_LEFT,
        right: CLEAR_OF_CONTROLS_RIGHT,
        zIndex: 1000,
        width: 'fit-content',
        maxWidth: 'calc(100vw - 80px)',
        background: 'rgba(120,53,15,0.92)',
        backdropFilter: 'blur(6px)',
        color: '#fef3c7',
        border: '1px solid rgba(251,191,36,0.4)',
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 12,
        lineHeight: 1.35,
      }}
    >
      {state.kind === 'unavailable' ? 'Flood warnings unavailable - check weather.gov' : 'Warnings may be out of date'}
    </div>
  );
}
