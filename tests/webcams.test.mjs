// Unit tests for src/lib/webcams.ts and src/lib/sun.ts. The fixtures are real:
// tests/fixtures/nims-cameras-sample.json is 17 entries cut from the live USGS NIMS list
// (api.waterdata.usgs.gov/nims/v0/cameras, read 2026-10-02) and gauge-sites-sample.json is
// 16 gauges from public/data/gauges-meta.json. Run: pnpm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createWebcamSource,
  formatPhotoAge,
  formatPhotoTime,
  imageUrlFor,
  isAllowedImageUrl,
  isValidCameraId,
  linkGauges,
  normalizeWebcams,
  parseWebcamsResponse,
  partitionWebcams,
  webcamStatus,
  camerasNear,
} from '../src/lib/webcams.ts';
import { isDarkAt, sunElevationDeg } from '../src/lib/sun.ts';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const NIMS = fixture('nims-cameras-sample.json');
const SITES = fixture('gauge-sites-sample.json');
// 2026-10-02 07:00 CDT, 19 minutes after the Comfort photo.
const NOW = Date.parse('2026-10-02T12:00:00Z');
const byId = (list, id) => list.find((w) => w.id === id);

test('normalizeWebcams keeps visible Texas cameras only', () => {
  const list = normalizeWebcams(NIMS, NOW);
  assert.equal(list.length, 13); // 15 Texas entries, 2 of them hideCam
  assert.ok(!byId(list, 'IL_Lick_Creek_near_Woodside'));
  assert.ok(!byId(list, 'TX_Lake_Conroe_near_Conroe')); // hideCam
  assert.ok(!byId(list, 'TX_W_Fk_San_Jacinto_Rv_nr_Humbl')); // hideCam
  assert.deepEqual(list.map((w) => w.id), [...list.map((w) => w.id)].sort());
});

test('normalizeWebcams reads NIMS quirks: string coordinates, lng, placeholder site numbers', () => {
  const list = normalizeWebcams(NIMS, NOW);
  const comfort = byId(list, 'TX_Guadalupe_Rv_at_Comfort');
  assert.equal(comfort.lat, 29.965238888888887);
  assert.equal(comfort.lon, -98.89716666666668);
  assert.equal(comfort.usgsId, '08167000');
  assert.equal(comfort.newestImageAt, '2026-10-02T11:41:21.000Z');
  assert.equal(
    comfort.imageUrl,
    'https://usgs-nims-images.s3.amazonaws.com/720/TX_Guadalupe_Rv_at_Comfort/TX_Guadalupe_Rv_at_Comfort___2026-10-02T11-41-21Z.jpg',
  );
  assert.equal(comfort.daylightOnly, false);
  assert.equal(comfort.intervalMin, 15);
  assert.equal(byId(list, 'TX_Olmos_Dam_on_Olmos_Creek_near_San_Antonio').usgsId, null); // "888888"
  assert.equal(byId(list, 'TX_Blanco_River_at_Wimberley').daylightOnly, true);
  const ray = byId(list, 'TX_Ray_Roberts_Lake_near_Pilot_Point'); // no image time at all
  assert.equal(ray.newestImageAt, null);
  assert.equal(ray.imageUrl, null);
});

test('normalizeWebcams drops bad entries and rejects absurd photo times', () => {
  const base = NIMS[0];
  const bad = [
    null,
    'x',
    { ...base, camId: '../etc/passwd' },
    { ...base, camId: 'a b' },
    { ...base, lat: 'abc' },
    { ...base, lat: '51.5', lng: '-0.1' }, // not Texas
  ];
  assert.deepEqual(normalizeWebcams(bad, NOW), []);
  assert.deepEqual(normalizeWebcams({ not: 'a list' }, NOW), []);
  const future = normalizeWebcams([{ ...base, newestImageDT: '2031-01-01T00:00:00Z' }], NOW)[0];
  assert.equal(future.newestImageAt, null);
  const html = normalizeWebcams([{ ...base, camName: '<img src=x onerror=1>\n  Two  ' }], NOW)[0];
  assert.equal(html.name, '<img src=x onerror=1> Two'); // text only; React escapes it
});

