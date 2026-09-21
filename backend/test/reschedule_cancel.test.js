// test/reschedule_cancel.test.js — owner "Move booking" / "Cancel booking"
// drawer actions: db.js's atomic rescheduleBooking/cancelBooking, the
// webhook.js email senders (notifyBarsReschedule/notifyBarsCancellation,
// sendGuestRescheduleEmail/sendGuestCancellationEmail), and the
// admin_api.js HTTP handlers (handleRescheduleBooking/handleCancelBooking).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import * as db from '../src/db.js';
import {
  createManualBooking, getBooking, rescheduleBooking, cancelBooking, toPositional,
} from '../src/db.js';
import { handleRescheduleBooking, handleCancelBooking } from '../src/admin_api.js';
import {
  notifyBarsReschedule, notifyBarsCancellation,
  sendGuestRescheduleEmail, sendGuestCancellationEmail,
} from '../src/webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

function exec(db_, sql, params = {}) {
  const t = toPositional(sql, params);
  return db_.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(db_, overrides = {}) {
  const route = {
    id: 'testroute',
    name: 'Test Route',
    city: 'Testville',
    price_cents: 2995,
    capacity: 2,
    max_party: 6,
    open_days: '[1,2,3,4,5,6,7]',
    slots: '["18:00","19:00"]',
    slot_capacity: '{}',
    map_url: null,
    active: 1,
    ...overrides,
  };
  exec(
    db_,
    `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
     VALUES (:id, :name, :city, :price_cents, :capacity, :max_party, :open_days, :slots, :slot_capacity, :map_url, :active)`,
    route
  );
  return route;
}

function seedBar(db_, routeId, overrides = {}) {
  const bar = {
    route_id: routeId, ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com', minutes_offset: 0,
    ...overrides,
  };
  exec(
    db_,
    `INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset)
     VALUES (:route_id, :ord, :bar_name, :bar_email, :minutes_offset)`,
    bar
  );
  return bar;
}

const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

let sqliteDb;
beforeEach(() => {
  sqliteDb = makeTestDb(schemaSql);
  seedRoute(sqliteDb);
});

// admin_api.js's handlers call the real webhook.js senders with NO deps
// override, so a real (unstubbed) run would try to fetch() Brevo's real API.
// Stub global.fetch the same way notes.test.js does for Stripe, so those
// HTTP-layer tests never touch the network — they always "succeed" quietly.
const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
});
afterEach(() => {
  global.fetch = realFetch;
});

