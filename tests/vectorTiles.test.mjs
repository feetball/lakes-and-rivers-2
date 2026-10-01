// Unit tests for src/lib/vectorTiles.ts (the logic that decides when the map
// gives up on our tile server). Run: pnpm test   (Node >= 22.18 strips the
// TypeScript types, so the .ts module is imported directly.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveInfoUrl,
  createHealthMonitor,
  createRetryBudget,
  createTileArchive,
  fetchArchiveInfo,
  probeRasterReachable,
  probeTileServer,
  randomTileIn,
  rasterProbeUrl,
  recoveryDelayMs,
  TileFetchError,
} from '../src/lib/vectorTiles.ts';

const TEMPLATE = 'https://tiles.test/texas/{z}/{x}/{y}.mvt';
const TX_BOUNDS = [[25.8, -106.7], [36.6, -93.5]];
/** Looks like a real tile: a vector tile starts with the protobuf `layers` tag, 0x1a. */
const tileBytes = () => new Uint8Array([0x1a, 2, 3, 4]).buffer;

/** A fetch whose answer comes from `handler(url, init)`; records every call. */
function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

/**
 * A fetch that never answers on its own: it only settles when its signal aborts,
 * like the real one (which also rejects at once for a signal that is already aborted).
 */
const hangingFetch = () =>
  fakeFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort);
      }),
  );

function archiveWith(handler, extra = {}) {
  const results = [];
  const { fetchImpl, calls } = fakeFetch(handler);
  const archive = createTileArchive({ template: TEMPLATE, onResult: (ok) => results.push(ok), fetchImpl, ...extra });
  return { archive, results, calls };
}

// ---------------------------------------------------------------------------
// createTileArchive
// ---------------------------------------------------------------------------

test('tile archive: a 200 returns the bytes and reports success', async () => {
  const { archive, results, calls } = archiveWith(() => new Response(tileBytes(), { status: 200 }));
  const tile = await archive.getZxy(3, 2, 1);
  assert.equal(calls[0].url, 'https://tiles.test/texas/3/2/1.mvt');
  assert.deepEqual(new Uint8Array(tile.data), new Uint8Array([0x1a, 2, 3, 4]));
  assert.deepEqual(results, [true]);
});

test('tile archive: 204 is an empty tile (undefined) and counts as success', async () => {
  const { archive, results } = archiveWith(() => new Response(null, { status: 204 }));
  assert.equal(await archive.getZxy(12, 1000, 1700), undefined);
  assert.deepEqual(results, [true]);
});

test('tile archive: any other HTTP status throws (never parsed as a tile) and counts as a failure', async () => {
  for (const status of [403, 404, 500, 503]) {
    const { archive, results } = archiveWith(() => new Response('Internal error', { status }));
    await assert.rejects(archive.getZxy(3, 2, 1), (e) => e instanceof TileFetchError && e.status === status);
    assert.deepEqual(results, [false], `HTTP ${status}`);
  }
});

test('tile archive: a network or CORS error is rethrown and counts as a failure', async () => {
  const { archive, results } = archiveWith(() => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(archive.getZxy(3, 2, 1), TypeError);
  assert.deepEqual(results, [false]);
});

test('tile archive: a request the caller cancels (zoom change, unmount) is not a failure and stays an AbortError', async () => {
  const { fetchImpl } = hangingFetch();
  const results = [];
  const archive = createTileArchive({ template: TEMPLATE, onResult: (ok) => results.push(ok), fetchImpl });
  const ac = new AbortController();
  const pending = archive.getZxy(3, 2, 1, ac.signal);
  ac.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(results, [], 'aborts must never count towards "the server is failing"');

  const already = new AbortController();
  already.abort();
  await assert.rejects(archive.getZxy(3, 2, 1, already.signal), { name: 'AbortError' });
  assert.deepEqual(results, []);
});

test('tile archive: a request that never answers times out, counts as a failure, and is not an AbortError', async () => {
  const { fetchImpl } = hangingFetch();
  const results = [];
  const archive = createTileArchive({ template: TEMPLATE, onResult: (ok) => results.push(ok), fetchImpl, timeoutMs: 20 });
  await assert.rejects(archive.getZxy(3, 2, 1), { name: 'TimeoutError' });
  assert.deepEqual(results, [false]);
});

test('tile archive: the timeout timer does not outlive a request that finished', async () => {
  let seen;
  const { archive } = archiveWith((_url, init) => {
    seen = init.signal;
    return new Response(tileBytes(), { status: 200 });
  }, { timeoutMs: 20 });
  await archive.getZxy(3, 2, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(seen.aborted, false, 'a leaked timer would abort the finished request after the timeout');
});

test('tile archive: a 200 that is not a vector tile is a failure the monitor can see (double gzip, HTML portal, JSON)', async () => {
  const bad = {
    'gzip stream (compressed twice)': new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]),
    'HTML page': new TextEncoder().encode('<html><body>Sign in to Wi-Fi</body></html>'),
    'JSON error': new TextEncoder().encode('{"error":"nope"}'),
  };
  for (const [label, bytes] of Object.entries(bad)) {
    const { archive, results } = archiveWith(() => new Response(bytes, { status: 200 }));
    await assert.rejects(archive.getZxy(3, 2, 1), (e) => e instanceof TileFetchError && /not a vector tile/.test(e.message), label);
    assert.deepEqual(results, [false], label);
  }
});

