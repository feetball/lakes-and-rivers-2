import { IS_WORKERD } from '@/lib/data-assets';

// Access to the app-data R2 bucket (gauge snapshots + analytics events),
// bound as DATA_BUCKET in wrangler.jsonc. This is deliberately a separate
// bucket from NEXT_INC_CACHE_R2_BUCKET — OpenNext owns that one for the Next
// Data Cache and may write/purge its own keys.
//
// Minimal structural types instead of @cloudflare/workers-types: pulling the
// real Workers types into the app's TS program would conflict with the DOM
// lib types the client code compiles against.

export type R2BucketLike = {
  put(key: string, value: string | ArrayBuffer): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
};

/**
 * The DATA_BUCKET binding, or null when not on Cloudflare (or the binding is
 * missing) — callers fall back to Vercel Blob / disabled behavior.
 */
export async function getDataBucket(): Promise<R2BucketLike | null> {
  if (!IS_WORKERD) return null;
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const { env } = getCloudflareContext();
    return (env as { DATA_BUCKET?: R2BucketLike }).DATA_BUCKET ?? null;
  } catch {
    return null;
  }
}
