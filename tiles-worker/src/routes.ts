// Pure request helpers, kept free of Workers-runtime globals so they can be
// unit-tested under plain Node (see test/).

const NAME = '[A-Za-z0-9_-]{1,64}';
// Canonical decimal numbers only (no leading zeros) and one extension: every
// other spelling of the same tile would be its own edge-cache entry and its own
// R2 read.
const TILE_PATH = new RegExp(`^/(${NAME})/(0|[1-9]\\d?)/(0|[1-9]\\d{0,7})/(0|[1-9]\\d{0,7})\\.mvt$`);
const TILEJSON_PATH = new RegExp(`^/(${NAME})\\.json$`);

/** Highest zoom we will even try to look up (PMTiles tile ids stop at z26). */
const MAX_Z = 26;

export type Route =
  | { kind: 'tile'; name: string; z: number; x: number; y: number }
  | { kind: 'tilejson'; name: string }
  | { kind: 'root' };

/** Parse `/{name}/{z}/{x}/{y}.mvt`, `/{name}.json` or `/`. Null = no such route. */
export function parseRoute(pathname: string): Route | null {
  if (pathname === '/') return { kind: 'root' };

  const json = TILEJSON_PATH.exec(pathname);
  if (json) return { kind: 'tilejson', name: json[1] };

  const m = TILE_PATH.exec(pathname);
  if (!m) return null;
  const z = Number(m[2]);
  const x = Number(m[3]);
  const y = Number(m[4]);
  if (z > MAX_Z) return null;
  const n = 2 ** z;
  if (x >= n || y >= n) return null;
  return { kind: 'tile', name: m[1], z, x, y };
}

/** The single URL path a route is served and edge-cached under. */
export function canonicalPath(route: Route & { kind: 'tile' | 'tilejson' }): string {
  return route.kind === 'tile'
    ? `/${route.name}/${route.z}/${route.x}/${route.y}.mvt`
    : `/${route.name}.json`;
}

/** R2 object key for an archive name, from the PMTILES_PATH template. */
export function archiveKey(template: string, name: string): string {
  return template.replace('{name}', name);
}

/**
 * ALLOWED_ARCHIVES is a comma-separated list of archive names this Worker will
 * serve ('*' = any name, for local development). Anything else is a 404 before
 * the cache or R2 is touched, so random names cannot run up R2 reads.
 */
export function archiveAllowed(allowed: string, name: string): boolean {
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') || list.includes(name);
}

/**
 * Decide the CORS response for a request's Origin against the allowlist.
 *  - no Origin header (native fetch, curl, <img>, same-origin) -> allowed, no CORS headers needed
 *  - allowlist "*"                                              -> allowed, ACAO "*"
 *  - Origin in the allowlist                                    -> allowed, ACAO echoes it
 *  - anything else                                              -> denied
 */
export function checkOrigin(
  origin: string | null,
  allowed: string,
): { ok: boolean; allowOrigin: string | null } {
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return { ok: true, allowOrigin: '*' };
  if (!origin) return { ok: true, allowOrigin: null };
  if (list.includes(origin)) return { ok: true, allowOrigin: origin };
  return { ok: false, allowOrigin: null };
}
