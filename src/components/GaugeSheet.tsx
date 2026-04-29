'use client';

import { CATEGORY_COLORS, CATEGORY_LABELS } from '@/lib/floodStatus';
import type { GaugeStatus } from '@/lib/types';

interface Props {
  gauge: GaugeStatus;
  onClose: () => void;
}

export default function GaugeSheet({ gauge, onClose }: Props) {
  const color = CATEGORY_COLORS[gauge.category];
  const observedAt = gauge.observedAt
    ? new Date(gauge.observedAt).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : null;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1200,
        }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label={`Gauge detail: ${gauge.name}`}
        style={{
          position: 'absolute',
          left: 0, right: 0,
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
        <div style={{ display: 'flex', alignItems: 'start', gap: 12, marginBottom: 12 }}>
          <span
            style={{
              display: 'inline-block', width: 14, height: 14, borderRadius: 7,
              background: color, marginTop: 6, flexShrink: 0,
              boxShadow: `0 0 0 3px ${color}33`,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.25 }}>{gauge.name}</h2>
            <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>Site ID: {gauge.id}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none', color: '#9ca3af',
              fontSize: 22, lineHeight: 1, cursor: 'pointer', padding: 4,
            }}
          >×</button>
        </div>

        <div
          style={{
            background: `${color}22`,
            border: `1px solid ${color}55`,
            borderRadius: 10,
            padding: '10px 12px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 12, color: '#9ca3af' }}>Status</div>
          <div style={{ fontSize: 16, fontWeight: 600, color }}>{CATEGORY_LABELS[gauge.category]}</div>
          {gauge.observedStage !== null && (
            <div style={{ fontSize: 14, marginTop: 4 }}>
              Observed: <strong>{gauge.observedStage} {gauge.unit ?? ''}</strong>
              {observedAt && <span style={{ color: '#9ca3af', marginLeft: 6 }}>· {observedAt}</span>}
            </div>
          )}
        </div>

        {gauge.thresholds && (
          <div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Flood stage thresholds</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
              {(['action', 'minor', 'moderate', 'major'] as const).map(k => {
                const val = gauge.thresholds?.[k];
                return (
                  <div
                    key={k}
                    style={{
                      display: 'flex', justifyContent: 'space-between',
                      background: '#1f2937', padding: '6px 10px', borderRadius: 6, fontSize: 13,
                    }}
                  >
                    <span style={{ color: CATEGORY_COLORS[k] }}>{CATEGORY_LABELS[k]}</span>
                    <span>{val !== null && val !== undefined ? `${val} ${gauge.unit ?? ''}` : '—'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Hydrograph</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://water.noaa.gov/resources/hydrographs/${gauge.id.toLowerCase()}_hg.png`}
            alt={`${gauge.name} hydrograph`}
            style={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: '40dvh',
              width: 'auto',
              height: 'auto',
              margin: '0 auto',
              borderRadius: 6,
              background: '#0b1220',
            }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <a
          href={`https://water.noaa.gov/gauges/${gauge.id}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block', marginTop: 14,
            color: '#60a5fa', fontSize: 13, textDecoration: 'none',
          }}
        >
          Full hydrograph on water.noaa.gov →
        </a>
      </div>
    </>
  );
}
