'use client';

import { useState } from 'react';
import { useGaugeDetail } from '@/hooks/useGaugeDetail';
import {
  CATEGORY_COLORS, CATEGORY_LABELS, STALE_DATA_MS, categorizeByStage, dataAgeMs, formatAge, hasValidThresholds,
} from '@/lib/floodStatus';
import { viewForecast } from '@/lib/forecastView';
import type { DetailCrest, DetailImpact, GaugeDetail } from '@/lib/gaugeDetail';
import { formatCalendarDate, formatWhen, relativeTime } from '@/lib/timeFormat';
import type { GaugeStatus } from '@/lib/types';
import GaugeHydrograph from './GaugeHydrograph';

const label = { fontSize: 12, color: '#9ca3af', marginBottom: 6 } as const;
const card = { background: '#1f2937', borderRadius: 8, padding: '8px 10px', fontSize: 13, lineHeight: 1.4 } as const;
const COLLAPSED_IMPACTS = 4;

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ color: '#9ca3af', fontSize: 12, width: 54, flexShrink: 0 }}>{name}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Forecast({ gauge, detail, failed, nowMs }: { gauge: GaugeStatus; detail?: GaugeDetail; failed: boolean; nowMs: number }) {
  const v = viewForecast(gauge, { data: detail, failed }, nowMs);
  switch (v.kind) {
    case 'loading':
      return <span style={{ color: '#9ca3af' }}>Loading…</span>;
    case 'none':
      return <span>No NWS forecast for this gauge.</span>;
    case 'unavailable':
      return <span style={{ color: '#fbbf24' }}>Forecast unavailable right now. That is not the same as no forecast: check water.noaa.gov.</span>;
    case 'expired':
      return (
        <span style={{ color: '#fbbf24' }}>
          The NWS forecast{v.issuedAt ? ` issued ${relativeTime(Date.parse(v.issuedAt), nowMs)}` : ''} has run out and may be
          out of date.
        </span>
      );
    case 'crest': {
      const color = CATEGORY_COLORS[v.category];
      const noStages = !hasValidThresholds(gauge.thresholds);
      return (
        <>
          <div>
            Crest <strong>{v.stage} {v.unit ?? ''}</strong>{' '}
            <span style={{ color, fontWeight: 600 }}>
              {noStages ? '(no flood stages to compare)' : `(${CATEGORY_LABELS[v.category]})`}
            </span>
          </div>
          <div>{formatWhen(v.t)} · {relativeTime(v.t, nowMs)}</div>
          <div style={{ color: v.stale ? '#fbbf24' : '#9ca3af', fontSize: 12 }}>
            {v.issuedAt
              ? `${v.stale ? '⚠ ' : ''}NWS forecast issued ${relativeTime(Date.parse(v.issuedAt), nowMs)}${v.stale ? ': may be out of date' : ''}`
              : 'NWS forecast (issue time not loaded)'}
          </div>
        </>
      );
    }
  }
}

function Trend({ detail, failed }: { detail?: GaugeDetail; failed: boolean }) {
  if (!detail) {
    return <span style={{ color: failed ? '#fbbf24' : '#9ca3af' }}>{failed ? 'Trend unavailable right now.' : 'Loading…'}</span>;
  }
  if (!detail.trend || detail.trendFtPerHour === null) {
    return <span>Trend unavailable: too few recent readings to tell.</span>;
  }
  const glyph = detail.trend === 'rising' ? '▲' : detail.trend === 'falling' ? '▼' : '▬';
  const rate = detail.trendFtPerHour;
  return (
    <span>
      {glyph} <strong style={{ textTransform: 'capitalize' }}>{detail.trend}</strong>
      {detail.trend !== 'steady' && <> at {Math.abs(rate).toFixed(2)} {detail.unit ?? 'ft'}/h</>}
      <span style={{ color: '#9ca3af', fontSize: 12 }}> · over the last 3 h of readings</span>
    </span>
  );
}

function Impacts({ impacts, gauge, detail, nowMs }: { impacts: DetailImpact[]; gauge: GaugeStatus; detail: GaugeDetail; nowMs: number }) {
  const [all, setAll] = useState(false);
  // A reading that is itself stale cannot say what the water is doing now.
  const age = dataAgeMs(gauge.observedAt);
  const current = gauge.observedStage !== null && age !== null && age <= STALE_DATA_MS ? gauge.observedStage : null;
  const view = viewForecast(gauge, { data: detail, failed: false }, nowMs);
  const crest = view.kind === 'crest' ? view.stage : null;
  const mark = (stage: number) => (current !== null && stage <= current ? 'now' : crest !== null && stage <= crest ? 'forecast' : null);
  const rows = impacts.map(i => ({ ...i, mark: mark(i.stage) }));
  const open = all || rows.length <= COLLAPSED_IMPACTS || rows.some(r => r.mark !== null);
  const shown = open ? rows : rows.slice(0, COLLAPSED_IMPACTS);
  return (
    <div style={{ marginTop: 14 }}>
      <div style={label}>Impacts at each stage <span style={{ color: '#6b7280' }}>· NWS impact statements</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shown.map(r => {
          const cat = gauge.thresholds ? categorizeByStage(r.stage, gauge.thresholds) : 'not_defined';
          return (
            <div
              key={`${r.stage}-${r.statement.slice(0, 24)}`}
              style={{ ...card, borderLeft: `3px solid ${CATEGORY_COLORS[cat]}`, background: r.mark ? '#374151' : '#1f2937' }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong>{r.stage} {detail.unit ?? gauge.unit ?? ''}</strong>
                {r.mark === 'now' && <span style={{ fontSize: 11, color: '#fbbf24' }}>at or below the current stage</span>}
                {r.mark === 'forecast' && <span style={{ fontSize: 11, color: '#c4b5fd' }}>at or below the forecast crest</span>}
              </div>
              <div style={{ color: '#d1d5db' }}>{r.statement}</div>
            </div>
          );
        })}
      </div>
      {!open && (
        <button onClick={() => setAll(true)} style={linkButton}>Show all {rows.length} stages</button>
      )}
    </div>
  );
}

