'use client';

import { useState } from 'react';
import useSWR from 'swr';
import type { GaugesResponse } from '@/lib/types';
import { apiUrl } from '@/lib/api';

const LIVE_URL = apiUrl('/api/gauges');

// The last successful LIVE response is persisted so a cold start — or a phone
// with no signal — paints the map from the previous snapshot instead of an
// empty state. The Legend shows the snapshot's own updatedAt, so stale data is
// labelled as such, and MapView shows a notice when a refresh fails. Only live
// responses are stored: history/forecast snapshots are keyed by time and
// would be wrong to replay.
const LAST_GOOD_KEY = 'tfm:last-gauges';

// A response worth keeping: real observations (updatedAt isn't the epoch-0
// "cache still cold" sentinel) for at least one gauge.
function isUsable(data: unknown): data is GaugesResponse {
  const d = data as GaugesResponse | null | undefined;
  if (!d || typeof d !== 'object' || typeof d.updatedAt !== 'string') return false;
  const t = new Date(d.updatedAt).getTime();
  return Number.isFinite(t) && t > 0 && !!d.gauges && Object.keys(d.gauges).length > 0;
}

function readLastGood(): GaugesResponse | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(LAST_GOOD_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isUsable(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeLastGood(data: GaugesResponse): void {
  try {
    window.localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(data));
  } catch {
    // Quota / private mode — the app just won't have an offline snapshot.
  }
}

const fetcher = async (url: string): Promise<GaugesResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gauges fetch ${res.status}`);
  return res.json();
};

// When `atIso` is null we pull live data (polled). When it's in the past we
// request the historical snapshot from /api/gauges/history; when it's in the
// future we request the forecast snapshot from /api/gauges/forecast. Both
// historical and forecast responses are static for a given timestamp so we
// don't poll either — only live data polls.
export function useGaugeData(atIso: string | null) {
  const isFuture = atIso !== null && new Date(atIso).getTime() > Date.now();
  const url = !atIso
    ? LIVE_URL
    : isFuture
      ? apiUrl(`/api/gauges/forecast?at=${encodeURIComponent(atIso)}`)
      : apiUrl(`/api/gauges/history?at=${encodeURIComponent(atIso)}`);
  // Read once per mount — it's a ~200 KB JSON.parse, not something to redo on
  // every render.
  const [lastGood] = useState(readLastGood);
  return useSWR<GaugesResponse>(url, fetcher, {
    fallbackData: atIso ? undefined : lastGood,
    // fallbackData would otherwise let SWR treat the stored snapshot as fresh
    // enough to skip the initial fetch; we always want a real request on mount.
    revalidateOnMount: true,
    onSuccess: (data, key) => {
      if (key === LIVE_URL && isUsable(data)) writeLastGood(data);
    },
    refreshInterval: (latest) => {
      if (atIso) return 0;
      const updated = latest?.updatedAt ? new Date(latest.updatedAt).getTime() : 0;
      return updated > 0 ? 10 * 60 * 1000 : 15 * 1000;
    },
    revalidateOnFocus: false,
    dedupingInterval: 10 * 1000,
    keepPreviousData: true,
  });
}
