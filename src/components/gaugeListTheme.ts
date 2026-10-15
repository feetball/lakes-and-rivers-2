// Colors of the gauge list sheet (the GaugeSheet's dark palette plus a few accents), kept
// in one place so the contrast of every pair can be checked: tests/gaugeList.test.mjs
// asserts each TEXT_ON pair is at least 4.5:1 and each GRAPHICS_ON pair at least 3:1 (WCAG AA).
// Add a color here and a pair below, not an inline hex, so the test covers it.

export const COLORS = {
  panel: '#111827',
  raised: '#1f2937',
  field: '#0b1220',
  border: '#374151',
  text: '#e5e7eb',
  muted: '#9ca3af',
  link: '#60a5fa',
  warn: '#fbbf24',
  danger: '#fca5a5',
  accent: '#2563eb',
  onAccent: '#ffffff',
  noticeBg: '#78350f',
  noticeText: '#fde68a',
  infoBg: '#1e3a8a',
  infoText: '#dbeafe',
  star: '#facc15',
  starOff: '#9ca3af',
  controlBorder: '#6b7280',
  dotRing: '#e5e7eb',
} as const;

export type ColorName = keyof typeof COLORS;

/** [text color, background it is drawn on]. Every text color used by the sheet appears here. */
export const TEXT_ON: ReadonlyArray<readonly [ColorName, ColorName]> = [
  ['text', 'panel'],
  ['muted', 'panel'],
  ['link', 'panel'],
  ['warn', 'panel'],
  ['danger', 'panel'],
  ['text', 'raised'],
  ['muted', 'raised'],
  ['text', 'field'],
  ['muted', 'field'],
  ['onAccent', 'accent'],
  ['noticeText', 'noticeBg'],
  ['infoText', 'infoBg'],
];

/** [icon or outline color, what it sits on]: the non-text parts that must stay visible (WCAG 1.4.11). */
export const GRAPHICS_ON: ReadonlyArray<readonly [ColorName, ColorName]> = [
  ['star', 'panel'],
  ['starOff', 'panel'],
  ['dotRing', 'panel'],
  ['controlBorder', 'field'],
  ['controlBorder', 'panel'],
];
