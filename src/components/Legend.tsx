'use client';

import { useState } from 'react';
import { CATEGORY_ORDER, CATEGORY_COLORS, CATEGORY_LABELS } from '@/lib/floodStatus';
import type { FloodCategory } from '@/lib/types';
import AdminControls from './AdminControls';

interface Props {
  counts: Record<FloodCategory, number>;
  updatedAt?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  // Re-read gauge data after an admin server-side force refresh.
  onForceRefreshed?: () => void;
}

export default function Legend({ counts, updatedAt, onRefresh, refreshing, onForceRefreshed }: Props) {
  const [open, setOpen] = useState(true);
  // epoch-0 (1970-01-01T00:00:00Z) is the "no real observation yet" sentinel
  // the API ships when the live NWPS cache is still cold. Formatting it
  // verbatim renders as "Dec 31" in US timezones, which reads like a real (and
  // alarmingly stale) timestamp — so surface it as "Updating…" instead.
  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : NaN;
  const updatedLabel = !updatedAt
    ? '—'
    : !Number.isFinite(updatedMs) || updatedMs === 0
      ? 'Updating…'
      : new Date(updatedMs).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

  return (
    <div
      style={{
        background: 'rgba(17,24,39,0.92)',
        backdropFilter: 'blur(6px)',
        color: '#e5e7eb',
        borderBottomLeftRadius: 10,
        borderBottomRightRadius: 10,
        padding: open ? '10px 12px' : '8px 12px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
        maxWidth: 'calc(100vw - 24px)',
        fontSize: 13,
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
        aria-expanded={open}
      >
        Flood status <span style={{ color: '#9ca3af', fontWeight: 400 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {CATEGORY_ORDER.map(cat => (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: CATEGORY_COLORS[cat],
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              />
              <span style={{ flex: 1 }}>{CATEGORY_LABELS[cat]}</span>
              <span style={{ color: '#9ca3af', minWidth: 24, textAlign: 'right' }}>{counts[cat]}</span>
            </div>
          ))}
          <div
            style={{
              marginTop: 6,
              color: '#9ca3af',
              fontSize: 11,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span>Updated {updatedLabel}</span>
            {onRefresh && (
              <button
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh gauge data"
                title="Refresh gauge data"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '0 2px',
                  color: refreshing ? '#6b7280' : '#e5e7eb',
                  cursor: refreshing ? 'wait' : 'pointer',
                  fontSize: 13,
                  lineHeight: 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  animation: refreshing ? 'tfm-spin 0.9s linear infinite' : 'none',
                }}
              >
                ↻
              </button>
            )}
            <span>· refreshes every 10 min</span>
          </div>
          <AdminControls onRefreshed={onForceRefreshed} />
          {process.env.NEXT_PUBLIC_APP_VERSION && (
            <div style={{ marginTop: 4, color: '#6b7280', fontSize: 10 }}>
              v{process.env.NEXT_PUBLIC_APP_VERSION}
            </div>
          )}
          <style>{`@keyframes tfm-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
        </div>
      )}
    </div>
  );
}
