import { readFile } from 'fs/promises';
import { resolve } from 'path';

// Reads a file from public/data/ in every runtime this app deploys to.
//
// The prebuild step (scripts/build-waterways-data.mjs) writes gauges-meta.json
// and the waterways GeoJSON artifacts into public/data. Several API routes
// need those files at runtime:
//  - Node servers (next dev, Docker standalone, Vercel functions): plain fs
//    read from process.cwd()/public/data — same as the routes always did.
//    On Vercel the files are traced into each function bundle via
//    outputFileTracingIncludes in next.config.mjs.
//  - Cloudflare Workers (OpenNext): there is no filesystem, but the same
//    files ship as static assets, so read them back through the ASSETS
//    binding (Workers Static Assets) declared in wrangler.jsonc.
//
// Returns null when the file can't be found in either source — callers keep
// their existing "meta unavailable" fallback behavior.

// workerd (the Cloudflare Workers runtime) identifies itself via
// navigator.userAgent; Node ≥21 reports "Node.js/…" here. Exported for the
// few places that need runtime-specific behavior beyond file reads (e.g.
// /api/waterways, where workerd owns response compression).
export const IS_WORKERD =
  typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

async function readViaAssetsBinding(relPath: string): Promise<Buffer | null> {
  try {
    // Static import would be fine (the package is a regular dependency), but a
    // dynamic import keeps @opennextjs/cloudflare out of the module graph on
    // Node deploys, where this branch is unreachable.
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const { env } = getCloudflareContext();
    const assets = (env as { ASSETS?: { fetch(req: Request): Promise<Response> } }).ASSETS;
    if (!assets) return null;
    // The binding routes purely on the pathname; the host is arbitrary.
    const res = await assets.fetch(new Request(`https://assets.local/data/${relPath}`));
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Read public/data/<relPath> as bytes, or null if unavailable. */
export async function readPublicData(relPath: string): Promise<Buffer | null> {
  if (IS_WORKERD) return readViaAssetsBinding(relPath);
  try {
    return await readFile(resolve(process.cwd(), 'public/data', relPath));
  } catch {
    return null;
  }
}

/** Read public/data/<relPath> as UTF-8 text, or null if unavailable. */
export async function readPublicDataText(relPath: string): Promise<string | null> {
  const buf = await readPublicData(relPath);
  return buf === null ? null : buf.toString('utf8');
}