test('staleness: fresh under 3 h, stale to 24 h, offline beyond or without a photo', () => {
  const list = normalizeWebcams(NIMS, NOW);
  const status = (id) => webcamStatus(byId(list, id), NOW);
  assert.equal(status('TX_Guadalupe_Rv_at_Comfort'), 'fresh'); // 19 min
  assert.equal(status('TX_Blanco_River_at_Wimberley'), 'stale'); // 11.5 h
  assert.equal(status('TX_Clear_Fk_Trinity_Rv_nr_Benbrook'), 'stale'); // 15 h
  assert.equal(status('TX_Turtle_Ck_at_Dallas'), 'offline'); // July
  assert.equal(status('TX_San_Pedro_Ck_at_Furnish_St_San_Antonio'), 'offline'); // 2019
  assert.equal(status('TX_Ray_Roberts_Lake_near_Pilot_Point'), 'offline'); // none
  const { shown, offline } = partitionWebcams(list, NOW);
  assert.equal(shown.length, 10);
  assert.equal(offline.length, 3);
  // Exact boundaries, and a clock a little ahead of USGS's is not "offline".
  const at = (ms) => webcamStatus({ newestImageAt: new Date(NOW - ms).toISOString() }, NOW);
  assert.equal(at(3 * 3_600_000), 'fresh');
  assert.equal(at(3 * 3_600_000 + 1000), 'stale');
  assert.equal(at(24 * 3_600_000), 'stale');
  assert.equal(at(24 * 3_600_000 + 1000), 'offline');
  assert.equal(at(-5 * 60_000), 'fresh');
});

test('camera ids and photo URLs: only the USGS image host, only a camera that matches its folder', () => {
  assert.ok(isValidCameraId('TX_Guadalupe_Rv_at_Comfort'));
  for (const id of ['', 'ab', 'a/b', '../x', 'a b', 'x'.repeat(121), 'TX-Rv', 'a\nb', null, 5, undefined]) {
    assert.equal(isValidCameraId(id), false, String(id));
  }
  const good = imageUrlFor('TX_Turtle_Ck_at_Dallas', '2026-07-20T23:00:02.000Z');
  assert.equal(good, 'https://usgs-nims-images.s3.amazonaws.com/720/TX_Turtle_Ck_at_Dallas/TX_Turtle_Ck_at_Dallas___2026-07-20T23-00-02Z.jpg');
  assert.ok(isAllowedImageUrl(good));
  assert.equal(imageUrlFor('../x', '2026-07-20T23:00:02Z'), null);
  assert.equal(imageUrlFor('TX_Turtle_Ck_at_Dallas', 'yesterday'), null);
  const bads = [
    good.replace('https://', 'http://'),
    good.replace('usgs-nims-images.s3.amazonaws.com', 'evil.example.com'),
    good.replace('usgs-nims-images.s3.amazonaws.com', 'usgs-nims-images.s3.amazonaws.com.evil.example'),
    good.replace('usgs-nims-images.s3.amazonaws.com', 'usgs-nims-images.s3.amazonaws.com@evil.example'),
    good + '?x=1',
    good.replace('/720/', '/thumbnail/'),
    good.replace('/TX_Turtle_Ck_at_Dallas___', '/TX_Other_Camera___'), // folder and file disagree
    good.replace('.jpg', '.svg'),
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    `${good}`.repeat(3),
    null,
    42,
  ];
  for (const u of bads) assert.equal(isAllowedImageUrl(u), false, String(u));
});

test('parseWebcamsResponse re-validates what the network returns', () => {
  const list = normalizeWebcams(NIMS, NOW);
  const ok = parseWebcamsResponse({ webcams: list, updatedAt: '2026-10-02T11:50:00.000Z' });
  assert.equal(ok.webcams.length, list.length);
  const evil = { ...list[0], imageUrl: 'https://evil.example/x.jpg', name: 'Evil' };
  const parsed = parseWebcamsResponse({ webcams: [evil, list[1]], updatedAt: 'x' });
  assert.equal(parsed.webcams[0].imageUrl, null);
  assert.throws(() => parseWebcamsResponse({ error: 'cameras unavailable' }), /not a camera list/);
  assert.throws(() => parseWebcamsResponse(null));
  assert.throws(() => parseWebcamsResponse({ webcams: [{ id: '../x' }], updatedAt: 'x' }), /no usable/);
  // A list that really is empty is a list; the server never sends one (see the source tests).
  assert.deepEqual(parseWebcamsResponse({ webcams: [], updatedAt: 'x' }).webcams, []);
});

