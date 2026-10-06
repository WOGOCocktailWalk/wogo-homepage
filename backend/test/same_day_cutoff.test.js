// test/same_day_cutoff.test.js — audit item 1: same-day booking cutoff
// (SAME_DAY_CUTOFF_MINUTES, config.js). isSlotPastCutoff itself (the pure
// predicate, including a DST-transition-date check) is covered in
// test/logic.test.js; this file proves the WIRING — GET /api/slots,
// GET /api/availability, and POST /api/book all actually apply it.
//
// Slot times here are computed RELATIVE TO THE REAL CLOCK (not hardcoded),
// so these tests are correct no matter what time of day the suite runs —
// the same pattern test/security.test.js uses for its FUTURE_DATE constant.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional } from '../src/db.js';
import { utcToZonedHHMM, todayInTimezone, addDaysToDateStr } from '../src/logic.js';
import { SAME_DAY_CUTOFF_MINUTES } from '../src/config.js';
import { handleSlots, handleAvailability, handleBook } from '../src/guest_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
  '0022_bar_locale.sql', '0025_admin_users.sql', '0027_booking_utm.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

function exec(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

const TIMEZONE = 'Europe/Amsterdam';
const TODAY = todayInTimezone(TIMEZONE);

// Computed fresh from Date.now() every run — never a hardcoded clock time.
// BUT a plain fixed +3h/+30m/-10m offset can cross the Amsterdam midnight
// boundary (e.g. running at 21:30 local: "now + 3h" is 00:30 TOMORROW, not
// today) — every test below asserts against the literal date string TODAY,
// so a wrapped slot silently becomes "already passed" and the suite fails
// deterministically for ~3 hours out of every 24. Each offset is clamped to
// never cross that boundary, so these stay correct (and still real-clock-
// derived, not hardcoded) no matter what time of day the suite runs.
function minutesUntilAmsterdamMidnight(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return 24 * 60 - (get('hour') * 60 + get('minute') + get('second') / 60);
}
const NOW = new Date();
const UNTIL_MIDNIGHT = minutesUntilAmsterdamMidnight(NOW);
const SINCE_MIDNIGHT = 24 * 60 - UNTIL_MIDNIGHT;
const PASSED_OFFSET_MIN = Math.min(10, Math.max(1, SINCE_MIDNIGHT - 1));           // stays today, still "already passed"
const WITHIN_CUTOFF_OFFSET_MIN = Math.min(30, Math.max(1, UNTIL_MIDNIGHT - 1));    // stays today, still < the 60min cutoff
// "Safe" must be BOTH same-day AND past the cutoff — genuinely impossible in
// the last ~70 minutes before Amsterdam midnight (any time that far out
// literally is tomorrow). SAFE_SLOT_IMPOSSIBLE flags that rare window so the
// one assertion that needs it can skip itself rather than fail on a false
// premise.
const SAFE_SLOT_IMPOSSIBLE = UNTIL_MIDNIGHT - 2 <= SAME_DAY_CUTOFF_MINUTES + 10;
const SAFE_OFFSET_MIN = SAFE_SLOT_IMPOSSIBLE ? 180 : Math.min(180, UNTIL_MIDNIGHT - 2);

const PASSED_SLOT = utcToZonedHHMM(new Date(NOW.getTime() - PASSED_OFFSET_MIN * 60 * 1000), TIMEZONE);
const WITHIN_CUTOFF_SLOT = utcToZonedHHMM(new Date(NOW.getTime() + WITHIN_CUTOFF_OFFSET_MIN * 60 * 1000), TIMEZONE);
const SAFE_SLOT = utcToZonedHHMM(new Date(NOW.getTime() + SAFE_OFFSET_MIN * 60 * 1000), TIMEZONE);

function seedRoute(db, overrides = {}) {
  const route = {
    id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 50, max_party: 6, open_days: '[1,2,3,4,5,6,7]',
    slots: JSON.stringify([PASSED_SLOT, WITHIN_CUTOFF_SLOT, SAFE_SLOT]),
    slot_capacity: '{}', map_url: null, active: 1, timezone: TIMEZONE, currency: 'EUR',
    ...overrides,
  };
  const cols = Object.keys(route);
  exec(db, `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, route);
  return route;
}

function bookRequest(overrides = {}) {
  const body = {
    route_id: 'testroute', date: TODAY, slot: SAFE_SLOT, party: 1,
    name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
    ...overrides,
  };
  return new Request('https://api.example.com/api/book', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.7.7.1', Origin: 'http://localhost:8000' },
  });
}

let db;
const realFetch = global.fetch;
beforeEach(() => {
  db = makeTestDb(schemaSql);
  global.fetch = async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
});
after(() => { global.fetch = realFetch; });

describe('GET /api/slots — same-day cutoff', () => {
  test('a slot on TODAY within the cutoff (or already passed) is reported with seats_left 0', async (t) => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleSlots(new Request(`https://api.example.com/api/slots?route=testroute&date=${TODAY}`), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    const passed = body.slots.find((s) => s.slot === PASSED_SLOT);
    const withinCutoff = body.slots.find((s) => s.slot === WITHIN_CUTOFF_SLOT);
    assert.equal(passed.seats_left, 0, 'an already-passed slot must show 0 seats left');
    assert.equal(withinCutoff.seats_left, 0, `a slot inside the ${SAME_DAY_CUTOFF_MINUTES}-minute cutoff must show 0 seats left`);
    if (SAFE_SLOT_IMPOSSIBLE) { t.skip('within ~70 minutes of Amsterdam midnight — no same-day slot can be both "today" and past the cutoff'); return; }
    const safe = body.slots.find((s) => s.slot === SAFE_SLOT);
    assert.ok(safe.seats_left > 0, 'a comfortably-future same-day slot is untouched');
  });

  test('the SAME slot times on a FUTURE date are completely unaffected', async () => {
    seedRoute(db, { slots: JSON.stringify([PASSED_SLOT, WITHIN_CUTOFF_SLOT, SAFE_SLOT]) });
    const env = { DB: db };
    const future = addDaysToDateStr(TODAY, 7);
    const res = await handleSlots(new Request(`https://api.example.com/api/slots?route=testroute&date=${future}`), env);
    const body = await res.json();
    for (const s of body.slots) {
      assert.ok(s.seats_left > 0, `${s.slot} on a future date must not be zeroed by the same-day cutoff`);
    }
  });
});

