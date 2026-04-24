// Runs once per Node server start.
//   1. Warm /api/gauges by self-fetching so the first real user visit gets
//      live data, not the cold-start fallback.
//   2. Kick off a daily background refresh of public/data/gauges-list.json —
//      the seed that `pnpm data:build` falls back to when the NWPS list
//      endpoint 504s. Survives across deploys only if public/data is a
//      mounted volume; otherwise it just keeps the running container's
//      seed fresh (still useful — rebuilds triggered inside the container
//      can read it).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const port = process.env.PORT || '3000';
  setTimeout(() => {
    fetch(`http://127.0.0.1:${port}/api/gauges`).catch(() => {});
  }, 1000);

  // Skip the background refresh during build (next build imports this file
  // when tree-walking routes) — `NEXT_PHASE` is set to 'phase-production-build'.
  if (process.env.NEXT_PHASE?.includes('build')) return;
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