test('linkGauges: by USGS number, then by position for a gauge with no number', () => {
  const linked = linkGauges(normalizeWebcams(NIMS, NOW), SITES);
  const gauge = (id) => byId(linked, id).gaugeId;
  assert.equal(gauge('TX_Guadalupe_Rv_at_Comfort'), 'COMT2');
  assert.equal(gauge('TX_Blanco_River_at_Wimberley'), 'WMBT2');
  assert.equal(gauge('TX_Barker_Reservoir_near_Addicks'), 'BAKT2');
  assert.equal(gauge('TX_Barker_Reservoir_near_Addicks_OUTFLOW_CULVERTS'), 'BAKT2'); // two cameras, one gauge
  assert.equal(gauge('TX_Addicks_Reservoir_near_Addicks'), 'ADDT2');
  assert.equal(gauge('TX_Zacate_Creek_at_Jacaman_Road_Laredo'), 'ZAJT2'); // gauge without a number, 5 m away
  assert.equal(gauge('TX_Langham_Creek_at_Addicks_Reservoir_Outflow_near_Addicks'), null); // 08073100: no such gauge
  assert.equal(gauge('TX_Olmos_Dam_on_Olmos_Creek_near_San_Antonio'), null);
  // A far-away gauge with the same number is a typo, not a match.
  const far = linkGauges(normalizeWebcams([NIMS[0]], NOW), [{ id: 'FAR', lat: 40, lon: -100, usgsId: '08167000' }]);
  assert.equal(far[0].gaugeId, null);
});

test('camerasNear finds the cameras sharing a spot', () => {
  const list = normalizeWebcams(NIMS, NOW);
  const near = camerasNear(byId(list, 'TX_Barker_Reservoir_near_Addicks'), list);
  assert.deepEqual(near.map((w) => w.id), ['TX_Barker_Reservoir_near_Addicks_OUTFLOW_CULVERTS']);
  assert.deepEqual(camerasNear(byId(list, 'TX_Guadalupe_Rv_at_Comfort'), list), []);
});

test('formatPhotoAge rounds down and never claims a younger photo', () => {
  const m = 60_000;
  assert.equal(formatPhotoAge(0), 'just now');
  assert.equal(formatPhotoAge(59_000), 'just now');
  assert.equal(formatPhotoAge(12 * m), '12 min ago');
  assert.equal(formatPhotoAge(60 * m), '1 h ago');
  assert.equal(formatPhotoAge(130 * m), '2 h 10 min ago');
  assert.equal(formatPhotoAge(27 * 60 * m), '1 d 3 h ago');
  assert.equal(formatPhotoAge(9 * 86_400_000), '9 days ago');
});

test('formatPhotoTime shows the viewer-zone time with its name', () => {
  const opts = { locale: 'en-US', timeZone: 'America/Chicago', nowMs: NOW };
  assert.match(formatPhotoTime('2026-10-02T11:41:21Z', opts), /^Fri,? 6:41 AM CDT$/);
  assert.match(formatPhotoTime('2026-07-20T23:00:02Z', opts), /^Jul 20,? 6:00 PM CDT$/); // over a week: a date, not a weekday
  assert.equal(formatPhotoTime('garbage', opts), '');
});

// ---------------------------------------------------------------------------
// The server-side source
// ---------------------------------------------------------------------------

function fakeFetch(plan) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = plan.shift();
    if (step instanceof Error) throw step;
    return step;
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('source: one USGS read per ttl, the right URL and a User-Agent, no other host', async () => {
  let t = NOW;
  const f = fakeFetch([json(NIMS), json(NIMS)]);
  const src = createWebcamSource({ fetchImpl: f, now: () => t });
  const a = await src.load();
  assert.equal(a.source, 'fresh');
  assert.equal(a.webcams.length, 13);
  assert.equal((await src.load()).source, 'cache');
  t += 9 * 60_000;
  assert.equal((await src.load()).source, 'cache');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.waterdata.usgs.gov/nims/v0/cameras');
  assert.match(f.calls[0].init.headers['User-Agent'], /texas-flood-map/);
  t += 2 * 60_000;
  assert.equal((await src.load()).source, 'fresh');
  assert.equal(f.calls.length, 2);
});

