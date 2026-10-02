'use client';

import type { ReactNode } from 'react';
import type { AlertLevel } from '@/lib/types';
import { ALERT_LEVELS, ALERT_STYLE } from '@/lib/alertStyle';
import { updatedText, type AlertsState } from '@/lib/alerts-view';

// The Legend's "Layers" section: one toggle row per optional map layer. LayerToggle is
// the reusable row (switch, 44 px target, optional detail underneath).
export function LayerToggle({
  label,
  checked,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: 44,
          padding: 0,
          background: 'none',
          border: 'none',
          color: '#e5e7eb',
          fontSize: 13,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'relative',
            flexShrink: 0,
            width: 34,
            height: 20,
            borderRadius: 10,
            background: checked ? '#2563eb' : '#374151',
            transition: 'background 0.15s',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: checked ? 16 : 2,
              width: 16,
              height: 16,
              borderRadius: 8,
              background: '#f9fafb',
              transition: 'left 0.15s',
            }}
          />
        </span>
        <span style={{ flex: 1 }}>{label}</span>
      </button>
      {children}
    </div>
  );
}

export interface AlertsLegendProps {
  enabled: boolean;
  onToggle: (on: boolean) => void;
  // The timeline is on a past or future time: alerts describe now, so they are hidden.
  hiddenForTimeline: boolean;
  state: AlertsState;
  count: number;
  byLevel: Record<AlertLevel, number>;
  // local HH:MM of the last successful read
  asOf: string | null;
  onOpenList: () => void;
}

const muted = { color: '#9ca3af', fontSize: 11, lineHeight: 1.4 } as const;

export function AlertsLegendLayer(p: AlertsLegendProps) {
  return (
    <LayerToggle label="Flood warnings & watches" checked={p.enabled} onChange={p.onToggle}>
      {p.enabled && p.hiddenForTimeline && (
        <div style={{ ...muted, marginBottom: 6 }}>Hidden while the timeline shows another time. Warnings describe right now; return to live to see them.</div>
      )}
      {p.enabled && !p.hiddenForTimeline && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
          {p.state.kind === 'loading' && <div style={muted}>Loading warnings…</div>}
          {p.state.kind === 'unavailable' && (
            <div role="status" style={{ ...muted, color: '#fbbf24' }}>
              ⚠ Flood warnings unavailable. Check weather.gov.
            </div>
          )}
          {p.state.kind === 'ready' && (
            <>
              {/* the key lists only the kinds in effect now; the count says how many */}
              {ALERT_LEVELS.filter(level => p.byLevel[level] > 0).map(level => {
                const s = ALERT_STYLE[level];
                return (
                  <div key={level} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      aria-hidden
                      style={{
                        width: 18,
                        height: 12,
                        borderRadius: 3,
                        flexShrink: 0,
                        border: `${Math.min(s.weight, 3)}px ${s.dashArray ? 'dashed' : 'solid'} ${s.color}`,
                        background: `${s.color}55`,
                      }}
                    />
                    <span style={{ flex: 1 }}>{s.label}</span>
                    <span style={{ color: '#9ca3af', minWidth: 20, textAlign: 'right' }}>{p.byLevel[level]}</span>
                  </div>
                );
              })}
              {p.count === 0 ? (
                <div role="status" style={muted}>
                  No active flood warnings or watches in Texas{p.asOf ? ` (as of ${p.asOf})` : ''}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={p.onOpenList}
                  style={{ minHeight: 44, background: '#1f2937', border: '1px solid #374151', borderRadius: 8, color: '#e5e7eb', fontSize: 13, cursor: 'pointer' }}
                >
                  Active alerts ({p.count})
                </button>
              )}
              {p.state.stale && (
                <div role="status" style={{ ...muted, color: '#fbbf24' }}>
                  ⚠ Warnings may be out of date. {updatedText(p.state.ageMs)}.
                </div>
              )}
              <div style={muted}>Unofficial copy of National Weather Service alerts.</div>
            </>
          )}
        </div>
      )}
    </LayerToggle>
  );
}

// The "Layers" heading and body. Other layer toggles go inside as siblings of the
// alerts row.
export default function LegendLayers({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1f2937' }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Layers</div>
      {children}
    </div>
  );
}
