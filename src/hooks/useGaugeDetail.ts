'use client';

import useSWR from 'swr';
import { apiUrl } from '@/lib/api';
import type { GaugeDetail } from '@/lib/gaugeDetail';

const fetcher = async (url: string): Promise<GaugeDetail> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gauge detail ${res.status}`);
  const data: GaugeDetail = await res.json();
  // ok:false is the route's "NWS answered nothing": an error for the sheet,
  // not an empty detail that would read as "no forecast, no impacts".
  if (!data?.ok) throw new Error('gauge detail unavailable');
  return data;
};

// Forecast, series and impacts for the open gauge sheet. The server caches for
// 10 minutes, so refreshing at that pace keeps a sheet left open current.
export function useGaugeDetail(id: string) {
  return useSWR<GaugeDetail>(apiUrl(`/api/gauges/${encodeURIComponent(id)}/detail`), fetcher, {
    refreshInterval: 10 * 60 * 1000,
    revalidateOnFocus: false,
    dedupingInterval: 60 * 1000,
    // Only the first fetch retries quickly; later errors keep the last good data on screen.
    errorRetryCount: 2,
    errorRetryInterval: 5000,
  });
}
