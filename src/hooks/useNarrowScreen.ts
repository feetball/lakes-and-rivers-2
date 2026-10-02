'use client';

import { useEffect, useState } from 'react';

// Below this width the timeline panel (up to 620 px, centered) and the legend
// (bottom-left) cover each other when both sit on the bottom edge, as they do by
// default: every phone, and a tablet in portrait. Used by MapView.
export const NARROW_SCREEN_PX = 1100;

// Bottom offset that puts the legend just above the timeline: the 12 px edge gap,
// the timeline's height (about 104 px) and an 8 px gap.
export const LEGEND_ABOVE_TIMELINE_PX = 12 + 104 + 8;

const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < NARROW_SCREEN_PX;

export function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const onResize = () => setNarrow(isNarrow());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}
