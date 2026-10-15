'use client';

import { CATEGORY_COLORS, CATEGORY_LABELS } from '@/lib/floodStatus';
import type { Thresholds } from '@/lib/floodStatus';
import type { DetailPoint } from '@/lib/gaugeDetail';
import { CHART, layoutHydrograph } from '@/lib/hydrographLayout';
import { formatWhen } from '@/lib/timeFormat';

interface Props {
  observed: DetailPoint[];
  forecast: DetailPoint[];
  thresholds: Thresholds | null | undefined;
  unit: string | null;
  nowMs: number;
}

const OBSERVED = '#60a5fa';
const FORECAST = '#c4b5fd';
const GRID = '#1f2937';
// The category colours are tuned for map dots; the darkest ones (Major #7f1d1d)
// vanish against the dark chart, so lines and labels use lighter tints of the
// same hues. Each line is also named in words.
const LINE: Record<'action' | 'minor' | 'moderate' | 'major', string> = {
  action: CATEGORY_COLORS.action, minor: CATEGORY_COLORS.minor, moderate: '#ef4444', major: '#f87171',
};

// The same words the SVG shows, for screen readers and as a visible caption.
function summarize(observed: DetailPoint[], forecast: DetailPoint[], unit: string, nowMs: number): string {
  const parts: string[] = [];
  if (observed.length > 0) {
    const first = observed[0];
    const last = observed[observed.length - 1];
    parts.push(`Observed stage ${first.v} ${unit} at the start of the chart and ${last.v} ${unit} at ${formatWhen(last.t)}.`);
  }
  const ahead = forecast.filter(p => p.t >= nowMs);
  if (ahead.length > 0) {
    const crest = ahead.reduce((a, b) => (b.v > a.v ? b : a));
    parts.push(`NWS forecast crest ${crest.v} ${unit} at ${formatWhen(crest.t)}.`);
  }
  return parts.join(' ');
}

// Compact stage hydrograph: observed (solid) and NWS forecast (dashed) with the
// gauge's flood stages as horizontal lines. Inline SVG, no chart library.
export default function GaugeHydrograph({ observed, forecast, thresholds, unit, nowMs }: Props) {
  const layout = layoutHydrograph({ observed, forecast, thresholds, nowMs });
  if (!layout) return null;
  const u = unit ?? 'ft';
  const summary = summarize(observed, forecast, u, nowMs);
  const plotRight = CHART.w - CHART.right;
  const plotBottom = CHART.h - CHART.bottom;
  // Flood-stage labels sit at the right edge; skip one that would overprint the
  // label above it (stages a foot apart on a tall scale).
  let lastLabelY = -Infinity;
  const labelled = [...layout.lines].sort((a, b) => a.y - b.y).map(l => {
    const show = l.y - lastLabelY >= 11;
    if (show) lastLabelY = l.y;
    return { ...l, show };
  });
  const dayFmt = (t: number) =>
    new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric' });

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${CHART.w} ${CHART.h}`}
        role="img"
        aria-label={`Stage hydrograph. ${summary}`}
        style={{ display: 'block', width: '100%', height: 'auto', background: '#0b1220', borderRadius: 8 }}
      >
        {layout.yTicks.map(t => (
          <g key={t.y}>
            <line x1={CHART.left} x2={plotRight} y1={t.y} y2={t.y} stroke={GRID} strokeWidth={1} />
            <text x={CHART.left - 4} y={t.y + 3} fontSize={9} fill="#9ca3af" textAnchor="end">
              {t.v}
            </text>
          </g>
        ))}
        {layout.xTicks.map((t, i) => (
          <text
            key={t.x}
            x={t.x}
            y={plotBottom + 14}
            fontSize={9}
            fill="#9ca3af"
            textAnchor={i === 0 ? 'start' : i === layout.xTicks.length - 1 ? 'end' : 'middle'}
          >
            {dayFmt(t.t)}
          </text>
        ))}
        {labelled.map(l => (
          <g key={l.key}>
            <line
              x1={CHART.left} x2={plotRight} y1={l.y} y2={l.y}
              stroke={LINE[l.key]} strokeWidth={1} strokeDasharray="2 3"
            />
            {l.show && (
              <text x={plotRight - 2} y={l.y - 2} fontSize={8.5} fill={LINE[l.key]} textAnchor="end">
                {CATEGORY_LABELS[l.key]} {l.stage}
              </text>
            )}
          </g>
        ))}
        {layout.nowX !== null && (
          <g>
            <line x1={layout.nowX} x2={layout.nowX} y1={CHART.top} y2={plotBottom} stroke="#6b7280" strokeWidth={1} strokeDasharray="1 3" />
            <text x={layout.nowX + 3} y={CHART.top + 8} fontSize={8.5} fill="#9ca3af">now</text>
          </g>
        )}
        {layout.observedPath && (
          <path d={layout.observedPath} fill="none" stroke={OBSERVED} strokeWidth={1.8} strokeLinejoin="round" />
        )}
        {layout.forecastPath && (
          <path d={layout.forecastPath} fill="none" stroke={FORECAST} strokeWidth={1.8} strokeDasharray="5 3" strokeLinejoin="round" />
        )}
      </svg>
      <figcaption style={{ marginTop: 6, fontSize: 11, color: '#9ca3af', lineHeight: 1.45 }}>
        <span style={{ color: OBSERVED }}>━</span> Observed ({u})
        {layout.forecastPath && <> &nbsp;<span style={{ color: FORECAST }}>╍</span> NWS forecast</>}
        {layout.lines.length > 0 && <> &nbsp;┄ Flood stages</>}
        <div style={{ marginTop: 2 }}>{summary}</div>
      </figcaption>
    </figure>
  );
}
