'use client';

import useSWR from 'swr';

interface SessionState {
  authed: boolean;
  configured: boolean;
}

const sessionFetcher = async (url: string): Promise<SessionState> => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return { authed: false, configured: false };
  return res.json();
};

// Tracks admin login state via the /api/admin/session probe and exposes
// login/logout helpers. Revalidates on focus so a session that expires (or a
// logout in another tab) is reflected.
export function useAdmin() {
  const { data, mutate, isLoading } = useSWR<SessionState>('/api/admin/session', sessionFetcher, {
    revalidateOnFocus: true,
    dedupingInterval: 30 * 1000,
  });

  async function login(password: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.ok) {
      await mutate();
      return { ok: true };
    }
    return { ok: false, error: body?.error || `login failed (${res.status})` };
  }

  async function logout(): Promise<void> {
    await fetch('/api/admin/logout', { method: 'POST' });
    await mutate();
  }

  return {
    authed: data?.authed ?? false,
    configured: data?.configured ?? false,
    loading: isLoading,
    login,
    logout,
  };
}
