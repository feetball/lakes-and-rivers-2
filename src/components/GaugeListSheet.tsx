'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatAge } from '@/lib/floodStatus';
import {
  NEAR_RADIUS_KM,
  buildGaugeIndex,
  favoriteItems,
  kmToMiles,
  nearbyItems,
  searchGauges,
  type GaugeListItem,
  type NearbyResult,
  type SortMode,
} from '@/lib/gaugeList';
import { loadPlaceIndex, placeHint, searchPlaces, type Place, type PlaceIndex } from '@/lib/places';
import { pushBackHandler } from '@/lib/backButton';
import { useFavorites } from '@/hooks/useFavorites';
import { useDeviceLocation } from '@/hooks/useDeviceLocation';
import type { GaugeStatus } from '@/lib/types';
import type { GaugeListData } from './GaugeListControl';
import GaugeListRow from './GaugeListRow';
import { COLORS } from './gaugeListTheme';

interface Props extends GaugeListData {
  onClose: () => void;
  onPickGauge: (gauge: GaugeStatus) => void;
  onPickPlace: (place: Place) => void;
}

type Tab = 'favorites' | 'near' | 'search';
const TABS: { id: Tab; label: string }[] = [
  { id: 'favorites', label: 'Favorites' },
  { id: 'near', label: 'Near me' },
  { id: 'search', label: 'Search' },
];

const NEAR_MILES = Math.round(kmToMiles(NEAR_RADIUS_KM));
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const buttonStyle = {
  minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: COLORS.accent, color: COLORS.onAccent, font: 'inherit', fontSize: 15, fontWeight: 600,
} as const;

// Bottom sheet in GaugeSheet's visual pattern with three ways to a gauge. It is also the
// text alternative to the canvas map: everything on the map can be reached from here
// without seeing it.
export default function GaugeListSheet({
  gauges, updatedAt, loading, refreshFailed, snapshot, onClose, onPickGauge, onPickPlace,
}: Props) {
  const { favorites } = useFavorites();
  const [tab, setTab] = useState<Tab>(() => (favorites.length > 0 ? 'favorites' : 'search'));
  const dialogRef = useRef<HTMLDivElement>(null);

  // Readings age while the sheet is open, so re-evaluate "stale" and "5 minutes ago" each minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // The parent re-renders often and passes a new onClose each time; going through a ref keeps
  // this effect (which moves focus) to once per open.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    dialogRef.current?.focus();
    const offBack = pushBackHandler(() => closeRef.current());
    // On the document, not the dialog: when the focused button is replaced (opening a place
    // swaps the search results for a list) focus falls to <body>, and Escape must still work.
    const onEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onEscape);
    return () => {
      offBack();
      document.removeEventListener('keydown', onEscape);
    };
  }, []);

  const list = useMemo(() => Object.values(gauges ?? {}), [gauges]);
  const hasData = list.length > 0;

  const pick = useCallback((item: GaugeListItem) => onPickGauge(item.gauge), [onPickGauge]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return;
    // Keep Tab inside the dialog: the map behind it is not reachable while it is open.
    const els = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!els || els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onTabKeyDown(e: React.KeyboardEvent, at: number) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(at + step + TABS.length) % TABS.length];
    setTab(next.id);
    document.getElementById(`gl-tab-${next.id}`)?.focus();
  }

  const updatedAge = updatedAt && !snapshot ? ageText(updatedAt, now) : null;

  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1200 }} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Gauge list: favorites, gauges near you and search. A text alternative to the map."
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, maxWidth: 560, marginInline: 'auto',
          height: '80dvh', display: 'flex', flexDirection: 'column',
          background: COLORS.panel, color: COLORS.text, outline: 'none',
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          padding: '12px 18px calc(env(safe-area-inset-bottom, 0px) + 12px)',
          zIndex: 1201, boxShadow: '0 -6px 24px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: COLORS.border }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 600 }}>Gauges</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close gauge list"
            style={{ width: 44, height: 44, background: 'transparent', border: 'none', color: COLORS.muted, fontSize: 26, lineHeight: 1, cursor: 'pointer' }}
          >×</button>
        </div>

        <div role="tablist" aria-label="Gauge list sections" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {TABS.map((t, i) => {
            const on = t.id === tab;
            return (
              <button
                key={t.id}
                id={`gl-tab-${t.id}`}
                role="tab"
                type="button"
                aria-selected={on}
                aria-controls="gl-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={e => onTabKeyDown(e, i)}
                style={{
                  flex: 1, minHeight: 44, borderRadius: 8, font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  background: on ? COLORS.accent : COLORS.raised, color: on ? COLORS.onAccent : COLORS.text,
                  border: `1px solid ${on ? COLORS.accent : COLORS.border}`,
                }}
              >{t.label}</button>
            );
          })}
        </div>

        <DataNotice
          hasData={hasData} loading={loading} refreshFailed={refreshFailed}
          snapshot={snapshot} updatedAge={updatedAge}
        />

        <div id="gl-panel" role="tabpanel" aria-labelledby={`gl-tab-${tab}`} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {hasData && tab === 'favorites' && <FavoritesPanel gauges={gauges ?? {}} now={now} snapshot={snapshot} onPick={pick} onGoSearch={() => setTab('search')} />}
          {hasData && tab === 'near' && <NearPanel list={list} now={now} snapshot={snapshot} onPick={pick} />}
          {hasData && tab === 'search' && <SearchPanel list={list} now={now} snapshot={snapshot} onPick={pick} onPickPlace={onPickPlace} />}
        </div>

        <p style={{ margin: '8px 0 0', fontSize: 11, lineHeight: 1.4, color: COLORS.muted }}>
          Unofficial. Readings and flood categories are from NOAA / National Weather Service gauges
          and are not an official warning.
        </p>
      </div>
    </>
  );
}

