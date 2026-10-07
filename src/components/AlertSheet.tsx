'use client';

import { useState } from 'react';
import type { NwsAlert } from '@/lib/types';
import { alertLevel } from '@/lib/alerts-fetch';
import { ALERT_STYLE } from '@/lib/alertStyle';
import { reflowNwsText, relativeTime, updatedText } from '@/lib/alerts-view';
import { onExternalLinkClick } from '@/lib/externalLink';

interface Props {
  // Every alert at the tapped point, strongest first.
  alerts: NwsAlert[];
  // ms since the server last read the NWS, null when unknown.
  ageMs: number | null;
  stale: boolean;
  onClose: () => void;
}

export const ALERT_SOURCE_NOTE =
  'Source: National Weather Service (api.weather.gov), shown as received. Unofficial: this app is not affiliated with or endorsed by NOAA or the NWS, and is not a substitute for weather.gov, the NWS or local officials.';

const fmtTime = (iso: string | null): string | null =>
  iso
    ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;

// Bottom sheet for one NWS flood warning or watch, in the GaugeSheet pattern.
export default function AlertSheet({ alerts, ageMs, stale, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const alert = alerts[Math.min(index, alerts.length - 1)];
  const level = alertLevel(alert);
  const style = ALERT_STYLE[level];
  const now = Date.now();
  const until = alert.ends ?? alert.expires;
  const text = reflowNwsText(alert.description);
  const instruction = alert.instruction ? reflowNwsText(alert.instruction) : null;

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1200 }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label={`NWS flood warning or watch: ${alert.event}`}
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

        {alerts.length > 1 && (
          <div role="tablist" aria-label="Warnings and watches at this spot" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {alerts.map((a, i) => (
              <button
                key={a.id}
                role="tab"
                aria-selected={i === index}
                onClick={() => setIndex(i)}
                style={{
                  minHeight: 44,
                  padding: '0 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  cursor: 'pointer',
                  color: '#e5e7eb',
                  background: i === index ? '#1f2937' : 'transparent',
                  border: `1px solid ${i === index ? ALERT_STYLE[alertLevel(a)].color : '#374151'}`,
                }}
              >
                {a.event}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'start', gap: 12, marginBottom: 12 }}>
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 18,
              height: 12,
              borderRadius: 3,
              marginTop: 6,
              flexShrink: 0,
              border: `${Math.min(style.weight, 3)}px ${style.dashArray ? 'dashed' : 'solid'} ${style.color}`,
              background: `${style.color}55`,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.25 }}>{alert.event}</h2>
            <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>
              {level === 'emergency' && <strong style={{ color: '#fda4af' }}>Flash flood emergency · </strong>}
              Issued by {alert.senderName}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: '#9ca3af', fontSize: 22, lineHeight: 1, cursor: 'pointer', minWidth: 44, minHeight: 44 }}
          >
            ×
          </button>
        </div>

        {alert.headline && <p style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{alert.headline}</p>}

        <div style={{ background: '#1f2937', borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 13, lineHeight: 1.5 }}>
          <Fact label="Areas" value={alert.areaDesc || 'Not listed'} />
          <Fact label="Issued" value={fmtTime(alert.sent)} rel={relativeTime(alert.sent, now)} />
          <Fact label={alert.ends ? 'Ends' : 'Expires'} value={fmtTime(until)} rel={relativeTime(until, now)} />
          {alert.damageThreat && <Fact label="Damage threat" value={alert.damageThreat.charAt(0) + alert.damageThreat.slice(1).toLowerCase()} />}
        </div>

        {alert.geometrySource === 'zones' && (
          <Note>The outline shows every NWS forecast zone named in this warning or watch, not the exact spot at risk.</Note>
        )}
        {alert.geometrySource === 'none' && <Note>No outline is available for this warning or watch. The areas it covers are listed above.</Note>}

        {instruction && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>Instructions from the NWS</div>
            <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-line' }}>{instruction}</div>
          </div>
        )}

        {text && (
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: '#9ca3af', minHeight: 32 }}>Full NWS text</summary>
            <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-line', marginTop: 6 }}>{text}</div>
          </details>
        )}

        <div
          style={
            stale
              ? { padding: '6px 8px', borderRadius: 6, background: '#78350f55', border: '1px solid #b4530988', color: '#fbbf24', fontSize: 12, lineHeight: 1.4, marginBottom: 8 }
              : { color: '#9ca3af', fontSize: 12, marginBottom: 8 }
          }
        >
          {stale && '⚠ Warnings may be out of date. '}
          {ageMs !== null ? updatedText(ageMs) : 'Update time unknown'}. This warning or watch may have changed or ended since; check weather.gov.
        </div>
        <div style={{ color: '#9ca3af', fontSize: 11, lineHeight: 1.45 }}>{ALERT_SOURCE_NOTE}</div>
        <a
          href={alert.web}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onExternalLinkClick}
          style={{ display: 'inline-block', marginTop: 12, padding: '10px 0', color: '#60a5fa', fontSize: 14, textDecoration: 'none' }}
        >
          Open on weather.gov →
        </a>
      </div>
    </>
  );
}

function Fact({ label, value, rel }: { label: string; value: string | null; rel?: string | null }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', gap: 10, padding: '2px 0' }}>
      <span style={{ color: '#9ca3af', width: 88, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {value}
        {rel && <span style={{ color: '#9ca3af' }}> · {rel}</span>}
      </span>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.4, marginBottom: 12 }}>{children}</div>;
}
