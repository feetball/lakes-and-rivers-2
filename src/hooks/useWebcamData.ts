'use client';

import useSWR from 'swr';
import type { WebcamsResponse } from '@/lib/types';

const fetcher = async (url: string): Promise<WebcamsResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`webcams fetch ${res.status}`);
  return res.json();
};

export default function useWebcamData() {
  return useSWR<WebcamsResponse>('/api/webcams', fetcher, {
    refreshInterval: 300_000,
    revalidateOnFocus: false,
    dedupingInterval: 10 * 1000,
    keepPreviousData: true,
  });
}
