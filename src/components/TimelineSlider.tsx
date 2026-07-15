'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  // null = "live"; otherwise ISO of the selected historical moment.
  value: string | null;
  onChange: (iso: string | null) => void;
  // Loading indicator while the backend fetches for this time.
  loading?: boolean;
}

const HISTORY_HOURS = 24 * 7;    // 7 days back
const FORECAST_HOURS = 24 * 5;   // 5 days forward
const STEP_MINUTES = 15;         // 15-min grain matches USGS IV cadence
const HIST_STEPS = (HISTORY_HOURS * 60) / STEP_MINUTES;
const FCST_STEPS = (FORECAST_HOURS * 60) / STEP_MINUTES;
const NOW_STEP = HIST_STEPS;
const MAX_STEP = HIST_STEPS + FCST_STEPS;
const STEPS_PER_HOUR = 60 / STEP_MINUTES;

// Playback: at 1× speed we want 1 hour of gauge data to advance per 5 s of
// wall time → 4 steps (4 × 15 min) per 5 s → 1.25 s per step. Higher speed
// multipliers shorten the per-step interval proportionally.
const PLAYBACK_BASE_MS_PER_STEP = 1250;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;
type Speed = (typeof SPEEDS)[number];

function stepToIso(step: number, nowMs: number): string | null {
  if (step === NOW_STEP) return null; // exactly "now" = live
  if (step < NOW_STEP) {
    const minutesBack = (NOW_STEP - step) * STEP_MINUTES;
    return new Date(nowMs - minutesBack * 60_000).toISOString();
  }
  const minutesForward = (step - NOW_STEP) * STEP_MINUTES;
  return new Date(nowMs + minutesForward * 60_000).toISOString();
}

function isoToStep(iso: string | null, nowMs: number): number {
  if (!iso) return NOW_STEP;
  const diffMin = (new Date(iso).getTime() - nowMs) / 60_000;
  const step = NOW_STEP + Math.round(diffMin / STEP_MINUTES);
  return Math.max(0, Math.min(MAX_STEP, step));
}

function formatLabel(iso: string | null, nowMs: number): string {
  if (!iso) return 'Live';
  const d = new Date(iso);
  const formatted = d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return d.getTime() > nowMs ? `Forecast · ${formatted}` : formatted;
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

  // Stop playback automatically once we've reached the end of the forecast
  // window (not at Live — playback now continues past Live into forecast).
  useEffect(() => { if (step >= MAX_STEP && playing) setPlaying(false); }, [step, playing]);

  useEffect(() => {
    if (!playing) return;
    const intervalMs = Math.max(50, PLAYBACK_BASE_MS_PER_STEP / speed);
    const id = window.setInterval(() => {
      const next = stepRef.current + 1;
      if (next >= MAX_STEP) {
        setStep(MAX_STEP);
        onChange(stepToIso(MAX_STEP, nowMs));
        setPlaying(false);
        return;
      }
      setStep(next);
      onChange(stepToIso(next, nowMs));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [playing, speed, nowMs, onChange]);

  const label = useMemo(() => formatLabel(stepToIso(step, nowMs), nowMs), [step, nowMs]);
  const atLive = step === NOW_STEP;
  const isFuture = step > NOW_STEP;

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
    setStep(NOW_STEP);
    onChange(null);
    setPlaying(false);
  };

  const togglePlay = () => {
    if (atLive) {
      // Starting playback from Live doesn't make sense — rewind a bit.
      const startStep = Math.max(0, NOW_STEP - 24); // 6 h back
      setStep(startStep);
      onChange(stepToIso(startStep, nowMs));
      setPlaying(true);
      return;
    }
    setPlaying(p => !p);
  };

  const stepForwardHour = () => {
    const s = Math.min(MAX_STEP, step + STEPS_PER_HOUR);
    setStep(s);
    onChange(stepToIso(s, nowMs));
    // Manual step advance pauses playback, same as scrubbing.
    if (playing) setPlaying(false);
  };

  return (
    <div
      style={{
        width: 'min(620px, calc(100vw - 24px))',
        background: 'rgba(17,24,39,0.92)',
        backdropFilter: 'blur(6px)',
        color: '#e5e7eb',
        borderBottomLeftRadius: 10,
        borderBottomRightRadius: 10,
        padding: '10px 14px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
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
        <button
          onClick={stepForwardHour}
          disabled={step >= MAX_STEP}
          aria-label="Advance 1 hour"
          title="Step forward 1 hour"
          style={{
            background: '#1f2937',
            color: step >= MAX_STEP ? '#6b7280' : '#9ca3af',
            border: 'none',
            borderRadius: 6,
            width: 32,
            height: 26,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: step >= MAX_STEP ? 'default' : 'pointer',
            padding: 0,
          }}
        >
          <SkipForwardIcon />
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
      <div style={{ position: 'relative' }}>
        <input
          type="range"
          min={0}
          max={MAX_STEP}
          step={1}
          value={step}
          onChange={onSlide}
          style={{
            width: '100%',
            accentColor: isFuture ? '#a855f7' : playing ? '#f97316' : atLive ? '#2563eb' : '#f97316',
          }}
          aria-label="Select time"
        />
        {/* Thin tick marking "now" on the track — purely decorative, so it's
            layered on top with pointer-events disabled to avoid stealing
            drag/click from the native range input. */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: `${(NOW_STEP / MAX_STEP) * 100}%`,
            top: 2,
            bottom: 2,
            width: 1,
            background: 'rgba(156,163,175,0.6)',
            pointerEvents: 'none',
          }}
        />
      </div>
      <div style={{ position: 'relative', color: '#9ca3af', fontSize: 11, marginTop: 2, height: 14 }}>
        <span style={{ position: 'absolute', left: 0 }}>7 days ago</span>
        <span style={{ position: 'absolute', left: `${(NOW_STEP / MAX_STEP) * 100}%`, transform: 'translateX(-50%)' }}>now</span>
        <span style={{ position: 'absolute', right: 0 }}>+5 days</span>
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

function SkipForwardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M1 1.5 L6 6 L1 10.5 Z" fill="currentColor" />
      <rect x="7.5" y="1.5" width="2" height="9" fill="currentColor" />
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