function adminRequest(pathname, body, headers = {}) {
  return new Request(`https://api.example.com${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin', ...headers },
  });
}

async function makeConfirmed(overrides = {}) {
  const result = await createManualBooking(sqliteDb, {
    id: overrides.id || `b_${Math.random().toString(36).slice(2)}`,
    route_id: 'testroute',
    date: TODAY,
    slot: '18:00',
    party: 1,
    name: 'Anna',
    email: 'anna@example.com',
    ...overrides,
  });
  assert.equal(result.created, true, 'fixture booking must actually be created');
  return result.booking;
}

// ---------------------------------------------------------------------------
// db.js — rescheduleBooking
// ---------------------------------------------------------------------------

describe('db.rescheduleBooking', () => {
  test('moves date/slot and returns previous', async () => {
    const booking = await makeConfirmed({ id: 'b_move_ok', date: TODAY, slot: '18:00', party: 1 });
    const result = await rescheduleBooking(sqliteDb, { id: booking.id, date: TOMORROW, slot: '19:00' });
    assert.equal(result.moved, true);
    assert.deepEqual(result.previous, { date: TODAY, slot: '18:00' });
    assert.equal(result.booking.date, TOMORROW);
    assert.equal(result.booking.slot, '19:00');

    const reread = await getBooking(sqliteDb, booking.id);
    assert.equal(reread.date, TOMORROW);
    assert.equal(reread.slot, '19:00');
    assert.equal(reread.status, 'confirmed', 'status is untouched by a move');
  });

  test('same date+slot is a no-op: moved:true, noop:true, no actual change', async () => {
    const booking = await makeConfirmed({ id: 'b_move_noop', date: TODAY, slot: '18:00', party: 1 });
    const result = await rescheduleBooking(sqliteDb, { id: booking.id, date: TODAY, slot: '18:00' });
    assert.equal(result.moved, true);
    assert.equal(result.noop, true);
    assert.equal(result.booking.date, TODAY);
    assert.equal(result.booking.slot, '18:00');
  });

  test('blocked when the new slot is full — booking stays at its old date/slot', async () => {
    // capacity is 2 (seedRoute default). Fill 19:00 completely with A, then
    // try to move B (currently at 18:00) into 19:00 — must be rejected.
    const a = await makeConfirmed({ id: 'b_fill', date: TODAY, slot: '19:00', party: 2 });
    const b = await makeConfirmed({ id: 'b_mover', date: TODAY, slot: '18:00', party: 1 });

    const result = await rescheduleBooking(sqliteDb, { id: b.id, date: TODAY, slot: '19:00' });
    assert.equal(result.moved, false);
    assert.equal(result.seats_left, 0);

    const reread = await getBooking(sqliteDb, b.id);
    assert.equal(reread.date, TODAY);
    assert.equal(reread.slot, '18:00', 'booking must stay put when the target slot has no room');

    // Sanity: A untouched too.
    const rereadA = await getBooking(sqliteDb, a.id);
    assert.equal(rereadA.slot, '19:00');
  });

  test('reports the real remaining seats when the move partially fits', async () => {
    // capacity 2. Fill 19:00 with 1 seat used, then try to move a party of 3
    // into it (0-that's over max but reschedule doesn't check max_party —
    // only capacity) — capacity guard should reject and report 1 seat left.
    await makeConfirmed({ id: 'b_partial', date: TODAY, slot: '19:00', party: 1 });
    const mover = await makeConfirmed({ id: 'b_mover2', date: TODAY, slot: '18:00', party: 2 });
    const result = await rescheduleBooking(sqliteDb, { id: mover.id, date: TODAY, slot: '19:00' });
    assert.equal(result.moved, false);
    assert.equal(result.seats_left, 1);
  });

  test('refuses a non-confirmed (hold) booking', async () => {
    exec(sqliteDb, `
      INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires)
      VALUES (:id, :route_id, :date, :slot, :party, :name, :email, 'hold', datetime('now'), datetime('now','+15 minutes'))
    `, { id: 'b_hold', route_id: 'testroute', date: TODAY, slot: '18:00', party: 1, name: 'Held', email: 'held@example.com' });

    const result = await rescheduleBooking(sqliteDb, { id: 'b_hold', date: TOMORROW, slot: '19:00' });
    assert.equal(result.not_movable, true);

    const reread = await getBooking(sqliteDb, 'b_hold');
    assert.equal(reread.date, TODAY, 'a hold must never be moved');
  });

  test('refuses a cancelled booking', async () => {
    const booking = await makeConfirmed({ id: 'b_already_cancelled', date: TODAY, slot: '18:00', party: 1 });
    await cancelBooking(sqliteDb, { id: booking.id });
    const result = await rescheduleBooking(sqliteDb, { id: booking.id, date: TOMORROW, slot: '19:00' });
    assert.equal(result.not_movable, true);
  });

  test('unknown booking id returns not_found', async () => {
    const result = await rescheduleBooking(sqliteDb, { id: 'nope', date: TOMORROW, slot: '19:00' });
    assert.equal(result.not_found, true);
  });

  test('confirmed_conflict bookings ARE movable', async () => {
    exec(sqliteDb, `
      INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at)
      VALUES (:id, :route_id, :date, :slot, :party, :name, :email, 'confirmed_conflict', datetime('now'))
    `, { id: 'b_conflict', route_id: 'testroute', date: TODAY, slot: '18:00', party: 1, name: 'Conflict', email: 'conflict@example.com' });

    const result = await rescheduleBooking(sqliteDb, { id: 'b_conflict', date: TOMORROW, slot: '19:00' });
    assert.equal(result.moved, true);
  });
});

// ---------------------------------------------------------------------------
// db.js — cancelBooking
// ---------------------------------------------------------------------------

describe('db.cancelBooking', () => {
  test('sets status=cancelled and clears hold_expires; frees seats for a later booking', async () => {
    // capacity 1 route for a tight seats-freed check.
    seedRoute(sqliteDb, { id: 'tightroute', capacity: 1, slots: '["18:00"]' });
    const a = await createManualBooking(sqliteDb, {
      id: 'b_cancel_free', route_id: 'tightroute', date: TODAY, slot: '18:00', party: 1, name: 'Anna', email: 'anna@example.com',
    });
    assert.equal(a.created, true);

    // Slot is now full — a second manual booking must fail.
    const blocked = await createManualBooking(sqliteDb, {
      id: 'b_second', route_id: 'tightroute', date: TODAY, slot: '18:00', party: 1, name: 'Bob', email: 'bob@example.com',
    });
    assert.equal(blocked.created, false);
    assert.equal(blocked.seats_left, 0);

    const result = await cancelBooking(sqliteDb, { id: a.booking.id });
    assert.equal(result.cancelled, true);
    assert.equal(result.booking.status, 'cancelled');
    assert.equal(result.booking.hold_expires, null);

    // Now the freed seat lets a new booking through.
    const after = await createManualBooking(sqliteDb, {
      id: 'b_third', route_id: 'tightroute', date: TODAY, slot: '18:00', party: 1, name: 'Cara', email: 'cara@example.com',
    });
    assert.equal(after.created, true, 'cancelling must free the seat for a subsequent booking');
  });

  test('refuses a non-confirmed (hold) booking', async () => {
    exec(sqliteDb, `
      INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires)
      VALUES (:id, :route_id, :date, :slot, :party, :name, :email, 'hold', datetime('now'), datetime('now','+15 minutes'))
    `, { id: 'b_hold2', route_id: 'testroute', date: TODAY, slot: '18:00', party: 1, name: 'Held', email: 'held@example.com' });

    const result = await cancelBooking(sqliteDb, { id: 'b_hold2' });
    assert.equal(result.not_cancellable, true);
    const reread = await getBooking(sqliteDb, 'b_hold2');
    assert.equal(reread.status, 'hold');
  });

  test('refuses an already-cancelled booking (no double-cancel)', async () => {
    const booking = await makeConfirmed({ id: 'b_double_cancel', date: TODAY, slot: '18:00', party: 1 });
    const first = await cancelBooking(sqliteDb, { id: booking.id });
    assert.equal(first.cancelled, true);
    const second = await cancelBooking(sqliteDb, { id: booking.id });
    assert.equal(second.not_cancellable, true);
  });

  test('unknown booking id returns not_found', async () => {
    const result = await cancelBooking(sqliteDb, { id: 'nope' });
    assert.equal(result.not_found, true);
  });
});

// ---------------------------------------------------------------------------
// webhook.js — email senders (deps-injected, real db functions against the
// sqlite test db, fake sendTransactional to capture what would have gone out)
// ---------------------------------------------------------------------------

describe('webhook.js — reschedule/cancel emails', () => {
  test('notifyBarsReschedule emails every bar with the NEW arrival time and subject says MOVED', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com', minutes_offset: 0 });
    seedBar(sqliteDb, 'testroute', { ord: 2, bar_name: 'Bar B', bar_email: 'barb@example.com', minutes_offset: 60 });
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };
    const sent = [];

    const oldBooking = await makeConfirmed({ id: 'b_resched_email', date: TODAY, slot: '18:00', party: 2, name: 'Anna', email: 'anna@example.com' });
    const newBooking = { ...oldBooking, date: TOMORROW, slot: '19:00' };

    const arrivals = await notifyBarsReschedule(env, newBooking, route, {
      previous: { date: oldBooking.date, slot: oldBooking.slot },
      database: db,
      sendTransactional: async (env2, msg) => { sent.push(msg); },
    });

    assert.equal(arrivals.length, 2);
    assert.equal(sent.length, 2, 'one email per bar');
    const recipients = sent.map((m) => m.to).sort();
    assert.deepEqual(recipients, ['bara@example.com', 'barb@example.com']);
    for (const msg of sent) {
      assert.match(msg.subject, /moved/i, 'bar reschedule subject must say MOVED');
      assert.ok(msg.htmlContent.includes('Anna'), 'bar email carries the guest name');
    }
  });

  test('notifyBarsCancellation emails every bar and subject says CANCELLED', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com', minutes_offset: 0 });
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };
    const sent = [];

    const booking = await makeConfirmed({ id: 'b_cancel_email', date: TODAY, slot: '18:00', party: 2, name: 'Bo', email: 'bo@example.com' });

    const arrivals = await notifyBarsCancellation(env, booking, route, {
      database: db,
      sendTransactional: async (env2, msg) => { sent.push(msg); },
    });

    assert.equal(arrivals.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'bara@example.com');
    assert.match(sent[0].subject, /cancelled/i);
    assert.ok(sent[0].htmlContent.includes('Bo'));
  });

  test('sendGuestRescheduleEmail sends ONE email to the guest, subject says moved, shows the previous slot', async () => {
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };
    const sent = [];

    const oldBooking = await makeConfirmed({ id: 'b_guest_resched', date: TODAY, slot: '18:00', party: 1, name: 'Dina', email: 'dina@example.com' });
    const newBooking = { ...oldBooking, date: TOMORROW, slot: '19:00' };

    await sendGuestRescheduleEmail(env, newBooking, route, { previous: { date: oldBooking.date, slot: oldBooking.slot } }, {
      database: db,
      sendTransactional: async (env2, msg) => { sent.push(msg); },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'dina@example.com');
    assert.match(sent[0].subject, /moved/i);
    assert.ok(sent[0].htmlContent.includes(oldBooking.slot), 'the old (struck-through) time appears in the email');
  });

  test('sendGuestCancellationEmail sends ONE email to the guest, subject says cancelled, includes the owner message when given', async () => {
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };
    const sent = [];

    const booking = await makeConfirmed({ id: 'b_guest_cancel', date: TODAY, slot: '18:00', party: 1, name: 'Eli', email: 'eli@example.com' });

    await sendGuestCancellationEmail(env, booking, route, { message: 'Refund of €30 is on its way.' }, {
      database: db,
      sendTransactional: async (env2, msg) => { sent.push(msg); },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'eli@example.com');
    assert.match(sent[0].subject, /cancelled/i);
    assert.ok(sent[0].htmlContent.includes('Refund of'), 'the owner note is included');
  });
});

// ---------------------------------------------------------------------------
// admin_api.js — HTTP handlers (CSRF, validation, status-code mapping)
// ---------------------------------------------------------------------------

describe('handleRescheduleBooking', () => {
  test('moves the booking and returns 200 with the updated booking', async () => {
    const booking = await makeConfirmed({ id: 'b_http_move', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const res = await handleRescheduleBooking(
      adminRequest(`/admin/api/bookings/${booking.id}/reschedule`, { date: TOMORROW, slot: '19:00' }),
      env, { id: booking.id }
    );
    assert.equal(res.status, 200);
    const { booking: updated } = await res.json();
    assert.equal(updated.date, TOMORROW);
    assert.equal(updated.slot, '19:00');
  });

  test('missing CSRF header is rejected with 403', async () => {
    const booking = await makeConfirmed({ id: 'b_http_move_csrf', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const req = new Request(`https://api.example.com/admin/api/bookings/${booking.id}/reschedule`, {
      method: 'POST', body: JSON.stringify({ date: TOMORROW, slot: '19:00' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handleRescheduleBooking(req, env, { id: booking.id });
    assert.equal(res.status, 403);
  });

  test('invalid date is rejected with 400', async () => {
    const booking = await makeConfirmed({ id: 'b_http_move_baddate', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const res = await handleRescheduleBooking(
      adminRequest(`/admin/api/bookings/${booking.id}/reschedule`, { date: 'not-a-date', slot: '19:00' }),
      env, { id: booking.id }
    );
    assert.equal(res.status, 400);
  });

  test('unknown booking id returns 404', async () => {
    const env = { DB: sqliteDb };
    const res = await handleRescheduleBooking(
      adminRequest(`/admin/api/bookings/nope/reschedule`, { date: TOMORROW, slot: '19:00' }),
      env, { id: 'nope' }
    );
    assert.equal(res.status, 404);
  });

  test('sold-out target slot returns 409 with error "sold_out" and the booking is untouched', async () => {
    await makeConfirmed({ id: 'b_http_fill', date: TODAY, slot: '19:00', party: 2 });
    const b = await makeConfirmed({ id: 'b_http_mover', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const res = await handleRescheduleBooking(
      adminRequest(`/admin/api/bookings/${b.id}/reschedule`, { date: TODAY, slot: '19:00' }),
      env, { id: b.id }
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'sold_out');

    const reread = await getBooking(sqliteDb, b.id);
    assert.equal(reread.slot, '18:00', 'a rejected move must not touch the booking');
  });

  test('a non-confirmed (hold) booking cannot be moved — 409 "not_movable"', async () => {
    exec(sqliteDb, `
      INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires)
      VALUES (:id, :route_id, :date, :slot, :party, :name, :email, 'hold', datetime('now'), datetime('now','+15 minutes'))
    `, { id: 'b_http_hold', route_id: 'testroute', date: TODAY, slot: '18:00', party: 1, name: 'Held', email: 'held@example.com' });
    const env = { DB: sqliteDb };
    const res = await handleRescheduleBooking(
      adminRequest(`/admin/api/bookings/b_http_hold/reschedule`, { date: TOMORROW, slot: '19:00' }),
      env, { id: 'b_http_hold' }
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'not_movable');
  });
});

describe('handleCancelBooking', () => {
  test('cancels the booking and returns 200 with status=cancelled', async () => {
    const booking = await makeConfirmed({ id: 'b_http_cancel', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const res = await handleCancelBooking(
      adminRequest(`/admin/api/bookings/${booking.id}/cancel`, { message: 'Refunded by hand.' }),
      env, { id: booking.id }
    );
    assert.equal(res.status, 200);
    const { booking: updated } = await res.json();
    assert.equal(updated.status, 'cancelled');
  });

  test('cancel works with no message at all (optional field)', async () => {
    const booking = await makeConfirmed({ id: 'b_http_cancel_nomsg', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const res = await handleCancelBooking(
      adminRequest(`/admin/api/bookings/${booking.id}/cancel`, {}),
      env, { id: booking.id }
    );
    assert.equal(res.status, 200);
  });

  test('missing CSRF header is rejected with 403', async () => {
    const booking = await makeConfirmed({ id: 'b_http_cancel_csrf', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const req = new Request(`https://api.example.com/admin/api/bookings/${booking.id}/cancel`, {
      method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' },
    });
    const res = await handleCancelBooking(req, env, { id: booking.id });
    assert.equal(res.status, 403);
  });

  test('an oversize message is rejected with 400', async () => {
    const booking = await makeConfirmed({ id: 'b_http_cancel_bigmsg', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const res = await handleCancelBooking(
      adminRequest(`/admin/api/bookings/${booking.id}/cancel`, { message: 'x'.repeat(2001) }),
      env, { id: booking.id }
    );
    assert.equal(res.status, 400);
  });

  test('unknown booking id returns 404', async () => {
    const env = { DB: sqliteDb };
    const res = await handleCancelBooking(adminRequest(`/admin/api/bookings/nope/cancel`, {}), env, { id: 'nope' });
    assert.equal(res.status, 404);
  });

  test('a non-confirmed (hold) booking cannot be cancelled — 409 "not_cancellable"', async () => {
    exec(sqliteDb, `
      INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, created_at, hold_expires)
      VALUES (:id, :route_id, :date, :slot, :party, :name, :email, 'hold', datetime('now'), datetime('now','+15 minutes'))
    `, { id: 'b_http_hold_cancel', route_id: 'testroute', date: TODAY, slot: '18:00', party: 1, name: 'Held', email: 'held@example.com' });
    const env = { DB: sqliteDb };
    const res = await handleCancelBooking(adminRequest(`/admin/api/bookings/b_http_hold_cancel/cancel`, {}), env, { id: 'b_http_hold_cancel' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'not_cancellable');
  });

  test('a second cancel of the same booking returns 409, not a repeated cancellation', async () => {
    const booking = await makeConfirmed({ id: 'b_http_double_cancel', date: TODAY, slot: '18:00', party: 1 });
    const env = { DB: sqliteDb };
    const first = await handleCancelBooking(adminRequest(`/admin/api/bookings/${booking.id}/cancel`, {}), env, { id: booking.id });
    assert.equal(first.status, 200);
    const second = await handleCancelBooking(adminRequest(`/admin/api/bookings/${booking.id}/cancel`, {}), env, { id: booking.id });
    assert.equal(second.status, 409);
  });
});
