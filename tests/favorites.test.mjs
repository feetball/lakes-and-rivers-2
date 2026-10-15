// Unit tests for src/lib/favorites.ts: the saved list's storage edge cases.
// Run: pnpm test. Each test loads a fresh copy of the module (the query string makes Node
// treat it as a new module) so module-level state, such as the unsaved-list fallback, never leaks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

let n = 0;

function setup({ stored = null, failWrites = false, blocked = false } = {}) {
  const data = new Map();
  if (stored !== null) data.set('tfm:favorites', stored);
  const storage = {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem(k, v) {
      if (failWrites) throw new DOMException('quota', 'QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: k => data.delete(k),
  };
  const win = new EventTarget();
  if (blocked) Object.defineProperty(win, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
  else win.localStorage = storage;
  globalThis.window = win;
  return { data, storage, win, load: () => import(`../src/lib/favorites.ts?case=${n++}`) };
}

test('starts empty and toggles on and off', async () => {
  const { load } = setup();
  const f = await load();
  assert.deepEqual([...f.getFavorites()], []);
  assert.equal(f.toggleFavorite('HNTT2'), true);
  assert.equal(f.isFavorite('HNTT2'), true);
  assert.equal(f.toggleFavorite('HNTT2'), false);
  assert.equal(f.isFavorite('HNTT2'), false);
});

test('stores a versioned object and survives a reload', async () => {
  const { data, load } = setup();
  const f = await load();
  f.toggleFavorite('hntt2');
  f.toggleFavorite('KRRT2');
  assert.deepEqual(JSON.parse(data.get('tfm:favorites')), { v: 1, ids: ['HNTT2', 'KRRT2'] });
  const again = await load();
  assert.deepEqual([...again.getFavorites()], ['HNTT2', 'KRRT2']);
});

test('getFavorites returns the same array until the list changes', async () => {
  const { load } = setup({ stored: '{"v":1,"ids":["HNTT2"]}' });
  const f = await load();
  assert.equal(f.getFavorites(), f.getFavorites());
  const before = f.getFavorites();
  f.toggleFavorite('KRRT2');
  assert.notEqual(f.getFavorites(), before);
});

test('corrupt, wrong-version and junk storage reads as empty without throwing', async () => {
  for (const stored of ['{not json', '', 'null', '42', '{"v":2,"ids":["HNTT2"]}', '{"v":1,"ids":"HNTT2"}', '{"v":1}']) {
    const f = await setup({ stored }).load();
    assert.deepEqual([...f.getFavorites()], [], `stored=${JSON.stringify(stored)}`);
  }
});

test('junk entries are dropped, ids upper-cased and de-duplicated', async () => {
  const stored = JSON.stringify({ v: 1, ids: ['hntt2', 'HNTT2', 7, null, '', 'a', '../etc', ' krrt2 ', {}] });
  const f = await setup({ stored }).load();
  assert.deepEqual([...f.getFavorites()], ['HNTT2', 'KRRT2']);
});

test('a bare array from an older build is accepted', async () => {
  const f = await setup({ stored: '["HNTT2","KRRT2"]' }).load();
  assert.deepEqual([...f.getFavorites()], ['HNTT2', 'KRRT2']);
});

test('caps at 50: the 51st is refused, removing one makes room', async () => {
  const { load } = setup();
  const f = await load();
  const ids = Array.from({ length: 50 }, (_, i) => `G${String(i).padStart(4, '0')}`);
  for (const id of ids) assert.equal(f.toggleFavorite(id), true);
  assert.equal(f.toggleFavorite('EXTRA1'), false);
  assert.equal(f.isFavorite('EXTRA1'), false);
  assert.equal(f.getFavorites().length, 50);
  assert.equal(f.toggleFavorite(ids[0]), false); // removal
  assert.equal(f.toggleFavorite('EXTRA1'), true);
});

test('an over-long stored list is cut to 50 on read', async () => {
  const stored = JSON.stringify({ v: 1, ids: Array.from({ length: 80 }, (_, i) => `G${String(i).padStart(4, '0')}`) });
  const f = await setup({ stored }).load();
  assert.equal(f.getFavorites().length, 50);
});

test('invalid ids are refused', async () => {
  const f = await setup().load();
  assert.equal(f.toggleFavorite(''), false);
  assert.equal(f.toggleFavorite('x'), false);
  assert.equal(f.getFavorites().length, 0);
});

test('a quota error keeps the list for this session and reports it is not saved', async () => {
  const { data, load } = setup({ failWrites: true });
  const f = await load();
  assert.equal(f.isFavoritesPersistent(), true);
  assert.equal(f.toggleFavorite('HNTT2'), true);
  assert.equal(f.isFavorite('HNTT2'), true);
  assert.equal(f.isFavoritesPersistent(), false);
  assert.equal(data.has('tfm:favorites'), false);
});

test('blocked localStorage (private mode) neither throws nor loses the session list', async () => {
  const f = await setup({ blocked: true }).load();
  assert.deepEqual([...f.getFavorites()], []);
  assert.equal(f.toggleFavorite('HNTT2'), true);
  assert.equal(f.isFavorite('HNTT2'), true);
  assert.equal(f.isFavoritesPersistent(), false);
});

test('no window at all (server render) reads as empty', async () => {
  delete globalThis.window;
  const f = await import(`../src/lib/favorites.ts?case=${n++}`);
  assert.deepEqual([...f.getFavorites()], []);
  assert.equal(typeof f.onFavoritesChange(() => {}), 'function');
});

test('onFavoritesChange fires for a change in this tab and stops after unsubscribe', async () => {
  const { load } = setup();
  const f = await load();
  const seen = [];
  const off = f.onFavoritesChange(ids => seen.push([...ids]));
  f.toggleFavorite('HNTT2');
  f.toggleFavorite('KRRT2');
  assert.deepEqual(seen, [['HNTT2'], ['HNTT2', 'KRRT2']]);
  off();
  f.toggleFavorite('LNXT2');
  assert.equal(seen.length, 2);
});

test('a storage event from another tab notifies, and an unrelated key does not', async () => {
  const { data, win, load } = setup();
  const f = await load();
  const seen = [];
  f.onFavoritesChange(ids => seen.push([...ids]));
  // Another tab wrote the list: the value changes under us, then the event arrives.
  data.set('tfm:favorites', '{"v":1,"ids":["KRRT2"]}');
  win.dispatchEvent(Object.assign(new Event('storage'), { key: 'tfm:favorites' }));
  assert.deepEqual(seen, [['KRRT2']]);
  win.dispatchEvent(Object.assign(new Event('storage'), { key: 'tfm:last-gauges' }));
  win.dispatchEvent(Object.assign(new Event('storage'), { key: 'tfm:favorites' })); // same list again
  assert.equal(seen.length, 1);
  // Storage cleared in another tab (key null).
  data.delete('tfm:favorites');
  win.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
  assert.deepEqual(seen[1], []);
});
