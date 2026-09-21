// test/weekday_slots.test.js — "different start times on different
// weekdays" (routes.slots is now POLYMORPHIC: an ARRAY means the same start
// times every open day, unchanged from before; an OBJECT keyed by ISO
// weekday string "1".."7" (Mon=1..Sun=7) means per-weekday start times).
//
// Coverage:
//   - logic.js:buildSlotsForDate resolves the right times for a Monday vs a
//     Saturday on an object-shaped route; an array-shaped route is unchanged;
//     a weekday absent from the object yields zero slots.
//   - guest_api.js: /api/slots and /api/availability serve weekday-correct
//     times with no extra work (they already go through buildSlotsForDate);
//     /api/book rejects a time not offered on that date's weekday and
//     accepts one that is.
//   - admin_api.js: handleCreateRoute/handleUpdateRoute accept a valid
//     per-weekday object, derive open_days from it, and reject malformed
//     shapes (bad weekday keys, bad times, duplicate times).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional, getRoute } from '../src/db.js';
import { buildSlotsForDate, isoWeekday, addDaysToDateStr } from '../src/logic.js';
import { handleCreateRoute, handleUpdateRoute } from '../src/admin_api.js';
import { handleAvailability, handleSlots, handleBook } from '../src/guest_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

function exec(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(db, overrides = {}) {
  const route = {
    id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 50, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00"]',
    slot_capacity: '{}', map_url: null, active: 1,
    ...overrides,
  };
  const cols = Object.keys(route);
  exec(
    db,
    `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`,
    route
  );
  return route;
}

const TODAY = new Date().toISOString().slice(0, 10);

/** The next date (from TODAY, inclusive) whose ISO weekday (Mon=1..Sun=7)
 * equals `targetIso` — stays well within the 90-day booking horizon. */
function nextIsoWeekday(targetIso) {
  let d = TODAY;
  for (let i = 0; i < 8; i++) {
    if (isoWeekday(d) === targetIso) return d;
    d = addDaysToDateStr(d, 1);
  }
  throw new Error('unreachable');
}

const MONDAY = nextIsoWeekday(1);
const SATURDAY = nextIsoWeekday(6);

function adminRequest(method, path_, body) {
  return new Request(`https://admin.example.com${path_}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

// ---------------------------------------------------------------------------
// logic.js — buildSlotsForDate resolving the polymorphic slots column
// ---------------------------------------------------------------------------

describe('buildSlotsForDate — per-weekday slots (object-shaped route.slots)', () => {
  const route = {
    capacity: 10,
    slots: JSON.stringify({ '1': ['16:00', '17:00'], '6': ['13:00', '14:00'] }),
  };

  test('a Monday gets weekday-1 times', () => {
    const result = buildSlotsForDate(route, [], MONDAY);
    assert.deepEqual(result.map((s) => s.slot), ['16:00', '17:00']);
  });

  test('a Saturday gets weekday-6 times, not Monday\'s', () => {
    const result = buildSlotsForDate(route, [], SATURDAY);
    assert.deepEqual(result.map((s) => s.slot), ['13:00', '14:00']);
  });

  test('a weekday absent from the object yields zero slots', () => {
    // Tuesday (2) has no key in the object at all.
    const tuesday = nextIsoWeekday(2);
    const result = buildSlotsForDate(route, [], tuesday);
    assert.deepEqual(result, []);
  });

  test('a weekday present with an empty array also yields zero slots', () => {
    const withEmpty = { capacity: 10, slots: JSON.stringify({ '1': ['16:00'], '2': [] }) };
    const tuesday = nextIsoWeekday(2);
    const result = buildSlotsForDate(withEmpty, [], tuesday);
    assert.deepEqual(result, []);
  });

  test('remove_slot / extra_slot overrides still apply on top of the resolved weekday', () => {
    const overrides = [
      { date: MONDAY, action: 'remove_slot', payload: JSON.stringify({ slot: '16:00' }) },
      { date: MONDAY, action: 'extra_slot', payload: JSON.stringify({ slot: '21:00', capacity: 4 }) },
    ];
    const result = buildSlotsForDate(route, overrides, MONDAY);
    assert.deepEqual(result.map((s) => s.slot), ['17:00', '21:00']);
  });
});

describe('buildSlotsForDate — array-shaped route.slots is completely unchanged', () => {
  const route = { capacity: 10, slots: JSON.stringify(['17:30', '18:00', '18:30']) };

  test('same times returned on a Monday and a Saturday alike', () => {
    const mon = buildSlotsForDate(route, [], MONDAY);
    const sat = buildSlotsForDate(route, [], SATURDAY);
    assert.deepEqual(mon.map((s) => s.slot), ['17:30', '18:00', '18:30']);
    assert.deepEqual(sat.map((s) => s.slot), ['17:30', '18:00', '18:30']);
  });
});

// ---------------------------------------------------------------------------
// guest_api.js — /api/slots, /api/availability, /api/book
// ---------------------------------------------------------------------------

describe('guest_api.js — per-weekday slots flow through automatically', () => {
  function seedWeekdayRoute(overrides = {}) {
    return seedRoute(db, {
      id: 'utrecht-weekday',
      city: 'Utrecht',
      capacity: 10,
      open_days: '[1,6]',
      slots: JSON.stringify({ '1': ['16:00', '17:00'], '6': ['13:00', '14:00'] }),
      ...overrides,
    });
  }

  test('GET /api/slots on a Monday returns weekday-1 times', async () => {
    seedWeekdayRoute();
    const env = { DB: db };
    const res = await handleSlots(new Request(`https://api.example.com/api/slots?route=utrecht-weekday&date=${MONDAY}`), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.closed, false);
    assert.deepEqual(body.slots.map((s) => s.slot).sort(), ['16:00', '17:00']);
  });

  test('GET /api/slots on a Saturday returns weekday-6 times', async () => {
    seedWeekdayRoute();
    const env = { DB: db };
    const res = await handleSlots(new Request(`https://api.example.com/api/slots?route=utrecht-weekday&date=${SATURDAY}`), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.closed, false);
    assert.deepEqual(body.slots.map((s) => s.slot).sort(), ['13:00', '14:00']);
  });

  test('GET /api/slots on a weekday with no entry (and not in open_days) reports closed', async () => {
    seedWeekdayRoute();
    const env = { DB: db };
    const tuesday = nextIsoWeekday(2);
    const res = await handleSlots(new Request(`https://api.example.com/api/slots?route=utrecht-weekday&date=${tuesday}`), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.closed, true);
    assert.deepEqual(body.slots, []);
  });

  test('GET /api/availability marks a weekday absent from the slots object as closed, present ones as open', async () => {
    seedWeekdayRoute();
    const env = { DB: db };
    const month = MONDAY.slice(0, 7);
    const res = await handleAvailability(new Request(`https://api.example.com/api/availability?route=utrecht-weekday&month=${month}`), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.days[MONDAY], 'open');
    if (SATURDAY.slice(0, 7) === month) assert.equal(body.days[SATURDAY], 'open');
    const tuesday = nextIsoWeekday(2);
    if (tuesday.slice(0, 7) === month) assert.equal(body.days[tuesday], 'closed');
  });

  test('POST /api/book accepts a time that IS offered on that date\'s weekday', async () => {
    seedWeekdayRoute();
    const env = { DB: db };
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
    try {
      const res = await handleBook(new Request('https://api.example.com/api/book', {
        method: 'POST',
        body: JSON.stringify({
          route_id: 'utrecht-weekday', date: MONDAY, slot: '16:00', party: 2,
          name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
        }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.5.5.1', Origin: 'http://localhost:8000' },
      }), env);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.booking_id);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('POST /api/book rejects a time NOT offered on that date\'s weekday (409 route_closed)', async () => {
    seedWeekdayRoute();
    const env = { DB: db };
    // 13:00 only runs on Saturday (weekday 6) — booking it on the Monday
    // fixture date must be rejected even though 13:00 is a real time on
    // this route.
    const res = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST',
      body: JSON.stringify({
        route_id: 'utrecht-weekday', date: MONDAY, slot: '13:00', party: 2,
        name: 'Bram', email: 'bram@example.com', locale: 'en', marketing_opt_in: false,
      }),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.5.5.2', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'route_closed');
  });
});

// ---------------------------------------------------------------------------
// admin_api.js — handleCreateRoute / handleUpdateRoute validate + derive
// open_days for the per-weekday object shape
// ---------------------------------------------------------------------------

describe('handleCreateRoute — per-weekday slots object', () => {
  test('a valid object is accepted and open_days is DERIVED from its keys, ignoring the client value', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'perday-1', name: 'Per Day 1', city: 'X', price_cents: 2995,
      // deliberately WRONG open_days — the server must ignore this and
      // derive [1,6] from the slots object instead.
      open_days: '[1,2,3,4,5]',
      slots: JSON.stringify({ '1': ['16:00', '17:00'], '6': ['13:00'] }),
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.deepEqual(JSON.parse(route.open_days), [1, 6]);
    assert.deepEqual(JSON.parse(route.slots), { '1': ['16:00', '17:00'], '6': ['13:00'] });
  });

  test('a weekday key present but with an empty array is excluded from derived open_days', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'perday-2', name: 'Per Day 2', city: 'X', price_cents: 2995,
      open_days: '[]',
      slots: JSON.stringify({ '1': ['16:00'], '2': [] }),
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.deepEqual(JSON.parse(route.open_days), [1]);
  });

  test('rejects a weekday key outside 1-7', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'perday-bad-key', name: 'Bad', city: 'X', price_cents: 2995,
      open_days: '[1]',
      slots: JSON.stringify({ '8': ['16:00'] }),
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /weekday/);
  });

  test('rejects a malformed time inside a weekday array', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'perday-bad-time', name: 'Bad', city: 'X', price_cents: 2995,
      open_days: '[1]',
      slots: JSON.stringify({ '1': ['16:00', 'not-a-time'] }),
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /HH:MM/);
  });

  test('rejects duplicate times within the same weekday', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'perday-dupe', name: 'Bad', city: 'X', price_cents: 2995,
      open_days: '[1]',
      slots: JSON.stringify({ '1': ['16:00', '16:00'] }),
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /duplicate/);
  });

  test('rejects slots sent as a bare JS object (not a JSON-encoded string) — must not reach the DB unstringified', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'perday-bare-object', name: 'Bad', city: 'X', price_cents: 2995,
      open_days: '[1]',
      slots: { '1': ['16:00'] }, // a real object, not JSON.stringify(...)
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    // parseSlotsField accepts a pre-parsed value (matches parseSlotCapacityMap's
    // leniency) but MUST persist the re-stringified canonical form, not the
    // bare object itself — otherwise this write would hand D1 a non-bindable
    // value.
    assert.equal(typeof route.slots, 'string');
    assert.deepEqual(JSON.parse(route.slots), { '1': ['16:00'] });
  });

  test('the array shape is still validated exactly as before (regression)', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'array-still-fine', name: 'Array', city: 'X', price_cents: 2995,
      open_days: '[1,2,3]', slots: '["18:00","18:30"]',
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.deepEqual(JSON.parse(route.open_days), [1, 2, 3]);
    assert.deepEqual(JSON.parse(route.slots), ['18:00', '18:30']);
  });
});

