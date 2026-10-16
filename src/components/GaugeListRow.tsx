'use client';

import { CATEGORY_COLORS, OLD_READING_STYLE } from '@/lib/floodStatus';
import { describeItem, type GaugeListItem } from '@/lib/gaugeList';
import { useFavorites } from '@/hooks/useFavorites';
import FavoriteStar from './FavoriteStar';
import { COLORS } from './gaugeListTheme';

interface Props {
  item: GaugeListItem;
  /** The data is a timeline snapshot, not live: no "ago" and no stale flag. */
  snapshot: boolean;
  onPick: (item: GaugeListItem) => void;
}

// One gauge in the list: status dot, name, "12.3 ft · Minor flood · 5 minutes ago", distance
// when known, and the star. The row button and the star are siblings (a button must not
// contain a button), so a screen reader gets two stops per row: open it, or star it.
export default function GaugeListRow({ item, snapshot, onPick }: Props) {
  const { isFavorite } = useFavorites();
  const text = describeItem(item, { snapshot, favorite: isFavorite(item.gauge.id) });
  return (
    <li style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${COLORS.raised}` }}>
      <button
        type="button"
        onClick={() => onPick(item)}
        aria-label={text.ariaLabel}
        style={{
          flex: 1, minWidth: 0, minHeight: 56, display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 4px 8px 2px', background: 'transparent', border: 'none',
          color: COLORS.text, textAlign: 'left', cursor: 'pointer', font: 'inherit',
        }}
      >
        {item.stale && !snapshot ? (
          // The map's look for an old reading: faded, with a dashed ring.
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden style={{ flexShrink: 0 }}>
            <circle
              cx="8" cy="8" r="7" fill={CATEGORY_COLORS[item.category]} fillOpacity={OLD_READING_STYLE.fillOpacity}
              stroke={COLORS.dotRing} strokeWidth="2" strokeDasharray={OLD_READING_STYLE.dashArray}
            />
          </svg>
        ) : (
          <span
            aria-hidden
            style={{
              width: 16, height: 16, borderRadius: 8, flexShrink: 0, boxSizing: 'border-box',
              background: CATEGORY_COLORS[item.category], border: `2px solid ${COLORS.dotRing}`,
            }}
          />
        )}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 600, lineHeight: 1.25 }}>{item.gauge.name}</span>
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
      <FavoriteStar id={item.gauge.id} name={item.gauge.name} />
    </li>
  );
}
