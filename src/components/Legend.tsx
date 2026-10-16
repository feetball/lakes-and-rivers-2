'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { CATEGORY_ORDER, CATEGORY_COLORS, CATEGORY_LABELS, OLD_READING_STYLE, STALE_DATA_MS, dataAgeMs, type DisplayCategory } from '@/lib/floodStatus';
import { onExternalLinkClick, PRIVACY_URL, SUPPORT_URL, TERMS_URL } from '@/lib/externalLink';
import { analyticsOptedOut, setAnalyticsOptOut } from '@/lib/track';
import LegendLayers, { AlertsLegendLayer, WebcamsLegendLayer, type AlertsLegendProps, type WebcamsLegendProps } from './LegendLayers';
import { EDGE_LEFT, EDGE_RIGHT } from './controlSlots';

// The admin login is an operator tool for the web deploy. In the store apps this is
// `null` and the import is dropped at build time, so the login UI and its endpoints are
// not in the app binary at all. The env read must stay inline (not IS_MOBILE): webpack
// only prunes a dead `import()` when the condition is a literal in this module.
const AdminControls = process.env.NEXT_PUBLIC_MOBILE === '1' ? null : dynamic(() => import('./AdminControls'));

const footerLink = { color: '#9ca3af', textDecoration: 'underline', padding: '4px 0' } as const;

interface Props {
  counts: Record<DisplayCategory, number>;
  // Gauges whose reading is old (isOldReading); they are also counted in `counts`.
  oldReadings?: number;
  updatedAt?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  // Re-read gauge data after an admin server-side force refresh.
  onForceRefreshed?: () => void;
  // gaugeId -> display name, passed through to the admin analytics panel.
  gaugeNames?: Record<string, string>;
  // Optional map layers, rendered in one "Layers" section. Omitted = no row.
  alertsLayer?: AlertsLegendProps;
  webcams?: WebcamsLegendProps;
  // CSS max-height; see legendMaxHeight.
  maxHeight?: string;
}

// With both optional layers on the panel is tall. Sitting `bottomPx` above the bottom
// safe-area inset, it may grow until its top (with the 14 px drag handle above it) is
// 114 px below the top inset: clear of the status bar / notch and below the map buttons.
export function legendMaxHeight(bottomPx: number): string {
  return `calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - ${bottomPx + 14 + 114}px)`;
}

export default function Legend({ counts, oldReadings, updatedAt, onRefresh, refreshing, onForceRefreshed, gaugeNames, alertsLayer, webcams, maxHeight = legendMaxHeight(12) }: Props) {
  const [open, setOpen] = useState(true);
  // Read after mount: localStorage does not exist during the static prerender.
  const [statsOn, setStatsOn] = useState(true);
  useEffect(() => { setStatsOn(!analyticsOptedOut()); }, []);
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
  // Flag a timestamp old enough that the flood colors on the map can't be
  // trusted, so "Updated Jul 17, 4:00 PM" a day later doesn't read as routine.
  const updatedAge = dataAgeMs(updatedAt);
  const updatedStale = updatedAge !== null && updatedAge > STALE_DATA_MS;

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
        maxWidth: `calc(100vw - ${EDGE_LEFT} - ${EDGE_RIGHT})`,
        maxHeight,
        overflowY: 'auto',
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
          {oldReadings !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              {/* The map's old-reading dot: faded fill, dashed ring (OLD_READING_STYLE). */}
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden style={{ flexShrink: 0 }}>
                <circle
                  cx="7" cy="7" r="5.5" fill="#94a3b8" fillOpacity={OLD_READING_STYLE.fillOpacity}
                  stroke="#e5e7eb" strokeWidth="1.5" strokeDasharray={OLD_READING_STYLE.dashArray}
                />
              </svg>
              <span style={{ flex: 1 }}>Faded, dashed: reading over {STALE_DATA_MS / 60_000} min old</span>
              <span style={{ color: oldReadings ? '#fbbf24' : '#9ca3af', minWidth: 24, textAlign: 'right' }}>{oldReadings}</span>
            </div>
          )}
          {/* No colour may read as "safe": a gauge measures one spot, flash floods hit creeks
              with no gauge, NWS publishes no flood stages for a third of Texas gauges, and
              others simply have no recent reading. */}
          <div style={{ color: '#9ca3af', fontSize: 11, lineHeight: 1.35, maxWidth: 190 }}>
            Even &ldquo;Normal&rdquo; is not an all-clear: flooding can happen where there is no
            gauge. Gray and tan: no recent reading, or NWS defines no flood stages to compare against
          </div>
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
            <span style={updatedStale ? { color: '#fbbf24', fontWeight: 600 } : undefined}>
              {updatedStale ? '⚠ ' : ''}Updated {updatedLabel}
            </span>
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
          {(alertsLayer || webcams) && (
            <LegendLayers
              summary={[
                alertsLayer && `warnings ${alertsLayer.enabled ? 'on' : 'off'}`,
                webcams && `cameras ${webcams.enabled ? 'on' : 'off'}`,
              ].filter(Boolean).join(', ')}
            >
              {alertsLayer && <AlertsLegendLayer {...alertsLayer} />}
              {webcams && <WebcamsLegendLayer {...webcams} />}
            </LegendLayers>
          )}
          {AdminControls && <AdminControls onRefreshed={onForceRefreshed} gaugeNames={gaugeNames} />}
          <label style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, color: '#9ca3af', fontSize: 11, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={statsOn}
              onChange={e => { setStatsOn(e.target.checked); setAnalyticsOptOut(!e.target.checked); }}
              style={{ margin: 0 }}
            />
            Share anonymous usage stats
          </label>
          <div style={{ marginTop: 2, color: '#6b7280', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" onClick={onExternalLinkClick} style={footerLink}>
              Privacy
            </a>
            <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" onClick={onExternalLinkClick} style={footerLink}>
              Support
            </a>
            <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" onClick={onExternalLinkClick} style={footerLink}>
              Terms
            </a>
            {process.env.NEXT_PUBLIC_APP_VERSION && <span>v{process.env.NEXT_PUBLIC_APP_VERSION}</span>}
          </div>
          <style>{`@keyframes tfm-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
        </div>
      )}
    </div>
  );
}
