#!/usr/bin/env node
// Refreshes public/data/gauges-list.json from the NWPS list endpoint.
//
// The endpoint (https://api.water.noaa.gov/nwps/v1/gauges) is flaky: it
// serves a ~13 MB payload that often brushes or exceeds the upstream 60 s
// nginx timeout, producing 504s. We retry patiently instead of failing fast.
//
// The file is a tiny (lid/lat/lon/name) snapshot used as a seed so
// `pnpm data:build` can still proceed when the live list is unreachable.
// Run daily via cron/systemd, or via the in-process scheduler in
// src/instrumentation.ts.

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'public/data/gauges-list.json');

const URL_LIST = 'https://api.water.noaa.gov/nwps/v1/gauges?state=TX';

// Each attempt gets its own 90 s budget (NWPS needs ~60 s on a good day,
// and the 60 s nginx gateway timeout returns 504 well within that).
const ATTEMPT_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 12;
const BACKOFF_MS = [10_000, 20_000, 30_000, 60_000, 120_000, 180_000];

function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

async function fetchOnce(attempt) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ATTEMPT_TIMEOUT_MS);
  const started = Date.now();
  let received = 0;
  let phase = 'connecting';
  let lastLogTs = 0;
  let lastLogBytes = -1;
  const isTty = !!process.stdout.isTTY;
  const tick = () => {
    const now = Date.now();
    const elapsed = ((now - started) / 1000).toFixed(1);
    const line = `[refresh-gauges-list] attempt ${attempt} · ${phase} · ${elapsed}s · ${fmtBytes(received)}`;
    if (isTty) { process.stdout.write(`\r${line}\x1b[K`); return; }
    if (phase === 'connecting' && now - lastLogTs >= 10_000) { console.log(line); lastLogTs = now; }
    else if (phase === 'downloading' && (received - lastLogBytes >= 1_000_000 || lastLogBytes < 0)) {
      console.log(line); lastLogBytes = received; lastLogTs = now;
    }
  };
  const ticker = setInterval(tick, 500);
  tick();
  try {
    const res = await fetch(URL_LIST, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'texas-flood-map/0.1', 'Accept-Encoding': 'gzip' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    phase = 'downloading';
    const reader = res.body?.getReader();
    if (!reader) {
      const txt = await res.text();
      received = txt.length;
      tick();
      const data = JSON.parse(txt);
      const all = Array.isArray(data) ? data : data.gauges ?? [];
      return all.filter(g => g?.state?.abbreviation === 'TX');
    }
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    tick();
    if (isTty) process.stdout.write('\n');
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const all = Array.isArray(data) ? data : data.gauges ?? [];
    // NWPS ignores ?state=TX server-side; filter locally.
    return all.filter(g => g?.state?.abbreviation === 'TX');
  } catch (e) {
    if (isTty) process.stdout.write('\n');
    throw e;
  } finally {
    clearInterval(ticker);
    clearTimeout(t);
  }
}

async function refresh() {
  let lastErr;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const started = Date.now();
    try {
      const tx = await fetchOnce(i + 1);
      if (!tx.length) throw new Error('empty TX list');
      const slim = tx.map(g => ({
        lid: g.lid,
        name: g.name,
        latitude: g.latitude,
        longitude: g.longitude,
      }));
      const body = JSON.stringify({
        fetchedAt: new Date().toISOString(),
        source: 'nwps-v1-list',
        gauges: slim,
      });
      await mkdir(dirname(OUT), { recursive: true });
      await writeFile(OUT + '.tmp', body);
      await rename(OUT + '.tmp', OUT);
      console.log(`[refresh-gauges-list] wrote ${OUT} (${slim.length} TX gauges, attempt ${i + 1})`);
      return { ok: true, count: slim.length };
    } catch (e) {
      lastErr = e;
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.warn(`[refresh-gauges-list] attempt ${i + 1}/${MAX_ATTEMPTS} failed after ${elapsed}s: ${e}`);
      if (i < MAX_ATTEMPTS - 1) {
        const wait = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// When imported, exports the function. When run directly, executes it.
export { refresh };

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  refresh().catch(err => {
    console.error('[refresh-gauges-list] gave up:', err);
    process.exit(1);
  });
}