function ageText(iso: string, now: number): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  const ms = now - t;
  return ms < 60_000 ? 'just now' : `${formatAge(ms)} ago`;
}

// What the data underneath is: failure and age are always said out loud, never an empty list.
function DataNotice({ hasData, loading, refreshFailed, snapshot, updatedAge }: {
  hasData: boolean; loading: boolean; refreshFailed: boolean; snapshot: boolean; updatedAge: string | null;
}) {
  if (!hasData) {
    return loading ? (
      <p role="status" style={noteStyle(COLORS.muted)}>Loading gauge readings…</p>
    ) : (
      <p role="alert" style={{ ...noteStyle(COLORS.danger), fontSize: 14 }}>
        Gauge readings are not available right now. Check your connection and try again; nothing
        here means the rivers are fine.
      </p>
    );
  }
  return (
    <>
      {refreshFailed && (
        <p role="status" style={{ ...boxStyle, background: COLORS.noticeBg, color: COLORS.noticeText }}>
          Can’t refresh right now. Showing the last saved readings{updatedAge ? `, updated ${updatedAge}` : ''}.
        </p>
      )}
      {snapshot && (
        <p role="status" style={{ ...boxStyle, background: COLORS.infoBg, color: COLORS.infoText }}>
          The map is showing a timeline snapshot, so these are not live readings.
        </p>
      )}
      {!refreshFailed && updatedAge && <p style={noteStyle(COLORS.muted)}>Data updated {updatedAge}.</p>}
    </>
  );
}

const noteStyle = (color: string) => ({ margin: '0 0 8px', fontSize: 12, color }) as const;
const boxStyle = { margin: '0 0 8px', padding: '8px 10px', borderRadius: 8, fontSize: 13, lineHeight: 1.4 } as const;

interface PanelProps {
  now: number;
  snapshot: boolean;
  onPick: (item: GaugeListItem) => void;
}

function Rows({ items, snapshot, onPick, label }: { items: GaugeListItem[]; snapshot: boolean; onPick: PanelProps['onPick']; label: string }) {
  return (
    <ul aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map(item => <GaugeListRow key={item.gauge.id} item={item} snapshot={snapshot} onPick={onPick} />)}
    </ul>
  );
}

function SortToggle({ mode, onChange }: { mode: SortMode; onChange: (m: SortMode) => void }) {
  const opts: [SortMode, string][] = [['status', 'Worst first'], ['distance', 'Nearest first']];
  return (
    <div role="group" aria-label="Sort order" style={{ display: 'flex', gap: 6, margin: '4px 0 6px' }}>
      {opts.map(([m, label]) => (
        <button
          key={m} type="button" aria-pressed={mode === m} onClick={() => onChange(m)}
          style={{
            minHeight: 44, padding: '0 14px', borderRadius: 8, font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            background: mode === m ? COLORS.accent : COLORS.raised, color: mode === m ? COLORS.onAccent : COLORS.text,
            border: `1px solid ${mode === m ? COLORS.accent : COLORS.border}`,
          }}
        >{label}</button>
      ))}
    </div>
  );
}

function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{ padding: '24px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      {children && <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: COLORS.muted }}>{children}</p>}
    </div>
  );
}

