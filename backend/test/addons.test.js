// test/addons.test.js — migrations/0033 (addons, booking_addons,
// bookings.addon_notes): bar-fulfilled booking upsells. WOGO resells at a
// markup — the guest sees ONE price, the bar invoices its own lower price —
// so the load-bearing guarantees this file pins are: the server NEVER
// trusts a client-sent price, add-on capacity is atomic (the exact same
// guarded-INSERT idiom CREATE_HOLD_SQL uses for seats), cutoff is judged in
// the route's own timezone (DST-safe), a bar only ever sees the add-ons IT
// owns, and a route with zero active add-ons is untouched by any of this.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import * as realDb from '../src/db.js';
import { toPositional, getBooking } from '../src/db.js';
import { handleBook, handleListAddons, handleListRoutes } from '../src/guest_api.js';
import { handleWebhook, notifyBars, sendGuestConfirmationEmails } from '../src/webhook.js';
import { renderBarNotification, renderGuestConfirmation, renderOwnerNotification } from '../src/emails.js';
import { createCheckoutSession } from '../src/stripe.js';
import { addDaysToDateStr, computeBarArrivals } from '../src/logic.js';
import {
  handleListRouteAddons, handleCreateAddon, handleUpdateAddon, handleDeleteAddon,
  handleRescheduleBooking, ROUTE_ROLES,
} from '../src/admin_api.js';
import { createSessionCookieValue, COOKIE_NAME } from '../src/auth.js';
import { router } from '../src/index.js';
import worker from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql',
  '0022_bar_locale.sql', '0025_admin_users.sql', '0027_booking_utm.sql', '0028_bookings_email_lower_index.sql',
  '0029_route_booking_cutoff.sql', '0032_push_notifications.sql', '0033_addons.sql',
].map(migration).join('\n');

function run(testDb, sql, params = {}) {
  const t = toPositional(sql, params);
  return testDb.prepare(t.sql).bind(...t.values).run();
}

const TODAY = new Date().toISOString().slice(0, 10);
// Same reasoning as gift_cards.test.js's BOOKABLE_DATE: a real POST /api/book
// call goes through the same-day cutoff, so tests that call handleBook use a
// safely-future date instead of TODAY.
const BOOKABLE_DATE = addDaysToDateStr(TODAY, 5);

