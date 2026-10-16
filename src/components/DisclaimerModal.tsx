'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { onExternalLinkClick, PRIVACY_URL, TERMS_URL } from '@/lib/externalLink';

// One-time liability disclaimer shown on a visitor's first arrival. Acceptance
// is remembered in localStorage so returning visitors aren't nagged. Bump
// STORAGE_KEY's version suffix to force the disclaimer to re-show everyone
// (e.g. after a material wording change).
// v3: the Terms of use were added (2026-10-15); everyone sees the disclaimer once more.
// v4: stronger warnings and an express release of liability (2026-10-16).
const STORAGE_KEY = 'tx-flood-map:disclaimer-accepted:v4';

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
        zIndex: 1400, overflowY: 'auto', overscrollBehavior: 'contain',
      }}
    >
      {/* Keeps the card clear of the status bar / notch and the home indicator /
          gesture bar on every side. Android scales the text with the system font
          size, so the card can be taller than the screen: it then starts at the
          top and the overlay scrolls, keeping "I understand" reachable. */}
      <div
        style={{
          minHeight: '100%', display: 'flex',
          padding: 'calc(env(safe-area-inset-top, 0px) + 16px) calc(env(safe-area-inset-right, 0px) + 16px) calc(env(safe-area-inset-bottom, 0px) + 16px) calc(env(safe-area-inset-left, 0px) + 16px)',
        }}
      >
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="disclaimer-title"
          aria-describedby="disclaimer-body"
          style={{
            // auto margins centre the card when it fits and, unlike
            // align-items: center, never push its top out of reach when it doesn't.
            margin: 'auto',
            maxWidth: 460,
            width: '100%',
            background: '#111827',
            color: '#e5e7eb',
            borderRadius: 16,
            padding: 22,
            boxShadow: '0 10px 40px rgba(0,0,0,0.55)',
            border: '1px solid #1f2937',
          }}
        >
          <h2 id="disclaimer-title" style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>
            Read before using this map
          </h2>
          <div id="disclaimer-body" style={{ fontSize: 14, lineHeight: 1.55, color: '#cbd5e1' }}>
            <p
              style={{
                margin: '0 0 12px', padding: '10px 12px', borderRadius: 10,
                background: '#7f1d1d', border: '1px solid #ef4444', color: '#fee2e2',
              }}
            >
              <strong>This is not an official warning service.</strong> Do not rely on it to
              decide whether you are safe, or whether to drive, evacuate or stay.
            </p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>
                <strong>Readings can be hours old, wrong or missing.</strong> Gauges can fail or
                stop reporting during a flood. A faded dot with a dashed ring is an old reading.
              </li>
              <li>
                <strong>&ldquo;Normal&rdquo; does not mean safe, and neither does any other
                color.</strong> A gauge measures one spot. Flash floods can rise in minutes on creeks and low-water crossings that have
                no gauge.
              </li>
              <li>
                <strong>This app sends no alerts</strong> and does not watch conditions for you.
                Keep your phone&apos;s emergency alerts on and use NOAA Weather Radio and your local
                alert system.
              </li>
              <li>
                <strong>Never drive or walk into flood water.</strong> Follow evacuation orders
                right away. In an emergency call 911.
              </li>
            </ul>
            <p style={{ margin: '0 0 12px' }}>
              For official flood information use the{' '}
              <ExternalLink href="https://www.weather.gov/">National Weather Service</ExternalLink>,
              the <ExternalLink href="https://water.noaa.gov/">NOAA National Water Prediction Service</ExternalLink>{' '}
              and your local emergency authorities.
            </p>
            <p style={{ margin: '0 0 12px' }}>
              This is an independent app from a private developer. It does not represent any
              government entity and is <strong>not affiliated with or endorsed by</strong> NOAA,
              the National Weather Service, USGS or the State of Texas; it displays their public
              data.
            </p>
            {/* Conspicuous on purpose: a release of the operator's own negligence has to be stated
                expressly and stand out to count under Texas law (see the Terms). DRAFT wording,
                kept in step with /terms: have an attorney review both. */}
            <p
              style={{
                margin: 0, padding: '10px 12px', borderRadius: 10,
                background: '#1f2937', border: '1px solid #4b5563', color: '#f3f4f6',
                fontSize: 13, fontWeight: 700, lineHeight: 1.5,
              }}
            >
              USE AT YOUR OWN RISK. The app and its data are provided &ldquo;as is&rdquo;, with no
              warranty that they are accurate, complete, current or available. To the fullest extent
              the law allows, you agree that the operator is not liable for any loss, damage, injury
              or death that arises from using or relying on this app or its data, including any
              caused by the operator&apos;s own negligence.
            </p>
            <p style={{ margin: '12px 0 0', fontSize: 12, color: '#94a3b8' }}>
              By tapping &ldquo;I understand and agree&rdquo; you accept the{' '}
              <ExternalLink href={TERMS_URL} color="#94a3b8">Terms of use</ExternalLink> and the{' '}
              <ExternalLink href={PRIVACY_URL} color="#94a3b8">Privacy policy</ExternalLink>.
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
            I understand and agree
          </button>
        </div>
      </div>
    </div>
  );
}

function ExternalLink({ href, color = '#60a5fa', children }: { href: string; color?: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={onExternalLinkClick} style={{ color }}>
      {children}
    </a>
  );
}
