'use client';

import { useState, type ReactNode } from 'react';
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
    <LayerToggle label="NWS flood warnings and watches" checked={p.enabled} onChange={p.onToggle}>
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
                  The NWS feed lists no flood warnings or watches for Texas{p.asOf ? ` (as of ${p.asOf})` : ''}. Not an all-clear: check weather.gov.
                </div>
              ) : (
                <button
                  type="button"
                  onClick={p.onOpenList}
                  style={{ minHeight: 44, background: '#1f2937', border: '1px solid #374151', borderRadius: 8, color: '#e5e7eb', fontSize: 13, cursor: 'pointer' }}
                >
                  Warnings and watches list ({p.count})
                </button>
              )}
              {p.state.stale && (
                <div role="status" style={{ ...muted, color: '#fbbf24' }}>
                  ⚠ Warnings may be out of date. {updatedText(p.state.ageMs)}.
                </div>
              )}
              <div style={muted}>Unofficial copy of NWS flood warnings and watches. Not a substitute for weather.gov, the NWS or local officials.</div>
            </>
          )}
        </div>
      )}
    </LayerToggle>
  );
}

export interface WebcamsLegendProps {
  enabled: boolean;
  onToggle: (on: boolean) => void;
  // The timeline is on a past or future time: photos are from now, so they are hidden.
  hiddenForTimeline: boolean;
  /** Cameras drawn on the map (photo under 24 h old). */
  shown: number;
  /** Cameras hidden because their newest photo is over 24 h old (or they have none). */
  offline: number;
  loading: boolean;
  unavailable: boolean;
}

export function WebcamsLegendLayer(p: WebcamsLegendProps) {
  return (
    <LayerToggle label="River cameras" checked={p.enabled} onChange={p.onToggle}>
      {p.enabled && (
        <div style={{ ...muted, marginBottom: 6 }}>
          {p.hiddenForTimeline ? (
            'Hidden while the timeline shows another time. Camera photos are from right now; return to live to see them.'
          ) : p.unavailable ? (
            <span role="status" style={{ color: '#fbbf24' }}>⚠ Could not load the camera list. No cameras are shown.</span>
          ) : p.loading ? (
            'Loading cameras…'
          ) : (
            <>
              {p.shown} {p.shown === 1 ? 'camera' : 'cameras'} shown. Still photos from USGS, not live video.
              {p.offline > 0 && <> {p.offline} {p.offline === 1 ? 'camera' : 'cameras'} offline (no photo in 24 h), not shown.</>}
            </>
          )}
        </div>
      )}
    </LayerToggle>
  );
}

const LAYERS_OPEN_KEY = 'tfm:legend-layers-open';

function loadLayersOpen(): boolean {
  try { return window.localStorage.getItem(LAYERS_OPEN_KEY) === '1'; } catch { return false; }
}

// The "Layers" heading and body: one LayerToggle row per optional map layer.
// Collapsed until the person opens it: with both layers expanded the legend is
// taller than most of a phone screen and hides the map on first launch. The
// one-line summary keeps the layers' state visible while collapsed.
export default function LegendLayers({ children, summary }: { children: ReactNode; summary?: string }) {
  const [open, setOpen] = useState<boolean>(() => typeof window !== 'undefined' && loadLayersOpen());
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { window.localStorage.setItem(LAYERS_OPEN_KEY, next ? '1' : '0'); } catch { /* private mode: just not remembered */ }
  };
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1f2937' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          minHeight: 44,
          padding: 0,
          background: 'none',
          border: 'none',
          color: '#e5e7eb',
          fontSize: 13,
          fontWeight: 600,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span aria-hidden style={{ fontSize: 10, width: 10 }}>{open ? '▼' : '▶'}</span>
        <span>Layers</span>
        {!open && summary && <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: 11 }}>· {summary}</span>}
      </button>
      {open && children}
    </div>
  );
}
