// Texas places for the gauge list's place search ("Gauges near Kerrville"). The data is
// public/data/tx-places.json, built from the US Census Gazetteer by
// scripts/build-places-data.mjs: [name, lat, lon, population] rows, most populous first.
// It is a same-origin static file (inside the app bundle in the store apps), fetched the
// first time Search is opened, so choosing a place needs no network call to anyone else.

import { formatMiles, haversineKm, scoreTokens, tokenize } from './gaugeList.ts';

export interface Place {
  name: string;
  lat: number;
  lon: number;
  /** 2010 Census count, used only to rank search results. 0 when unknown. */
  population: number;
}

export const PLACES_URL = '/data/tx-places.json';

// The real file has about 1,860 rows. Far fewer means a truncated or wrong download, which
// must surface as "place search unavailable", not as a search that quietly finds nothing.
const MIN_PLACES = 1000;
// A place at least this big is something to describe an unfamiliar place by ("12 mi from Terrell").
const LANDMARK_MIN_POPULATION = 10_000;

/** The rows of the file as places; null when the shape is wrong or too few rows are valid. */
export function parsePlaces(json: unknown): Place[] | null {
  if (!Array.isArray(json)) return null;
  const places: Place[] = [];
  for (const row of json) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [name, lat, lon, population] = row;
    if (typeof name !== 'string' || name === '') continue;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    places.push({ name, lat, lon, population: typeof population === 'number' && population > 0 ? population : 0 });
  }
  return places.length >= MIN_PLACES ? places : null;
}

export interface PlaceIndex {
  places: readonly Place[];
  tokens: readonly (readonly string[])[];
  /** Places big enough to describe other places by. */
  landmarks: readonly Place[];
  /** Search-normalized names that more than one place has. */
  repeated: ReadonlySet<string>;
}

export function buildPlaceIndex(places: readonly Place[]): PlaceIndex {
  const tokens = places.map(p => tokenize(p.name));
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t.join(' '), (counts.get(t.join(' ')) ?? 0) + 1);
  return {
    places,
    tokens,
    landmarks: places.filter(p => p.population >= LANDMARK_MIN_POPULATION),
    repeated: new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name)),
  };
}

/** Best match first, then the more populous place. Same word matching as gauge search ("ft worth" finds Fort Worth). */
export function searchPlaces(index: PlaceIndex, query: string, limit = 5): Place[] {
  const typed = tokenize(query);
  if (typed.length === 0) return [];
  const hits: { place: Place; score: number }[] = [];
  index.places.forEach((place, i) => {
    const score = scoreTokens(typed, index.tokens[i]);
    if (score > 0) hits.push({ place, score });
  });
  hits.sort((a, b) => b.score - a.score || b.place.population - a.place.population || a.place.name.localeCompare(b.place.name, 'en'));
  return hits.slice(0, limit).map(h => h.place);
}

/**
 * Texas has several places with the same name (three Chula Vistas, two Oak Ridges), so a
 * repeated name needs something to tell the results apart: how far it is from the nearest
 * bigger place, e.g. "11 mi from Dallas". Null for a name that is unique.
 */
export function placeHint(index: PlaceIndex, place: Place): string | null {
  if (!index.repeated.has(tokenize(place.name).join(' '))) return null;
  let nearest: { name: string; km: number } | null = null;
  for (const landmark of index.landmarks) {
    if (landmark === place || landmark.name === place.name) continue;
    const km = haversineKm(place, landmark);
    if (!nearest || km < nearest.km) nearest = { name: landmark.name, km };
  }
  return nearest ? `${formatMiles(nearest.km)} from ${nearest.name}` : null;
}

let loading: Promise<PlaceIndex> | null = null;

/** Loads the places file once and keeps it. A failure is not remembered, so the next call retries. */
export function loadPlaceIndex(fetchImpl: typeof fetch = fetch): Promise<PlaceIndex> {
  loading ??= fetchImpl(PLACES_URL)
    .then(res => {
      if (!res.ok) throw new Error(`places ${res.status}`);
      return res.json() as Promise<unknown>;
    })
    .then(json => {
      const places = parsePlaces(json);
      if (!places) throw new Error('places file is malformed');
      return buildPlaceIndex(places);
    })
    .catch(err => {
      loading = null;
      throw err;
    });
  return loading;
}
