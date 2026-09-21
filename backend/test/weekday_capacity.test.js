// test/weekday_capacity.test.js — per-weekday capacity (migrations/0014):
// a RECURRING default that varies by day of week — e.g. Saturdays always cap
// at 6 seats/departure while every other open day stays at the route's
// normal 10 — sitting between routes.slot_capacity (per-slot default) and
// routes.capacity (route-wide default) in the existing precedence chain.
//
// Coverage:
//   - logic.js:buildSlotsForDate resolves the weekday cap when set, falls
//     back to route.capacity when the weekday has no entry.
//   - db.js:resolveEffectiveCapacity (the read-only mirror of the atomic SQL
//     guard) returns the EXACT SAME number as buildSlotsForDate for the same
//     (route, date, slot) — guard/read parity, the thing that keeps the
//     guest-facing "seats left" number and the no-overbooking guard from
//     ever disagreeing.
//   - db.js:createHold's atomic SQL guard actually blocks the
//     (weekday-capacity + 1)th seat — not just the read-only mirror.
//   - per-slot route.slot_capacity still overrides the weekday cap (higher
//     precedence).
//   - per-date overrides (slot_capacity_override / capacity_override) still
//     win over the weekday cap (highest precedence, unchanged).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import {
  createHold, createManualBooking, diagnoseHoldFailure, resolveEffectiveCapacity, confirmBooking, expireHolds, getRoute, toPositional,
} from '../src/db.js';
import { buildSlotsForDate, computeHoldExpiry, isoWeekday, addDaysToDateStr } from '../src/logic.js';
import { handleCreateRoute, handleUpdateRoute } from '../src/admin_api.js';

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
    capacity: 10, max_party: 12, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00","20:00"]',
    slot_capacity: '{}', weekday_capacity: null, map_url: null, active: 1,
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
 * equals `targetIso` — mirrors weekday_slots.test.js's helper. */
function nextIsoWeekday(targetIso) {
  let d = TODAY;
  for (let i = 0; i < 8; i++) {
    if (isoWeekday(d) === targetIso) return d;
    d = addDaysToDateStr(d, 1);
  }
  throw new Error('unreachable');
}

const SATURDAY = nextIsoWeekday(6); // weekday 6 — the capped day in these fixtures
const MONDAY = nextIsoWeekday(1);   // weekday 1 — an uncapped day

function makeHoldParams(overrides = {}) {
  return {
    id: `b_${Math.random().toString(36).slice(2)}`,
    route_id: 'testroute',
    date: SATURDAY,
    slot: '18:00',
    party: 1,
    name: 'Anna',
    email: 'anna@example.com',
    phone: null,
    locale: 'en',
    marketing_opt_in: false,
    hold_expires: computeHoldExpiry(15),
    ...overrides,
  };
}

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

// ---------------------------------------------------------------------------
// logic.js — buildSlotsForDate resolving routes.weekday_capacity
// ---------------------------------------------------------------------------

