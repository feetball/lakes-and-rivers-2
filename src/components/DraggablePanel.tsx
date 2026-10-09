'use client';

import { useEffect, useRef, useState } from 'react';

// CSS positioning used the first time the panel renders. After the user
// drags the panel, an absolute (top, left) override takes precedence and
// is persisted in localStorage.
export interface PanelAnchor {
  top?: number | string;
  bottom?: number | string;
  left?: number | string;
  right?: number | string;
  transform?: string;
}

interface Props {
  storageKey: string;
  defaultAnchor: PanelAnchor;
  zIndex?: number;
  onHide?: () => void;
  children: React.ReactNode;
}

interface SavedPos { x: number; y: number }

function loadPos(key: string): SavedPos | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.x === 'number' && typeof v?.y === 'number') return v;
  } catch {}
  return null;
}

const EDGE_GAP = 4;

// The device's safe-area insets (notch / Dynamic Island / home indicator) in
// px. A panel dragged into the top inset ends up under the status bar, where
// iOS swallows touches, so its handle could never be grabbed again.
function safeInsets() {
  if (typeof document === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);' +
    'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

// Keep a panel of size w×h fully inside the visible, touchable area.
function clampPos(x: number, y: number, w: number, h: number): SavedPos {
  const s = safeInsets();
  const minX = s.left + EDGE_GAP;
  const minY = s.top + EDGE_GAP;
  const maxX = Math.max(minX, window.innerWidth - s.right - w - EDGE_GAP);
  const maxY = Math.max(minY, window.innerHeight - s.bottom - h - EDGE_GAP);
  return { x: Math.max(minX, Math.min(maxX, x)), y: Math.max(minY, Math.min(maxY, y)) };
}

export default function DraggablePanel({ storageKey, defaultAnchor, zIndex = 1000, onHide, children }: Props) {
  const [pos, setPos] = useState<SavedPos | null>(() => loadPos(storageKey));
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Rescue a position saved before the safe-area clamp existed (or on a
  // different screen) that would leave the panel out of reach.
  useEffect(() => {
    setPos(p => {
      const el = elRef.current;
      if (!p || !el) return p;
      const c = clampPos(p.x, p.y, el.offsetWidth, el.offsetHeight);
      if (c.x === p.x && c.y === p.y) return p;
      try { window.localStorage.setItem(storageKey, JSON.stringify(c)); } catch {}
      return c;
    });
  }, [storageKey]);

  // Clamp the persisted position into view when the window resizes (e.g.
  // a panel parked in the bottom-right corner shouldn't disappear when
  // the user shrinks the window).
  useEffect(() => {
    const onResize = () => {
      setPos(p => {
        if (!p) return p;
        const el = elRef.current;
        if (!el) return p;
        const c = clampPos(p.x, p.y, el.offsetWidth, el.offsetHeight);
        return c.x === p.x && c.y === p.y ? p : c;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = elRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
    };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    const el = elRef.current;
    setPos(clampPos(
      d.origX + (e.clientX - d.startX),
      d.origY + (e.clientY - d.startY),
      el?.offsetWidth ?? 0,
      el?.offsetHeight ?? 0,
    ));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
    setPos(p => {
      if (p) {
        try { window.localStorage.setItem(storageKey, JSON.stringify(p)); } catch {}
      }
      return p;
    });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    // Reset to the default anchor.
    e.preventDefault();
    e.stopPropagation();
    try { window.localStorage.removeItem(storageKey); } catch {}
    setPos(null);
  };

  const positioning: React.CSSProperties = pos
    ? { top: pos.y, left: pos.x, right: 'auto', bottom: 'auto', transform: 'none' }
    : { ...defaultAnchor };

  return (
    <div
      ref={elRef}
      style={{
        position: 'absolute',
        zIndex,
        ...positioning,
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
        role="button"
        aria-label="Drag to move panel (double-click to reset)"
        title="Drag to move · double-click to reset"
        style={{
          position: 'relative',
          height: 14,
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
          background: 'rgba(31,41,55,0.92)',
          backdropFilter: 'blur(6px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
          boxShadow: '0 -1px 0 rgba(255,255,255,0.04) inset',
        }}
      >
        <span style={dotStyle} />
        <span style={dotStyle} />
        <span style={dotStyle} />
        {onHide && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onHide(); }}
            aria-label="Hide panel"
            title="Hide panel"
            style={{
              position: 'absolute',
              right: 2,
              top: '50%',
              transform: 'translateY(-50%)',
              height: 14,
              lineHeight: '14px',
              padding: '0 4px',
              border: 'none',
              background: 'none',
              color: '#9ca3af',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

const dotStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 3,
  height: 3,
  borderRadius: 2,
  background: '#6b7280',
};
