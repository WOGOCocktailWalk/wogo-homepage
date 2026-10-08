// test/route_booking_cutoff.test.js — migrations/0029 (routes.booking_cutoff_minutes):
// the owner audit item 1 same-day cutoff (test/same_day_cutoff.test.js,
// SAME_DAY_CUTOFF_MINUTES) made PER-ROUTE. Real bar policy isn't uniform —
// Rotterdam Route 3 Premium needs 24h notice, Delft 10h, every other route
// keeps the original 1h.
//
// The pure predicate (logic.js:isSlotPastCutoff) was ALREADY a real "slot
// start < now + cutoff" instant comparison, not a same-calendar-day
// shortcut — its multi-day/DST correctness for arbitrary cutoff lengths is
// covered with FIXED clock times in test/logic.test.js (extended there,
// alongside the original 1h cases). This file proves the WIRING: each route
// reads its OWN booking_cutoff_minutes (falling back to the global
// SAME_DAY_CUTOFF_MINUTES only when the column is absent from a hand-built
// fixture), in GET /api/slots, GET /api/availability, POST /api/book, the
// admin create/update endpoints, and the real migration backfill.
//
// Slot times for the real-clock (full-stack) tests are computed RELATIVE TO
// THE REAL CLOCK (never hardcoded) via futureSlot() below, generalizing
// test/same_day_cutoff.test.js's technique to offsets that deliberately
// cross a calendar-day boundary — the whole point of a cutoff longer than a
// day. Offsets carry a >=60-minute margin on both sides of the cutoff
// boundary they're testing, so ordinary test-run jitter can never flip a
// result.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional, getRoute, getSlotsWithSeatsLeft } from '../src/db.js';
import { utcToZonedHHMM, todayInTimezone } from '../src/logic.js';
import { SAME_DAY_CUTOFF_MINUTES } from '../src/config.js';
import { handleAvailability, handleBook, handleListRoutes } from '../src/guest_api.js';
import { handleCreateRoute, handleUpdateRoute } from '../src/admin_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function migrationFile(n) {
  return readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8');
}

const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
  '0022_bar_locale.sql', '0025_admin_users.sql', '0027_booking_utm.sql', '0028_bookings_email_lower_index.sql',
  '0029_route_booking_cutoff.sql',
].map(migrationFile).join('\n');

