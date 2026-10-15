// Drives the real Worker handler (src/index.ts) with the real pmtiles library,
// a fake R2 bucket and a stand-in for the Cache API. Run: node --test test/*.test.ts
// (needs Node >= 22.18, which strips the TypeScript types).
//
// What this CANNOT see: behaviours of Cloudflare's runtime itself, namely that
// encodeBody 'automatic' gzips a body a second time and that the real Cache API
// re-encodes a stored body that carries Content-Encoding. Removing either
// workaround leaves these tests green. scripts/smoke.sh checks both against the
// real runtime (it reads the decoded body's first bytes on a miss and on a hit)
// and must be run after every deploy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { buildArchive, gz } from './pmtiles-fixture.ts';

interface StoredObject {
  data: Buffer;
  etag: string;
}

/** Just enough of R2Bucket: ranged reads, etagMatches conditions, missing keys, injected failures. */
class FakeBucket {
  objects = new Map<string, StoredObject>();
  gets = 0;
  failNext = 0;

  put(key: string, data: Buffer, etag: string) {
    this.objects.set(key, { data, etag });
  }

  async get(key: string, opts: { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } } = {}) {
    this.gets++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('R2 internal error');
    }
    const obj = this.objects.get(key);
    if (!obj) return null;
    // A failed precondition returns the object's metadata without a body.
    if (opts.onlyIf?.etagMatches && opts.onlyIf.etagMatches !== obj.etag) return { key, etag: obj.etag };
    let data = obj.data;
    if (opts.range) data = data.subarray(opts.range.offset, opts.range.offset + opts.range.length);
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return { key, etag: obj.etag, httpMetadata: {}, body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes };
  }
}

let counter = 0;
/** A fresh archive name per test: the Worker keeps per-isolate caches keyed by it. */
const uniq = () => `fx${++counter}`;

function harness(overrides: Record<string, string> = {}) {
  const bucket = new FakeBucket();
  const env = {
    BUCKET: bucket,
    PMTILES_PATH: '{name}.pmtiles',
    ALLOWED_ORIGINS: 'capacitor://localhost,https://localhost',
    ALLOWED_ARCHIVES: '*',
    CACHE_CONTROL: 'public, max-age=604800',
    PUBLIC_HOSTNAME: 'tiles.example.test',
    ...overrides,
  };
  // Stand-in for caches.default: stores status, headers and body bytes.
  const store = new Map<string, { status: number; headers: [string, string][]; body: ArrayBuffer }>();
  Object.assign(globalThis, {
    caches: {
      default: {
        async match(req: Request) {
          const e = store.get(req.url);
          return e && new Response(e.body, { status: e.status, headers: e.headers });
        },
        async put(req: Request, res: Response) {
          store.set(req.url, { status: res.status, headers: [...res.headers], body: await res.arrayBuffer() });
        },
      },
    },
  });
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException() {},
  };
  async function call(path: string, init: RequestInit = {}) {
    const res = await worker.fetch(new Request(`https://tiles.example.test${path}`, init), env as never, ctx as never);
    await Promise.all(pending.splice(0));
    return res;
  }
  return { bucket, env, store, call };
}

const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

test('serves a stored gzip tile untouched, and identically from the edge cache without reading R2', async () => {
  const name = uniq();
  const h = harness();
  const stored = gz('tile-3-2-2');
  h.bucket.put(`${name}.pmtiles`, buildArchive([{ z: 3, x: 2, y: 2, data: stored }], { minZoom: 0, maxZoom: 4 }), 'e1');

  const miss = await h.call(`/${name}/3/2/2.mvt`, { headers: { Origin: 'capacitor://localhost' } });
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get('content-encoding'), 'gzip');
  assert.equal(miss.headers.get('x-tile-encoding'), null, 'the internal marker must never leave the Worker');
  assert.equal(miss.headers.get('content-type'), 'application/vnd.mapbox-vector-tile');
  assert.equal(miss.headers.get('cache-control'), 'public, max-age=604800');
  assert.ok((await bytesOf(miss)).equals(stored), 'bytes must be exactly what the archive stores (no second gzip)');

  const getsAfterMiss = h.bucket.gets;
  const hit = await h.call(`/${name}/3/2/2.mvt`, { headers: { Origin: 'https://localhost' } });
  assert.equal(h.bucket.gets, getsAfterMiss, 'an edge-cache hit must not read R2');
  assert.equal(hit.headers.get('content-encoding'), 'gzip');
  assert.equal(hit.headers.get('x-tile-encoding'), null);
  assert.equal(hit.headers.get('access-control-allow-origin'), 'https://localhost', 'CORS is decided per request, never cached');
  assert.ok((await bytesOf(hit)).equals(stored));
});