describe('buildSlotsForDate — per-weekday capacity (migrations/0014)', () => {
  test('a weekday present in the map overrides route.capacity for every slot that date', () => {
    const route = {
      capacity: 10,
      slots: JSON.stringify(['18:00', '20:00']),
      weekday_capacity: JSON.stringify({ '6': 6, '7': 6 }),
    };
    const result = buildSlotsForDate(route, [], SATURDAY);
    assert.deepEqual(result, [
      { slot: '18:00', capacity: 6 },
      { slot: '20:00', capacity: 6 },
    ]);
  });

  test('a weekday absent from the map falls back to route.capacity', () => {
    const route = {
      capacity: 10,
      slots: JSON.stringify(['18:00']),
      weekday_capacity: JSON.stringify({ '6': 6 }), // Saturday only
    };
    const result = buildSlotsForDate(route, [], MONDAY);
    assert.deepEqual(result, [{ slot: '18:00', capacity: 10 }]);
  });

  test('NULL weekday_capacity (column never touched) behaves exactly like today', () => {
    const route = { capacity: 10, slots: JSON.stringify(['18:00']), weekday_capacity: null };
    const result = buildSlotsForDate(route, [], SATURDAY);
    assert.deepEqual(result, [{ slot: '18:00', capacity: 10 }]);
  });

  test('route.slot_capacity (a higher-precedence level) still overrides the weekday cap for its named slot', () => {
    const route = {
      capacity: 10,
      slots: JSON.stringify(['18:00', '20:00']),
      slot_capacity: JSON.stringify({ '20:00': 3 }),
      weekday_capacity: JSON.stringify({ '6': 6 }),
    };
    const result = buildSlotsForDate(route, [], SATURDAY);
    assert.deepEqual(result, [
      { slot: '18:00', capacity: 6 }, // no slot_capacity entry -> falls to weekday cap
      { slot: '20:00', capacity: 3 }, // slot_capacity wins over weekday cap
    ]);
  });

  test('a date+slot override still wins over the weekday cap (highest precedence, unchanged)', () => {
    const route = {
      capacity: 10,
      slots: JSON.stringify(['18:00', '20:00']),
      weekday_capacity: JSON.stringify({ '6': 6 }),
    };
    const overrides = [
      { date: SATURDAY, action: 'slot_capacity_override', payload: JSON.stringify({ '20:00': 2 }) },
    ];
    const result = buildSlotsForDate(route, overrides, SATURDAY);
    assert.deepEqual(result, [
      { slot: '18:00', capacity: 6 }, // weekday cap, untouched by the override
      { slot: '20:00', capacity: 2 }, // date+slot override wins
    ]);
  });

  test('a date-wide capacity_override still wins over the weekday cap', () => {
    const route = {
      capacity: 10,
      slots: JSON.stringify(['18:00']),
      weekday_capacity: JSON.stringify({ '6': 6 }),
    };
    const overrides = [
      { date: SATURDAY, action: 'capacity_override', payload: JSON.stringify({ capacity: 9 }) },
    ];
    const result = buildSlotsForDate(route, overrides, SATURDAY);
    assert.deepEqual(result, [{ slot: '18:00', capacity: 9 }]);
  });
});

// ---------------------------------------------------------------------------
// db.js — resolveEffectiveCapacity / read-write PARITY with buildSlotsForDate
// ---------------------------------------------------------------------------

describe('resolveEffectiveCapacity — guard/read parity with buildSlotsForDate (migrations/0014)', () => {
  test('on the capped weekday (Saturday), the real DB read and the pure read agree on the actual number', async () => {
    seedRoute(db, { capacity: 10, slots: '["18:00","20:00"]', weekday_capacity: JSON.stringify({ '6': 6, '7': 6 }) });
    const route = await getRoute(db, 'testroute');

    const fromReadPath = buildSlotsForDate(route, [], SATURDAY).find((s) => s.slot === '18:00').capacity;
    const fromGuardMirror = await resolveEffectiveCapacity(db, 'testroute', SATURDAY, '18:00', route.capacity);

    assert.equal(fromReadPath, 6, 'sanity: the weekday cap is actually applied');
    assert.equal(fromGuardMirror, 6, 'sanity: the guard mirror resolves the same weekday cap');
    assert.equal(fromReadPath, fromGuardMirror, 'guard/read parity: both paths must agree on the effective capacity');
  });

  test('on an uncapped weekday (Monday), both paths fall through to route.capacity and agree', async () => {
    seedRoute(db, { capacity: 10, slots: '["18:00"]', weekday_capacity: JSON.stringify({ '6': 6, '7': 6 }) });
    const route = await getRoute(db, 'testroute');

    const fromReadPath = buildSlotsForDate(route, [], MONDAY).find((s) => s.slot === '18:00').capacity;
    const fromGuardMirror = await resolveEffectiveCapacity(db, 'testroute', MONDAY, '18:00', route.capacity);

    assert.equal(fromReadPath, 10);
    assert.equal(fromGuardMirror, 10);
    assert.equal(fromReadPath, fromGuardMirror);
  });

  test('per-slot route.slot_capacity beating the weekday cap agrees on both paths too', async () => {
    seedRoute(db, {
      capacity: 10, slots: '["18:00","20:00"]',
      slot_capacity: JSON.stringify({ '20:00': 3 }),
      weekday_capacity: JSON.stringify({ '6': 6 }),
    });
    const route = await getRoute(db, 'testroute');

    const fromReadPath = buildSlotsForDate(route, [], SATURDAY).find((s) => s.slot === '20:00').capacity;
    const fromGuardMirror = await resolveEffectiveCapacity(db, 'testroute', SATURDAY, '20:00', route.capacity);

    assert.equal(fromReadPath, 3);
    assert.equal(fromGuardMirror, 3);
    assert.equal(fromReadPath, fromGuardMirror);
  });
});

