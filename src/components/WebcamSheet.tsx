'use client';

import { useEffect, useState } from 'react';
import { isDarkAt } from '@/lib/sun';
import {
  WEBCAM_STALE_MS,
  formatPhotoAge,
  formatPhotoTime,
  isAllowedImageUrl,
  webcamAgeMs,
  type Webcam,
} from '@/lib/webcams';

interface Props {
  webcam: Webcam;
  /** Name of the gauge at this camera's site, when the app has one. */
  gaugeName?: string;
  /** Opens that gauge's sheet (and closes this one). */
  onOpenGauge?: () => void;
  /** Other cameras at the same spot, for switching. */
  siblings?: Webcam[];
  onSelectSibling?: (w: Webcam) => void;
  onClose: () => void;
}

const AMBER = '#fbbf24';

export default function WebcamSheet({ webcam, gaugeName, onOpenGauge, siblings = [], onSelectSibling, onClose }: Props) {
  // The age on screen must keep counting while the sheet stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [webcam.id, webcam.imageUrl]);

  const age = webcamAgeMs(webcam, now);
  const stale = age !== null && age > WEBCAM_STALE_MS;
  // A night photo looks black or grainy; say why, since that reads as a broken camera.
  const takenMs = webcam.newestImageAt ? Date.parse(webcam.newestImageAt) : NaN;
  const dark = Number.isFinite(takenMs) && isDarkAt(takenMs, webcam.lat, webcam.lon);
  // Never an <img> src that did not come from the USGS image host.
  const src = webcam.imageUrl && isAllowedImageUrl(webcam.imageUrl) ? webcam.imageUrl : null;
  const taken = webcam.newestImageAt ? formatPhotoTime(webcam.newestImageAt, { nowMs: now }) : '';

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1200 }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label={`River camera: ${webcam.name}`}
        style={{
          position: 'absolute',
          left: 0, right: 0,
          bottom: 0,
          maxWidth: 560,
          marginInline: 'auto',
          maxHeight: '85dvh',
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
        <div style={{ display: 'flex', alignItems: 'start', gap: 12, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.25 }}>{webcam.name}</h2>
            {webcam.description && <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>{webcam.description}</div>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none', color: '#9ca3af',
              fontSize: 22, lineHeight: 1, cursor: 'pointer', width: 44, height: 44, margin: '-10px -10px 0 0',
            }}
          >×</button>
        </div>

        {/* The capture time comes first: a photo of a river is only worth anything with its age. */}
        <div
          style={{
            background: stale ? '#78350f55' : '#1f2937',
            border: `1px solid ${stale ? '#b4530988' : '#374151'}`,
            borderRadius: 10,
            padding: '10px 12px',
            marginBottom: 10,
          }}
        >
          {age === null ? (
            <div style={{ fontSize: 15, fontWeight: 600, color: AMBER }}>No photo time available</div>
          ) : (
            <>
              <div style={{ fontSize: 15, fontWeight: 600, color: stale ? AMBER : '#e5e7eb' }}>
                Photo taken {formatPhotoAge(age)}
              </div>
              {taken && <div style={{ fontSize: 13, color: '#d1d5db', marginTop: 2 }}>{taken}</div>}
            </>
          )}
          {stale && (
            <div style={{ marginTop: 8, color: AMBER, fontSize: 12, lineHeight: 1.4 }}>
              ⚠ This photo is more than 3 hours old. It may not show the river as it is now.
            </div>
          )}
        </div>

        <div style={{ position: 'relative', minHeight: 180, background: '#0b1220', borderRadius: 8, overflow: 'hidden' }}>
          {src && !failed && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={`${webcam.name}: still photo taken ${taken || 'at an unknown time'}`}
              // The photo comes straight from USGS's image host; send it no page address.
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              style={{ display: 'block', width: '100%', height: 'auto', opacity: loaded ? 1 : 0, transition: 'opacity 120ms' }}
            />
          )}
          {(!src || failed || !loaded) && (
            <div
              role={!src || failed ? 'alert' : 'status'}
              style={{
                position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                padding: 12, textAlign: 'center', fontSize: 13,
                color: !src || failed ? AMBER : '#9ca3af',
              }}
            >
              {!src ? 'No photo is available for this camera.' : failed ? 'The photo could not be loaded. Check your connection and reopen this camera.' : 'Loading photo…'}
            </div>
          )}
        </div>

        {dark && (
          <div style={{ marginTop: 8, color: '#9ca3af', fontSize: 12, lineHeight: 1.4 }}>
            🌙 This photo was taken after dark, so it may look black or grainy{stale ? '.' : '. That does not mean the camera is broken.'}
          </div>
        )}
        {webcam.daylightOnly && (
          <div style={{ marginTop: 6, color: '#9ca3af', fontSize: 12, lineHeight: 1.4 }}>
            This camera only photographs in daylight, so overnight the newest photo is from the evening before.
          </div>
        )}

        {onOpenGauge && (
          <button
            onClick={onOpenGauge}
            style={{
              marginTop: 12, width: '100%', minHeight: 44, textAlign: 'left',
              background: '#1f2937', border: '1px solid #374151', borderRadius: 8,
              color: '#e5e7eb', fontSize: 14, padding: '8px 12px', cursor: 'pointer',
            }}
          >
            View the river gauge{gaugeName ? `: ${gaugeName}` : ''} →
          </button>
        )}

        {siblings.length > 0 && onSelectSibling && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>Other cameras at this spot</div>
            {siblings.map(s => (
              <button
                key={s.id}
                onClick={() => onSelectSibling(s)}
                style={{
                  display: 'block', width: '100%', minHeight: 44, textAlign: 'left', marginBottom: 6,
                  background: '#1f2937', border: '1px solid #374151', borderRadius: 8,
                  color: '#e5e7eb', fontSize: 13, padding: '8px 12px', cursor: 'pointer',
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        <div style={{ marginTop: 12, color: '#9ca3af', fontSize: 11, lineHeight: 1.5 }}>
          <div>Image: USGS</div>
          <div>
            A still photo that the camera takes every {webcam.intervalMin ? `${webcam.intervalMin} minutes` : '15 to 60 minutes'}, when it is working. It is not live video, and
            it is not an official flood report. For flood status use the gauge and your local emergency officials.
          </div>
        </div>
      </div>
    </>
  );
}
