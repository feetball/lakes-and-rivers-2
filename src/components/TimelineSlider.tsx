'use client';

import { useEffect, useMemo, useState } from 'react';

interface Props {
  // null = "live"; otherwise ISO of the selected historical moment.
  value: string | null;
  onChange: (iso: string | null) => void;
  // Loading indicator while the backend fetches for this time.
  loading?: boolean;
}

const WINDOW_HOURS = 24 * 7;     // 7 days back
const STEP_MINUTES = 15;         // 15-min grain matches USGS IV cadence
const STEPS = (WINDOW_HOURS * 60) / STEP_MINUTES;

function stepToIso(step: number, nowMs: number): string | null {
  if (step === STEPS) return null; // rightmost = live
  const minutesBack = (STEPS - step) * STEP_MINUTES;
  return new Date(nowMs - minutesBack * 60_000).toISOString();
}

function isoToStep(iso: string | null, nowMs: number): number {
  if (!iso) return STEPS;
  const diffMin = Math.max(0, (nowMs - new Date(iso).getTime()) / 60_000);
  return Math.max(0, STEPS - Math.round(diffMin / STEP_MINUTES));
}

function formatLabel(iso: string | null): string {
  if (!iso) return 'Live';
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function TimelineSlider({ value, onChange, loading }: Props) {
  // Freeze "now" per mount so the slider doesn't drift under the user while
  // they drag. Refreshed when they click Live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [step, setStep] = useState(() => isoToStep(value, Date.now()));

  // Keep the local step in sync when the parent resets to Live.
  useEffect(() => { setStep(isoToStep(value, nowMs)); }, [value, nowMs]);

  const label = useMemo(() => formatLabel(stepToIso(step, nowMs)), [step, nowMs]);
  const atLive = step === STEPS;

  const onSlide = (e: React.ChangeEvent<HTMLInputElement>) => {
    const s = Number(e.target.value);
    setStep(s);
    onChange(stepToIso(s, nowMs));
  };

  const goLive = () => {
    const now = Date.now();
    setNowMs(now);
    setStep(STEPS);
    onChange(null);
  };

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 'calc(env(safe-area-inset-bottom, 0) + 12px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(560px, calc(100vw - 24px))',
        background: 'rgba(17,24,39,0.92)',
        backdropFilter: 'blur(6px)',
        color: '#e5e7eb',
        borderRadius: 10,
        padding: '10px 14px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
        zIndex: 1000,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {loading && <LoadingDot />}
        <div style={{ flex: 1 }} />
        <button
          onClick={goLive}
          disabled={atLive}
          style={{
            background: atLive ? '#1f2937' : '#2563eb',
            color: atLive ? '#6b7280' : '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 600,
            cursor: atLive ? 'default' : 'pointer',
          }}
        >
          Live
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={STEPS}
        step={1}
        value={step}
        onChange={onSlide}
        style={{ width: '100%', accentColor: atLive ? '#2563eb' : '#f97316' }}
        aria-label="Select time"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
        <span>7 days ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

function LoadingDot() {
  return (
    <span
      aria-label="Loading"
      style={{
        display: 'inline-block', width: 10, height: 10, borderRadius: 5,
        background: '#f97316',
        animation: 'tfm-pulse 1s ease-in-out infinite',
      }}
    >
      <style>{`@keyframes tfm-pulse { 0%,100% { opacity: 0.3 } 50% { opacity: 1 } }`}</style>
    </span>
  );
}
