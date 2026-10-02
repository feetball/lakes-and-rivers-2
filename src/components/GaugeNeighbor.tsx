'use client';

import { CATEGORY_COLORS } from '@/lib/floodStatus';
import { describeItem, toListItem } from '@/lib/gaugeList';
import type { GaugeStatus } from '@/lib/types';
import { COLORS } from './gaugeListTheme';

interface Props {
  /** The nearest flood-staged gauge on the same river (src/lib/riverNeighbor.ts). */
  neighbor: GaugeStatus;
  /** The gauge whose sheet this is: the distance is measured from it. */
  from: { lat: number; lon: number };
  /** The data is a timeline snapshot, not live: no "ago" and no stale flag. */
  snapshot: boolean;
  onOpen: () => void;
}

// For a gauge NWS has no flood stages for: the nearest gauge on the same river that does have
// them, with its status in the list's own words ("12.3 ft · Minor flood · 5 minutes ago") and
// the distance. Tapping it opens that gauge. It is a neighbour's status, never this gauge's, and
// the line under it says so. Whether it is upstream or downstream is not known, so not said.
export default function GaugeNeighbor({ neighbor, from, snapshot, onOpen }: Props) {
  const item = toListItem(neighbor, Date.now(), from);
  const text = describeItem(item, { snapshot });
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>
        Nearest gauge with NWS flood stages on this river
      </div>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${text.ariaLabel}`}
        style={{
          width: '100%', minHeight: 56, display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 12px', background: COLORS.raised, border: `1px solid ${COLORS.border}`, borderRadius: 8,
          color: COLORS.text, textAlign: 'left', cursor: 'pointer', font: 'inherit',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 16, height: 16, borderRadius: 8, flexShrink: 0, boxSizing: 'border-box',
            background: CATEGORY_COLORS[item.category], border: `2px solid ${COLORS.dotRing}`,
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600, lineHeight: 1.25 }}>{neighbor.name}</span>
          <span style={{ display: 'block', fontSize: 13, lineHeight: 1.35, marginTop: 2, color: COLORS.muted }}>
            {text.segments.map((seg, i) => (
              <span key={i} style={seg.warn ? { color: COLORS.warn } : undefined}>
                {i > 0 ? ' · ' : ''}
                {seg.text}
              </span>
            ))}
          </span>
        </span>
        {text.distance && (
          <span style={{ fontSize: 13, color: COLORS.muted, flexShrink: 0, whiteSpace: 'nowrap' }}>{text.distance}</span>
        )}
      </button>
      <div style={{ marginTop: 6, fontSize: 12, color: COLORS.muted, lineHeight: 1.4 }}>
        Conditions differ along a river: that is its status, not this gauge&apos;s. The map colors this stretch of river by it.
      </div>
    </div>
  );
}
