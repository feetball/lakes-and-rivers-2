// The user's starred gauges, kept in localStorage on this device and nowhere else.
//
// This is the whole public surface (the push-alert feature builds on exactly this):
//
//   getFavorites()           ids, oldest first. The same array instance until the list changes
//   isFavorite(id)           boolean
//   toggleFavorite(id)       adds or removes; returns the NEW state (true = now a favorite).
//                            Adding when FAVORITES_LIMIT are already starred is refused and
//                            returns false, which is also what a removal returns, so compare
//                            isFavorite(id) before and after if the difference matters
//   onFavoritesChange(cb)    cb(ids) after any change made here or in another tab/window;
//                            returns the unsubscribe function
//   isFavoritesPersistent()  false once a write has failed (private mode, quota): the list then
//                            lives in memory for this session only
//
// Stored under 'tfm:favorites' as {"v":1,"ids":["HNTT2","KRRT2"]}. Reading is forgiving (a bare
// JSON array of ids is accepted too; corrupt JSON, an unknown version or junk entries read as
// "nothing there" and never throw). Ids are NWS location ids, upper-cased and de-duplicated.

export const FAVORITES_KEY = 'tfm:favorites';
export const FAVORITES_LIMIT = 50;

const VERSION = 1;
const CHANGE_EVENT = 'tfm:favorites-changed';
const ID_PATTERN = /^[A-Z0-9]{3,12}$/;

// Set while the last write failed: the list as the user left it, ahead of what is stored.
let unsaved: readonly string[] | null = null;
let persistent = true;
// Parsed form of the last raw string read or written, so repeated reads return the same
// array (React's useSyncExternalStore requires a stable snapshot).
let cache: { raw: string | null; ids: readonly string[] } | null = null;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // accessing localStorage itself can throw when site data is blocked
  }
}

function readRaw(): string | null {
  try {
    return storage()?.getItem(FAVORITES_KEY) ?? null;
  } catch {
    return null;
  }
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toUpperCase();
  return ID_PATTERN.test(id) ? id : null;
}

function cleanIds(list: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of list) {
    const id = normalizeId(value);
    if (id) seen.add(id);
    if (seen.size >= FAVORITES_LIMIT) break;
  }
  return [...seen];
}

/** Ids out of a stored string; anything unreadable gives []. Exported for tests. */
export function parseFavorites(raw: string | null): string[] {
  if (raw === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(data)) return cleanIds(data);
  if (data && typeof data === 'object' && (data as { v?: unknown }).v === VERSION) {
    const ids = (data as { ids?: unknown }).ids;
    if (Array.isArray(ids)) return cleanIds(ids);
  }
  return [];
}

export function getFavorites(): readonly string[] {
  if (unsaved) return unsaved;
  const raw = readRaw();
  if (cache && cache.raw === raw) return cache.ids;
  const ids = Object.freeze(parseFavorites(raw));
  cache = { raw, ids };
  return ids;
}

export function isFavorite(id: string): boolean {
  const normalized = normalizeId(id);
  return normalized !== null && getFavorites().includes(normalized);
}

export function isFavoritesPersistent(): boolean {
  return persistent;
}

function write(ids: readonly string[]): void {
  const frozen = Object.freeze([...ids]);
  const raw = JSON.stringify({ v: VERSION, ids: frozen });
  try {
    const store = storage();
    if (!store) throw new Error('localStorage unavailable');
    store.setItem(FAVORITES_KEY, raw);
    unsaved = null;
    cache = { raw, ids: frozen };
    persistent = true;
  } catch {
    // Quota exceeded or private mode. Keep the list for this session so the star still
    // works, and let isFavoritesPersistent() tell the UI it will not survive a restart.
    unsaved = frozen;
    persistent = false;
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function toggleFavorite(id: string): boolean {
  const normalized = normalizeId(id);
  if (normalized === null) return false;
  const current = getFavorites();
  if (current.includes(normalized)) {
    write(current.filter(existing => existing !== normalized));
    return false;
  }
  if (current.length >= FAVORITES_LIMIT) return false;
  write([...current, normalized]);
  return true;
}

export function onFavoritesChange(cb: (ids: readonly string[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let last = getFavorites().join(',');
  const fire = () => {
    const ids = getFavorites();
    const key = ids.join(',');
    if (key === last) return; // a storage event for a value that did not change the list
    last = key;
    cb(ids);
  };
  // Other tabs and windows announce a write through the 'storage' event (key null = storage cleared).
  const onStorage = (event: Event) => {
    const key = (event as Event & { key?: string | null }).key;
    if (key === undefined || key === null || key === FAVORITES_KEY) fire();
  };
  window.addEventListener(CHANGE_EVENT, fire);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, fire);
    window.removeEventListener('storage', onStorage);
  };
}