const linkButton = {
  marginTop: 6, minHeight: 44, background: 'none', border: 'none', color: '#60a5fa',
  fontSize: 13, cursor: 'pointer', padding: '0 4px',
} as const;

function CrestList({ title, crests, unit }: { title: string; crests: DetailCrest[]; unit: string }) {
  return (
    <div style={{ flex: '1 1 150px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>{title}</div>
      {crests.map(c => (
        <div key={`${c.date}-${c.stage}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '2px 0' }}>
          <span>{formatCalendarDate(c.date)}</span>
          <strong>{c.stage} {unit}</strong>
        </div>
      ))}
    </div>
  );
}

function PastCrests({ detail, unit }: { detail: GaugeDetail; unit: string }) {
  const { recent, historic } = detail.crests;
  if (recent.length === 0 && historic.length === 0) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={label}>Past crests <span style={{ color: '#6b7280' }}>· NWS record for this gauge</span></div>
      <div style={{ ...card, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {historic.length > 0 && <CrestList title="Highest on record" crests={historic} unit={unit} />}
        {recent.length > 0 && <CrestList title="Most recent" crests={recent} unit={unit} />}
      </div>
    </div>
  );
}

// Forecast, trend, hydrograph, impacts and past crests of the open gauge. The
// per-gauge detail loads separately (it is NWS data fetched through our API), so
// the rest of the sheet never waits on it and a failure only affects this part.
export default function GaugeDetailSections({ gauge }: { gauge: GaugeStatus }) {
  const { data, error, isLoading, mutate } = useGaugeDetail(gauge.id);
  const nowMs = Date.now();
  const failed = !!error && !data;
  const unit = data?.unit ?? gauge.unit ?? 'ft';
  const newest = data?.observedAt ? Date.parse(data.observedAt) : null;
  const readingAge = newest !== null ? nowMs - newest : null;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={label}>Outlook <span style={{ color: '#6b7280' }}>· NWS data via NWPS</span></div>
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Row name="Forecast"><Forecast gauge={gauge} detail={data} failed={failed} nowMs={nowMs} /></Row>
        <Row name="Trend"><Trend detail={data} failed={failed} /></Row>
      </div>

      {failed && (
        <div
          role="alert"
          style={{
            marginTop: 10, padding: '8px 10px', borderRadius: 6, background: '#78350f55',
            border: '1px solid #b4530988', color: '#fbbf24', fontSize: 12, lineHeight: 1.4,
          }}
        >
          <div>⚠ Couldn&apos;t load the forecast series, impacts and past crests right now. The status above is unaffected.</div>
          <button onClick={() => void mutate()} style={{ ...linkButton, color: '#fbbf24', textDecoration: 'underline', marginTop: 0, padding: 0 }}>
            Try again
          </button>
        </div>
      )}

      {isLoading && !data && (
        <div style={{ marginTop: 14, color: '#9ca3af', fontSize: 12 }}>Loading hydrograph, impacts and past crests…</div>
      )}

      {data && (
        <>
          <div style={{ marginTop: 14 }}>
            <div style={label}>Stage, last 48 hours and NWS forecast</div>
            {data.sources.observed && data.observed.length > 1 ? (
              <GaugeHydrograph
                observed={data.observed}
                forecast={data.forecast}
                thresholds={gauge.thresholds}
                unit={unit}
                nowMs={nowMs}
              />
            ) : (
              <div style={{ ...card, color: '#9ca3af' }}>
                {data.sources.observed
                  ? 'No readings in the last 48 hours.'
                  : 'The recent readings could not be loaded.'}
              </div>
            )}
            {readingAge !== null && readingAge > STALE_DATA_MS && (
              <div style={{ marginTop: 6, fontSize: 12, color: '#fbbf24' }}>
                ⚠ The newest reading is {formatAge(readingAge)} old.
              </div>
            )}
          </div>

          {data.impacts.length > 0 && <Impacts impacts={data.impacts} gauge={gauge} detail={data} nowMs={nowMs} />}
          {data.impacts.length === 0 && data.sources.record && (
            <div style={{ marginTop: 14, fontSize: 12, color: '#9ca3af' }}>NWS has published no impact statements for this gauge.</div>
          )}
          <PastCrests detail={data} unit={unit} />
          {!data.sources.record && (
            <div style={{ marginTop: 14, fontSize: 12, color: '#fbbf24' }}>
              ⚠ Impact statements and past crests could not be loaded.
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280', lineHeight: 1.4 }}>
            Forecast, impact statements and crests are National Weather Service data from water.noaa.gov, loaded
            {' '}{relativeTime(Date.parse(data.updatedAt), nowMs)}. This app is unofficial; for decisions follow
            {' '}weather.gov and local officials.
          </div>
        </>
      )}
    </div>
  );
}
