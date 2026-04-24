'use client';

interface Props { label: string; }

// Small status pill shown at top-center while initial data is loading.
export default function LoadingBanner({ label }: Props) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 'calc(env(safe-area-inset-top, 0) + 12px)',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(17,24,39,0.92)',
        backdropFilter: 'blur(6px)',
        color: '#e5e7eb',
        borderRadius: 999,
        padding: '6px 14px',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        zIndex: 1100,
        boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      }}
    >
      <span
        style={{
          width: 10, height: 10, borderRadius: 5, background: '#f97316',
          animation: 'tfm-pulse-top 1s ease-in-out infinite',
        }}
      />
      {label}
      <style>{`@keyframes tfm-pulse-top { 0%,100% { opacity: 0.3 } 50% { opacity: 1 } }`}</style>
    </div>
  );
}
