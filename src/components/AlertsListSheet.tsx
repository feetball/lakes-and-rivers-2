'use client';

import type { NwsAlert } from '@/lib/types';
import { alertLevel } from '@/lib/alerts-fetch';
import { ALERT_STYLE } from '@/lib/alertStyle';
import { relativeTime, updatedText } from '@/lib/alerts-view';
import { ALERT_SOURCE_NOTE } from './AlertSheet';

interface Props {
  alerts: NwsAlert[];
  ageMs: number | null;
  stale: boolean;
  // "as of" for the empty state, local HH:MM
  asOf: string | null;
  onPick: (a: NwsAlert) => void;
  onClose: () => void;
}

// The "Active alerts" list. It is also the way in for alerts with no outline on the
// map (an alert whose zone shapes could not be fetched) and for screen-reader users,
// who cannot tap a polygon.
export default function AlertsListSheet({ alerts, ageMs, stale, asOf, onPick, onClose }: Props) {
  const now = Date.now();
  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1200 }} aria-hidden />
      <div
        role="dialog"
        aria-label="Active flood alerts"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxWidth: 560,
          marginInline: 'auto',
          maxHeight: '70dvh',
          background: '#111827',
          color: '#e5e7eb',
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: '16px 18px calc(env(safe-area-inset-bottom, 0) + 18px)',
          zIndex: 1201,
          boxShadow: '0 -6px 24px rgba(0,0,0,0.45)',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: '#374151' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>Active flood alerts ({alerts.length})</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: '#9ca3af', fontSize: 22, lineHeight: 1, cursor: 'pointer', padding: '8px 10px' }}
          >
            ×
          </button>
        </div>

        {alerts.length === 0 ? (
          <p style={{ fontSize: 14, lineHeight: 1.45, margin: '8px 0 12px' }}>
            No active flood warnings or watches in Texas{asOf ? ` (as of ${asOf})` : ''}
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {alerts.map(a => {
              const s = ALERT_STYLE[alertLevel(a)];
              const until = a.ends ?? a.expires;
              return (
                <li key={a.id}>
                  <button
                    onClick={() => onPick(a)}
                    style={{
                      width: '100%',
                      minHeight: 44,
                      textAlign: 'left',
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      background: '#1f2937',
                      color: '#e5e7eb',
                      border: '1px solid #374151',
                      borderRadius: 8,
                      padding: '8px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 18,
                        height: 12,
                        marginTop: 4,
                        borderRadius: 3,
                        flexShrink: 0,
                        border: `${Math.min(s.weight, 3)}px ${s.dashArray ? 'dashed' : 'solid'} ${s.color}`,
                        background: `${s.color}55`,
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>
                        {alertLevel(a) === 'emergency' ? 'Flash Flood Emergency' : a.event}
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          color: '#9ca3af',
                          overflow: 'hidden',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        } as React.CSSProperties}
                      >
                        {a.areaDesc}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                        {until ? `${a.ends ? 'Ends' : 'Expires'} ${relativeTime(until, now) ?? ''}` : ''}
                        {a.geometry === null ? `${until ? ' · ' : ''}not drawn on the map` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div style={stale ? { color: '#fbbf24', fontSize: 12, marginBottom: 8 } : { color: '#9ca3af', fontSize: 12, marginBottom: 8 }}>
          {stale && '⚠ Warnings may be out of date. '}
          {ageMs !== null ? updatedText(ageMs) : ''}
        </div>
        <div style={{ color: '#9ca3af', fontSize: 11, lineHeight: 1.45 }}>{ALERT_SOURCE_NOTE}</div>
      </div>
    </>
  );
}
