// Tests for src/lib/alerts-view.ts: freshness verdicts, time wording, NWS text layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alertsState, isAlertsResponse, reflowNwsText, relativeTime, updatedText } from '../src/lib/alerts-view.ts';
import { normaliseAlerts } from '../src/lib/alerts-fetch.ts';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const resp = (ageMin, extra = {}) => ({ alerts: [], updatedAt: new Date(NOW - ageMin * 60_000).toISOString(), ok: true, source: 'api.weather.gov', ...extra });

test('alertsState: loading, unavailable, fresh, stale, too old', () => {
  assert.deepEqual(alertsState(undefined, false, NOW), { kind: 'loading' });
  assert.deepEqual(alertsState(undefined, true, NOW), { kind: 'unavailable' });
  assert.deepEqual(alertsState(resp(1), false, NOW), { kind: 'ready', ageMs: 60_000, stale: false });
  assert.equal(alertsState(resp(10), false, NOW).stale, false);
  assert.equal(alertsState(resp(11), false, NOW).stale, true);
  // the server's own stale fallback is judged by its updatedAt too
  assert.equal(alertsState(resp(30, { ok: false, stale: true }), true, NOW).stale, true);
  // a copy older than 6 h is not shown as current
  assert.deepEqual(alertsState(resp(7 * 60), false, NOW), { kind: 'unavailable' });
  assert.deepEqual(alertsState({ ...resp(1), updatedAt: null }, false, NOW), { kind: 'unavailable' });
  assert.deepEqual(alertsState({ ...resp(1), updatedAt: 'garbage' }, false, NOW), { kind: 'unavailable' });
});

test('isAlertsResponse accepts a real normalised response and rejects junk', () => {
  const live = JSON.parse(readFileSync(new URL('./fixtures/nws-alerts-tx-2026-10-02.json', import.meta.url), 'utf8'));
  const alerts = normaliseAlerts(live, Date.parse('2026-10-02T11:45:00Z'));
  assert.equal(isAlertsResponse({ alerts, updatedAt: '2026-10-02T11:45:00Z', ok: true, source: 'api.weather.gov' }), true);
  assert.equal(isAlertsResponse({ alerts: [], updatedAt: null, ok: false, source: 'api.weather.gov', error: 'x' }), true);
  assert.equal(isAlertsResponse(null), false);
  assert.equal(isAlertsResponse({ alerts: 'no', updatedAt: null, ok: true }), false);
  assert.equal(isAlertsResponse({ alerts: [{ id: 1 }], updatedAt: null, ok: true }), false);
  assert.equal(isAlertsResponse(JSON.parse(JSON.stringify(live))), false, 'a raw NWS feed is not our response');
});

test('relativeTime and updatedText', () => {
  const at = min => new Date(NOW + min * 60_000).toISOString();
  assert.equal(relativeTime(at(-5), NOW), '5 min ago');
  assert.equal(relativeTime(at(130), NOW), 'in 2 h 10 min');
  assert.equal(relativeTime(at(60), NOW), 'in 1 h');
  assert.equal(relativeTime(at(0.2), NOW), 'just now');
  assert.equal(relativeTime(at(60 * 30), NOW), 'in 1 d');
  assert.equal(relativeTime(null, NOW), null);
  assert.equal(relativeTime('nope', NOW), null);
  assert.equal(updatedText(20_000), 'Updated just now');
  assert.equal(updatedText(5 * 60_000), 'Updated 5 min ago');
  assert.equal(updatedText(95 * 60_000), 'Updated 1 h 35 min ago');
});

test('reflowNwsText joins hard-wrapped lines but keeps paragraphs and bullets (real FFW text)', () => {
  const live = JSON.parse(readFileSync(new URL('./fixtures/nws-alerts-tx-2026-10-02.json', import.meta.url), 'utf8'));
  const d = live.features[0].properties.description;
  assert.ok(d.includes('\n'), 'the real text is hard wrapped');
  const out = reflowNwsText(d);
  assert.ok(out.length > 100);
  const lines = out.split('\n').filter(Boolean);
  assert.ok(lines.length < d.split('\n').filter(Boolean).length, 'fewer lines than the wrapped original');
  assert.equal(reflowNwsText('A line\nwrapped here.\n\n* WHAT...Flooding\ncaused by rain.\n* WHERE...Hill'), 'A line wrapped here.\n\n* WHAT...Flooding caused by rain.\n* WHERE...Hill');
  assert.equal(reflowNwsText(''), '');
});
