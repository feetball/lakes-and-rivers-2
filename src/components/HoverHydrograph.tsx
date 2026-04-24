'use client';

import { useEffect, useState } from 'react';
import type { GaugeStatus } from '@/lib/types';
import { CATEGORY_LABELS } from '@/lib/floodStatus';

interface Props { gauge: GaugeStatus; x: number; y: number; }

// NWPS pre-renders a hydrograph PNG per gauge; lid is lowercase in the URL.
function hydrographUrl(lid: string) {
  return `https://water.noaa.gov/resources/hydrographs/${lid.toLowerCase()}_hg.png`;
}

export default function HoverHydrograph({ gauge, x, y }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  // Reset load state when the gauge changes (stale image flash otherwise).
  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [gauge.id]);

  // Flip to the left/above when near viewport edges so it doesn't clip.
  const pad = 12;
  const width = 360;
  const height = 260;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const flipX = x + width + pad > vw;
  const flipY = y + height + pad > vh;
  const left = flipX ? Math.max(8, x - width - pad) : x + pad;
  const top = flipY ? Math.max(8, y - height - pad) : y + pad;

  return (
    <div
      style={{
        position: 'fixed',
        left, top, width, maxHeight: height,
        zIndex: 1300,
        background: '#111827',
        color: '#e5e7eb',
        borderRadius: 8,
        padding: 8,
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
        pointerEvents: 'none', // don't steal hover from the marker
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        {gauge.name} · <span style={{ color: '#9ca3af', fontWeight: 400 }}>{CATEGORY_LABELS[gauge.category]}</span>
      </div>
      <div style={{ position: 'relative', height: 200, background: '#0b1220', borderRadius: 4 }}>
        {!loaded && !errored && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#9ca3af', fontSize: 12 }}>
            Loading chart…
          </div>
        )}
        {errored && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#9ca3af', fontSize: 12, padding: 8, textAlign: 'center' }}>
            No hydrograph available for this gauge.
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={hydrographUrl(gauge.id)}
          alt={`${gauge.name} hydrograph`}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          style={{
            width: '100%', height: '100%', objectFit: 'contain',
            borderRadius: 4,
            opacity: loaded ? 1 : 0, transition: 'opacity 120ms',
          }}
        />
      </div>
    </div>
  );
}
