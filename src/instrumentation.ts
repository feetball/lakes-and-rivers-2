// Runs once per Node server start.
//   1. Warm /api/gauges by self-fetching so the first real user visit gets
//      live data, not the cold-start fallback.
//   2. On long-lived servers (Docker), keep the cache warm with a 30-min
//      self-fetch interval. Skipped on Vercel — lambdas freeze between
//      requests, so setInterval doesn't fire reliably; the Vercel Cron in
//      vercel.json handles the periodic refresh instead.
//   3. On long-lived servers, kick off a daily refresh of
//      public/data/gauges-list.json. Skipped on Vercel because the runtime
//      filesystem is read-only outside /tmp.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE?.includes('build')) return;

  const isVercel = process.env.VERCEL === '1';
  const port = process.env.PORT || '3000';
  const warmGauges = () => {
    fetch(`http://127.0.0.1:${port}/api/gauges`).catch(() => {});
  };
  setTimeout(warmGauges, 1000);
  if (!isVercel) {
    setInterval(warmGauges, 30 * 60 * 1000);
  }

  if (isVercel) return;
  if (process.env.DISABLE_GAUGE_LIST_REFRESH === '1') return;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const runRefresh = async () => {
    try {
      // @ts-expect-error — plain .mjs with no type declarations
      const mod = await import('../scripts/refresh-gauges-list.mjs');
      await mod.refresh();
    } catch (err) {
      console.warn('[instrumentation] gauge list refresh failed:', err);
    }
  };
  // First refresh 5 min after boot (gives the server time to stabilize),
  // then every 24 h.
  setTimeout(() => {
    runRefresh();
    setInterval(runRefresh, DAY_MS);
  }, 5 * 60 * 1000);
}
