'use client';

import { useEffect, useRef, useState } from 'react';
import type { GaugeStatus } from '@/lib/types';
// The website, which opens this gauge's sheet from ?gauge=ID (see MapView). The
// apps share the same link: it works for anyone, with or without the app.
import { SITE_ORIGIN as SHARE_ORIGIN } from '@/lib/externalLink';

type Result = 'idle' | 'copied' | 'manual';

// Native share sheet where the browser has one, else the clipboard; if even that
// is blocked the link is shown to copy by hand, so the button never fails silently.
export default function GaugeShareButton({ gauge }: { gauge: GaugeStatus }) {
  const url = `${SHARE_ORIGIN}/?gauge=${encodeURIComponent(gauge.id)}`;
  const [result, setResult] = useState<Result>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  // A different gauge is a different link: forget the previous confirmation.
  useEffect(() => { setResult('idle'); }, [gauge.id]);

  const share = async () => {
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: `${gauge.name} flood gauge`, url });
        return;
      }
    } catch (e) {
      // Closing the share sheet is not an error; anything else falls through to copying.
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setResult('copied');
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setResult('idle'), 2500);
    } catch {
      setResult('manual');
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <button
        onClick={share}
        style={{
          minHeight: 44, padding: '0 14px', background: '#1f2937', color: '#e5e7eb',
          border: '1px solid #374151', borderRadius: 8, fontSize: 14, cursor: 'pointer',
        }}
      >
        Share this gauge
      </button>
      <span role="status" style={{ marginLeft: 10, fontSize: 12, color: '#9ca3af' }}>
        {result === 'copied' && 'Link copied'}
      </span>
      {result === 'manual' && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#9ca3af' }}>
          Copy this link: <input readOnly value={url} onFocus={e => e.currentTarget.select()}
            style={{ width: '100%', marginTop: 4, background: '#0b1220', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 6, padding: '8px 10px', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
      )}
    </div>
  );
}