test('a valid coordinate with no data is a briefly cacheable 204 that is not stored at the edge', async () => {
  const name = uniq();
  const h = harness();
  h.bucket.put(`${name}.pmtiles`, buildArchive([{ z: 3, x: 2, y: 2, data: gz('x') }], { minZoom: 0, maxZoom: 4 }), 'e1');

  const empty = await h.call(`/${name}/3/1/1.mvt`);
  assert.equal(empty.status, 204);
  assert.equal(empty.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal((await bytesOf(empty)).length, 0);

  const beyond = await h.call(`/${name}/5/0/0.mvt`); // deeper than the archive's max zoom
  assert.equal(beyond.status, 204);
  assert.equal(h.store.size, 0, '204s are not put in the edge cache');
});

test('unknown archive names, padded numbers and the .pbf alias are 404 without touching R2', async () => {
  const h = harness({ ALLOWED_ARCHIVES: 'texas' });
  for (const path of ['/other/3/2/2.mvt', '/texas/03/2/2.mvt', '/texas/3/2/2.pbf', '/other.json', '/texas/3/9/0.mvt']) {
    assert.equal((await h.call(path)).status, 404, path);
  }
  assert.equal(h.bucket.gets, 0);
});

test('an allowed archive that is missing from R2 is a 404 (and is logged), not a 500', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const h = harness({ ALLOWED_ARCHIVES: 'fxmissing' });
  const res = await h.call('/fxmissing/3/2/2.mvt');
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'Archive not found');
  assert.equal(warn.mock.callCount(), 1);
});

