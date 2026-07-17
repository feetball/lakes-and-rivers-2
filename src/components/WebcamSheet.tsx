'use client';

import { useEffect, useRef, useState } from 'react';
import type { Webcam, WebcamFramesResponse } from '@/lib/types';

interface Props {
  webcam: Webcam;
  onClose: () => void;
}

// "Updated N min/hours/days ago", or null when there's no timestamp to show.
function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < 60_000) return 'just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

async function fetchLatestFrame(id: string, signal?: AbortSignal) {
  try {
    const res = await fetch(`/api/webcams/${encodeURIComponent(id)}/frames?limit=1`, { signal });
    if (!res.ok) return null;
    const data: WebcamFramesResponse = await res.json();
    return data.frames?.[0] ?? null;
  } catch {
    return null;
  }
}

export default function WebcamSheet({ webcam, onClose }: Props) {
  const [imageUrl, setImageUrl] = useState<string | null>(webcam.imageUrl);
  const [takenAt, setTakenAt] = useState<string | null>(webcam.newestImageAt);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Tracks which camera is currently displayed so an in-flight refresh for a
  // camera the user has since navigated away from can't clobber state.
  const webcamIdRef = useRef(webcam.id);

  // Reset image state for the newly-selected camera, and if we have no image
  // to show yet, make one attempt at the frames endpoint to find the newest.
  useEffect(() => {
    webcamIdRef.current = webcam.id;
    setImageUrl(webcam.imageUrl);
    setTakenAt(webcam.newestImageAt);
    setImgLoaded(false);
    setImgError(false);

    if (webcam.imageUrl) return;
    const controller = new AbortController();
    (async () => {
      const frame = await fetchLatestFrame(webcam.id, controller.signal);
      if (controller.signal.aborted) return;
      if (frame) {
        setImageUrl(frame.url);
        setTakenAt(frame.takenAt);
      } else {
        setImgError(true);
      }
    })();
    return () => controller.abort();
  }, [webcam.id, webcam.imageUrl, webcam.newestImageAt]);

  const handleRefresh = async () => {
    const id = webcam.id;
    setRefreshing(true);
    try {
      const frame = await fetchLatestFrame(id);
      if (webcamIdRef.current !== id) return; // camera changed while this was in flight
      if (frame) {
        setImageUrl(frame.url);
        // An identical src never re-fires <img onLoad>, so only reset the
        // "Loading image…" overlay when the URL actually changed.
        if (frame.url !== imageUrl) setImgLoaded(false);
        setTakenAt(frame.takenAt);
        setImgError(false);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const updatedLabel = relativeTime(takenAt);

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1200,
        }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label={`Webcam: ${webcam.name}`}
        style={{
          position: 'absolute',
          left: 0, right: 0,
          bottom: 0,
          maxWidth: 560,
          marginInline: 'auto',
          maxHeight: '70dvh',
          background: '#111827',
          color: '#e5e7eb',
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: '16px 18px calc(env(safe-area-inset-bottom, 0) + 18px)',
          zIndex: 1201,
          boxShadow: '0 -6px 24px rgba(0,0,0,0.45)',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: '#374151' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'start', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.25 }}>{webcam.name}</h2>
            {webcam.description && (
              <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>{webcam.description}</div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none', color: '#9ca3af',
              fontSize: 22, lineHeight: 1, cursor: 'pointer', padding: 4,
            }}
          >×</button>
        </div>

        {imageUrl ? (
          <div style={{ position: 'relative', minHeight: 200, background: '#0b1220', borderRadius: 8 }}>
            {!imgLoaded && !imgError && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#9ca3af', fontSize: 12 }}>
                Loading image…
              </div>
            )}
            {imgError && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#9ca3af', fontSize: 12, padding: 8, textAlign: 'center' }}>
                Camera image unavailable
              </div>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt={`${webcam.name} — latest still`}
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
              style={{
                display: imgError ? 'none' : 'block',
                maxWidth: '100%',
                maxHeight: '40dvh',
                width: 'auto',
                height: 'auto',
                margin: '0 auto',
                borderRadius: 8,
                opacity: imgLoaded ? 1 : 0,
                transition: 'opacity 120ms',
              }}
            />
          </div>
        ) : (
          <div style={{ minHeight: 200, background: '#0b1220', borderRadius: 8, display: 'grid', placeItems: 'center', color: '#9ca3af', fontSize: 12 }}>
            Camera image unavailable
          </div>
        )}

        <div
          style={{
            marginTop: 10,
            color: '#9ca3af',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {updatedLabel && <span>Updated {updatedLabel}</span>}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="Refresh camera image"
            title="Refresh camera image"
            style={{
              background: 'none',
              border: 'none',
              padding: '0 2px',
              marginLeft: updatedLabel ? 4 : 0,
              color: refreshing ? '#6b7280' : '#e5e7eb',
              cursor: refreshing ? 'wait' : 'pointer',
              fontSize: 11,
              lineHeight: 1,
            }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <a
            href={webcam.hivisUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              color: '#60a5fa', fontSize: 13, textDecoration: 'none',
            }}
          >
            View on USGS HIVIS →
          </a>
          <div style={{ color: '#9ca3af', fontSize: 11 }}>
            Imagery: U.S. Geological Survey (public domain)
          </div>
        </div>
      </div>
    </>
  );
}