function exec(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

const TIMEZONE = 'Europe/Amsterdam';
const TODAY = todayInTimezone(TIMEZONE);

/**
 * The (date, slot) pair — in TIMEZONE — for the real instant `offsetMinutes`
 * from now. Unlike test/same_day_cutoff.test.js's minutesUntilAmsterdamMidnight
 * trick (which deliberately clamps offsets to STAY within "today"), this is
 * built to cross however many midnights the offset needs to — the whole
 * point of testing a cutoff longer than a day. Reconstructing BOTH the zoned
 * calendar date and the zoned HH:MM from the same target instant guarantees
 * they round-trip back through zonedDateTimeToUtc to (within a minute of)
 * that same instant, regardless of which calendar day it lands on.
 */
function futureSlot(offsetMinutes, timeZone = TIMEZONE) {
  const target = new Date(Date.now() + offsetMinutes * 60 * 1000);
  return { date: todayInTimezone(timeZone, target), slot: utcToZonedHHMM(target, timeZone) };
}

function seedRoute(db, overrides = {}) {
  const route = {
    id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 50, max_party: 6, open_days: '[1,2,3,4,5,6,7]',
    slots: '[]', slot_capacity: '{}', map_url: null, active: 1,
    timezone: TIMEZONE, currency: 'EUR',
    ...overrides,
  };
  const cols = Object.keys(route);
  exec(db, `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, route);
  return route;
}

function bookRequest(overrides = {}) {
  const body = {
    route_id: 'testroute', date: TODAY, slot: '18:00', party: 1,
    name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
    ...overrides,
  };
  return new Request('https://api.example.com/api/book', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': overrides.ip || '10.9.9.1', Origin: 'http://localhost:8000' },
  });
}

function adminRequest(method, path_, body) {
  return new Request(`https://admin.example.com${path_}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let db;
const realFetch = global.fetch;
beforeEach(() => {
  db = makeTestDb(schemaSql);
  global.fetch = async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
});
after(() => { global.fetch = realFetch; });

// ---------------------------------------------------------------------------
// migrations/0029 itself — column default + real backfill
// ---------------------------------------------------------------------------

describe('migrations/0029 — routes.booking_cutoff_minutes default', () => {
  test('a route inserted WITHOUT the column (old-shaped INSERT) gets the 60-minute default', async () => {
    seedRoute(db); // explicit column list above never mentions booking_cutoff_minutes
    const route = await getRoute(db, 'testroute');
    assert.equal(route.booking_cutoff_minutes, 60);
    assert.equal(route.booking_cutoff_minutes, SAME_DAY_CUTOFF_MINUTES);
  });

  test('a route can be seeded with an explicit non-default cutoff', async () => {
    seedRoute(db, { id: 'premium-test', booking_cutoff_minutes: 1440 });
    const route = await getRoute(db, 'premium-test');
    assert.equal(route.booking_cutoff_minutes, 1440);
  });
});

describe('migrations/0029 — real backfill against the live seed data', () => {
  // Loads the ACTUAL route-seeding migrations (0002, 0016) in their REAL
  // numeric position — BEFORE 0029 — so 0029's backfill UPDATEs run against
  // rows that already exist, exactly as they do in the real migration
  // sequence applied in order. (Appending 0002/0016 AFTER the rest of
  // schemaSql, which already ends in 0029, would run the UPDATEs against an
  // empty table and silently no-op them — proving nothing.)
  const liveSchema = [
    '0001_init.sql', '0002_seed_routes.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
    '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
    '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
    '0011_currency_timezone.sql', '0012_map_url_nl.sql',
    '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0016_seed_delft.sql',
    '0022_bar_locale.sql', '0025_admin_users.sql', '0027_booking_utm.sql', '0028_bookings_email_lower_index.sql',
    '0029_route_booking_cutoff.sql',
  ].map(migrationFile).join('\n');
  let liveDb;
  beforeEach(() => { liveDb = makeTestDb(liveSchema); });

  test('Rotterdam Route 3 Premium backfills to 1440 (24h)', async () => {
    const route = await getRoute(liveDb, 'rotterdam-premium-gin');
    assert.equal(route.booking_cutoff_minutes, 1440);
  });

  test('Delft backfills to 600 (10h)', async () => {
    const route = await getRoute(liveDb, 'delft');
    assert.equal(route.booking_cutoff_minutes, 600);
  });

  test('every other pre-existing route keeps the 60-minute (1h) default', async () => {
    for (const id of ['amsterdam', 'utrecht', 'groningen', 'rotterdam-witte-de-with', 'rotterdam-hidden-gems']) {
      const route = await getRoute(liveDb, id);
      assert.equal(route.booking_cutoff_minutes, 60, `${id} must keep the 1h default`);
    }
  });
});

// ---------------------------------------------------------------------------
// db.js:getSlotsWithSeatsLeft — per-route cutoff, including across a day
// boundary for a cutoff longer than 24h
// ---------------------------------------------------------------------------

describe('db.js:getSlotsWithSeatsLeft — route.booking_cutoff_minutes overrides the global default', () => {
  test('a route with the 1h default is unaffected by a slot comfortably inside 24h', async () => {
    // offset = 20h: well outside the 1h default cutoff, so still bookable —
    // even though the SAME offset would be rejected for a 24h-cutoff route
    // (proven in the next test). Margin from the 60-minute boundary: 19h.
    const { date, slot } = futureSlot(20 * 60);
    const route = seedRoute(db, { slots: JSON.stringify([slot]) }); // booking_cutoff_minutes omitted -> 60 (column default)
    const slots = await getSlotsWithSeatsLeft(db, route, [], date);
    assert.ok(slots.find((s) => s.slot === slot).seats_left > 0, 'a 1h-cutoff route must not be touched by a 20h-out slot');
  });

  test('a route with a 1440-minute (24h) cutoff zeroes a slot 23h out — on TOMORROW\'s date', async () => {
    const { date, slot } = futureSlot(23 * 60); // 60-minute margin inside the 1440 boundary
    const route = seedRoute(db, { id: 'premium-test', booking_cutoff_minutes: 1440, slots: JSON.stringify([slot]) });
    const slots = await getSlotsWithSeatsLeft(db, route, [], date);
    assert.equal(slots.find((s) => s.slot === slot).seats_left, 0, 'a 24h-cutoff route must zero a slot only 23h out, even on a future date');
  });

  test('the SAME 24h-cutoff route leaves a slot 25h out (just past the boundary) bookable', async () => {
    const { date, slot } = futureSlot(25 * 60); // 60-minute margin outside the 1440 boundary
    const route = seedRoute(db, { id: 'premium-test', booking_cutoff_minutes: 1440, slots: JSON.stringify([slot]) });
    const slots = await getSlotsWithSeatsLeft(db, route, [], date);
    assert.ok(slots.find((s) => s.slot === slot).seats_left > 0, 'a slot 25h out must clear a 24h cutoff');
  });

  test('a route with a 600-minute (10h) cutoff zeroes a slot 9h out but not one 11h out', async () => {
    const within = futureSlot(9 * 60);
    const safe = futureSlot(11 * 60);
    const route = seedRoute(db, { id: 'delft-test', booking_cutoff_minutes: 600, slots: JSON.stringify([within.slot, safe.slot]) });
    const withinSlots = await getSlotsWithSeatsLeft(db, route, [], within.date);
    const safeSlots = await getSlotsWithSeatsLeft(db, route, [], safe.date);
    assert.equal(withinSlots.find((s) => s.slot === within.slot).seats_left, 0, '9h out must be inside a 10h cutoff');
    assert.ok(safeSlots.find((s) => s.slot === safe.slot).seats_left > 0, '11h out must clear a 10h cutoff');
  });

  test('a hand-built route object with NO booking_cutoff_minutes at all falls back to SAME_DAY_CUTOFF_MINUTES', async () => {
    // Simulates a caller/fixture that predates migrations/0029 — the `??`
    // fallback in db.js must still apply the original 1h behaviour.
    const { date, slot } = futureSlot(30); // 30 minutes out — inside the 60-min fallback
    const route = { id: 'testroute', timezone: TIMEZONE, slots: JSON.stringify([slot]), open_days: '[1,2,3,4,5,6,7]', capacity: 10 };
    delete route.booking_cutoff_minutes;
    const slots = await getSlotsWithSeatsLeft(db, route, [], date);
    assert.equal(slots.find((s) => s.slot === slot).seats_left, 0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/availability — a day whose only slots are inside a LONG cutoff
// ---------------------------------------------------------------------------

describe('GET /api/availability — per-route cutoff reaches into tomorrow for a 24h route', () => {
  test('a 24h-cutoff route reports tomorrow "soldout" when its only slot is inside the window', async () => {
    const { date, slot } = futureSlot(20 * 60); // 20h out — inside a 24h cutoff, and (almost always) tomorrow
    seedRoute(db, { id: 'premium-test', booking_cutoff_minutes: 1440, open_days: '[1,2,3,4,5,6,7]', slots: JSON.stringify([slot]) });
    const env = { DB: db };
    const month = date.slice(0, 7);
    const res = await handleAvailability(new Request(`https://api.example.com/api/availability?route=premium-test&month=${month}`), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.days[date], 'soldout');
  });
});

// ---------------------------------------------------------------------------
// POST /api/book — rejects by the ROUTE's own cutoff, not the global one
// ---------------------------------------------------------------------------

describe('POST /api/book — per-route cutoff', () => {
  test('a 24h-cutoff route rejects a booking 20h out with 409 slot_passed', async () => {
    const { date, slot } = futureSlot(20 * 60);
    seedRoute(db, { id: 'premium-test', booking_cutoff_minutes: 1440, open_days: '[1,2,3,4,5,6,7]', slots: JSON.stringify([slot]) });
    const env = { DB: db };
    const res = await handleBook(bookRequest({ route_id: 'premium-test', date, slot, email: 'guest1@example.com', ip: '10.9.9.11' }), env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'slot_passed');
  });

  test('the SAME offset (20h out) still succeeds for a plain 1h-default route', async () => {
    const { date, slot } = futureSlot(20 * 60);
    seedRoute(db, { open_days: '[1,2,3,4,5,6,7]', slots: JSON.stringify([slot]) }); // booking_cutoff_minutes omitted -> 60
    const env = { DB: db };
    const res = await handleBook(bookRequest({ date, slot, email: 'guest2@example.com', ip: '10.9.9.12' }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.booking_id);
  });

  test('a 600-minute (10h) cutoff route accepts a booking 11h out', async () => {
    const { date, slot } = futureSlot(11 * 60);
    seedRoute(db, { id: 'delft-test', booking_cutoff_minutes: 600, open_days: '[1,2,3,4,5,6,7]', slots: JSON.stringify([slot]) });
    const env = { DB: db };
    const res = await handleBook(bookRequest({ route_id: 'delft-test', date, slot, email: 'guest3@example.com', ip: '10.9.9.13' }), env);
    assert.equal(res.status, 200);
  });

  test('a 600-minute (10h) cutoff route rejects a booking 9h out, with the reworded message', async () => {
    const { date, slot } = futureSlot(9 * 60);
    seedRoute(db, { id: 'delft-test', booking_cutoff_minutes: 600, open_days: '[1,2,3,4,5,6,7]', slots: JSON.stringify([slot]) });
    const env = { DB: db };
    const res = await handleBook(bookRequest({ route_id: 'delft-test', date, slot, email: 'guest4@example.com', ip: '10.9.9.14' }), env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'slot_passed');
    // The message was reworded from "already started or is starting too
    // soon to book" — a 9h-out rejection no longer reads like the slot just
    // started. The error CODE (asserted above) is what callers key off; this
    // only pins the new human-readable text.
    assert.equal(body.message, 'booking closed for this start time');
  });
});

// ---------------------------------------------------------------------------
// GET /api/routes — booking_cutoff_minutes is exposed per route
// ---------------------------------------------------------------------------

describe('GET /api/routes — booking_cutoff_minutes served per route', () => {
  test('a route with the default and a route with an explicit override both report correctly', async () => {
    seedRoute(db); // default 60
    seedRoute(db, { id: 'premium-test', booking_cutoff_minutes: 1440 });
    const env = { DB: db };
    const res = await handleListRoutes(new Request('https://api.example.com/api/routes'), env);
    const { routes } = await res.json();
    assert.equal(routes.find((r) => r.id === 'testroute').booking_cutoff_minutes, 60);
    assert.equal(routes.find((r) => r.id === 'premium-test').booking_cutoff_minutes, 1440);
  });
});

// ---------------------------------------------------------------------------
// Admin create/update — validation + persistence
// ---------------------------------------------------------------------------

describe('handleCreateRoute — booking_cutoff_minutes', () => {
  test('omitting it defaults to 60 (every pre-0029 route-creation call is unaffected)', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'newroute', name: 'New Route', city: 'Testville', price_cents: 2995,
      open_days: '[1,2,3]', slots: '["18:00"]',
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.equal(route.booking_cutoff_minutes, 60);
  });

  test('a valid explicit value (1440) is created as given', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'premium2', name: 'Premium 2', city: 'Rotterdam', price_cents: 3495,
      open_days: '[2,3,4,5,6]', slots: '["18:00"]', booking_cutoff_minutes: 1440,
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.equal(route.booking_cutoff_minutes, 1440);
  });

  test('0 is a valid value (no cutoff at all — bookable right up to start)', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'zerocutoff', name: 'Zero Cutoff', city: 'Testville', price_cents: 2995,
      open_days: '[1]', slots: '["18:00"]', booking_cutoff_minutes: 0,
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.equal(route.booking_cutoff_minutes, 0);
  });

  test('rejects a negative value', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'bad1', name: 'Bad', city: 'X', price_cents: 1000,
      open_days: '[1]', slots: '["18:00"]', booking_cutoff_minutes: -5,
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /booking_cutoff_minutes/);
  });

  test('rejects a non-integer value', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'bad2', name: 'Bad', city: 'X', price_cents: 1000,
      open_days: '[1]', slots: '["18:00"]', booking_cutoff_minutes: 90.5,
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /booking_cutoff_minutes/);
  });

  test('rejects a value above the 10080 (7-day) cap', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'bad3', name: 'Bad', city: 'X', price_cents: 1000,
      open_days: '[1]', slots: '["18:00"]', booking_cutoff_minutes: 10081,
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /booking_cutoff_minutes/);
  });

  test('exactly 10080 (the cap) is accepted', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'atcap', name: 'At Cap', city: 'X', price_cents: 1000,
      open_days: '[1]', slots: '["18:00"]', booking_cutoff_minutes: 10080,
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.equal(route.booking_cutoff_minutes, 10080);
  });
});