test('origins: allowlisted ones get CORS headers, others are 403 before any R2 work, no Origin is allowed', async () => {
  const name = uniq();
  const h = harness();
  h.bucket.put(`${name}.pmtiles`, buildArchive([{ z: 3, x: 2, y: 2, data: gz('x') }], { minZoom: 0, maxZoom: 4 }), 'e1');

  const denied = await h.call(`/${name}/3/2/2.mvt`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
  assert.equal(h.bucket.gets, 0);

  const ok = await h.call(`/${name}/3/2/2.mvt`, { headers: { Origin: 'capacitor://localhost' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  assert.equal(ok.headers.get('vary'), 'Origin');

  const none = await h.call(`/${name}/3/2/2.mvt`);
  assert.equal(none.status, 200);
  assert.equal(none.headers.get('access-control-allow-origin'), null);
});

test('methods: OPTIONS preflight, HEAD without a body, everything else 405', async () => {
  const name = uniq();
  const h = harness();
  h.bucket.put(`${name}.pmtiles`, buildArchive([{ z: 3, x: 2, y: 2, data: gz('x') }], { minZoom: 0, maxZoom: 4 }), 'e1');

  const pre = await h.call(`/${name}/3/2/2.mvt`, { method: 'OPTIONS', headers: { Origin: 'https://localhost' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.match(pre.headers.get('access-control-allow-methods') ?? '', /HEAD/);

  const head = await h.call(`/${name}/3/2/2.mvt`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-encoding'), 'gzip');
  assert.equal((await bytesOf(head)).length, 0);

  const post = await h.call(`/${name}/3/2/2.mvt`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.match(post.headers.get('allow') ?? '', /GET, HEAD/);
});

test('an archive replaced under a warm isolate is noticed on the next read that reaches R2', async () => {
  const name = uniq();
  const h = harness();
  const key = `${name}.pmtiles`;
  // Different tile sizes in the two archives, so reading the new archive at the old
  // archive's offsets (a missing ETag precondition) yields garbage instead of a lucky match.
  const bigA = gz('A-2-2 ' + 'a'.repeat(300));
  h.bucket.put(key, buildArchive([{ z: 3, x: 2, y: 2, data: bigA }, { z: 3, x: 4, y: 4, data: gz('A-4-4') }], { minZoom: 0, maxZoom: 4 }), 'eA');
  assert.equal((await h.call(`/${name}/3/2/2.mvt`)).status, 200); // warms the isolate with archive A's header

  const newTile = gz('B-4-4 is a different length than anything in A');
  h.bucket.put(key, buildArchive([{ z: 3, x: 2, y: 2, data: gz('B') }, { z: 3, x: 4, y: 4, data: newTile }], { minZoom: 0, maxZoom: 4 }), 'eB');
  const res = await h.call(`/${name}/3/4/4.mvt`); // a tile that is not in the edge cache
  assert.equal(res.status, 200);
  assert.ok((await bytesOf(res)).equals(newTile), 'must come from the new archive, not garbage read at old offsets');
});

test('TileJSON reports the NEW zoom range right after a replacement, not the cached one', async () => {
  const name = uniq();
  const h = harness();
  const key = `${name}.pmtiles`;
  h.bucket.put(key, buildArchive([{ z: 3, x: 2, y: 2, data: gz('A') }], { minZoom: 0, maxZoom: 4 }), 'eA');
  assert.equal((await h.call(`/${name}/3/2/2.mvt`)).status, 200); // header (maxZoom 4) now cached in the isolate

  h.bucket.put(key, buildArchive([{ z: 3, x: 2, y: 2, data: gz('B') }, { z: 5, x: 3, y: 3, data: gz('B5') }], { minZoom: 0, maxZoom: 5 }), 'eB');
  const res = await h.call(`/${name}.json`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { maxzoom: number; tiles: string[] };
  assert.equal(json.maxzoom, 5);
  assert.deepEqual(json.tiles, [`https://tiles.example.test/${name}/{z}/{x}/{y}.mvt`]);
});

test('a zoom range widened by a replacement shows up within the header TTL', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const name = uniq();
  const h = harness();
  const key = `${name}.pmtiles`;
  h.bucket.put(key, buildArchive([{ z: 3, x: 2, y: 2, data: gz('A') }], { minZoom: 0, maxZoom: 4 }), 'eA');
  assert.equal((await h.call(`/${name}/3/2/2.mvt`)).status, 200);

  h.bucket.put(key, buildArchive([{ z: 3, x: 2, y: 2, data: gz('B') }, { z: 5, x: 3, y: 3, data: gz('B5') }], { minZoom: 0, maxZoom: 5 }), 'eB');
  // The isolate still holds the old header (max zoom 4), so z5 is answered 204 without reading R2.
  assert.equal((await h.call(`/${name}/5/3/3.mvt`)).status, 204);

  now += 61_000; // past HEADER_TTL_MS
  const res = await h.call(`/${name}/5/3/3.mvt`);
  assert.equal(res.status, 200);
  assert.ok((await bytesOf(res)).equals(gz('B5')));
});

test('a transient R2 error is retried; a persistent one becomes a 500', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const name = uniq();
  const h = harness();
  h.bucket.put(`${name}.pmtiles`, buildArchive([{ z: 3, x: 2, y: 2, data: gz('x') }], { minZoom: 0, maxZoom: 4 }), 'e1');

  h.bucket.failNext = 1;
  assert.equal((await h.call(`/${name}/3/2/2.mvt`)).status, 200);
  assert.equal(error.mock.callCount(), 0);

  const other = uniq();
  const h2 = harness();
  h2.bucket.put(`${other}.pmtiles`, buildArchive([{ z: 3, x: 2, y: 2, data: gz('x') }], { minZoom: 0, maxZoom: 4 }), 'e1');
  h2.bucket.failNext = 10;
  const res = await h2.call(`/${other}/3/2/2.mvt`);
  assert.equal(res.status, 500);
  assert.equal(await res.text(), 'Internal error');
  assert.equal(error.mock.callCount(), 1);
});

test('query strings do not create new edge-cache entries: a repeat with ?v=2 is a hit that reads nothing from R2', async () => {
  const name = uniq();
  const h = harness();
  h.bucket.put(`${name}.pmtiles`, buildArchive([{ z: 3, x: 2, y: 2, data: gz('x') }], { minZoom: 0, maxZoom: 4 }), 'e1');
  assert.equal((await h.call(`/${name}/3/2/2.mvt`)).status, 200);
  const gets = h.bucket.gets;
  for (const q of ['?v=2', '?cachebust=123', '?']) assert.equal((await h.call(`/${name}/3/2/2.mvt${q}`)).status, 200, q);
  assert.equal(h.bucket.gets, gets, 'every variant must be answered from the one cache entry');
  assert.equal(h.store.size, 1);
});

test('HEAD: no body on a miss, no body on a hit, same headers as GET', async () => {
  const name = uniq();
  const h = harness();
  const stored = gz('tile');
  h.bucket.put(`${name}.pmtiles`, buildArchive([{ z: 3, x: 2, y: 2, data: stored }], { minZoom: 0, maxZoom: 4 }), 'e1');
  const miss = await h.call(`/${name}/3/2/2.mvt`, { method: 'HEAD' });
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get('content-encoding'), 'gzip');
  assert.equal((await bytesOf(miss)).length, 0);
  const get = await h.call(`/${name}/3/2/2.mvt`);
  assert.ok((await bytesOf(get)).equals(stored), 'a HEAD that filled the cache must not poison later GETs');
  const hit = await h.call(`/${name}/3/2/2.mvt`, { method: 'HEAD' });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('content-encoding'), 'gzip');
  assert.equal(hit.headers.get('x-tile-encoding'), null);
  assert.equal((await bytesOf(hit)).length, 0);
});

test('a denied origin is logged once per distinct value, not once per request', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const h = harness();
  for (let i = 0; i < 5; i++) assert.equal((await h.call('/texas/3/2/2.mvt', { headers: { Origin: 'https://preview-123.workers.dev' } })).status, 403);
  assert.equal((await h.call('/texas/3/2/2.mvt', { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal(warn.mock.callCount(), 2);
});
