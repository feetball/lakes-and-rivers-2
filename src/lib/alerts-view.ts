// Pure helpers behind the alert UI (hook, sheets, Legend): how fresh the data is, how to
// word a time, how to lay out NWS text. No React, no aliases: tests/alerts-view.test.mjs
// imports this directly.
import type { AlertsResponse } from './types';

// The server stamps `updatedAt` when it last READ the NWS. Past this the map says the
// warnings may be out of date (the poll is every 2 min, so this is five missed polls).
export const ALERTS_STALE_MS = 10 * 60_000;
// Past this a remembered copy is dropped: an old list drawn as current is worse than
// admitting there is nothing.
export const ALERTS_DROP_MS = 6 * 3_600_000;

export type AlertsState =
  // Nothing usable: never loaded, or the only copy is too old. Show "unavailable".
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  // `ageMs` is how old the newest read is; `stale` says to warn about it.
  | { kind: 'ready'; ageMs: number; stale: boolean };

/**
 * One verdict from what the hook holds. `data` is the newest response or last good copy,
 * `failed` whether the latest request errored. A response flagged `ok: false` came from
 * the server's own last good copy, so its age is judged the same way.
 */
export function alertsState(data: AlertsResponse | undefined, failed: boolean, nowMs: number): AlertsState {
  if (!data) return failed ? { kind: 'unavailable' } : { kind: 'loading' };
  const t = data.updatedAt ? Date.parse(data.updatedAt) : NaN;
  if (!Number.isFinite(t)) return { kind: 'unavailable' };
  const ageMs = Math.max(0, nowMs - t);
  if (ageMs > ALERTS_DROP_MS) return { kind: 'unavailable' };
  return { kind: 'ready', ageMs, stale: ageMs > ALERTS_STALE_MS };
}

/** A usable response shape (read back from localStorage or the network). */
export function isAlertsResponse(v: unknown): v is AlertsResponse {
  const d = v as AlertsResponse | null | undefined;
  return (
    !!d &&
    typeof d === 'object' &&
    Array.isArray(d.alerts) &&
    (d.updatedAt === null || typeof d.updatedAt === 'string') &&
    typeof d.ok === 'boolean' &&
    d.alerts.every(a => !!a && typeof a.id === 'string' && typeof a.event === 'string' && Array.isArray(a.ugc))
  );
}

/** "5 min ago", "in 2 h 10 min", "just now". `iso` null gives null. */
export function relativeTime(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diff = t - nowMs;
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (mins < 1) return 'just now';
  const h = Math.floor(mins / 60);
  const span = mins < 60 ? `${mins} min` : mins < 24 * 60 ? `${h} h${mins % 60 ? ` ${mins % 60} min` : ''}` : `${Math.round(mins / 1440)} d`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** "Updated 3 min ago" for the data's age. */
export function updatedText(ageMs: number): string {
  const mins = Math.round(ageMs / 60_000);
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `Updated ${h} h${mins % 60 ? ` ${mins % 60} min` : ''} ago`;
}

/**
 * NWS text is hard-wrapped at about 66 columns. Join the wrapped lines back into
 * paragraphs, but keep a line break before a bullet ("* WHAT...", "- ").
 */
export function reflowNwsText(text: string): string {
  return text
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map(p => p.replace(/\n(?!\s*[*\-•]\s)/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
