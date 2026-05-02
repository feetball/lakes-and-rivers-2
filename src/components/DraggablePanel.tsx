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

export default function DraggablePanel({ storageKey, defaultAnchor, zIndex = 1000, children }: Props) {
  const [pos, setPos] = useState<SavedPos | null>(() => loadPos(storageKey));
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Clamp the persisted position into view when the window resizes (e.g.
  // a panel parked in the bottom-right corner shouldn't disappear when
  // the user shrinks the window).
  useEffect(() => {
    const onResize = () => {
      setPos(p => {
        if (!p) return p;
        const el = elRef.current;
        if (!el) return p;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const maxX = Math.max(4, window.innerWidth - w - 4);
        const maxY = Math.max(4, window.innerHeight - h - 4);
        const x = Math.max(4, Math.min(p.x, maxX));
        const y = Math.max(4, Math.min(p.y, maxY));
        return x === p.x && y === p.y ? p : { x, y };
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
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const maxX = Math.max(4, window.innerWidth - w - 4);
    const maxY = Math.max(4, window.innerHeight - h - 4);
    const nx = Math.max(4, Math.min(maxX, d.origX + (e.clientX - d.startX)));
    const ny = Math.max(4, Math.min(maxY, d.origY + (e.clientY - d.startY)));
    setPos({ x: nx, y: ny });
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
