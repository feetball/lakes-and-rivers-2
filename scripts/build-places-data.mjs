#!/usr/bin/env node
// Builds public/data/tx-places.json, the bundled list of Texas places that the
// gauge list's place search ("Gauges near Kerrville") runs on. The generated file
// is COMMITTED (it changes about once a year), so a normal build never touches the
// network; run this by hand when the Census publishes a new Gazetteer:
//
//   pnpm data:places                # uses .cache/census/ if the files are already there
//   pnpm data:places -- --refresh   # download again
//   pnpm data:places -- --year=2026 # pin a Gazetteer year instead of the newest
//
// Sources (US Census Bureau, public domain), all under
// https://www2.census.gov/geo/docs/maps-data/data/gazetteer/ :
//   <newest year>_Gazetteer/<year>_gaz_place_48.txt   names + internal points of every
//       incorporated place and census designated place (CDP) in Texas (FIPS state 48).
//   2010_place_list_48.txt   the only Gazetteer vintage that carries a population column
//       (POP10); the newer place files dropped it. Population is used for ranking
//       search results only and never shown, so a 2010 count is good enough: it is
//       joined on GEOID, and a place that did not exist in 2010 (about 7% of the list,
//       mostly newer CDPs) gets 0 and sorts after the known ones.
//
// Output: an array of [name, lat, lon, population] rows, most populous first, e.g.
//   ["Houston",29.7857,-95.3888,2099451]
// Names have the Census legal-area suffix removed ("Austin city" -> "Austin").
// Coordinates are the Census internal points, rounded to 4 decimals (about 10 m).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/tx-places.json');
const CACHE = resolve(ROOT, '.cache/census');
const GAZETTEER = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/';
const USER_AGENT = 'texas-flood-map (+https://txfloods.kuecker.us)';
const TX = '48';
const POPULATION_YEAR = 2010;
// The app downloads this file the first time someone opens Search (and ships it inside
// the store apps), so keep it small. The Texas list is about 70 KB.
const MAX_BYTES = 150 * 1024;
const MIN_PLACES = 1500;

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const pinnedYear = args.find(a => a.startsWith('--year='))?.slice('--year='.length);

async function download(url, cacheName) {
  const file = resolve(CACHE, cacheName);
  if (!REFRESH && existsSync(file)) return readFileSync(file, 'utf8');
  console.log(`[places] GET ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, text);
  return text;
}

// Newest <year>_Gazetteer/ folder that actually holds a Texas place file (a freshly
// published year can be partial for a day or two).
async function findPlaceFile() {
  const index = await download(GAZETTEER, 'gazetteer-index.html');
  const years = [...index.matchAll(/href="(\d{4})_Gazetteer\/"/g)].map(m => Number(m[1]));
  const candidates = pinnedYear ? [Number(pinnedYear)] : [...new Set(years)].sort((a, b) => b - a);
  for (const year of candidates) {
    try {
      const text = await download(`${GAZETTEER}${year}_Gazetteer/${year}_gaz_place_${TX}.txt`, `${year}_gaz_place_${TX}.txt`);
      return { year, text };
    } catch (err) {
      console.warn(`[places] ${year}: ${err.message}`);
    }
  }
  throw new Error('no Gazetteer year with a Texas place file was found');
}

// The Gazetteer is pipe-delimited since 2020 and tab-delimited before that, with
// padded fields. Returns one object per row, keyed by the header names.
function parseTable(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const delimiter = lines[0].includes('\t') ? '\t' : '|';
  const header = lines[0].split(delimiter).map(s => s.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(delimiter).map(s => s.trim());
    return Object.fromEntries(header.map((name, i) => [name, cells[i]]));
  });
}

// "Austin city" -> "Austin", "Hunt CDP" -> "Hunt". The suffix is the Census legal/statistical
// area description. "Town of Pecos city" is the legal name of Pecos.
function displayName(censusName) {
  return censusName
    .replace(/ (city|town|village|CDP|municipality|borough)$/, '')
    .replace(/^Town of /, '');
}

const { year, text: placeText } = await findPlaceFile();
const places = parseTable(placeText);
const population = new Map(
  parseTable(await download(`${GAZETTEER}${POPULATION_YEAR}_place_list_${TX}.txt`, `${POPULATION_YEAR}_place_list_${TX}.txt`))
    .map(r => [r.GEOID, Number(r.POP10)]),
);

const rows = [];
let withoutPopulation = 0;
for (const p of places) {
  const lat = Number(p.INTPTLAT);
  const lon = Number(p.INTPTLONG);
  const name = displayName(p.NAME ?? '');
  // Skip anything without a usable name or point rather than shipping a place the map can't fly to.
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const pop = population.get(p.GEOID);
  if (!Number.isFinite(pop)) withoutPopulation++;
  rows.push([name, Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, Number.isFinite(pop) ? pop : 0]);
}
rows.sort((a, b) => b[3] - a[3] || a[0].localeCompare(b[0], 'en'));

const json = `[\n${rows.map(r => JSON.stringify(r)).join(',\n')}\n]\n`;
const bytes = Buffer.byteLength(json);
if (rows.length < MIN_PLACES) throw new Error(`only ${rows.length} places parsed (expected at least ${MIN_PLACES}); not writing`);
if (bytes > MAX_BYTES) throw new Error(`${bytes} bytes is over the ${MAX_BYTES} byte budget; not writing`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(`${OUT}.tmp`, json);
renameSync(`${OUT}.tmp`, OUT);
console.log(
  `[places] wrote ${OUT}: ${rows.length} places, ${(bytes / 1024).toFixed(1)} KB ` +
    `(names and points from the ${year} Gazetteer; population from the ${POPULATION_YEAR} Gazetteer, ${withoutPopulation} places without one)`,
);
console.log(`[places] top: ${rows.slice(0, 5).map(r => `${r[0]} ${r[3]}`).join(', ')}`);
