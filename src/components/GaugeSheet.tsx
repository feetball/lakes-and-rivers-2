'use client';

import { useEffect, useState } from 'react';
import { CATEGORY_COLORS, CATEGORY_LABELS, STALE_DATA_MS, dataAgeMs, formatAge, hasValidThresholds } from '@/lib/floodStatus';
import type { GaugeStatus } from '@/lib/types';
import { apiUrl } from '@/lib/api';
import GaugeDetailSections from './GaugeDetailSections';
import GaugeShareButton from './GaugeShareButton';
import FavoriteStar from './FavoriteStar';

interface Props {
  gauge: GaugeStatus;
  onClose: () => void;
  /** A USGS river camera at this gauge's site, when the app knows of one that is online. */
  webcam?: { name: string; onOpen: () => void };
}

interface FloodRecord {
  date: string;
  stage: number;
  isRecord: boolean;
}

interface GaugeRecordsResponse {
  siteNo: string | null;
  records: FloodRecord[];
  updatedAt: string;
}

// USGS peak dates are calendar dates with no time-of-day meaning; parsing the
// raw string directly with `new Date()` treats it as UTC midnight, which can
// display as the previous day once formatted in a US timezone. Build the Date
// from local year/month/day parts instead so formatting never shifts a day.
function formatPeakDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString([], {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const [year, month] = raw.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString([], {
      year: 'numeric', month: 'short',
    });
  }
  if (/^\d{4}$/.test(raw)) {
    return raw;
  }
  return raw;
}

export default function GaugeSheet({ gauge, onClose, webcam }: Props) {
  const color = CATEGORY_COLORS[gauge.category];
  const observedAt = gauge.observedAt
    ? new Date(gauge.observedAt).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : null;
  // A stale observation must not masquerade as a confident current status —
  // e.g. a day-old "Normal" on a lake that has since risen past Action stage.
  const obsAge = dataAgeMs(gauge.observedAt);
  const obsStale = obsAge !== null && obsAge > STALE_DATA_MS;

  // Gray means "no category", and the reason differs: say which, so a reading
  // without flood stages never reads as a status. An all-empty thresholds object
  // is NWS's "none defined"; null thresholds only mean we do not have them (a
  // gauge newer than the build-time list), which proves nothing either way.
  const noFloodStages = !!gauge.thresholds && !hasValidThresholds(gauge.thresholds);
  const noStagesGray = noFloodStages && gauge.category === 'not_defined';
  const statusLabel = noStagesGray && gauge.observedStage !== null
    ? 'No flood stages defined'
    : CATEGORY_LABELS[gauge.category];

  const [records, setRecords] = useState<FloodRecord[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setRecords([]);

    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/gauges/${encodeURIComponent(gauge.id)}/records`), {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data: GaugeRecordsResponse = await res.json();
        setRecords(data.records ?? []);
      } catch {
        // Fail silently, same graceful-degradation approach as the hydrograph image.
      }
    })();

    return () => controller.abort();
  }, [gauge.id]);

  const record = records.find(r => r.isRecord);

  const recordRow = record && (
    <div
      style={{
        display: 'flex', justifyContent: 'space-between',
        background: '#1f2937', padding: '6px 10px', borderRadius: 6, fontSize: 13,
        borderLeft: `3px solid ${CATEGORY_COLORS.major}`,
        gridColumn: '1 / -1',
      }}
    >
      <span>
        <span style={{ color: CATEGORY_COLORS.major, marginRight: 6, fontSize: 11 }}>
          Record
        </span>
        {formatPeakDate(record.date)}
      </span>
      <span>{record.stage} ft</span>
    </div>
  
  );

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
          <FavoriteStar id={gauge.id} name={gauge.name} />
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
          <div style={{ fontSize: 16, fontWeight: 600, color }}>{statusLabel}</div>
          {gauge.observedStage !== null && (
            <div style={{ fontSize: 14, marginTop: 4 }}>
              Observed: <strong>{gauge.observedStage} {gauge.unit ?? ''}</strong>
              {observedAt && <span style={{ color: '#9ca3af', marginLeft: 6 }}>· {observedAt}</span>}
            </div>
          )}
          {obsStale && obsAge !== null && (
            <div
              style={{
                marginTop: 8, padding: '6px 8px', borderRadius: 6,
                background: '#78350f55', border: '1px solid #b4530988',
                color: '#fbbf24', fontSize: 12, lineHeight: 1.4,
              }}
            >
              ⚠ This reading is {formatAge(obsAge)} old — the status above may not
              reflect current conditions. Check the live hydrograph below.
            </div>
          )}
        </div>

        {webcam && (
          <button
            onClick={webcam.onOpen}
            style={{
              width: '100%', minHeight: 44, textAlign: 'left', marginBottom: 14,
              background: '#1f2937', border: '1px solid #374151', borderRadius: 8,
              color: '#e5e7eb', fontSize: 14, padding: '8px 12px', cursor: 'pointer',
            }}
          >
            📷 River camera at this site: {webcam.name} →
          </button>
        )}

        {noStagesGray && (
          <div
            style={{
              background: '#1f2937', borderRadius: 8, padding: '8px 10px', fontSize: 13, lineHeight: 1.45,
            }}
          >
            NWS has not defined flood stages for this gauge, so it has no flood category and is shown gray.
            A reading here does not mean conditions are normal.
          </div>
        )}
        {noFloodStages && recordRow && <div style={{ marginTop: 8 }}>{recordRow}</div>}

        {!noFloodStages && gauge.thresholds && (
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
              {recordRow}
            </div>
          </div>
        )}

        <GaugeDetailSections gauge={gauge} />

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
        <GaugeShareButton gauge={gauge} />
      </div>
    </>
  );
}