function FavoritesPanel({ gauges, now, snapshot, onPick, onGoSearch }: PanelProps & { gauges: Record<string, GaugeStatus>; onGoSearch: () => void }) {
  const { favorites, persistent, toggle } = useFavorites();
  const { items, missing } = useMemo(() => favoriteItems(gauges, favorites, now), [gauges, favorites, now]);
  if (favorites.length === 0) {
    return (
      <Empty title="Star a gauge to see it here">
        Tap the star in a gauge’s details, or find one with Search. Favorites stay on this device.
        <br />
        <button type="button" onClick={onGoSearch} style={{ ...buttonStyle, marginTop: 14 }}>Search gauges</button>
      </Empty>
    );
  }
  return (
    <>
      {!persistent && (
        <p role="status" style={{ ...boxStyle, background: COLORS.noticeBg, color: COLORS.noticeText }}>
          This device is not letting the app save favorites, so they will be lost when you close it.
        </p>
      )}
      <Rows items={items} snapshot={snapshot} onPick={onPick} label="Favorite gauges, worst flood status first" />
      {missing.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 4px', fontSize: 13, color: COLORS.muted }}>
            {snapshot ? 'Not in this timeline snapshot' : 'Not in the current data'}: no reading to show, which is not the same as normal.
          </p>
          <ul aria-label="Favorites without data" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {missing.map(id => (
              <li key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 14 }}>
                <span>Gauge {id}</span>
                <button
                  type="button" onClick={() => toggle(id)} aria-label={`Remove ${id} from favorites`}
                  style={{ minHeight: 44, padding: '0 12px', background: 'transparent', border: 'none', color: COLORS.link, font: 'inherit', fontSize: 14, cursor: 'pointer' }}
                >Remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// Shared by "near me" and "near <place>": the radius sentence, sort toggle and rows.
function NearbyList({ result, subject, snapshot, sort, onSort, onPick }: Omit<PanelProps, 'now'> & {
  result: NearbyResult; subject: string; sort: SortMode; onSort: (m: SortMode) => void;
}) {
  const { items, total, beyondRadius } = result;
  return (
    <>
      <p role="status" style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.4, color: COLORS.muted }}>
        {beyondRadius
          ? `No gauges within ${NEAR_MILES} miles of ${subject}. These are the ${items.length} nearest, so they may be far away.`
          : `${total} gauge${total === 1 ? '' : 's'} within ${NEAR_MILES} miles of ${subject}${total > items.length ? `; showing the nearest ${items.length}` : ''}.`}
      </p>
      {!beyondRadius && <SortToggle mode={sort} onChange={onSort} />}
      <Rows items={items} snapshot={snapshot} onPick={onPick} label={`Gauges near ${subject}`} />
    </>
  );
}

function NearPanel({ list, now, snapshot, onPick }: PanelProps & { list: GaugeStatus[] }) {
  const { fix, busy, failure, permission, locate, refreshPermission } = useDeviceLocation();
  const [sort, setSort] = useState<SortMode>('status');
  const tried = useRef(false);

  // When the OS already allows location, skip the explanation and go straight to the list.
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    void refreshPermission().then(state => { if (state === 'granted') void locate(); });
  }, [refreshPermission, locate]);

  const result = useMemo(
    () => (fix ? nearbyItems(list, fix, { sort, nowMs: now }) : null),
    [list, fix, sort, now],
  );

  if (busy && !fix) return <p role="status" style={{ ...noteStyle(COLORS.muted), fontSize: 14, padding: '16px 0' }}>Finding your location…</p>;
  if (!fix || !result) {
    return (
      <div style={{ padding: '8px 0' }}>
        <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.5 }}>
          To list the gauges closest to you, the app needs your location once. It is only used on this
          device to measure distances: it is never sent anywhere or saved.
        </p>
        {failure && (
          <p role="alert" style={{ ...boxStyle, background: COLORS.noticeBg, color: COLORS.noticeText }}>
            {failure.message}.{' '}
            {failure.kind === 'denied' || permission === 'denied'
              ? 'Allow location for this app in your device settings, then try again. You can still use Search.'
              : failure.kind === 'off'
                ? 'Turn on location services, then try again.'
                : 'Try again, or use Search.'}
          </p>
        )}
        <button type="button" onClick={() => void locate()} style={buttonStyle}>
          {failure ? 'Try again' : 'Show gauges near me'}
        </button>
      </div>
    );
  }
  return (
    <>
      <NearbyList result={result} subject="you" snapshot={snapshot} sort={sort} onSort={setSort} onPick={onPick} />
      <button
        type="button" onClick={() => void locate()} disabled={busy}
        style={{ ...buttonStyle, background: COLORS.raised, border: `1px solid ${COLORS.border}`, color: COLORS.text, marginTop: 12 }}
      >{busy ? 'Updating location…' : 'Update my location'}</button>
      {failure && <p role="alert" style={{ ...boxStyle, background: COLORS.noticeBg, color: COLORS.noticeText, marginTop: 8 }}>{failure.message}. Showing your earlier position.</p>}
    </>
  );
}