describe('GET /api/availability — same-day cutoff', () => {
  test('a day whose only slots are all past-cutoff (today) is not misreported as plain "open"', async () => {
    // Route with ONLY a past slot today — every slot for today is past
    // cutoff, so today must not look like a normal open day with seats.
    seedRoute(db, { slots: JSON.stringify([PASSED_SLOT]) });
    const env = { DB: db };
    const month = TODAY.slice(0, 7);
    const res = await handleAvailability(new Request(`https://api.example.com/api/availability?route=testroute&month=${month}`), env);
    const body = await res.json();
    // buildMonthAvailability marks a date 'soldout' when every known slot has
    // seats_left 0 — the same status a guest sees on a genuinely full day.
    assert.equal(body.days[TODAY], 'soldout');
  });
});

describe('POST /api/book — same-day cutoff', () => {
  test('booking a slot that already started is rejected 409 slot_passed', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleBook(bookRequest({ slot: PASSED_SLOT, email: 'passed@example.com' }), env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'slot_passed');
  });

  test(`booking a slot inside the ${SAME_DAY_CUTOFF_MINUTES}-minute cutoff is rejected 409 slot_passed`, async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleBook(bookRequest({ slot: WITHIN_CUTOFF_SLOT, email: 'cutoff@example.com' }), env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'slot_passed');
  });

  test('booking a comfortably-future same-day slot still succeeds', async (t) => {
    if (SAFE_SLOT_IMPOSSIBLE) { t.skip('within ~70 minutes of Amsterdam midnight — no same-day slot can be both "today" and past the cutoff'); return; }
    seedRoute(db);
    const env = { DB: db };
    const res = await handleBook(bookRequest({ slot: SAFE_SLOT, email: 'safe@example.com' }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.booking_id);
  });

  test('the SAME near/passed slot time on a FUTURE date is bookable (cutoff is same-day only)', async () => {
    seedRoute(db);
    const env = { DB: db };
    const future = addDaysToDateStr(TODAY, 7);
    const res = await handleBook(bookRequest({ date: future, slot: WITHIN_CUTOFF_SLOT, email: 'future@example.com' }), env);
    assert.equal(res.status, 200);
  });
});
