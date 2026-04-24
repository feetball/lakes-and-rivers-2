'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

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

// Playback: at 1× speed we want 1 hour of gauge data to advance per 5 s of
// wall time → 4 steps (4 × 15 min) per 5 s → 1.25 s per step. Higher speed
// multipliers shorten the per-step interval proportionally.
const PLAYBACK_BASE_MS_PER_STEP = 1250;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;
type Speed = (typeof SPEEDS)[number];

function stepToIso(step: number, nowMs: number): string | null {
  if (step >= STEPS) return null; // rightmost = live
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
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  // Latest committed step in a ref so the playback interval doesn't have to
  // be recreated every tick — it reads from here and writes back via setStep.
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // Keep the local step in sync when the parent resets to Live.
  useEffect(() => { setStep(isoToStep(value, nowMs)); }, [value, nowMs]);

  // Stop playback automatically if we've reached Live.
  useEffect(() => { if (step >= STEPS && playing) setPlaying(false); }, [step, playing]);

  useEffect(() => {
    if (!playing) return;
    const intervalMs = Math.max(50, PLAYBACK_BASE_MS_PER_STEP / speed);
    const id = window.setInterval(() => {
      const next = stepRef.current + 1;
      if (next >= STEPS) {
        setStep(STEPS);
        onChange(null);
        setPlaying(false);
        return;
      }
      setStep(next);
      onChange(stepToIso(next, nowMs));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [playing, speed, nowMs, onChange]);

  const label = useMemo(() => formatLabel(stepToIso(step, nowMs)), [step, nowMs]);
  const atLive = step >= STEPS;

  const onSlide = (e: React.ChangeEvent<HTMLInputElement>) => {
    const s = Number(e.target.value);
    setStep(s);
    onChange(stepToIso(s, nowMs));
    // Pause if the user starts scrubbing manually.
    if (playing) setPlaying(false);
  };

  const goLive = () => {
    const now = Date.now();
    setNowMs(now);
    setStep(STEPS);
    onChange(null);
    setPlaying(false);
  };

  const togglePlay = () => {
    if (atLive) {
      // Starting playback from Live doesn't make sense — rewind a bit.
      const startStep = Math.max(0, STEPS - 24); // 6 h back
      setStep(startStep);
      onChange(stepToIso(startStep, nowMs));
      setPlaying(true);
      return;
    }
    setPlaying(p => !p);
  };

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 'calc(env(safe-area-inset-bottom, 0) + 12px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(620px, calc(100vw - 24px))',
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <button
          onClick={togglePlay}
          aria-label={playing ? 'Pause playback' : 'Play playback'}
          title={playing ? 'Pause' : atLive ? 'Rewind 6 h and play' : 'Play'}
          style={{
            background: playing ? '#f97316' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            width: 32,
            height: 26,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span style={{ fontWeight: 600, minWidth: 130 }}>{label}</span>
        {loading && <LoadingDot />}
        <div style={{ flex: 1 }} />
        <SpeedSelect speed={speed} onChange={setSpeed} />
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
        style={{ width: '100%', accentColor: playing ? '#f97316' : atLive ? '#2563eb' : '#f97316' }}
        aria-label="Select time"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
        <span>7 days ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

function SpeedSelect({ speed, onChange }: { speed: Speed; onChange: (s: Speed) => void }) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        color: '#9ca3af',
      }}
      title="Playback speed (1× = 1 hour of gauge data per 5 s)"
    >
      <span>Speed</span>
      <select
        value={speed}
        onChange={(e) => onChange(Number(e.target.value) as Speed)}
        style={{
          background: '#1f2937',
          color: '#e5e7eb',
          border: '1px solid #374151',
          borderRadius: 6,
          padding: '2px 6px',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {SPEEDS.map(s => (
          <option key={s} value={s}>{s}×</option>
        ))}
      </select>
    </label>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 1.5 L10 6 L2.5 10.5 Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect x="2.5" y="1.5" width="2.5" height="9" fill="currentColor" />
      <rect x="7" y="1.5" width="2.5" height="9" fill="currentColor" />
    </svg>
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