function SearchPanel({ list, now, snapshot, onPick, onPickPlace }: PanelProps & { list: GaugeStatus[]; onPickPlace: (p: Place) => void }) {
  const [query, setQuery] = useState('');
  const [placeIndex, setPlaceIndex] = useState<PlaceIndex | null>(null);
  const [placesFailed, setPlacesFailed] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [sort, setSort] = useState<SortMode>('status');
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(() => buildGaugeIndex(list), [list]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hadPlace = useRef(false);

  // Keep focus inside the panel when the view switches between results and a place's list.
  useEffect(() => {
    if (place) headingRef.current?.focus();
    else if (hadPlace.current) inputRef.current?.focus();
    hadPlace.current = place !== null;
  }, [place]);

  useEffect(() => {
    let alive = true;
    loadPlaceIndex()
      .then(idx => { if (alive) setPlaceIndex(idx); })
      .catch(() => { if (alive) setPlacesFailed(true); });
    return () => { alive = false; };
  }, []);

  const gaugeHits = useMemo(() => searchGauges(index, query, { nowMs: now }), [index, query, now]);
  const placeHits = useMemo(() => (placeIndex ? searchPlaces(placeIndex, query, 4) : []), [placeIndex, query]);
  const nearPlace = useMemo(
    () => (place ? nearbyItems(list, place, { sort, nowMs: now }) : null),
    [list, place, sort, now],
  );

  if (place && nearPlace) {
    return (
      <>
        <button
          type="button" onClick={() => setPlace(null)}
          style={{ minHeight: 44, padding: 0, background: 'transparent', border: 'none', color: COLORS.link, font: 'inherit', fontSize: 14, cursor: 'pointer' }}
        >← Back to search</button>
        <h3 ref={headingRef} tabIndex={-1} style={{ margin: '0 0 2px', fontSize: 16, outline: 'none' }}>Gauges near {place.name}</h3>
        <NearbyList result={nearPlace} subject={place.name} snapshot={snapshot} sort={sort} onSort={setSort} onPick={onPick} />
      </>
    );
  }

  const typed = query.trim() !== '';
  return (
    <>
      <label htmlFor="gl-search" style={{ display: 'block', fontSize: 13, color: COLORS.muted, marginBottom: 4 }}>
        Search by river, lake, town or gauge ID (for example HNTT2)
      </label>
      <input
        id="gl-search" ref={inputRef} type="search" value={query} autoComplete="off" autoCorrect="off" spellCheck={false}
        enterKeyHint="search" onChange={e => setQuery(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0 12px', borderRadius: 8, font: 'inherit',
          fontSize: 16, // 16 px or more stops iOS from zooming the page when the field is focused
          background: COLORS.field, color: COLORS.text, border: `1px solid ${COLORS.controlBorder}`,
        }}
      />
      {placesFailed && typed && (
        <p style={{ ...noteStyle(COLORS.muted), marginTop: 8 }}>Place search is unavailable right now; gauge names and IDs still work.</p>
      )}
      {placeHits.length > 0 && (
        <>
          <h3 style={sectionStyle}>Places</h3>
          <ul aria-label="Matching places" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {placeHits.map(p => {
              const hint = placeIndex ? placeHint(placeIndex, p) : null;
              return (
                <li key={`${p.name}:${p.lat}:${p.lon}`} style={{ borderBottom: `1px solid ${COLORS.raised}` }}>
                  <button
                    type="button" onClick={() => { setPlace(p); onPickPlace(p); }}
                    aria-label={`Show gauges near ${p.name}${hint ? `, ${hint}` : ''}`}
                    style={{ width: '100%', minHeight: 48, padding: '6px 2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', color: COLORS.text, font: 'inherit', fontSize: 15, textAlign: 'left', cursor: 'pointer' }}
                  >
                    <span><strong>{p.name}</strong>{hint && <span style={{ color: COLORS.muted, fontSize: 13 }}> · {hint}</span>}</span>
                    <span style={{ color: COLORS.link, fontSize: 13, flexShrink: 0 }}>Gauges near →</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {typed && gaugeHits.total > 0 && (
        <>
          <h3 style={sectionStyle}>Gauges</h3>
          <Rows items={gaugeHits.items} snapshot={snapshot} onPick={onPick} label="Matching gauges" />
          {gaugeHits.total > gaugeHits.items.length && (
            <p style={noteStyle(COLORS.muted)}>Showing the best {gaugeHits.items.length} of {gaugeHits.total} matches. Type more to narrow it down.</p>
          )}
        </>
      )}
      {typed && gaugeHits.total === 0 && placeHits.length === 0 && (
        <p role="status" style={{ ...noteStyle(COLORS.muted), fontSize: 14, marginTop: 12 }}>No gauges or places match “{query.trim()}”.</p>
      )}
    </>
  );
}

const sectionStyle = { margin: '14px 0 2px', fontSize: 13, fontWeight: 600, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5 } as const;