test('source: concurrent requests share one read', async () => {
  const f = fakeFetch([json(NIMS)]);
  const src = createWebcamSource({ fetchImpl: f, now: () => NOW });
  const all = await Promise.all([src.load(), src.load(), src.load()]);
  assert.equal(f.calls.length, 1);
  assert.ok(all.every((r) => r.webcams.length === 13));
});

test('source: serves the last good list when USGS fails, then gives up', async () => {
  let t = NOW;
  const f = fakeFetch([json(NIMS), json('nope', 503), json('nope', 503)]);
  const src = createWebcamSource({ fetchImpl: f, now: () => t, ttlMs: 60_000, retryMs: 30_000, staleMaxMs: 3_600_000 });
  await src.load();
  t += 61_000;
  const stale = await src.load();
  assert.equal(stale.source, 'stale');
  assert.equal(stale.fetchedAt, NOW); // the list's own age is kept, so the app can show it
  t += 10_000; // inside the retry back-off: USGS is not asked again
  assert.equal((await src.load()).source, 'stale');
  assert.equal(f.calls.length, 2);
  t += 3_600_000; // older than staleMaxMs: an error, not old news
  await assert.rejects(src.load());
});

test('source: failures without a cached list are errors, never an empty list', async () => {
  for (const bad of [
    json('nope', 500),
    json('not json'),
    json([]),
    json(NIMS.filter((c) => c.stateAbrv !== 'TX')), // a list with no Texas cameras
    json({ cameras: [] }),
    json('x'.repeat(8_000_001)), // not the list
    new Error('network'),
  ]) {
    const src = createWebcamSource({ fetchImpl: fakeFetch([bad]), now: () => NOW });
    await assert.rejects(src.load());
  }
});

test('source: a hung USGS is cut off by the timeout', async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const src = createWebcamSource({ fetchImpl: hang, now: () => NOW, timeoutMs: 20 });
  await assert.rejects(src.load(), /aborted/);
});

// ---------------------------------------------------------------------------
// Sun position (night photos)
// ---------------------------------------------------------------------------

test('sunElevationDeg matches the equinox and solstice noon heights at 30 N', () => {
  const noon = (date, hours) => {
    let best = -90;
    for (let t = Date.parse(`${date}T${hours[0]}:00:00Z`); t < Date.parse(`${date}T${hours[1]}:00:00Z`); t += 60_000) {
      best = Math.max(best, sunElevationDeg(t, 30, -97.7));
    }
    return best;
  };
  assert.ok(Math.abs(noon('2026-09-23', [16, 21]) - 60) < 0.5);
  assert.ok(Math.abs(noon('2026-06-21', [16, 21]) - 83.4) < 0.5);
  assert.ok(Math.abs(noon('2026-12-21', [16, 21]) - 36.6) < 0.5);
});

test('isDarkAt: real camera photos from the fixture', () => {
  const photo = (id) => {
    const c = byId(normalizeWebcams(NIMS, NOW), id);
    return [Date.parse(c.newestImageAt), c.lat, c.lon];
  };
  assert.equal(isDarkAt(...photo('TX_Guadalupe_Rv_at_Comfort')), true); // 6:41 AM CDT, before dawn: the photo is black
  assert.equal(isDarkAt(...photo('TX_Blanco_River_at_Wimberley')), false); // 7:31 PM CDT, last daylight frame, dusk
  assert.equal(isDarkAt(Date.parse('2026-10-02T18:00:00Z'), 30.27, -97.74), false); // Austin at 1 PM
  assert.equal(isDarkAt(Date.parse('2026-10-02T06:00:00Z'), 30.27, -97.74), true); // Austin at 1 AM
  // Austin sunrise and sunset on 2 Oct 2026 are about 7:22 AM and 7:10 PM CDT.
  assert.equal(isDarkAt(Date.parse('2026-10-02T12:25:00Z'), 30.27, -97.74), false);
  assert.equal(isDarkAt(Date.parse('2026-10-03T00:20:00Z'), 30.27, -97.74), false);
});
