'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import type { AlertsResponse, NwsAlert } from '@/lib/types';
import { apiUrl } from '@/lib/api';
import { isAlertActive } from '@/lib/alerts-fetch';
import { alertsState, isAlertsResponse, type AlertsState } from '@/lib/alerts-view';

const ALERTS_URL = apiUrl('/api/alerts');

// Like the gauge snapshot (useGaugeData): the last good response is kept so a cold
// start or a phone with no signal still shows what was in effect. Its own updatedAt
// says how old it is, and alertsState() turns an old one into "may be out of date",
// or, past six hours, into "unavailable".
const LAST_GOOD_KEY = 'tfm:last-alerts';

function readLastGood(): AlertsResponse | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(LAST_GOOD_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isAlertsResponse(parsed) && parsed.updatedAt ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeLastGood(data: AlertsResponse): void {
  try {
    window.localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(data));
  } catch {
    // Quota / private mode: no offline copy, nothing else changes.
  }
}

// The route answers 503 with a JSON body when it has nothing at all; only a body
// that carries a read time is usable data. Everything else is an error, so a failure
// can never turn into an empty list that reads as "no warnings".
const fetcher = async (url: string): Promise<AlertsResponse> => {
  const res = await fetch(url);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON (a proxy error page)
  }
  if (!isAlertsResponse(body) || !body.updatedAt) throw new Error(`alerts fetch ${res.status}`);
  return body;
};

export interface AlertsHook {
  // In effect right now (an alert that expired since the last poll is filtered here).
  alerts: NwsAlert[];
  state: AlertsState;
  updatedAt: string | null;
  // The server could not reach the NWS and sent its own last good copy.
  serverStale: boolean;
}

/**
 * NWS flood alerts from /api/alerts, polled every 2 minutes while the page is visible.
 * `enabled` false (layer off, or the timeline on another time) makes no requests.
 */
export function useAlerts(enabled: boolean): AlertsHook {
  const [lastGood] = useState(readLastGood);
  const { data, error } = useSWR<AlertsResponse>(enabled ? ALERTS_URL : null, fetcher, {
    fallbackData: lastGood,
    // fallbackData would otherwise count as fresh enough to skip the first request.
    revalidateOnMount: true,
    onSuccess: d => writeLastGood(d),
    refreshInterval: 2 * 60_000, // SWR pauses it while the tab is hidden
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 30_000,
    shouldRetryOnError: false, // the 2 min poll is the retry
  });

  // Re-evaluate ages and expiries between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [enabled]);

  const state = alertsState(data, !!error, now);
  const alerts = useMemo(
    () => (state.kind === 'ready' && data ? data.alerts.filter(a => isAlertActive(a, now)) : []),
    [state.kind, data, now],
  );
  return {
    alerts,
    state,
    updatedAt: data?.updatedAt ?? null,
    serverStale: !!data && !data.ok,
  };
}
