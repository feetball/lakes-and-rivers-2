'use client';

import { useEffect, useState } from 'react';

// Reads the self-hosted analytics summary from /api/admin/analytics (admin
// cookie required) and renders it inside the admin section of the Legend.
// Lazy: only fetches when first opened.

type DayAggregate = {
  day: string;
  pageviews: number;
  visitors: number;
  gaugeOpens: Record<string, number>;
  referrers: Record<string, number>;
};
type Summary = {
  ok: boolean;
  totals: Omit<DayAggregate, 'day'>;
  byDay: DayAggregate[];
  error?: string;
};

// gaugeId -> display name, supplied by the parent so we can show "Lake Travis"
// instead of a bare LID. Falls back to the id when unknown.
interface Props {
  gaugeNames?: Record<string, string>;
}

function topN(counts: Record<string, number>, n: number): [string, number][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

const cell: React.CSSProperties = { fontSize: 11, color: '#cbd5e1' };
const num: React.CSSProperties = { fontSize: 18, fontWeight: 700, color: '#e5e7eb' };

export default function AnalyticsPanel({ gaugeNames }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch('/api/admin/analytics', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as Summary;
      if (res.ok && body.ok) setData(body);
      else setErr(body.error || `failed (${res.status})`);
    } catch {
      setErr('request failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && !data && !loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          background: 'none', border: 'none', padding: 0,
          color: '#93c5fd', cursor: 'pointer', fontSize: 11, textDecoration: 'underline',
          alignSelf: 'flex-start',
        }}
      >
        Analytics
      </button>
    );
  }

  return (
    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 11, color: '#e5e7eb' }}>Analytics</strong>
        <button onClick={load} disabled={loading} style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}>
          Hide
        </button>
      </div>

      {err && <span style={{ color: '#f87171', fontSize: 11 }}>{err}</span>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 16 }}>
            <div>
              <div style={num}>{data.totals.pageviews.toLocaleString()}</div>
              <div style={cell}>pageviews</div>
            </div>
            <div>
              <div style={num}>{data.totals.visitors.toLocaleString()}</div>
              <div style={cell}>visitors (daily uniq)</div>
            </div>
          </div>

          <Section title="Top gauges opened" rows={topN(data.totals.gaugeOpens, 8).map(([id, c]) => [gaugeNames?.[id] ?? id, c])} empty="no gauge opens yet" />
          <Section title="Top referrers" rows={topN(data.totals.referrers, 6)} empty="no external referrers" />

          {data.byDay.length > 0 && (
            <div>
              <div style={{ ...cell, marginBottom: 2, color: '#9ca3af' }}>Last days</div>
              {data.byDay.slice(-7).map((d) => (
                <div key={d.day} style={{ display: 'flex', justifyContent: 'space-between', ...cell }}>
                  <span>{d.day}</span>
                  <span>{d.pageviews} pv · {d.visitors} v</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, rows, empty }: { title: string; rows: [string, number][]; empty: string }) {
  return (
    <div>
      <div style={{ ...cell, marginBottom: 2, color: '#9ca3af' }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ ...cell, color: '#6b7280' }}>{empty}</div>
      ) : (
        rows.map(([label, count]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, ...cell }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            <span style={{ color: '#e5e7eb' }}>{count}</span>
          </div>
        ))
      )}
    </div>
  );
}