describe('handleUpdateRoute — booking_cutoff_minutes', () => {
  test('updating it on an existing route persists the new value', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      booking_cutoff_minutes: 600,
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);
    const { route } = await res.json();
    assert.equal(route.booking_cutoff_minutes, 600);
  });

  test('not touching it in a PUT leaves the existing value unchanged', async () => {
    seedRoute(db, { booking_cutoff_minutes: 1440 });
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      price_cents: 3200,
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);
    const { route } = await res.json();
    assert.equal(route.booking_cutoff_minutes, 1440);
    assert.equal(route.price_cents, 3200);
  });

  test('rejects an invalid value on update, leaving the stored value untouched', async () => {
    seedRoute(db, { booking_cutoff_minutes: 60 });
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      booking_cutoff_minutes: -1,
    }), env, { id: 'testroute' });
    assert.equal(res.status, 400);
    const route = await getRoute(db, 'testroute');
    assert.equal(route.booking_cutoff_minutes, 60);
  });

  test('rejects a value above the cap on update, leaving the stored value untouched', async () => {
    seedRoute(db, { booking_cutoff_minutes: 60 });
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      booking_cutoff_minutes: 20000,
    }), env, { id: 'testroute' });
    assert.equal(res.status, 400);
    const route = await getRoute(db, 'testroute');
    assert.equal(route.booking_cutoff_minutes, 60);
  });
});