function seedRoute(testDb, overrides = {}) {
  const route = {
    id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 50, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00"]',
    slot_capacity: '{}', map_url: null, active: 1, currency: 'EUR', timezone: 'Europe/Amsterdam',
    ...overrides,
  };
  const cols = Object.keys(route);
  run(testDb, `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, route);
  return route;
}

async function seedBar(testDb, overrides = {}) {
  return realDb.addBar(testDb, 'testroute', {
    ord: 1, bar_name: 'Door 74', bar_email: 'bar-a@example.com', minutes_offset: 0, locale: 'nl',
    ...overrides,
  });
}

async function seedAddon(testDb, overrides = {}) {
  return realDb.createAddon(testDb, 'testroute', {
    name_en: 'Bites', name_nl: 'Bites', description_en: null, description_nl: null, image_url: null,
    price_cents: 1195, cost_cents: 999, currency: 'EUR', vat_rate: 9, is_food: true, unit: 'per_person',
    max_qty_per_booking: 10, capacity_per_slot: null, cutoff_hours: 24, sort_order: 0, active: true,
    ...overrides,
  });
}

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

// ---------------------------------------------------------------------------
// A route with zero active add-ons is byte-for-byte unchanged
// ---------------------------------------------------------------------------

describe('zero active add-ons — untouched guest flow', () => {
  test('GET /api/routes carries has_addons: false when no add-on exists', async () => {
    seedRoute(db);
    const res = await handleListRoutes(new Request('https://api.example.com/api/routes'), { DB: db });
    const { routes } = await res.json();
    assert.equal(routes[0].has_addons, false);
  });

  test('GET /api/routes carries has_addons: false when one exists but is inactive', async () => {
    seedRoute(db);
    await seedAddon(db, { active: false });
    const res = await handleListRoutes(new Request('https://api.example.com/api/routes'), { DB: db });
    const { routes } = await res.json();
    assert.equal(routes[0].has_addons, false, 'an inactive add-on must not make the widget fetch GET /api/addons');
  });

  test('GET /api/routes carries has_addons: true once an ACTIVE one exists', async () => {
    seedRoute(db);
    await seedAddon(db, { active: true });
    const res = await handleListRoutes(new Request('https://api.example.com/api/routes'), { DB: db });
    const { routes } = await res.json();
    assert.equal(routes[0].has_addons, true);
  });

  test('POST /api/book with no addons field books exactly as before — no booking_addons row, no addon_notes', async () => {
    seedRoute(db);
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
    let res;
    try {
      res = await handleBook(new Request('https://api.example.com/api/book', {
        method: 'POST',
        body: JSON.stringify({
          route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00', party: 2,
          name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
        }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.1', Origin: 'http://localhost:8000' },
      }), { DB: db, STRIPE_SECRET_KEY: 'sk_test' });
    } finally {
      global.fetch = realFetch;
    }
    assert.equal(res.status, 200);
    const { booking_id } = await res.json();
    const booking = await getBooking(db, booking_id);
    assert.equal(booking.addon_notes, null);
    const lines = await realDb.getAddonsForBooking(db, booking_id);
    assert.deepEqual(lines, []);
  });
});

// ---------------------------------------------------------------------------
// GET /api/addons — guest-facing filtering
// ---------------------------------------------------------------------------

describe('GET /api/addons', () => {
  test('an inactive add-on never appears', async () => {
    seedRoute(db);
    await seedAddon(db, { active: false });
    const res = await handleListAddons(
      new Request(`https://api.example.com/api/addons?route=testroute&date=${BOOKABLE_DATE}&slot=18:00`),
      { DB: db }
    );
    const body = await res.json();
    assert.deepEqual(body.addons, []);
  });

  test('guest-facing fields only — cost_cents/margin never leave this response', async () => {
    seedRoute(db);
    await seedAddon(db);
    const res = await handleListAddons(
      new Request(`https://api.example.com/api/addons?route=testroute&date=${BOOKABLE_DATE}&slot=18:00`),
      { DB: db }
    );
    const { addons } = await res.json();
    assert.equal(addons.length, 1);
    assert.equal('cost_cents' in addons[0], false);
    assert.equal(addons[0].price_cents, 1195);
    assert.equal(addons[0].is_food, true);
  });

  test('capacity_per_slot reached — the add-on drops out entirely', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { capacity_per_slot: 2 });
    // Reserve the only 2 units against a live hold.
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires, locale, marketing_opt_in)
              VALUES ('b_hold', 'testroute', :date, '18:00', 2, 'X', 'x@x.com', 'hold', datetime('now'), datetime('now','+10 minutes'), 'en', 0)`, { date: BOOKABLE_DATE });
    const reserve = await realDb.createBookingAddon(db, {
      booking_id: 'b_hold', addon_id: addon.id, qty: 2, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });
    assert.equal(reserve.created, true);

    const res = await handleListAddons(
      new Request(`https://api.example.com/api/addons?route=testroute&date=${BOOKABLE_DATE}&slot=18:00`),
      { DB: db }
    );
    const { addons } = await res.json();
    assert.deepEqual(addons, [], 'sold out for this slot — must not be offered');
  });

  test('remaining_qty reflects partial capacity used', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { capacity_per_slot: 5 });
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires, locale, marketing_opt_in)
              VALUES ('b_hold', 'testroute', :date, '18:00', 2, 'X', 'x@x.com', 'hold', datetime('now'), datetime('now','+10 minutes'), 'en', 0)`, { date: BOOKABLE_DATE });
    await realDb.createBookingAddon(db, {
      booking_id: 'b_hold', addon_id: addon.id, qty: 3, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });
    const res = await handleListAddons(
      new Request(`https://api.example.com/api/addons?route=testroute&date=${BOOKABLE_DATE}&slot=18:00`),
      { DB: db }
    );
    const { addons } = await res.json();
    assert.equal(addons[0].remaining_qty, 2);
  });

  // DST: Europe/Amsterdam fall-back, 2026-10-25 (the EXACT fixture date +
  // "now" test/logic.test.js already pins for isSlotPastCutoff itself —
  // this proves the REUSE through the guest-facing add-ons endpoint reaches
  // the real DST-aware arithmetic, not a naive one). Mocking `new Date()`
  // (the function's own default `nowDate` param) requires replacing the
  // global Date class, not just Date.now — overriding Date.now alone does
  // NOT affect a no-argument `new Date()` in V8/Node.
  function withFixedNow(isoString, fn) {
    const RealDate = Date;
    const fixedMs = new RealDate(isoString).getTime();
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixedMs);
        else super(...args);
      }
      static now() { return fixedMs; }
    }
    global.Date = FakeDate;
    return Promise.resolve(fn()).finally(() => { global.Date = RealDate; });
  }

  test('cutoff_hours is judged in the ROUTE timezone, DST-safe (Europe/Amsterdam fall-back date)', async () => {
    seedRoute(db, { timezone: 'Europe/Amsterdam' });
    await seedAddon(db, { cutoff_hours: 1 });
    // "now" = 2026-10-25T20:00:00Z = 21:00 CET local (clocks already fell
    // back at 01:00 UTC that day) — identical fixture to test/logic.test.js's
    // own isSlotPastCutoff DST pin.
    await withFixedNow('2026-10-25T20:00:00.000Z', async () => {
      const res = await handleListAddons(
        new Request('https://api.example.com/api/addons?route=testroute&date=2026-10-25&slot=23:30'),
        { DB: db }
      );
      const { addons } = await res.json();
      assert.equal(addons.length, 1, 'still 2.5h away — within a 1h cutoff');

      const res2 = await handleListAddons(
        new Request('https://api.example.com/api/addons?route=testroute&date=2026-10-25&slot=21:30'),
        { DB: db }
      );
      const { addons: addons2 } = await res2.json();
      assert.deepEqual(addons2, [], 'only 30 min away — past a 1h cutoff');
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/book — server-side validation + price recompute
// ---------------------------------------------------------------------------

describe('POST /api/book — add-ons validation', () => {
  function bookBody(extra = {}) {
    return {
      route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00', party: 2,
      name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
      ...extra,
    };
  }
  function bookReq(body) {
    return new Request('https://api.example.com/api/book', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.2', Origin: 'http://localhost:8000' },
    });
  }

  test('a tampered client price is ignored — the Stripe line item uses the DB price', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { price_cents: 1195 });
    const capturedBodies = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      capturedBodies.push(String(opts.body));
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
    };
    try {
      const res = await handleBook(bookReq(bookBody({
        // Client sends only addon_id/qty per the real contract, but even if
        // it tried to smuggle a price in, the handler never reads one.
        addons: [{ addon_id: addon.id, qty: 1, price_cents: 1 }],
      })), { DB: db, STRIPE_SECRET_KEY: 'sk_test' });
      assert.equal(res.status, 200);
      const stripeBody = capturedBodies.find((b) => b.includes('unit_amount%5D=1195'));
      assert.ok(stripeBody, 'Stripe must have been called with the DB price (1195), not a tampered one');
      assert.ok(!capturedBodies.some((b) => /unit_amount%5D=1(?!\d)/.test(b)), 'the tampered price_cents=1 must never reach Stripe');
    } finally {
      global.fetch = realFetch;
    }
  });

  test('qty beyond party size is rejected for a per_person add-on', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { unit: 'per_person' });
    const res = await handleBook(bookReq(bookBody({ party: 2, addons: [{ addon_id: addon.id, qty: 3 }] })), { DB: db });
    assert.equal(res.status, 400);
  });

  test('qty beyond 1 is rejected for a per_booking add-on, even with a large party', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { unit: 'per_booking', max_qty_per_booking: 10 });
    const res = await handleBook(bookReq(bookBody({ party: 6, addons: [{ addon_id: addon.id, qty: 2 }] })), { DB: db });
    assert.equal(res.status, 400);
  });

  test('qty is further capped by max_qty_per_booking even within the unit cap', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { unit: 'per_person', max_qty_per_booking: 1 });
    const res = await handleBook(bookReq(bookBody({ party: 6, addons: [{ addon_id: addon.id, qty: 2 }] })), { DB: db });
    assert.equal(res.status, 400);
  });

  test('an inactive add-on is rejected', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { active: false });
    const res = await handleBook(bookReq(bookBody({ addons: [{ addon_id: addon.id, qty: 1 }] })), { DB: db });
    assert.equal(res.status, 400);
    const { error } = await res.json();
    assert.equal(error, 'addon_not_found');
  });

  test('an add-on belonging to a DIFFERENT route is rejected', async () => {
    seedRoute(db);
    seedRoute(db, { id: 'otherroute', name: 'Other' });
    const addon = await realDb.createAddon(db, 'otherroute', {
      name_en: 'Bites', name_nl: 'Bites', price_cents: 1000, cost_cents: 800, currency: 'EUR',
      vat_rate: 9, is_food: true, unit: 'per_person', max_qty_per_booking: 5, cutoff_hours: 24, active: true,
    });
    const res = await handleBook(bookReq(bookBody({ addons: [{ addon_id: addon.id, qty: 1 }] })), { DB: db });
    assert.equal(res.status, 400);
  });

  test('past the add-on cutoff is rejected even though the booking itself is still bookable', async () => {
    seedRoute(db);
    // cutoff_hours longer than the route's own booking_cutoff_minutes
    // default (60 min = 1h) — the SLOT is still bookable, but this specific
    // extra needs more notice than that.
    const addon = await seedAddon(db, { cutoff_hours: 24 * 10 }); // 10 days
    const res = await handleBook(bookReq(bookBody({ addons: [{ addon_id: addon.id, qty: 1 }] })), { DB: db });
    assert.equal(res.status, 409);
    const { error } = await res.json();
    assert.equal(error, 'addon_cutoff_passed');
  });

  test('duplicate addon_id entries in one request are rejected', async () => {
    seedRoute(db);
    const addon = await seedAddon(db);
    const res = await handleBook(bookReq(bookBody({ addons: [{ addon_id: addon.id, qty: 1 }, { addon_id: addon.id, qty: 1 }] })), { DB: db });
    assert.equal(res.status, 400);
  });

  test('a sold-out add-on at the atomic reservation step releases the seat hold and reports addon_sold_out', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { capacity_per_slot: 1 });
    // Pre-fill the one unit of capacity with a live hold.
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires, locale, marketing_opt_in)
              VALUES ('b_first', 'testroute', :date, '18:00', 1, 'X', 'x@x.com', 'hold', datetime('now'), datetime('now','+10 minutes'), 'en', 0)`, { date: BOOKABLE_DATE });
    await realDb.createBookingAddon(db, {
      booking_id: 'b_first', addon_id: addon.id, qty: 1, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });

    const res = await handleBook(bookReq(bookBody({ addons: [{ addon_id: addon.id, qty: 1 }] })), { DB: db });
    assert.equal(res.status, 409);
    const { error } = await res.json();
    assert.equal(error, 'addon_sold_out');
    // The seat hold must have been released, not left to expire naturally —
    // a second identical attempt right away must not trip the active-hold cap.
    const holds = await realDb.countActiveHoldsByEmail(db, 'anna@example.com');
    assert.equal(holds, 0);
  });

  test('allergy note is stored on bookings.addon_notes, separate from the general notes field', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { is_food: true });
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
    let res;
    try {
      res = await handleBook(bookReq(bookBody({
        notes: 'please ring the bell',
        addon_notes: 'severe nut allergy',
        addons: [{ addon_id: addon.id, qty: 1 }],
      })), { DB: db, STRIPE_SECRET_KEY: 'sk_test' });
    } finally {
      global.fetch = realFetch;
    }
    assert.equal(res.status, 200);
    const { booking_id } = await res.json();
    const booking = await getBooking(db, booking_id);
    assert.equal(booking.notes, 'please ring the bell');
    assert.equal(booking.addon_notes, 'severe nut allergy');
  });
});

// ---------------------------------------------------------------------------
// Atomic capacity (concurrency) — the second of two requests for the last
// unit must lose, exactly like CREATE_HOLD_SQL's own seat guard.
// ---------------------------------------------------------------------------

describe('atomic add-on capacity', () => {
  test('two reservations against a 1-unit add-on — only the first succeeds', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { capacity_per_slot: 1 });
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires, locale, marketing_opt_in)
              VALUES ('b_a', 'testroute', :date, '18:00', 1, 'A', 'a@a.com', 'hold', datetime('now'), datetime('now','+10 minutes'), 'en', 0),
                     ('b_b', 'testroute', :date, '18:00', 1, 'B', 'b@b.com', 'hold', datetime('now'), datetime('now','+10 minutes'), 'en', 0)`, { date: BOOKABLE_DATE });

    const paramsFor = (bookingId) => ({
      booking_id: bookingId, addon_id: addon.id, qty: 1, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });
    const first = await realDb.createBookingAddon(db, paramsFor('b_a'));
    const second = await realDb.createBookingAddon(db, paramsFor('b_b'));
    assert.equal(first.created, true);
    assert.equal(second.created, false, 'capacity is exhausted — the second reservation must be rejected');
  });

  test('cancellation releases capacity for the next booking', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { capacity_per_slot: 1 });
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires, locale, marketing_opt_in)
              VALUES ('b_a', 'testroute', :date, '18:00', 1, 'A', 'a@a.com', 'confirmed', datetime('now'), NULL, 'en', 0)`, { date: BOOKABLE_DATE });
    const first = await realDb.createBookingAddon(db, {
      booking_id: 'b_a', addon_id: addon.id, qty: 1, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });
    assert.equal(first.created, true);

    // Cancel booking b_a — src/db.js:cancelBooking excludes 'cancelled' from
    // every capacity SUM (bookings AND, via the same status check, this
    // add-on's capacity query) — no separate "release" step exists or is
    // needed.
    await realDb.cancelBooking(db, { id: 'b_a' });

    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires, locale, marketing_opt_in)
              VALUES ('b_b', 'testroute', :date, '18:00', 1, 'B', 'b@b.com', 'confirmed', datetime('now'), NULL, 'en', 0)`, { date: BOOKABLE_DATE });
    const second = await realDb.createBookingAddon(db, {
      booking_id: 'b_b', addon_id: addon.id, qty: 1, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });
    assert.equal(second.created, true, 'cancelling the first booking must free the unit for the next one');
  });
});

