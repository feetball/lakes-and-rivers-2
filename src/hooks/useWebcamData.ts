'use client';

import useSWR from 'swr';
import { apiUrl } from '@/lib/api';
import { parseWebcamsResponse, type WebcamsResponse } from '@/lib/webcams';

const fetcher = async (url: string): Promise<WebcamsResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`webcams fetch ${res.status}`);
  // Validated here so nothing the network returns reaches an <img> or the map unchecked.
  return parseWebcamsResponse(await res.json());
};

/** The river-camera list. The server caches it for 10 min and cameras shoot every 15-60, so 5 min is plenty. */
export default function useWebcamData() {
  return useSWR<WebcamsResponse>(apiUrl('/api/webcams'), fetcher, {
    refreshInterval: 5 * 60_000,
    revalidateOnFocus: false,
    dedupingInterval: 10_000,
    keepPreviousData: true,
  });
}
