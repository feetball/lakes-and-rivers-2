'use client';

import { useEffect, useState } from 'react';

// One-time liability disclaimer shown on a visitor's first arrival. Acceptance
// is remembered in localStorage so returning visitors aren't nagged. Bump
// STORAGE_KEY's version suffix to force the disclaimer to re-show everyone
// (e.g. after a material wording change).
const STORAGE_KEY = 'tx-flood-map:disclaimer-accepted:v1';

export default function DisclaimerModal() {
  // Start hidden and decide on mount: localStorage isn't available during SSR,
  // and reading it in a useState initializer would mismatch hydration.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) !== 'true') setOpen(true);
    } catch {
      // Private mode / storage blocked: show it (fail toward informing the user).
      setOpen(true);
    }
  }, []);

  const accept = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // If we can't persist, the worst case is it shows again next visit.
    }
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div
      style={{
        // fixed (not absolute) so the overlay covers the whole viewport — <main>
        // establishes no positioning context, and this is a full-screen blocker.
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 1400, display: 'grid', placeItems: 'center', padding: 16,
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="disclaimer-title"
        aria-describedby="disclaimer-body"
        style={{
          maxWidth: 460,
          width: '100%',
          background: '#111827',
          color: '#e5e7eb',
          borderRadius: 16,
          padding: '22px 22px calc(env(safe-area-inset-bottom, 0) + 22px)',
          boxShadow: '0 10px 40px rgba(0,0,0,0.55)',
          border: '1px solid #1f2937',
        }}
      >
        <h2 id="disclaimer-title" style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 600 }}>
          Before you continue
        </h2>
        <div id="disclaimer-body" style={{ fontSize: 14, lineHeight: 1.55, color: '#cbd5e1' }}>
          <p style={{ margin: '0 0 12px' }}>
            This map is provided for general informational purposes only. The
            operator is <strong>not liable</strong> for any data shown here, and
            makes no warranty as to its accuracy, completeness, or timeliness.
            Gauge readings may be delayed, incorrect, or unavailable.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Do not</strong> rely on this map for flood-safety decisions.
            Always check{' '}
            <a
              href="https://water.noaa.gov/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#60a5fa' }}
            >
              NOAA / National Water Prediction Service
            </a>{' '}
            and your local emergency authorities for official flood information.
          </p>
        </div>
        <button
          onClick={accept}
          style={{
            marginTop: 20,
            width: '100%',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            padding: '12px 16px',
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          I understand
        </button>
      </div>
    </div>
  );
}