// ---------------------------------------------------------------------------
// Stripe line items
// ---------------------------------------------------------------------------

describe('createCheckoutSession — add-on line items', () => {
  test('each add-on gets its own line item, in the route currency, at the snapshot price', async () => {
    const capturedBodies = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      capturedBodies.push(String(opts.body));
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
    };
    try {
      const route = { id: 'testroute', name: 'Test Route', price_cents: 2995, currency: 'EUR' };
      const booking = { id: 'b_1', party: 2, email: 'a@a.com', locale: 'en', date: BOOKABLE_DATE, slot: '18:00' };
      const addons = [
        { qty: 2, unit_price_cents: 1195, currency: 'EUR', name_snapshot_en: 'Bites', name_snapshot_nl: 'Hapjes' },
      ];
      await createCheckoutSession({ STRIPE_SECRET_KEY: 'sk_test' }, booking, route, addons);
      const body = capturedBodies[0];
      assert.ok(body.includes('line_items%5B0%5D'), 'the ticket must still be line_items[0]');
      assert.ok(body.includes('line_items%5B1%5D%5Bquantity%5D=2'));
      assert.ok(body.includes('line_items%5B1%5D%5Bprice_data%5D%5Bunit_amount%5D=1195'));
      assert.ok(body.includes(encodeURIComponent('Bites')));
    } finally {
      global.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Gift card + add-ons interaction
// ---------------------------------------------------------------------------

describe('gift card + add-ons', () => {
  test('a gift card that partially covers the TICKET also counts the add-ons total toward its coverage', async () => {
    seedRoute(db, { price_cents: 2000 });
    const addon = await seedAddon(db, { price_cents: 1000, cost_cents: 800 });
    const card = await realDb.createGiftCard(db, {
      initial_cents: 2500, currency: 'EUR', buyer_email: 'buyer@example.com', buyer_name: 'Buyer',
      recipient_name: 'Rita', recipient_email: 'rita@example.com', message: 'enjoy',
    });
    // Ticket (party 1 x 2000) + 1x addon (1000) = 3000 total; a 2500 gift
    // card covers 2500 of it, leaving 500 to actually charge via Stripe.
    const capturedBodies = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      capturedBodies.push(String(opts.body));
      if (String(url).includes('/v1/coupons')) return new Response(JSON.stringify({ id: 'coupon_1' }), { status: 200 });
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
    };
    try {
      const res = await handleBook(new Request('https://api.example.com/api/book', {
        method: 'POST',
        body: JSON.stringify({
          route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00', party: 1,
          name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
          gift_code: card.code, addons: [{ addon_id: addon.id, qty: 1 }],
        }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.3', Origin: 'http://localhost:8000' },
      }), { DB: db, STRIPE_SECRET_KEY: 'sk_test' });
      assert.equal(res.status, 200);
      const { booking_id } = await res.json();
      const booking = await getBooking(db, booking_id);
      assert.equal(booking.gift_applied_cents, 2500, 'the full 2500 balance must be applied against ticket+addon combined');

      const couponBody = capturedBodies.find((b) => b.includes('amount_off'));
      assert.ok(couponBody && couponBody.includes('amount_off=2500'));

      const lines = await realDb.getAddonsForBooking(db, booking_id);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].unit_price_cents, 1000, 'recomputed from the DB, matching the resolved snapshot');
    } finally {
      global.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Bar isolation + allergy note propagation
// ---------------------------------------------------------------------------

describe('bar isolation', () => {
  test('only the bar that owns the add-on sees it — and the allergy note rides only with it', async () => {
    seedRoute(db);
    const barA = await seedBar(db, { ord: 1, bar_name: 'Bar A', bar_email: 'bar-a@example.com' });
    const barB = await seedBar(db, { ord: 2, bar_name: 'Bar B', bar_email: 'bar-b@example.com', minutes_offset: 60 });
    const addon = await seedAddon(db, { bar_id: barA.id, name_en: 'Secret Bites' });

    const booking = {
      id: 'b_1', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00', party: 2,
      name: 'Anna', email: 'anna@example.com', phone: null, locale: 'en', notes: null,
      addon_notes: 'nut allergy — please keep separate',
    };
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville', timezone: 'Europe/Amsterdam' };
    const bars = await realDb.listBarsForDate(db, 'testroute', BOOKABLE_DATE);
    const overrides = await realDb.listOverridesForDate(db, 'testroute', BOOKABLE_DATE);
    const arrivals = computeBarArrivals(route, bars, overrides, booking);

    const emails = [];
    await notifyBars({ DB: db }, booking, route, {
      database: realDb, computeBarArrivals,
      sendTransactional: async (env, msg) => { emails.push(msg); },
      addons: [{ bar_id: addon.bar_id, qty: 2, name_snapshot_en: 'Secret Bites', name_snapshot_nl: 'Secret Bites', unit_price_cents: addon.price_cents, currency: 'EUR' }],
    });

    const mailToA = emails.find((m) => m.to === 'bar-a@example.com');
    const mailToB = emails.find((m) => m.to === 'bar-b@example.com');
    assert.ok(mailToA, 'Bar A must have been emailed');
    assert.ok(mailToB, 'Bar B must have been emailed (its own arrival notice)');
    assert.match(mailToA.htmlContent, /Secret Bites/);
    assert.match(mailToA.htmlContent, /nut allergy/);
    assert.doesNotMatch(mailToB.htmlContent, /Secret Bites/, "Bar B must never see Bar A's add-on");
    assert.doesNotMatch(mailToB.htmlContent, /nut allergy/, 'Bar B must never see the allergy note for an item it does not own');
  });

  test('a route-wide (bar_id = null) add-on reaches NO bar email, only the guest/owner side', () => {
    const bar = { bar_id: null, bar_name: 'Any Bar', bar_email: 'any@example.com', arrival_time: '18:00', locale: 'nl' };
    const mail = renderBarNotification(bar, { party: 2, name: 'Anna', email: 'a@a.com', notes: null, addon_notes: 'nut allergy' }, { name: 'R', city: 'C' }, { addons: [] });
    assert.doesNotMatch(mail.html, /nut allergy/);
  });
});

describe('allergy note propagation', () => {
  test('the guest confirmation shows what was ordered and the allergy note', () => {
    const booking = { id: 'b_1', date: BOOKABLE_DATE, slot: '18:00', party: 2, name: 'Anna', locale: 'en', addon_notes: 'nut allergy' };
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville', currency: 'EUR' };
    const addons = [{ qty: 2, name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', unit_price_cents: 1195, currency: 'EUR' }];
    const mail = renderGuestConfirmation(booking, route, { locale: 'en', addons });
    assert.match(mail.html, /Bites/);
    assert.match(mail.html, /nut allergy/);
  });

  test('the owner notification shows every add-on on the booking, regardless of which bar owns it', () => {
    const booking = { id: 'b_1', date: BOOKABLE_DATE, slot: '18:00', party: 2, name: 'Anna', email: 'a@a.com', locale: 'en', addon_notes: 'nut allergy' };
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville', currency: 'EUR' };
    const addons = [{ qty: 1, name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', unit_price_cents: 1195, currency: 'EUR' }];
    const mail = renderOwnerNotification(booking, route, { addons });
    assert.match(mail.html, /Bites/);
    assert.match(mail.html, /nut allergy/);
  });

  test('a booking with no add-ons renders no extras section and no allergy block anywhere', () => {
    const booking = { id: 'b_1', date: BOOKABLE_DATE, slot: '18:00', party: 2, name: 'Anna', locale: 'en', addon_notes: null };
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville', currency: 'EUR' };
    const mail = renderGuestConfirmation(booking, route, { locale: 'en' });
    assert.doesNotMatch(mail.html, /EXTRAS ORDERED/i);
  });
});

// ---------------------------------------------------------------------------
// Admin — add-ons CRUD + margin validation
// ---------------------------------------------------------------------------

describe('admin add-ons CRUD', () => {
  function csrfReq(method, body) {
    return new Request('https://api.example.com/x', {
      method, body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
    });
  }

  test('a brand-new add-on is NEVER active, even if the client asks for active: true', async () => {
    seedRoute(db);
    const res = await handleCreateAddon(csrfReq('POST', {
      name_en: 'Bites', name_nl: 'Bites', price_cents: 1000, cost_cents: 800,
      vat_rate: 9, unit: 'per_person', max_qty_per_booking: 5, cutoff_hours: 24, active: true,
    }), { DB: db }, { id: 'testroute' });
    assert.equal(res.status, 201);
    const { addon } = await res.json();
    assert.equal(addon.active, 0, '"ship with zero active add-ons" — create never trusts a client active:true');
  });

  test('guest price below bar cost is BLOCKED outright', async () => {
    seedRoute(db);
    const res = await handleCreateAddon(csrfReq('POST', {
      name_en: 'Bites', name_nl: 'Bites', price_cents: 500, cost_cents: 800,
      vat_rate: 9, unit: 'per_person', max_qty_per_booking: 5, cutoff_hours: 24,
    }), { DB: db }, { id: 'testroute' });
    assert.equal(res.status, 400);
  });

  test('a sub-€1 margin is reported back as a warning, not blocked', async () => {
    seedRoute(db);
    const res = await handleCreateAddon(csrfReq('POST', {
      name_en: 'Bites', name_nl: 'Bites', price_cents: 850, cost_cents: 800,
      vat_rate: 9, unit: 'per_person', max_qty_per_booking: 5, cutoff_hours: 24,
    }), { DB: db }, { id: 'testroute' });
    assert.equal(res.status, 201);
    const { margin_warning } = await res.json();
    assert.equal(margin_warning, true);
  });

  test('bar_id must belong to the same route', async () => {
    seedRoute(db);
    seedRoute(db, { id: 'otherroute', name: 'Other' });
    const foreignBar = await realDb.addBar(db, 'otherroute', { ord: 1, bar_name: 'Foreign', bar_email: 'f@f.com', minutes_offset: 0, locale: 'nl' });
    const res = await handleCreateAddon(csrfReq('POST', {
      bar_id: foreignBar.id, name_en: 'Bites', name_nl: 'Bites', price_cents: 1000, cost_cents: 800,
      vat_rate: 9, unit: 'per_person', max_qty_per_booking: 5, cutoff_hours: 24,
    }), { DB: db }, { id: 'testroute' });
    assert.equal(res.status, 400);
  });

  test('update + delete round-trip', async () => {
    seedRoute(db);
    const addon = await seedAddon(db, { active: false });
    const upd = await handleUpdateAddon(csrfReq('PUT', { active: true, price_cents: 1300 }), { DB: db }, { id: 'testroute', addonId: addon.id });
    assert.equal(upd.status, 200);
    const { addon: updated } = await upd.json();
    assert.equal(updated.active, 1);
    assert.equal(updated.price_cents, 1300);

    const del = await handleDeleteAddon(csrfReq('DELETE'), { DB: db }, { id: 'testroute', addonId: addon.id });
    assert.equal(del.status, 200);
    const gone = await realDb.getAddon(db, addon.id);
    assert.equal(gone, null);
  });

  test('a deleted add-on leaves its booking_addons history untouched (name snapshot survives)', async () => {
    seedRoute(db);
    const addon = await seedAddon(db);
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, locale, marketing_opt_in)
              VALUES ('b_1', 'testroute', :date, '18:00', 1, 'A', 'a@a.com', 'confirmed', datetime('now'), 'en', 0)`, { date: BOOKABLE_DATE });
    await realDb.createBookingAddon(db, {
      booking_id: 'b_1', addon_id: addon.id, qty: 1, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });
    await realDb.deleteAddon(db, addon.id);
    const lines = await realDb.getAddonsForBooking(db, 'b_1');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].name_snapshot_en, 'Bites', 'history must survive the parent add-on being deleted');
    assert.equal(lines[0].bar_id, null, 'the live bar_id join is simply null once the add-on is gone');
  });
});

// ---------------------------------------------------------------------------
// Role gating — viewing vs editing
// ---------------------------------------------------------------------------

describe('role gating (ROUTE_ROLES)', () => {
  test('viewing a route\'s add-ons is viewer+', () => {
    assert.equal(ROUTE_ROLES['GET /admin/api/routes/:id/addons'], 'viewer');
  });
  test('creating/editing/deleting an add-on is staff+ (looser than the owner-only bars editor, per spec)', () => {
    assert.equal(ROUTE_ROLES['POST /admin/api/routes/:id/addons'], 'staff');
    assert.equal(ROUTE_ROLES['PUT /admin/api/routes/:id/addons/:addonId'], 'staff');
    assert.equal(ROUTE_ROLES['DELETE /admin/api/routes/:id/addons/:addonId'], 'staff');
  });

  const SESSION_SECRET = 'test-session-secret';
  async function cookieHeaderFor(identity) {
    const value = await createSessionCookieValue(SESSION_SECRET, identity);
    return `${COOKIE_NAME}=${value}`;
  }
  const BASE_ENV = (testDb) => ({ DB: testDb, ADMIN_SESSION_SECRET: SESSION_SECRET, ADMIN_TOKEN: 'emergency-token' });
  const CTX = { waitUntil: () => {} };

  test('a viewer is 403d from creating an add-on; a staff member succeeds', async () => {
    seedRoute(db);
    const viewerCookie = await cookieHeaderFor({ uid: null, role: 'viewer', email: 'v@example.com' });
    const staffCookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const body = JSON.stringify({ name_en: 'Bites', name_nl: 'Bites', price_cents: 1000, cost_cents: 800, vat_rate: 9, unit: 'per_person', max_qty_per_booking: 5, cutoff_hours: 24 });

    const asViewer = await worker.fetch(new Request('https://api.example.com/admin/api/routes/testroute/addons', {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', Cookie: viewerCookie, 'X-Requested-With': 'wogo-admin' },
    }), BASE_ENV(db), CTX);
    assert.equal(asViewer.status, 403);

    const asStaff = await worker.fetch(new Request('https://api.example.com/admin/api/routes/testroute/addons', {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', Cookie: staffCookie, 'X-Requested-With': 'wogo-admin' },
    }), BASE_ENV(db), CTX);
    assert.equal(asStaff.status, 201);
  });

  test('a viewer CAN list a route\'s add-ons', async () => {
    seedRoute(db);
    const viewerCookie = await cookieHeaderFor({ uid: null, role: 'viewer', email: 'v@example.com' });
    const res = await worker.fetch(new Request('https://api.example.com/admin/api/routes/testroute/addons', {
      headers: { Cookie: viewerCookie },
    }), BASE_ENV(db), CTX);
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Reschedule re-validation — "fail loudly", never silently drop a paid item
// ---------------------------------------------------------------------------

describe('reschedule — add-ons re-validated against the new slot', () => {
  function csrfReq(method, body) {
    return new Request('https://api.example.com/x', {
      method, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
    });
  }

  test('a capacity conflict in the new slot blocks the reschedule outright', async () => {
    seedRoute(db, { slots: '["18:00","20:00"]' });
    const addon = await seedAddon(db, { capacity_per_slot: 1 });
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, locale, marketing_opt_in)
              VALUES
              ('b_mover', 'testroute', :date, '18:00', 2, 'Mover', 'mover@example.com', 'confirmed', datetime('now'), 'en', 0),
              ('b_other', 'testroute', :date, '20:00', 1, 'Other', 'other@example.com', 'confirmed', datetime('now'), 'en', 0)`, { date: BOOKABLE_DATE });
    const paramsFor = (bid) => ({
      booking_id: bid, addon_id: addon.id, qty: 1, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: bid === 'b_mover' ? '18:00' : '20:00',
    });
    await realDb.createBookingAddon(db, paramsFor('b_mover'));
    await realDb.createBookingAddon(db, paramsFor('b_other'));

    const res = await handleRescheduleBooking(csrfReq('POST', { date: BOOKABLE_DATE, slot: '20:00' }), { DB: db }, { id: 'b_mover' });
    assert.equal(res.status, 409);
    const { error } = await res.json();
    assert.equal(error, 'addon_conflict');
    const stillAt1800 = await getBooking(db, 'b_mover');
    assert.equal(stillAt1800.slot, '18:00', 'the booking must NOT have moved when its add-on could not be honoured');
  });

  test('a cutoff conflict in the new (closer) slot blocks the reschedule', async () => {
    seedRoute(db, { slots: '["18:00","20:00"]', timezone: 'Europe/Amsterdam' });
    const addon = await seedAddon(db, { cutoff_hours: 24 * 30 }); // effectively always "too late" to move
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, locale, marketing_opt_in)
              VALUES ('b_mover', 'testroute', :date, '18:00', 2, 'Mover', 'mover@example.com', 'confirmed', datetime('now'), 'en', 0)`, { date: BOOKABLE_DATE });
    await realDb.createBookingAddon(db, {
      booking_id: 'b_mover', addon_id: addon.id, qty: 1, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });

    const res = await handleRescheduleBooking(csrfReq('POST', { date: BOOKABLE_DATE, slot: '20:00' }), { DB: db }, { id: 'b_mover' });
    assert.equal(res.status, 409);
    const { error } = await res.json();
    assert.equal(error, 'addon_conflict');
  });

  test('a booking that is the ONLY order on a 1-unit add-on can move within its own reservation (no false self-conflict)', async () => {
    seedRoute(db, { slots: '["18:00","20:00"]' });
    const addon = await seedAddon(db, { capacity_per_slot: 1 });
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, locale, marketing_opt_in)
              VALUES ('b_mover', 'testroute', :date, '18:00', 2, 'Mover', 'mover@example.com', 'confirmed', datetime('now'), 'en', 0)`, { date: BOOKABLE_DATE });
    await realDb.createBookingAddon(db, {
      booking_id: 'b_mover', addon_id: addon.id, qty: 1, unit_price_cents: addon.price_cents,
      unit_cost_cents: addon.cost_cents, currency: 'EUR', vat_rate: 9,
      name_snapshot_en: 'Bites', name_snapshot_nl: 'Bites', route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00',
    });

    const res = await handleRescheduleBooking(csrfReq('POST', { date: BOOKABLE_DATE, slot: '20:00' }), { DB: db }, { id: 'b_mover' });
    assert.equal(res.status, 200);
    const moved = await getBooking(db, 'b_mover');
    assert.equal(moved.slot, '20:00');
  });
});
