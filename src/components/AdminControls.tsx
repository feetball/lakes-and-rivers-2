'use client';

import { useState } from 'react';
import { useAdmin } from '@/hooks/useAdmin';
import AnalyticsPanel from './AnalyticsPanel';

interface Props {
  // Called after a successful server-side force refresh so the caller can
  // re-read /api/gauges (e.g. SWR mutate).
  onRefreshed?: () => void;
  // gaugeId -> display name, for friendlier labels in the analytics panel.
  gaugeNames?: Record<string, string>;
}

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: '#93c5fd',
  cursor: 'pointer',
  fontSize: 11,
  textDecoration: 'underline',
};

// Admin login + force-refresh, rendered inside the Legend. Hidden entirely
// when admin login isn't configured on the server (no ADMIN_PASSWORD).
export default function AdminControls({ onRefreshed, gaugeNames }: Props) {
  const { authed, configured, login, logout } = useAdmin();
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [forceMsg, setForceMsg] = useState<string | null>(null);

  if (!configured) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await login(password);
    setBusy(false);
    if (res.ok) {
      setPassword('');
      setShowLogin(false);
    } else {
      setError(res.error ?? 'login failed');
    }
  }

  async function forceRefresh() {
    setForcing(true);
    setForceMsg(null);
    try {
      const res = await fetch('/api/admin/refresh-gauges', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) {
        setForceMsg(`Refreshed ${body.count} gauges`);
        onRefreshed?.();
      } else {
        setForceMsg(body?.error || `failed (${res.status})`);
      }
    } catch {
      setForceMsg('request failed');
    } finally {
      setForcing(false);
    }
  }

  if (authed) {
    return (
      <div style={{ marginTop: 6, fontSize: 11, color: '#9ca3af', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={forceRefresh}
            disabled={forcing}
            style={{
              background: forcing ? '#374151' : '#1d4ed8',
              border: 'none',
              borderRadius: 4,
              padding: '3px 8px',
              color: '#fff',
              cursor: forcing ? 'wait' : 'pointer',
              fontSize: 11,
            }}
          >
            {forcing ? 'Refreshing…' : 'Force refresh data'}
          </button>
          <button onClick={() => logout()} style={linkBtn}>
            Sign out
          </button>
        </div>
        {forceMsg && <span style={{ color: '#6b7280' }}>{forceMsg}</span>}
        <AnalyticsPanel gaugeNames={gaugeNames} />
      </div>
    );
  }

  if (!showLogin) {
    return (
      <div style={{ marginTop: 6 }}>
        <button onClick={() => setShowLogin(true)} style={linkBtn}>
          Admin
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Admin password"
          autoFocus
          style={{
            flex: 1,
            minWidth: 0,
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4,
            color: '#e5e7eb',
            padding: '3px 6px',
            fontSize: 11,
          }}
        />
        <button
          type="submit"
          disabled={busy || !password}
          style={{
            background: '#1d4ed8',
            border: 'none',
            borderRadius: 4,
            padding: '3px 8px',
            color: '#fff',
            cursor: busy ? 'wait' : 'pointer',
            fontSize: 11,
          }}
        >
          {busy ? '…' : 'Sign in'}
        </button>
        <button type="button" onClick={() => { setShowLogin(false); setError(null); }} style={linkBtn}>
          Cancel
        </button>
      </div>
      {error && <span style={{ color: '#f87171', fontSize: 11 }}>{error}</span>}
    </form>
  );
}
