import { IS_WORKERD } from '@/lib/data-assets';
import { getDataBucket } from '@/lib/r2-data';
import { createMemoryStore, layerStores, type AlertsStore } from '@/lib/alerts-fetch';

// Where /api/alerts keeps what must outlive one request: the simplified zone shapes
// (good for days) and the last good response (what it falls back to when the NWS is
// down). On Cloudflare that is DATA_BUCKET (R2, shared by every isolate), with a small
// per-isolate memory copy in front of the zone shapes. Everywhere else (next dev,
// Docker, Vercel) it is process memory only, which the NWS's own caching makes cheap.
//
// Keys live under alerts/ in the same bucket as the gauge snapshots and analytics.

const memory = createMemoryStore();

export async function getAlertsStore(): Promise<AlertsStore> {
  const bucket = IS_WORKERD ? await getDataBucket() : null;
  if (!bucket) return memory;
  const r2: AlertsStore = {
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? obj.text() : null;
    },
    async put(key, value) {
      await bucket.put(key, value);
    },
  };
  // Zone shapes are immutable for days, so the isolate-local copy is safe. The
  // latest response is not: another isolate may have written a newer one, so it
  // goes to R2 only.
  const zones = layerStores(memory, r2);
  return {
    get: key => (key.startsWith('alerts/zones/') ? zones.get(key) : r2.get(key)),
    put: (key, value) => (key.startsWith('alerts/zones/') ? zones.put(key, value) : r2.put(key, value)),
  };
}
