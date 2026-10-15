'use client';

import { useEffect, useRef, useState } from 'react';
import { useFavorites } from '@/hooks/useFavorites';
import { COLORS } from './gaugeListTheme';

interface Props {
  id: string;
  name: string;
}

// Star toggle for one gauge: a 44 px target (Apple's minimum) used in the gauge sheet header
// and in every list row, so both show and change the same saved list. At the 50-gauge limit
// the press is refused and a short notice appears under the button (a silent no-op would
// look like a broken button).
export default function FavoriteStar({ id, name }: Props) {
  const { isFavorite, toggle, limit } = useFavorites();
  const [limited, setLimited] = useState(false);
  const timer = useRef<number | null>(null);
  const on = isFavorite(id);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  function press() {
    if (toggle(id) === 'limit') {
      setLimited(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setLimited(false), 4000);
    }
  }

  return (
    <span style={{ position: 'relative', flexShrink: 0, margin: '-8px 0' }}>
      <button
        type="button"
        onClick={press}
        aria-pressed={on}
        aria-label={on ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        title={on ? 'Remove from favorites' : 'Add to favorites'}
        style={{
          width: 44, height: 44, padding: 0, display: 'grid', placeItems: 'center',
          background: 'transparent', border: 'none', cursor: 'pointer',
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden focusable="false">
          <path
            d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z"
            fill={on ? COLORS.star : 'none'}
            stroke={on ? COLORS.star : COLORS.starOff}
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {limited && (
        <span
          role="status"
          style={{
            position: 'absolute', right: 0, top: '100%', zIndex: 5, width: 190,
            background: COLORS.noticeBg, color: COLORS.noticeText, fontSize: 12, lineHeight: 1.4,
            padding: '6px 8px', borderRadius: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
          }}
        >
          You can star up to {limit} gauges. Remove one to add another.
        </span>
      )}
    </span>
  );
}
