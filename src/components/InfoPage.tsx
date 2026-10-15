import type { ReactNode } from 'react';
import Link from 'next/link';

// Plain text pages on the website (/privacy, /support). The store listings link to them
// and the apps open them in the in-app browser (src/lib/externalLink.ts), so they are
// static, readable on a phone and need no JavaScript.

export const CONTACT_URL = 'https://github.com/feetball/lakes-and-rivers-2/issues';

export default function InfoPage({ title, updated, children }: { title: string; updated?: string; children: ReactNode }) {
  return (
    // The map page fixes the body to the viewport height, so this page scrolls itself.
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <article
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: 'calc(env(safe-area-inset-top, 0px) + 24px) max(20px, env(safe-area-inset-right, 0px)) calc(env(safe-area-inset-bottom, 0px) + 48px) max(20px, env(safe-area-inset-left, 0px))',
          fontSize: 16,
          lineHeight: 1.6,
          color: '#cbd5e1',
        }}
      >
        <p style={{ margin: '0 0 8px', fontSize: 14 }}>
          <Link href="/" style={{ color: '#60a5fa' }}>Texas Flood Map</Link>
        </p>
        <h1 style={{ margin: '0 0 4px', fontSize: 28, lineHeight: 1.25, color: '#f1f5f9' }}>{title}</h1>
        {updated && <p style={{ margin: '0 0 24px', fontSize: 14, color: '#94a3b8' }}>Last updated {updated}</p>}
        {children}
      </article>
      <style>{`
        article h2 { margin: 32px 0 8px; font-size: 20px; color: #f1f5f9; }
        article p, article ul { margin: 0 0 14px; }
        article ul { padding-left: 22px; }
        article li { margin-bottom: 6px; }
        article a { color: #60a5fa; }
        article strong { color: #e2e8f0; }
      `}</style>
    </div>
  );
}