// ---------------------------------------------------------------------------
// db.js — createHold's ATOMIC SQL guard actually enforces the weekday cap
// ---------------------------------------------------------------------------

describe('createHold — atomic guard enforces the weekday cap (no-overbooking, migrations/0014)', () => {
  test('fills exactly to the weekday cap (6 on Saturday), the (cap+1)th seat is blocked', async () => {
    seedRoute(db, { capacity: 10, slots: '["18:00"]', weekday_capacity: JSON.stringify({ '6': 6 }) });

    const within = await createHold(db, makeHoldParams({ id: 'b_a', party: 6 }));
    assert.equal(within.created, true, 'fills exactly to the weekday cap of 6');

    const over = await createHold(db, makeHoldParams({ id: 'b_b', party: 1 }));
    assert.equal(over.created, false, 'the 7th seat must be rejected — weekday cap is 6, not route.capacity 10');

    const diag = await diagnoseHoldFailure(db, { route_id: 'testroute', date: SATURDAY, slot: '18:00', party: 1 });
    assert.equal(diag.code, 'sold_out');
    assert.equal(diag.seats_left, 0);
  });

  test('the SAME route on an uncapped weekday (Monday) still allows up to route.capacity (10)', async () => {
    seedRoute(db, { capacity: 10, slots: '["18:00"]', weekday_capacity: JSON.stringify({ '6': 6 }) });

    const full = await createHold(db, makeHoldParams({ id: 'b_mon', date: MONDAY, party: 10 }));
    assert.equal(full.created, true, 'Monday has no weekday cap entry, so route.capacity (10) applies');

    const over = await createHold(db, makeHoldParams({ id: 'b_mon2', date: MONDAY, party: 1 }));
    assert.equal(over.created, false, '11th seat on Monday must still be blocked at route.capacity');
  });

  test('per-slot route.slot_capacity still overrides the weekday cap inside the atomic guard itself', async () => {
    seedRoute(db, {
      capacity: 10, slots: '["18:00","20:00"]',
      slot_capacity: JSON.stringify({ '20:00': 2 }),
      weekday_capacity: JSON.stringify({ '6': 6 }),
    });

    // 18:00 has no slot_capacity entry -> falls to the weekday cap of 6.
    const at18 = await createHold(db, makeHoldParams({ id: 'b_18', slot: '18:00', party: 6 }));
    assert.equal(at18.created, true);
    const at18over = await createHold(db, makeHoldParams({ id: 'b_18x', slot: '18:00', party: 1 }));
    assert.equal(at18over.created, false);

    // 20:00 has a slot_capacity entry of 2 -> that wins over the weekday cap of 6.
    const at20 = await createHold(db, makeHoldParams({ id: 'b_20', slot: '20:00', party: 2 }));
    assert.equal(at20.created, true);
    const at20over = await createHold(db, makeHoldParams({ id: 'b_20x', slot: '20:00', party: 1 }));
    assert.equal(at20over.created, false, 'slot_capacity (2) must win over the weekday cap (6), not the other way round');
  });

  test('a per-date slot_capacity_override still wins over the weekday cap inside the atomic guard', async () => {
    seedRoute(db, { capacity: 10, slots: '["18:00"]', weekday_capacity: JSON.stringify({ '6': 6 }) });
    exec(db, `INSERT INTO date_overrides (route_id, date, action, payload) VALUES (:route_id, :date, :action, :payload)`, {
      route_id: 'testroute', date: SATURDAY, action: 'slot_capacity_override',
      payload: JSON.stringify({ '18:00': 2 }),
    });

    const within = await createHold(db, makeHoldParams({ id: 'b_ov', party: 2 }));
    assert.equal(within.created, true, 'fills to the override of 2, not the weekday cap of 6');
    const over = await createHold(db, makeHoldParams({ id: 'b_ov2', party: 1 }));
    assert.equal(over.created, false, 'date+slot override (2) must win over the weekday cap (6)');
  });

  test('confirmBooking\'s §6.4 conflict-recovery path (a different SQL guard, EFFECTIVE_CAPACITY_RECOVERY) also honors the weekday cap — a genuinely resold seat lands in confirmed_conflict', async () => {
    seedRoute(db, { capacity: 10, slots: '["18:00"]', weekday_capacity: JSON.stringify({ '6': 2 }) });

    // Hold X takes the full 2-seat weekday cap, then expires unpaid.
    const x = await createHold(db, makeHoldParams({ id: 'b_recX', party: 2, hold_expires: '2000-01-01 00:00:00' }));
    assert.equal(x.created, true);
    await expireHolds(db);

    // Someone else re-books and CONFIRMS into the now-free capacity before
    // X's late Stripe webhook arrives.
    const resold = await createManualBooking(db, {
      id: 'b_recY', route_id: 'testroute', date: SATURDAY, slot: '18:00', party: 2, name: 'Resold', email: 'resold@example.com',
    });
    assert.equal(resold.created, true);

    // X's guest actually paid — the webhook fires late, hitting the §6.4
    // recovery path (existing.status is 'expired', not 'hold'). The seat is
    // genuinely gone: the recovery path's OWN weekday-capacity lookup must
    // reject it and mark confirmed_conflict, not silently overbook.
    const result = await confirmBooking(db, 'b_recX', 'cs_1', 'pi_1');
    assert.equal(result.status, 'confirmed_conflict', 'the recovery path must respect the weekday cap — the seat is genuinely gone');
  });
});

