// Tiny client-side beacon for self-hosted analytics. Fire-and-forget POST to
// /api/track. Uses sendBeacon when available (survives page unload) and falls
// back to fetch with keepalive. Never throws and never blocks the UI.

import { apiUrl, IS_MOBILE } from '@/lib/api';

type TrackBody =
  | { type: 'pageview'; platform?: AppPlatform }
  | { type: 'gauge_open'; gaugeId: string; platform?: AppPlatform };

// Set only by the store apps so the admin analytics can split app users from
// web visitors (the server files it under referrer as `app:ios` / `app:android`).
// iOS serves the bundle from capacitor://localhost, Android from https://localhost.
type AppPlatform = 'ios' | 'android';
function appPlatform(): AppPlatform | undefined {
  if (!IS_MOBILE) return undefined;
  return window.location.protocol === 'capacitor:' ? 'ios' : 'android';
}

export function track(body: TrackBody): void {
  if (typeof window === 'undefined') return;
  try {
    const platform = appPlatform();
    const json = JSON.stringify(platform ? { ...body, platform } : body);
    // text/plain rather than application/json: the route parses the body as
    // JSON regardless of Content-Type, and text/plain keeps this a CORS
    // "simple request" — no OPTIONS preflight, which sendBeacon can't do and
    // which would otherwise silently drop every beacon from the mobile apps
    // (whose web view is a different origin from the API).
    const blob = new Blob([json], { type: 'text/plain' });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(apiUrl('/api/track'), blob);
      return;
    }
    void fetch(apiUrl('/api/track'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: json,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // analytics must never break the app
  }
}