describe('handleUpdateRoute — per-weekday slots object', () => {
  test('switching an existing array route to a per-weekday object derives open_days, overriding any open_days also sent', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      open_days: '[1,2,3,4,5,6,7]', // deliberately wrong/stale
      slots: JSON.stringify({ '2': ['09:00'], '4': ['09:00', '10:00'] }),
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);
    const { route } = await res.json();
    assert.deepEqual(JSON.parse(route.open_days), [2, 4]);
    assert.deepEqual(JSON.parse(route.slots), { '2': ['09:00'], '4': ['09:00', '10:00'] });
  });

  test('editing open_days alone on an already per-weekday route is rejected (would desync the two columns)', async () => {
    seedRoute(db, { slots: JSON.stringify({ '1': ['16:00'] }), open_days: '[1]' });
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      open_days: '[1,2]',
    }), env, { id: 'testroute' });
    assert.equal(res.status, 400);
    const route = await getRoute(db, 'testroute');
    // left untouched
    assert.deepEqual(JSON.parse(route.open_days), [1]);
  });

  test('rejects a malformed per-weekday object on update, leaving the stored route untouched', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      slots: JSON.stringify({ monday: ['16:00'] }),
    }), env, { id: 'testroute' });
    assert.equal(res.status, 400);
    const route = await getRoute(db, 'testroute');
    assert.equal(route.slots, '["18:00"]');
  });

  test('updating an unrelated field on an array route still works exactly as before (regression)', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      price_cents: 3100,
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);
    const { route } = await res.json();
    assert.equal(route.price_cents, 3100);
    assert.equal(route.slots, '["18:00"]');
    assert.deepEqual(JSON.parse(route.open_days), [1, 2, 3, 4, 5, 6, 7]);
  });
});
