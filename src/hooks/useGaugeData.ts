'use client';

import useSWR from 'swr';
import type { GaugesResponse } from '@/lib/types';

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
    ? '/api/gauges'
    : isFuture
      ? `/api/gauges/forecast?at=${encodeURIComponent(atIso)}`
      : `/api/gauges/history?at=${encodeURIComponent(atIso)}`;
  return useSWR<GaugesResponse>(url, fetcher, {
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
