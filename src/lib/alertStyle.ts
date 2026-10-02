import type { AlertLevel } from './types';

// How each alert level is drawn and keyed in the Legend. Strongest first.
//
// The hues are chosen to be unlike every gauge colour (blue, yellow, orange, red,
// dark red, gray) and the violet "you are here" dot, and never green (green reads
// as "safe"). Colour is not the only cue: the stronger the alert, the heavier the
// outline and the fill, and watches and advisories are dashed, so the levels stay
// apart for colour-blind viewers too. tests/alerts-style.test.mjs checks the
// contrast against the basemap and the colour-blind separation numerically.
export interface AlertStyle {
  label: string;
  color: string;
  weight: number;
  fillOpacity: number;
  dashArray: string | null;
}

export const ALERT_LEVELS: AlertLevel[] = ['emergency', 'flash', 'warning', 'watch', 'advisory'];

export const ALERT_STYLE: Record<AlertLevel, AlertStyle> = {
  emergency: { label: 'Flash flood emergency', color: '#500724', weight: 4.5, fillOpacity: 0.4, dashArray: null },
  flash: { label: 'Flash flood warning', color: '#be185d', weight: 3, fillOpacity: 0.28, dashArray: null },
  warning: { label: 'Flood warning', color: '#6d28d9', weight: 2.5, fillOpacity: 0.2, dashArray: null },
  watch: { label: 'Flood watch', color: '#115e59', weight: 2, fillOpacity: 0.1, dashArray: '8 6' },
  advisory: { label: 'Flood advisory', color: '#0f6b86', weight: 1.5, fillOpacity: 0.12, dashArray: '2 5' },
};
