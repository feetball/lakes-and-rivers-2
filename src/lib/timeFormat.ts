import { formatAge } from './floodStatus';

/** "Sat, Oct 3, 1:00 AM CDT": always with the zone, since the sheet mixes NWS and local times. */
export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

/** "in 17 hours" / "3 hours ago" / "just now" (under a minute either way). */
export function relativeTime(ms: number, nowMs: number): string {
  const delta = ms - nowMs;
  if (Math.abs(delta) < 60_000) return 'just now';
  return delta > 0 ? `in ${formatAge(delta)}` : `${formatAge(-delta)} ago`;
}

/** "Oct 3, 2025" from a YYYY-MM-DD calendar date, never shifted by the viewer's time zone. */
export function formatCalendarDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString([], {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}
