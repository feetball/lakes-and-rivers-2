import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveAllowed, archiveKey, canonicalPath, checkOrigin, parseRoute } from '../src/routes.ts';

test('parses tile, tilejson and root routes', () => {
  assert.deepEqual(parseRoute('/texas/15/7487/13490.mvt'), { kind: 'tile', name: 'texas', z: 15, x: 7487, y: 13490 });
  assert.deepEqual(parseRoute('/texas/0/0/0.mvt'), { kind: 'tile', name: 'texas', z: 0, x: 0, y: 0 });
  assert.deepEqual(parseRoute('/texas.json'), { kind: 'tilejson', name: 'texas' });
  assert.deepEqual(parseRoute('/'), { kind: 'root' });
});

test('rejects coordinates outside the tile grid', () => {
  assert.equal(parseRoute('/texas/3/8/0.mvt'), null); // x must be < 2^3
  assert.equal(parseRoute('/texas/3/0/8.mvt'), null);
  assert.equal(parseRoute('/texas/27/0/0.mvt'), null); // beyond PMTiles' max zoom
  assert.notEqual(parseRoute('/texas/3/7/7.mvt'), null);
});

test('only one spelling of a tile exists (no padding, no .pbf alias)', () => {
  for (const p of [
    '/texas/05/1/1.mvt', // leading zeros would be a second cache entry for the same tile
    '/texas/5/01/1.mvt',
    '/texas/5/1/001.mvt',
    '/texas/5/1/1.pbf',
    '/texas/5/1/1.MVT',
    '/texas/00/0/0.mvt',
  ]) {
    assert.equal(parseRoute(p), null, p);
  }
  assert.notEqual(parseRoute('/texas/10/0/0.mvt'), null); // a real zero or a trailing zero is fine
});

test('rejects malformed paths and anything that could escape the archive name', () => {
  for (const p of [
    '/texas/1/0/0', // no extension
    '/texas/1/0/0.png', // wrong type
    '/texas/-1/0/0.mvt',
    '/texas/1/0/0.mvt/extra',
    '/../secret/1/0/0.mvt',
    '/a b/1/0/0.mvt',
    '/te.xas/1/0/0.mvt', // dots are not allowed in names
    '/.json',
    '//1/0/0.mvt',
    `/${'a'.repeat(65)}/1/0/0.mvt`,
  ]) {
    assert.equal(parseRoute(p), null, p);
  }
});

test('canonical path round-trips through parseRoute', () => {
  for (const p of ['/texas/14/3492/6798.mvt', '/texas/0/0/0.mvt', '/texas.json']) {
    const route = parseRoute(p);
    assert.ok(route && route.kind !== 'root');
    assert.equal(canonicalPath(route), p);
  }
});

test('archive key comes from the PMTILES_PATH template', () => {
  assert.equal(archiveKey('{name}.pmtiles', 'texas'), 'texas.pmtiles');
  assert.equal(archiveKey('tiles/{name}.pmtiles', 'texas'), 'tiles/texas.pmtiles');
});

test('ALLOWED_ARCHIVES gates archive names', () => {
  assert.equal(archiveAllowed('texas', 'texas'), true);
  assert.equal(archiveAllowed('texas', 'austin'), false);
  assert.equal(archiveAllowed('texas, austin ', 'austin'), true);
  assert.equal(archiveAllowed('*', 'anything'), true);
  assert.equal(archiveAllowed('', 'texas'), false);
});

test('CORS: allowlisted origins are echoed, others denied, no Origin is fine', () => {
  const allow = 'capacitor://localhost, https://localhost';
  assert.deepEqual(checkOrigin('capacitor://localhost', allow), { ok: true, allowOrigin: 'capacitor://localhost' });
  assert.deepEqual(checkOrigin('https://localhost', allow), { ok: true, allowOrigin: 'https://localhost' });
  assert.deepEqual(checkOrigin('https://evil.example', allow), { ok: false, allowOrigin: null });
  assert.deepEqual(checkOrigin(null, allow), { ok: true, allowOrigin: null });
});

test('CORS: wildcard allows everything', () => {
  assert.deepEqual(checkOrigin('https://anything.example', '*'), { ok: true, allowOrigin: '*' });
  assert.deepEqual(checkOrigin(null, '*'), { ok: true, allowOrigin: '*' });
});

test('CORS: an empty allowlist denies every browser origin', () => {
  assert.equal(checkOrigin('https://x.example', '').ok, false);
});

test('CORS: matching is exact (case, trailing slash, the literal "null")', () => {
  const allow = 'https://txfloods.kuecker.us';
  assert.equal(checkOrigin('https://TXFLOODS.kuecker.us', allow).ok, false);
  assert.equal(checkOrigin('https://txfloods.kuecker.us/', allow).ok, false);
  assert.equal(checkOrigin('null', allow).ok, false);
});