test('tile archive: an empty 200 body is still an (empty) tile, not an error', async () => {
  const { archive, results } = archiveWith(() => new Response(new Uint8Array(0), { status: 200 }));
  const tile = await archive.getZxy(3, 2, 1);
  assert.equal(tile.data.byteLength, 0);
  assert.deepEqual(results, [true]);
});

test('tile archive: disposing it (the layer was removed) cancels in-flight requests promptly, without counting them', async () => {
  const { fetchImpl } = hangingFetch();
  const results = [];
  const dispose = new AbortController();
  const archive = createTileArchive({ template: TEMPLATE, onResult: (ok) => results.push(ok), fetchImpl, signal: dispose.signal, timeoutMs: 60_000 });
  const promptly = (p, label) =>
    Promise.race([
      assert.rejects(p, { name: 'AbortError' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} was not cancelled promptly`)), 500).unref()),
    ]);
  const a = archive.getZxy(3, 2, 1);
  const b = archive.getZxy(3, 2, 2);
  dispose.abort();
  await promptly(a, 'in-flight request 1');
  await promptly(b, 'in-flight request 2');
  await promptly(archive.getZxy(3, 2, 3), 'a request made after disposal');
  assert.deepEqual(results, []);
});

// ---------------------------------------------------------------------------
// createHealthMonitor
// ---------------------------------------------------------------------------

test('health monitor: trips once after 4 failures in a row', () => {
  let trips = 0;
  const m = createHealthMonitor({ onUnhealthy: () => trips++ });
  [false, false, false].forEach((ok) => m.record(ok));
  assert.equal(trips, 0);
  m.record(false);
  assert.equal(trips, 1);
  [false, false, false, false].forEach((ok) => m.record(ok));
  assert.equal(trips, 1, 'only ever fires once');
});

test('health monitor: any success resets the count (a stray 500 never flips the map)', () => {
  let trips = 0;
  const m = createHealthMonitor({ onUnhealthy: () => trips++ });
  for (const ok of [false, false, false, true, false, false, false, true]) m.record(ok);
  assert.equal(trips, 0);
  for (const ok of [false, false, false, false]) m.record(ok);
  assert.equal(trips, 1);
});

test('health monitor: failures are not counted while ignoreFailures() says the device is offline', () => {
  let trips = 0;
  let offline = true;
  const m = createHealthMonitor({ onUnhealthy: () => trips++, ignoreFailures: () => offline });
  for (let i = 0; i < 20; i++) m.record(false);
  assert.equal(trips, 0);
  offline = false;
  for (let i = 0; i < 3; i++) m.record(false);
  assert.equal(trips, 0, 'the offline failures did not accumulate');
  m.record(false);
  assert.equal(trips, 1);
});

test('health monitor: reset() re-arms it after a false alarm', () => {
  let trips = 0;
  const m = createHealthMonitor({ onUnhealthy: () => trips++ });
  for (let i = 0; i < 4; i++) m.record(false);
  assert.equal(trips, 1);
  for (let i = 0; i < 10; i++) m.record(false);
  assert.equal(trips, 1, 'stays quiet until reset');
  m.reset();
  for (let i = 0; i < 3; i++) m.record(false);
  assert.equal(trips, 1, 'the failure count restarted from zero');
  m.record(false);
  assert.equal(trips, 2);
});

test('health monitor: the limit is configurable', () => {
  let trips = 0;
  const m = createHealthMonitor({ onUnhealthy: () => trips++, maxConsecutiveFailures: 2 });
  m.record(false);
  m.record(false);
  assert.equal(trips, 1);
});

// ---------------------------------------------------------------------------
// archive info (TileJSON)
// ---------------------------------------------------------------------------

test('archive info url is derived from the tile template', () => {
  assert.equal(archiveInfoUrl(TEMPLATE), 'https://tiles.test/texas.json');
  assert.equal(archiveInfoUrl('https://tiles.test/texas/{z}/{x}/{y}.png'), null);
  assert.equal(archiveInfoUrl('https://tiles.test/{z}/{x}/{y}'), null);
});

test('archive info: reads maxzoom from the TileJSON', async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ maxzoom: 14, minzoom: 0 }));
  assert.deepEqual(await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 9, fetchImpl }), { status: 'ok', maxZoom: 14 });
  assert.equal(calls[0].url, 'https://tiles.test/texas.json');
});

test('archive info: server trouble is "unavailable", not a guessed zoom', async () => {
  const cases = {
    'HTTP error': () => new Response('nope', { status: 503 }),
    'captive portal / non-JSON': () => new Response('<html>Sign in to Wi-Fi</html>', { status: 200 }),
    'network error': () => {
      throw new TypeError('Failed to fetch');
    },
  };
  for (const [label, handler] of Object.entries(cases)) {
    const { fetchImpl } = fakeFetch(handler);
    const info = await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl });
    assert.equal(info.status, 'unavailable', label);
    assert.ok(info.reason.length > 0, label);
  }
});

test('archive info: offline, a network failure is not "unavailable": cached tiles may still draw, so start at the fallback zoom', async () => {
  const net = () => {
    throw new TypeError('Failed to fetch');
  };
  const { fetchImpl } = fakeFetch(net);
  assert.deepEqual(await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl, isOffline: () => true }), { status: 'ok', maxZoom: 14 });
  // a timeout while offline is the same thing
  assert.deepEqual(await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl: hangingFetch().fetchImpl, timeoutMs: 20, isOffline: () => true }), { status: 'ok', maxZoom: 14 });
  // online, the same failure still means the server is unavailable
  const online = await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl, isOffline: () => false });
  assert.equal(online.status, 'unavailable');
  // an HTTP error needs a connection, so being "offline" does not excuse it
  const http = fakeFetch(() => new Response('x', { status: 503 })).fetchImpl;
  assert.equal((await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl: http, isOffline: () => true })).status, 'unavailable');
});

test('archive info: a readable answer with a missing or implausible maxzoom still works, at the fallback zoom', async () => {
  for (const body of [{}, { maxzoom: 0 }, { maxzoom: 99 }, { maxzoom: '14' }, { maxzoom: 3.5 }, { maxzoom: null }, null]) {
    const { fetchImpl } = fakeFetch(() => Response.json(body));
    assert.deepEqual(await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl }), { status: 'ok', maxZoom: 14 }, JSON.stringify(body));
  }
});

test('archive info: a server that never answers is unavailable after the timeout', async () => {
  const { fetchImpl } = hangingFetch();
  const info = await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl, timeoutMs: 20 });
  assert.equal(info.status, 'unavailable');
  assert.match(info.reason, /timed out/);
});

test('archive info: cancelling (unmount) is reported as cancelled, before or during the request', async () => {
  const { fetchImpl } = hangingFetch();
  const ac = new AbortController();
  const pending = fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl, signal: ac.signal, timeoutMs: 5000 });
  ac.abort();
  assert.deepEqual(await pending, { status: 'unavailable', reason: 'cancelled' });
  assert.deepEqual(await fetchArchiveInfo(TEMPLATE, { fallbackMaxZoom: 14, fetchImpl, signal: ac.signal }), { status: 'unavailable', reason: 'cancelled' });
});

test('archive info: a template that is not our layout cannot be asked, so it is assumed healthy at the fallback zoom', async () => {
  const { fetchImpl, calls } = fakeFetch(() => {
    throw new Error('must not be called');
  });
  assert.deepEqual(await fetchArchiveInfo('https://x.test/{z}/{x}/{y}', { fallbackMaxZoom: 12, fetchImpl }), { status: 'ok', maxZoom: 12 });
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// recovery probe
// ---------------------------------------------------------------------------

test('random tile: stays inside the bounds and matches known slippy-map coordinates', () => {
  // Reference values from an independent calculation: Austin (30.2672, -97.7431) is z12 tile 935/1686.
  assert.deepEqual(randomTileIn([[30.2672, -97.7431], [30.2672, -97.7431]], 12, () => 0.5), { z: 12, x: 935, y: 1686 });
  // Texas' corners at z12: NW tile 833/1599, SE tile 984/1743.
  assert.deepEqual(randomTileIn(TX_BOUNDS, 12, () => 0), { z: 12, x: 833, y: 1599 });
  assert.deepEqual(randomTileIn(TX_BOUNDS, 12, () => 0.999999), { z: 12, x: 984, y: 1743 });
  assert.deepEqual(randomTileIn([[-10, -10], [10, 10]], 0, Math.random), { z: 0, x: 0, y: 0 });
});

test('probe: a random in-bounds tile, fetched without the browser cache; 200-with-body and 204 are healthy', async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(tileBytes(), { status: 200 }));
  assert.equal(await probeTileServer(TEMPLATE, { bounds: TX_BOUNDS, fetchImpl, rand: () => 0 }), true);
  assert.equal(calls[0].url, 'https://tiles.test/texas/12/833/1599.mvt');
  assert.equal(calls[0].init.cache, 'no-store', 'a cached answer would say nothing about the server');

  const empty = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(await probeTileServer(TEMPLATE, { bounds: TX_BOUNDS, fetchImpl: empty.fetchImpl }), true);
});

test('probe: HTTP errors, empty or non-tile 200 bodies, network errors and timeouts are unhealthy', async () => {
  const bad = [
    fakeFetch(() => new Response('x', { status: 500 })).fetchImpl,
    fakeFetch(() => new Response(new Uint8Array(0), { status: 200 })).fetchImpl,
    fakeFetch(() => new Response('<html>Sign in to Wi-Fi</html>', { status: 200 })).fetchImpl,
    fakeFetch(() => new Response(new Uint8Array([0x1f, 0x8b, 8, 0]), { status: 200 })).fetchImpl,
    fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    }).fetchImpl,
  ];
  for (const fetchImpl of bad) assert.equal(await probeTileServer(TEMPLATE, { bounds: TX_BOUNDS, fetchImpl }), false);
  assert.equal(await probeTileServer(TEMPLATE, { bounds: TX_BOUNDS, fetchImpl: hangingFetch().fetchImpl, timeoutMs: 20 }), false);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await probeTileServer(TEMPLATE, { bounds: TX_BOUNDS, fetchImpl: hangingFetch().fetchImpl, signal: ac.signal }), false);
});

test('raster probe URL fills in the template with the world tile', () => {
  assert.equal(rasterProbeUrl('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'), 'https://a.tile.openstreetmap.org/0/0/0.png');
  assert.equal(rasterProbeUrl('https://tiles.example/{z}/{x}/{y}{r}.png?key=k'), 'https://tiles.example/0/0/0.png?key=k');
});

test('raster probe: any HTTP answer means reachable; only network failure, timeout or cancel mean not', async () => {
  const ok = fakeFetch(() => new Response(null, { status: 200 }));
  assert.equal(await probeRasterReachable('https://{s}.tile.test/{z}/{x}/{y}.png', { fetchImpl: ok.fetchImpl }), true);
  assert.equal(ok.calls[0].url, 'https://a.tile.test/0/0/0.png');
  assert.equal(ok.calls[0].init.mode, 'no-cors', 'needs no CORS headers from the fallback provider');
  assert.equal(ok.calls[0].init.cache, 'no-store');

  const notFound = fakeFetch(() => new Response('nope', { status: 404 }));
  assert.equal(await probeRasterReachable('https://x.test/{z}/{x}/{y}.png', { fetchImpl: notFound.fetchImpl }), true, 'a 404 still proves the network works');

  const down = fakeFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal(await probeRasterReachable('https://x.test/{z}/{x}/{y}.png', { fetchImpl: down.fetchImpl }), false);
  assert.equal(await probeRasterReachable('https://x.test/{z}/{x}/{y}.png', { fetchImpl: hangingFetch().fetchImpl, timeoutMs: 20 }), false);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await probeRasterReachable('https://x.test/{z}/{x}/{y}.png', { fetchImpl: hangingFetch().fetchImpl, signal: ac.signal }), false);
});

test('recovery backoff doubles from a minute up to a 15 minute ceiling', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(recoveryDelayMs), [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  assert.equal(recoveryDelayMs(-3), 60_000);
});

test('retry budget: 8 s, 16 s, 32 s, then none until a success resets it', () => {
  const b = createRetryBudget();
  assert.deepEqual([b.next(), b.next(), b.next(), b.next(), b.next()], [8000, 16000, 32000, null, null]);
  b.reset();
  assert.equal(b.next(), 8000);
  const custom = createRetryBudget({ max: 1, baseMs: 100 });
  assert.deepEqual([custom.next(), custom.next()], [100, null]);
});
