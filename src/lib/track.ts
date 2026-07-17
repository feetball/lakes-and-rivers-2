// Tiny client-side beacon for self-hosted analytics. Events are buffered in a
// module-level queue and flushed as a single batched POST to /api/track —
// each flush becomes exactly one Blob `put()` server-side, instead of one per
// event, since Blob bills put/list/delete as "Advanced Operations". Flushes
// on a timer, once the queue gets large, or when the page is hidden/unloaded
// so nothing is lost. Uses sendBeacon when available (survives page unload)
// and falls back to fetch with keepalive. Never throws and never blocks the UI.

type TrackBody = { type: 'pageview' } | { type: 'gauge_open'; gaugeId: string };

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 20;

let queue: TrackBody[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unloadListenersAttached = false;

function sendBatch(events: TrackBody[]): void {
  if (events.length === 0) return;
  try {
    const json = JSON.stringify({ events });
    if (navigator.sendBeacon) {
      const queued = navigator.sendBeacon('/api/track', new Blob([json], { type: 'application/json' }));
      if (queued) return;
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

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  sendBatch(events);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

// Flush on tab hide / unload so a short session's events aren't stranded in
// the queue past the flush timer.
function attachUnloadListeners(): void {
  if (unloadListenersAttached || typeof document === 'undefined') return;
  unloadListenersAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}

export function track(body: TrackBody): void {
  if (typeof window === 'undefined') return;
  try {
    attachUnloadListeners();
    queue.push(body);
    if (queue.length >= MAX_BATCH_SIZE) {
      flush();
    } else {
      scheduleFlush();
    }
  } catch {
    // analytics must never break the app
  }
}