// ---------------------------------------------------------------------------
// admin_api.js — handleCreateRoute / handleUpdateRoute validate weekday_capacity
// ---------------------------------------------------------------------------

function adminRequest(method, path_, body) {
  return new Request(`https://admin.example.com${path_}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('handleCreateRoute / handleUpdateRoute — weekday_capacity validation (migrations/0014)', () => {
  test('a valid weekday_capacity object is accepted and stored', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'wc-1', name: 'WC 1', city: 'X', price_cents: 2995,
      open_days: '[1,6,7]', slots: '["18:00"]',
      weekday_capacity: { '6': 6, '7': 6 },
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.deepEqual(JSON.parse(route.weekday_capacity), { '6': 6, '7': 6 });
  });

  test('an empty weekday_capacity object normalizes to NULL', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'wc-empty', name: 'WC Empty', city: 'X', price_cents: 2995,
      open_days: '[1]', slots: '["18:00"]', weekday_capacity: {},
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.equal(route.weekday_capacity, null);
  });

  test('rejects a weekday key outside 1-7', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'wc-bad-key', name: 'Bad', city: 'X', price_cents: 2995,
      open_days: '[1]', slots: '["18:00"]', weekday_capacity: { '8': 6 },
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /weekday/);
  });

  test('rejects a zero or negative capacity (positive integers only, unlike slot_capacity)', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'wc-zero', name: 'Bad', city: 'X', price_cents: 2995,
      open_days: '[1]', slots: '["18:00"]', weekday_capacity: { '1': 0 },
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /positive integer/);
  });

  test('omitting weekday_capacity entirely leaves it NULL (route created exactly as before this feature)', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'wc-omit', name: 'Omit', city: 'X', price_cents: 2995,
      open_days: '[1]', slots: '["18:00"]',
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.equal(route.weekday_capacity, null);
  });

  test('handleUpdateRoute can set weekday_capacity on an existing route, and clear it back to NULL', async () => {
    const env = { DB: db };
    const create = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'wc-upd', name: 'Upd', city: 'X', price_cents: 2995, open_days: '[1,6]', slots: '["18:00"]',
    }), env);
    assert.equal(create.status, 201);

    const setRes = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/wc-upd', {
      weekday_capacity: { '6': 4 },
    }), env, { id: 'wc-upd' });
    assert.equal(setRes.status, 200);
    const { route: setRoute } = await setRes.json();
    assert.deepEqual(JSON.parse(setRoute.weekday_capacity), { '6': 4 });

    const clearRes = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/wc-upd', {
      weekday_capacity: {},
    }), env, { id: 'wc-upd' });
    assert.equal(clearRes.status, 200);
    const { route: clearedRoute } = await clearRes.json();
    assert.equal(clearedRoute.weekday_capacity, null);
  });

  test('leaving weekday_capacity out of a PUT body does not touch the stored value (regression)', async () => {
    const env = { DB: db };
    await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'wc-untouched', name: 'Untouched', city: 'X', price_cents: 2995, open_days: '[1,6]', slots: '["18:00"]',
      weekday_capacity: { '6': 6 },
    }), env);

    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/wc-untouched', {
      price_cents: 3100,
    }), env, { id: 'wc-untouched' });
    assert.equal(res.status, 200);
    const { route } = await res.json();
    assert.equal(route.price_cents, 3100);
    assert.deepEqual(JSON.parse(route.weekday_capacity), { '6': 6 });
  });
});
