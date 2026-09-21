import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { computeHoldExpiry, toSqliteDatetime, aggregateCustomers } from '../src/logic.js';
import {
  createHold,
  diagnoseHoldFailure,
  confirmBooking,
  expireHolds,
  recordWebhookEvent,
  createRoute,
  getBooking,
  attachStripeSession,
  createManualBooking,
  listCustomerBookingRows,
  updateCustomer,
  setBookingDiscount,
  toPositional,
} from '../src/db.js';

// Test fixtures are written with named params for readability; the adapter is
// strict positional-only (like real D1), so route through the same translator
// production uses.
function exec(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Migrations applied in order, exactly as `wrangler d1 migrations apply`
// would — 0002 is real seed data (not needed for these fixtures) so it's
// skipped, but 0003 (routes.slot_capacity), 0004 (customers/manual/
// discount columns, Dashboard v2), and 0005 (security: bookings.ip,
// rate_events, auth_events) are schema and must be applied.
const schemaSql =
  readFileSync(path.join(__dirname, '../migrations/0001_init.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0003_slot_capacity.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0004_customers_manual_discount.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0005_security.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0006_error_log.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0007_admin_audit.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0008_failed_email.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0009_webhook_processing_status.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0010_booking_notes.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0011_currency_timezone.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0012_map_url_nl.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0014_weekday_capacity.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0015_weekday_bars.sql'), 'utf8');

function seedRoute(db, overrides = {}) {
  const route = {
    id: 'testroute',
    name: 'Test Route',
    city: 'Testville',
    price_cents: 2995,
    capacity: 10,
    max_party: 6,
    open_days: '[1,2,3,4,5,6,7]',
    slots: '["18:00"]',
    slot_capacity: '{}',
    map_url: null,
    active: 1,
    ...overrides,
  };
  exec(
    db,
    `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
     VALUES (:id, :name, :city, :price_cents, :capacity, :max_party, :open_days, :slots, :slot_capacity, :map_url, :active)`,
    route
  );
  return route;
}

function upsertDateOverride(db, { route_id, date, action, payload }) {
  exec(
    db,
    `INSERT OR REPLACE INTO date_overrides (route_id, date, action, payload) VALUES (:route_id, :date, :action, :payload)`,
    { route_id, date, action, payload: payload ?? null }
  );
}

let db;
beforeEach(() => {
  db = makeTestDb(schemaSql);
});

function makeHoldParams(overrides = {}) {
  return {
    id: `b_${Math.random().toString(36).slice(2)}`,
    route_id: 'testroute',
    date: '2026-08-06',
    slot: '18:00',
    party: 2,
    name: 'Anna',
    email: 'anna@example.com',
    phone: null,
    locale: 'en',
    marketing_opt_in: false,
    hold_expires: computeHoldExpiry(15),
    ...overrides,
  };
}

describe('createHold — atomic capacity guard', () => {
  test('succeeds up to exactly capacity; concurrent overflow calls fail with changes===0', async () => {
    seedRoute(db, { capacity: 10, max_party: 6 });

    // Fire capacity(10) + 5 = 15 calls with varying party sizes, no await gaps
    // between them (node:sqlite is synchronous under the hood via the adapter),
    // simulating "simultaneous" requests for the last seats.
    const parties = [3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1]; // sums to 29 total attempted
    const results = [];
    for (const party of parties) {
      const r = await createHold(db, makeHoldParams({ party }));
      results.push(r);
    }

    const succeeded = results.filter((r) => r.created);
    const failed = results.filter((r) => !r.created);
    const seatsSummed = succeeded.reduce((sum, r) => sum + r.booking.party, 0);

    assert.equal(seatsSummed, 10, 'exactly capacity seats should be held, no more');
    assert.ok(failed.length > 0, 'some calls should have been rejected');
    assert.ok(succeeded.length > 0);
  });

  test('party size exceeding max_party is rejected even with seats free', async () => {
    seedRoute(db, { capacity: 10, max_party: 6 });
    const result = await createHold(db, makeHoldParams({ party: 7 }));
    assert.equal(result.created, false);

    const diag = await diagnoseHoldFailure(db, { route_id: 'testroute', date: '2026-08-06', slot: '18:00', party: 7 });
    assert.equal(diag.code, 'party_too_large');
  });

  test('closed date_override blocks createHold even with seats free', async () => {
    seedRoute(db, { capacity: 10 });
    db.prepare(
      `INSERT INTO date_overrides (route_id, date, action, payload) VALUES ('testroute', '2026-08-06', 'closed', NULL)`
    ).bind().run();

    const result = await createHold(db, makeHoldParams());
    assert.equal(result.created, false);

    const diag = await diagnoseHoldFailure(db, { route_id: 'testroute', date: '2026-08-06', slot: '18:00', party: 2 });
    assert.equal(diag.code, 'route_closed');
  });

  test('remove_slot override blocks that one slot only', async () => {
    seedRoute(db, { capacity: 10, slots: '["18:00","18:30"]' });
    db.prepare(
      `INSERT INTO date_overrides (route_id, date, action, payload) VALUES ('testroute', '2026-08-06', 'remove_slot', '{"slot":"18:00"}')`
    ).bind().run();

    const blocked = await createHold(db, makeHoldParams({ slot: '18:00' }));
    assert.equal(blocked.created, false);

    const allowed = await createHold(db, makeHoldParams({ slot: '18:30' }));
    assert.equal(allowed.created, true);
  });

  test('capacity_override is honored over the route default capacity', async () => {
    seedRoute(db, { capacity: 10, max_party: 6 });
    db.prepare(
      `INSERT INTO date_overrides (route_id, date, action, payload) VALUES ('testroute', '2026-08-06', 'capacity_override', '{"capacity":3}')`
    ).bind().run();

    const first = await createHold(db, makeHoldParams({ party: 3 }));
    assert.equal(first.created, true);

    const second = await createHold(db, makeHoldParams({ party: 1 }));
    assert.equal(second.created, false, 'capacity_override of 3 already fully used');
  });
});

describe('per-timeslot capacity — precedence + no-overbook (migrations/0003)', () => {
  test('route-level per-slot default caps that one slot below the route default, other slots untouched', async () => {
    // Owner example: Rotterdam Route 2 defaults to 10 seats/departure, but
    // the 20:00 slot only ever has 6 (a bar is busy at that hour).
    seedRoute(db, {
      capacity: 10,
      max_party: 12,
      slots: '["18:00","20:00"]',
      slot_capacity: JSON.stringify({ '20:00': 6 }),
    });

    const at20 = await createHold(db, makeHoldParams({ id: 'b_20a', slot: '20:00', party: 6 }));
    assert.equal(at20.created, true, '6 seats fits the 20:00 per-slot default');
    const overAt20 = await createHold(db, makeHoldParams({ id: 'b_20b', slot: '20:00', party: 1 }));
    assert.equal(overAt20.created, false, '7th seat at 20:00 must be rejected — its cap is 6, not the route default of 10');

    // 18:00 has no per-slot entry, so it still uses the route default of 10.
    const at18 = await createHold(db, makeHoldParams({ id: 'b_18a', slot: '18:00', party: 10 }));
    assert.equal(at18.created, true, '18:00 keeps the full route-wide default capacity of 10');
  });

  test('date+slot override beats the route-level per-slot default', async () => {
    seedRoute(db, {
      capacity: 10,
      slots: '["20:00"]',
      slot_capacity: JSON.stringify({ '20:00': 6 }),
    });
    // Sat 2026-08-15, 20:00 slot -> 4 seats (owner example), lower than the
    // route-level per-slot default of 6.
    upsertDateOverride(db, {
      route_id: 'testroute', date: '2026-08-15', action: 'slot_capacity_override',
      payload: JSON.stringify({ '20:00': 4 }),
    });

    const within = await createHold(db, makeHoldParams({ id: 'b_a', date: '2026-08-15', slot: '20:00', party: 4 }));
    assert.equal(within.created, true, '4 seats fits the date+slot override');
    const overflow = await createHold(db, makeHoldParams({ id: 'b_b', date: '2026-08-15', slot: '20:00', party: 1 }));
    assert.equal(overflow.created, false, '5th seat must be rejected — lowest effective capacity (4) already used');

    // A different date is untouched by the override — falls back to the
    // route-level per-slot default of 6.
    const otherDate = await createHold(db, makeHoldParams({ id: 'b_c', date: '2026-08-16', slot: '20:00', party: 6 }));
    assert.equal(otherDate.created, true, 'other dates still get the route-level per-slot default of 6');
  });

  test('date+slot override only touches the named slot; sibling slots keep their own effective capacity', async () => {
    seedRoute(db, { capacity: 10, max_party: 12, slots: '["19:00","20:00"]' });
    upsertDateOverride(db, {
      route_id: 'testroute', date: '2026-08-15', action: 'slot_capacity_override',
      payload: JSON.stringify({ '20:00': 4 }),
    });

    const at20 = await createHold(db, makeHoldParams({ id: 'b_20', date: '2026-08-15', slot: '20:00', party: 4 }));
    assert.equal(at20.created, true);
    const at20over = await createHold(db, makeHoldParams({ id: 'b_20x', date: '2026-08-15', slot: '20:00', party: 1 }));
    assert.equal(at20over.created, false, '20:00 is capped at 4 by the override');

    // 19:00 that same date has no override entry -> falls through to route
    // default of 10, completely unaffected by the 20:00-only override.
    const at19 = await createHold(db, makeHoldParams({ id: 'b_19', date: '2026-08-15', slot: '19:00', party: 10 }));
    assert.equal(at19.created, true, '19:00 keeps the full route default of 10');
  });

  test('date+slot override (4) beats a date-wide capacity_override (6) for the named slot, but the date-wide number still applies to other slots', async () => {
    seedRoute(db, { capacity: 10, slots: '["19:00","20:00"]' });
    upsertDateOverride(db, {
      route_id: 'testroute', date: '2026-08-15', action: 'capacity_override',
      payload: JSON.stringify({ capacity: 6 }),
    });
    upsertDateOverride(db, {
      route_id: 'testroute', date: '2026-08-15', action: 'slot_capacity_override',
      payload: JSON.stringify({ '20:00': 4 }),
    });

    // 20:00: date+slot override (4) wins over the date-wide number (6).
    const at20 = await createHold(db, makeHoldParams({ id: 'b_20', date: '2026-08-15', slot: '20:00', party: 4 }));
    assert.equal(at20.created, true);
    const at20over = await createHold(db, makeHoldParams({ id: 'b_20x', date: '2026-08-15', slot: '20:00', party: 1 }));
    assert.equal(at20over.created, false, 'effective cap at 20:00 is 4 (date+slot), not 6 (date-wide)');

    // 19:00: no date+slot entry for it, so the date-wide capacity_override (6) applies.
    const at19 = await createHold(db, makeHoldParams({ id: 'b_19', date: '2026-08-15', slot: '19:00', party: 6 }));
    assert.equal(at19.created, true);
    const at19over = await createHold(db, makeHoldParams({ id: 'b_19x', date: '2026-08-15', slot: '19:00', party: 1 }));
    assert.equal(at19over.created, false, 'effective cap at 19:00 is 6 (date-wide), route default of 10 must not leak through');
  });

  test('slot_capacity_override of 0 fully closes just that slot on that date ("or closed")', async () => {
    seedRoute(db, { capacity: 10, max_party: 12, slots: '["19:00","20:00"]' });
    upsertDateOverride(db, {
      route_id: 'testroute', date: '2026-08-15', action: 'slot_capacity_override',
      payload: JSON.stringify({ '20:00': 0 }),
    });

    const blocked = await createHold(db, makeHoldParams({ id: 'b_x', date: '2026-08-15', slot: '20:00', party: 1 }));
    assert.equal(blocked.created, false, 'capacity 0 must reject even a party of 1');

    const diag = await diagnoseHoldFailure(db, { route_id: 'testroute', date: '2026-08-15', slot: '20:00', party: 1 });
    assert.equal(diag.code, 'sold_out');
    assert.equal(diag.seats_left, 0);

    // sibling slot that date is untouched
    const ok = await createHold(db, makeHoldParams({ id: 'b_y', date: '2026-08-15', slot: '19:00', party: 10 }));
    assert.equal(ok.created, true);
  });

  test('no-overbook holds against the LOWEST effective capacity under concurrent-style calls', async () => {
    // route default 10, per-slot default for 20:00 = 6, date+slot override
    // for this one date knocks it down further to 3 — the lowest number in
    // the whole precedence chain must be the one enforced.
    seedRoute(db, {
      capacity: 10,
      slots: '["20:00"]',
      slot_capacity: JSON.stringify({ '20:00': 6 }),
    });
    upsertDateOverride(db, {
      route_id: 'testroute', date: '2026-08-15', action: 'slot_capacity_override',
      payload: JSON.stringify({ '20:00': 3 }),
    });

    const parties = [2, 2, 2, 2, 2]; // attempts sum to 10, well past every candidate cap
    const results = [];
    for (const party of parties) {
      results.push(await createHold(db, makeHoldParams({ date: '2026-08-15', slot: '20:00', party })));
    }
    const seatsSummed = results.filter((r) => r.created).reduce((sum, r) => sum + r.booking.party, 0);
    assert.equal(seatsSummed, 2, 'only 2 fits under the lowest effective cap of 3 (party size 2, next 2 would be 4 > 3)');
    assert.ok(seatsSummed <= 3, 'never exceeds the lowest effective capacity in the precedence chain');
  });

  test('diagnoseHoldFailure reports seats_left against the lowest effective capacity', async () => {
    seedRoute(db, {
      capacity: 10,
      slots: '["20:00"]',
      slot_capacity: JSON.stringify({ '20:00': 6 }),
    });
    upsertDateOverride(db, {
      route_id: 'testroute', date: '2026-08-15', action: 'slot_capacity_override',
      payload: JSON.stringify({ '20:00': 4 }),
    });
    const a = await createHold(db, makeHoldParams({ id: 'b_a', date: '2026-08-15', slot: '20:00', party: 3 }));
    assert.ok(a.created);

    const diag = await diagnoseHoldFailure(db, { route_id: 'testroute', date: '2026-08-15', slot: '20:00', party: 5 });
    assert.equal(diag.code, 'sold_out');
    assert.equal(diag.seats_left, 1, '4 (date+slot cap) - 3 used = 1 left, not 6 or 10');
  });
});

describe('expireHolds', () => {
  test('flips only holds past hold_expires; leaves confirmed/future holds untouched', async () => {
    seedRoute(db, { capacity: 10 });

    const past = await createHold(db, makeHoldParams({ id: 'b_past', hold_expires: '2000-01-01 00:00:00' }));
    const future = await createHold(db, makeHoldParams({ id: 'b_future', hold_expires: computeHoldExpiry(15) }));
    assert.ok(past.created && future.created);

    // confirm one booking so it's out of 'hold' status entirely
    const confirmedResult = await confirmBooking(db, 'b_future', 'cs_test', 'pi_test');
    assert.equal(confirmedResult.status, 'confirmed');

    const pastHold2 = await createHold(db, makeHoldParams({ id: 'b_past2', hold_expires: '2000-01-01 00:00:00' }));
    assert.ok(pastHold2.created);

    const { expired } = await expireHolds(db);
    assert.equal(expired, 2, 'both past-expiry holds should flip');

    const pastBooking = await getBooking(db, 'b_past');
    const pastBooking2 = await getBooking(db, 'b_past2');
    const futureBooking = await getBooking(db, 'b_future');

    assert.equal(pastBooking.status, 'expired');
    assert.equal(pastBooking2.status, 'expired');
    assert.equal(futureBooking.status, 'confirmed', 'confirmed booking must be untouched by the sweep');
  });
});

describe('confirmBooking', () => {
  test('normal path: hold -> confirmed', async () => {
    seedRoute(db, { capacity: 10 });
    const hold = await createHold(db, makeHoldParams({ id: 'b_1' }));
    assert.ok(hold.created);

    const result = await confirmBooking(db, 'b_1', 'cs_123', 'pi_123');
    assert.equal(result.status, 'confirmed');
    assert.equal(result.booking.stripe_session, 'cs_123');
    assert.equal(result.booking.stripe_payment_intent, 'pi_123');
    assert.equal(result.booking.hold_expires, null);
  });

  test('conflict path (§6.4): expired hold whose seat got resold lands in confirmed_conflict, not confirmed', async () => {
    seedRoute(db, { capacity: 5, max_party: 6 });

    // Booking A holds all 5 seats, then we manually expire it (simulating the
    // Stripe-minimum-vs-15-minute-hold race described in SPEC.md §6.4).
    const a = await createHold(db, makeHoldParams({ id: 'b_a', party: 5, hold_expires: '2000-01-01 00:00:00' }));
    assert.ok(a.created);
    await expireHolds(db); // sweep it to 'expired'
    const aRow = await getBooking(db, 'b_a');
    assert.equal(aRow.status, 'expired');

    // A second booking now fills the now-empty slot with a confirmed booking.
    const b = await createHold(db, makeHoldParams({ id: 'b_b', party: 5, hold_expires: computeHoldExpiry(15) }));
    assert.ok(b.created);
    const bConfirm = await confirmBooking(db, 'b_b', 'cs_b', 'pi_b');
    assert.equal(bConfirm.status, 'confirmed');

    // Now A's stale Stripe payment succeeds and the webhook tries to confirm it.
    // The seat is gone (B holds all 5) — A must land in confirmed_conflict.
    const aConfirm = await confirmBooking(db, 'b_a', 'cs_a', 'pi_a');
    assert.equal(aConfirm.status, 'confirmed_conflict');
  });

  test('conflict-recovery path succeeds when the seat is still actually free', async () => {
    seedRoute(db, { capacity: 10, max_party: 6 });
    const a = await createHold(db, makeHoldParams({ id: 'b_recover', party: 3, hold_expires: '2000-01-01 00:00:00' }));
    assert.ok(a.created);
    await expireHolds(db);
    const row = await getBooking(db, 'b_recover');
    assert.equal(row.status, 'expired');

    // nobody else took the seat — recovery path should succeed
    const result = await confirmBooking(db, 'b_recover', 'cs_r', 'pi_r');
    assert.equal(result.status, 'confirmed');
  });
});

describe('recordWebhookEvent — dedupe', () => {
  test('first call returns duplicate:false, second call same id returns duplicate:true', async () => {
    const first = await recordWebhookEvent(db, 'evt_123', 'checkout.session.completed');
    assert.equal(first.duplicate, false);

    const second = await recordWebhookEvent(db, 'evt_123', 'checkout.session.completed');
    assert.equal(second.duplicate, true);
  });
});

describe('attachStripeSession', () => {
  test('only updates a booking still in hold status', async () => {
    seedRoute(db, { capacity: 10 });
    await createHold(db, makeHoldParams({ id: 'b_x' }));
    const ok = await attachStripeSession(db, 'b_x', 'cs_x');
    assert.equal(ok, true);
    const booking = await getBooking(db, 'b_x');
    assert.equal(booking.stripe_session, 'cs_x');
  });
});

// ---------------------------------------------------------------------------
// Dashboard v2 — manual (phone) booking: same atomic seat guard as createHold
// ---------------------------------------------------------------------------

function makeManualParams(overrides = {}) {
  return {
    id: `b_${Math.random().toString(36).slice(2)}`,
    route_id: 'testroute',
    date: '2026-08-06',
    slot: '18:00',
    party: 2,
    name: 'Phone Guest',
    email: 'phone@example.com',
    phone: null,
    locale: 'en',
    marketing_opt_in: false,
    payment_status: 'paid_invoice',
    discount_code: null,
    discount_cents: 0,
    ...overrides,
  };
}

describe('createManualBooking — atomic capacity guard (owner phone booking)', () => {
  test('lands straight as a confirmed, source=manual row', async () => {
    seedRoute(db, { capacity: 10, max_party: 6 });
    const result = await createManualBooking(db, makeManualParams({ id: 'b_manual_1', party: 4 }));
    assert.equal(result.created, true);
    assert.equal(result.booking.status, 'confirmed');
    assert.equal(result.booking.source, 'manual');
    assert.equal(result.booking.payment_status, 'paid_invoice');
    assert.equal(result.booking.hold_expires, null, 'a confirmed manual booking has no hold to expire');
  });

  test('is rejected atomically once the slot is full — never oversells the physical seats', async () => {
    seedRoute(db, { capacity: 5, max_party: 6 });
    const first = await createManualBooking(db, makeManualParams({ id: 'b_manual_a', party: 5 }));
    assert.equal(first.created, true);

    const second = await createManualBooking(db, makeManualParams({ id: 'b_manual_b', party: 1 }));
    assert.equal(second.created, false);
    assert.equal(second.seats_left, 0);
  });

  test('shares the exact same capacity pool as web holds — a manual booking cannot oversell around an active hold', async () => {
    seedRoute(db, { capacity: 5, max_party: 6 });
    const webHold = await createHold(db, makeHoldParams({ id: 'b_web', party: 4, date: '2026-08-06', slot: '18:00' }));
    assert.equal(webHold.created, true);

    // Only 1 seat physically left — a 2-person phone booking must be refused.
    const manual = await createManualBooking(db, makeManualParams({ id: 'b_manual_c', party: 2 }));
    assert.equal(manual.created, false);
    assert.equal(manual.seats_left, 1);

    // ...but a 1-person one fits exactly.
    const manualFits = await createManualBooking(db, makeManualParams({ id: 'b_manual_d', party: 1 }));
    assert.equal(manualFits.created, true);
  });

  test('does NOT enforce max_party — the owner can override that guest-facing rule by hand', async () => {
    seedRoute(db, { capacity: 20, max_party: 6 });
    const result = await createManualBooking(db, makeManualParams({ id: 'b_manual_big', party: 12 }));
    assert.equal(result.created, true, 'manual bookings intentionally skip the max_party guest-facing cap');
  });

  test('persists discount_code/discount_cents on the manual row (owner-typed comp/discount)', async () => {
    seedRoute(db, { capacity: 10 });
    const result = await createManualBooking(db, makeManualParams({
      id: 'b_manual_disc', payment_status: 'comp', discount_code: 'FRIEND', discount_cents: 1500,
    }));
    assert.equal(result.created, true);
    assert.equal(result.booking.payment_status, 'comp');
    assert.equal(result.booking.discount_code, 'FRIEND');
    assert.equal(result.booking.discount_cents, 1500);
  });
});

// ---------------------------------------------------------------------------
// Dashboard v2 — Customers (CRM): aggregation over real DB rows + edit
// propagation across every booking that shares an email.
// ---------------------------------------------------------------------------

describe('listCustomerBookingRows + aggregateCustomers — real DB round trip', () => {
  test('one row per distinct email, spend net of discount, comp bookings count as €0', async () => {
    seedRoute(db, { id: 'testroute', capacity: 20, price_cents: 3000 });

    const web = await createHold(db, makeHoldParams({ id: 'b_agg_1', email: 'Repeat@Example.com', name: 'Repeat Guest', party: 2 }));
    await confirmBooking(db, 'b_agg_1', 'cs_agg_1', 'pi_agg_1');
    await setBookingDiscount(db, 'b_agg_1', 'SUMMER10', 500);

    await createManualBooking(db, makeManualParams({
      id: 'b_agg_2', email: 'repeat@example.com', name: 'Repeat Guest (phone)', party: 3, payment_status: 'paid_invoice',
    }));

    await createManualBooking(db, makeManualParams({
      id: 'b_agg_3', email: 'repeat@example.com', name: 'Repeat Guest', party: 1, payment_status: 'comp',
    }));

    const rows = await listCustomerBookingRows(db);
    const customers = aggregateCustomers(rows);

    assert.equal(customers.length, 1, 'same email (case-insensitive) folds into one customer');
    const c = customers[0];
    assert.equal(c.email, 'repeat@example.com');
    assert.equal(c.bookings_count, 3);
    assert.equal(c.guests, 6, '2 (web) + 3 (manual paid) + 1 (comp) guests');
    // web: 2*3000 - 500 = 5500 ; manual paid: 3*3000 = 9000 ; comp: €0
    assert.equal(c.total_spent_cents, 5500 + 9000);
    assert.equal(c.discount_total_cents, 500);
  });

  test('search filters by name/email/phone, case-insensitively', async () => {
    seedRoute(db, { id: 'testroute', capacity: 20 });
    await createManualBooking(db, makeManualParams({ id: 'b_search_1', email: 'anna@example.com', name: 'Anna Smith', phone: '+31600000001' }));
    await createManualBooking(db, makeManualParams({ id: 'b_search_2', email: 'bram@example.com', name: 'Bram Jansen', phone: '+31600000002' }));

    const rows = await listCustomerBookingRows(db);
    const byName = aggregateCustomers(rows, 'anna');
    assert.equal(byName.length, 1);
    assert.equal(byName[0].email, 'anna@example.com');

    const byPhone = aggregateCustomers(rows, '0000002');
    assert.equal(byPhone.length, 1);
    assert.equal(byPhone[0].email, 'bram@example.com');
  });
});

describe('updateCustomer — edit propagates to every booking sharing the old email', () => {
  test('fixing a typo\'d name/phone updates ALL of that customer\'s rows, not just one', async () => {
    seedRoute(db, { id: 'testroute', capacity: 20 });
    await createManualBooking(db, makeManualParams({ id: 'b_edit_1', email: 'typo@example.com', name: 'Ana', phone: '+31600000000' }));
    await createManualBooking(db, makeManualParams({ id: 'b_edit_2', email: 'typo@example.com', name: 'Ana', phone: '+31600000000' }));
    await createManualBooking(db, makeManualParams({ id: 'b_edit_other', email: 'someoneelse@example.com', name: 'Untouched' }));

    const result = await updateCustomer(db, 'typo@example.com', { name: 'Anna', phone: '+31611111111' });
    assert.equal(result.updated, 2, 'both of typo@example.com\'s bookings were rewritten, and only those');

    const b1 = await getBooking(db, 'b_edit_1');
    const b2 = await getBooking(db, 'b_edit_2');
    assert.equal(b1.name, 'Anna');
    assert.equal(b1.phone, '+31611111111');
    assert.equal(b2.name, 'Anna');
    assert.equal(b2.phone, '+31611111111');

    const untouched = await getBooking(db, 'b_edit_other');
    assert.equal(untouched.name, 'Untouched', 'a different customer\'s row must be unaffected');
  });

  test('changing the email re-points every one of that customer\'s rows to the new address', async () => {
    seedRoute(db, { id: 'testroute', capacity: 20 });
    await createManualBooking(db, makeManualParams({ id: 'b_move_1', email: 'old@example.com', name: 'Mover' }));
    await createManualBooking(db, makeManualParams({ id: 'b_move_2', email: 'old@example.com', name: 'Mover' }));

    const result = await updateCustomer(db, 'old@example.com', { email: 'new@example.com' });
    assert.equal(result.updated, 2);

    const rows = await listCustomerBookingRows(db);
    const customers = aggregateCustomers(rows);
    const moved = customers.find((c) => c.email === 'new@example.com');
    assert.ok(moved, 'the customer now appears under the new email');
    assert.equal(moved.bookings_count, 2);
    assert.equal(customers.find((c) => c.email === 'old@example.com'), undefined, 'no trace left under the old email');
  });

  test('is a no-op (0 updated) for an email with no bookings — nothing to propagate to', async () => {
    const result = await updateCustomer(db, 'nobody@example.com', { name: 'Nobody' });
    assert.equal(result.updated, 0);
  });
});

// ---------------------------------------------------------------------------
// toPositional — the named→positional translation layer that makes db.js's
// :named SQL safe on REAL D1 (which only supports ?/?N positional binding).
// These are the regression tests for the 2026-07 D1_TYPE_ERROR production
// incident: the adapter is now strict positional-only, and this translator
// is the one seam that feeds it (and production D1).
// ---------------------------------------------------------------------------

describe('toPositional — named→positional D1 translation', () => {
  test('same named param used multiple times maps to ONE ?N index, bound once', () => {
    const t = toPositional(
      `SELECT * FROM bookings WHERE route_id = :route_id AND (:party + 0) <= capacity AND route_id = :route_id`,
      { route_id: 'r1', party: 2 }
    );
    assert.equal(t.sql, `SELECT * FROM bookings WHERE route_id = ?1 AND (?2 + 0) <= capacity AND route_id = ?1`);
    assert.deepEqual(t.values, ['r1', 2]);
  });

  test("':' inside string literals is never treated as a param (JSON paths, time strings)", () => {
    const t = toPositional(
      `SELECT json_extract(payload, '$."' || :slot || '"') FROM t WHERE x = '18:00' AND f = strftime('%H:%M', 'now') AND s = :slot`,
      { slot: '18:00' }
    );
    assert.equal(
      t.sql,
      `SELECT json_extract(payload, '$."' || ?1 || '"') FROM t WHERE x = '18:00' AND f = strftime('%H:%M', 'now') AND s = ?1`
    );
    assert.deepEqual(t.values, ['18:00']);
  });

  test('escaped quotes inside literals do not end the literal early', () => {
    const t = toPositional(`SELECT 'it''s :not_a_param' AS s WHERE id = :id`, { id: 7 });
    assert.equal(t.sql, `SELECT 'it''s :not_a_param' AS s WHERE id = ?1`);
    assert.deepEqual(t.values, [7]);
  });

  test("':' inside -- line comments is left untouched", () => {
    const t = toPositional(`SELECT 1 -- note :route_id precedence\n WHERE id = :id`, { id: 'x' });
    assert.equal(t.sql, `SELECT 1 -- note :route_id precedence\n WHERE id = ?1`);
    assert.deepEqual(t.values, ['x']);
  });

  test('a :token with no matching binding throws (missing param)', () => {
    assert.throws(
      () => toPositional(`SELECT * FROM t WHERE id = :id`, {}),
      /references :id but no such binding/
    );
  });

  test('a binding the SQL never references throws (unused param)', () => {
    assert.throws(
      () => toPositional(`SELECT * FROM t WHERE id = :id`, { id: 1, stray: 2 }),
      /'stray' is never referenced/
    );
  });

  test('binding undefined throws — D1 has no undefined, null must be explicit', () => {
    assert.throws(
      () => toPositional(`SELECT * FROM t WHERE id = :id`, { id: undefined }),
      /'id' is undefined/
    );
  });

  test('the real CREATE_HOLD_SQL path works end-to-end through translation (colon-heavy SQL)', async () => {
    seedRoute(db, { capacity: 10, slot_capacity: JSON.stringify({ '18:00': 4 }) });
    const ok = await createHold(db, makeHoldParams({ party: 4 }));
    assert.equal(ok.created, true);
    const over = await createHold(db, makeHoldParams({ party: 1 }));
    assert.equal(over.created, false, 'per-slot cap of 4 enforced through translated SQL');
  });
});

describe('test adapter enforces real-D1 positional-only binding', () => {
  test('.bind(objectOfNamedParams) throws D1_TYPE_ERROR exactly like production D1', () => {
    assert.throws(
      () => db.prepare(`SELECT * FROM routes WHERE id = :id`).bind({ id: 'x' }),
      /D1_TYPE_ERROR: Type 'object' not supported/
    );
  });

  test('.bind(undefined value) throws D1_TYPE_ERROR', () => {
    assert.throws(
      () => db.prepare(`SELECT * FROM routes WHERE id = ?1`).bind(undefined),
      /D1_TYPE_ERROR/
    );
  });

  test('positional variadic bind works for run/all/first', () => {
    seedRoute(db);
    const row = db.prepare(`SELECT id, city FROM routes WHERE id = ?1`).bind('testroute').first();
    assert.equal(row.city, 'Testville');
    const allRes = db.prepare(`SELECT id FROM routes WHERE active = ?1`).bind(1).all();
    assert.equal(allRes.results.length, 1);
  });
});
