// Tiny client-side beacon for self-hosted analytics. Fire-and-forget POST to
// /api/track. Uses sendBeacon when available (survives page unload) and falls
// back to fetch with keepalive. Never throws and never blocks the UI.

type TrackBody = { type: 'pageview' } | { type: 'gauge_open'; gaugeId: string };

export function track(body: TrackBody): void {
  if (typeof window === 'undefined') return;
  try {
    const json = JSON.stringify(body);
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([json], { type: 'application/json' }));
      return;
    }
    void fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // analytics must never break the app
  }
}
