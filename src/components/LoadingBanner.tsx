'use client';

interface Props { label: string; sublabel?: string; }

// Prominent status banner shown at top-center while initial data is loading.
// Deliberately large and high-contrast so it's obvious the map isn't yet live.
export default function LoadingBanner({ label, sublabel }: Props) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 'calc(env(safe-area-inset-top, 0) + 16px)',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'calc(100vw - 24px)',
        background: 'rgba(17,24,39,0.96)',
        backdropFilter: 'blur(8px)',
        color: '#f9fafb',
        borderRadius: 14,
        border: '1px solid rgba(249,115,22,0.55)',
        padding: '14px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        zIndex: 1100,
        boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
        animation: 'tfm-banner-in 220ms ease-out',
      }}
      role="status"
      aria-live="polite"
    >
      {/* Animated ring spinner — larger and busier than the old single dot. */}
      <span
        style={{
          flex: '0 0 auto',
          width: 22,
          height: 22,
          borderRadius: '50%',
          border: '3px solid rgba(249,115,22,0.25)',
          borderTopColor: '#f97316',
          animation: 'tfm-spin 0.9s linear infinite',
        }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.25 }}>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.2 }}>{label}</span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>
          {sublabel ?? 'This can take a few seconds…'}
        </span>
      </span>
      <style>{`
        @keyframes tfm-spin { to { transform: rotate(360deg); } }
        @keyframes tfm-banner-in {
          from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  );
}
