import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import d1NextTagCache from '@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache';

// Wires Next's caching into Cloudflare primitives so it behaves like it does
// on Vercel (where the platform provides this implicitly):
//  - incrementalCache (R2): the Data Cache behind unstable_cache in
//    src/lib/gauges-fetch.ts — shared across all worker isolates, so one
//    cron refresh serves every subsequent /api/gauges request.
//  - tagCache (D1): backs revalidateTag(GAUGES_CACHE_TAG) from the cron and
//    admin refresh routes.
// No queue override: the app has no ISR pages (the map page is a static
// shell; every API route is force-dynamic), so nothing enqueues page
// revalidations.
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  tagCache: d1NextTagCache,
});
