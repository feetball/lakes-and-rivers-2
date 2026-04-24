'use client';

import useSWR from 'swr';
import type { GaugesResponse } from '@/lib/types';

const fetcher = async (url: string): Promise<GaugesResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gauges fetch ${res.status}`);
  return res.json();
};

// When `atIso` is null we pull live data (polled), otherwise we request the
// historical snapshot from /api/gauges/history. Historical responses are
// static for a given timestamp so we don't poll.
export function useGaugeData(atIso: string | null) {
  const url = atIso ? `/api/gauges/history?at=${encodeURIComponent(atIso)}` : '/api/gauges';
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
