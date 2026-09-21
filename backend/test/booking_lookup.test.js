// test/booking_lookup.test.js — GET /api/booking?session_id=... powers the
// post-payment "you're booked" page (booking-confirmed/). It returns only the
// few non-sensitive fields the page shows, keyed by the guest's Stripe Checkout
// Session id. Confirmed → status 'confirmed'; still-held (webhook not yet
// processed) → status 'pending'; unknown session → 404.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional } from '../src/db.js';
import { handleBookingLookup } from '../src/guest_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0017_map_by_weekday.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

function exec(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(db, o = {}) {
  const route = {
    id: 'testroute', name: 'Rotterdam Route 1', city: 'Rotterdam', price_cents: 2995,
    capacity: 50, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00"]',
    slot_capacity: '{}', map_url: null, active: 1, ...o,
  };
  const cols = Object.keys(route);
  exec(db, `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, route);
  return route;
}

function seedBooking(db, o = {}) {
  const b = {
    id: 'b_test1', route_id: 'testroute', date: '2026-09-19', slot: '18:00', party: 2,
    name: 'Anna de Vries', email: 'anna@example.com', phone: null, locale: 'en',
    marketing_opt_in: 0, status: 'confirmed', stripe_session: 'cs_test_confirmed',
    discount_cents: 0, ...o,
  };
  const cols = Object.keys(b);
  exec(db, `INSERT INTO bookings (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, b);
  return b;
}

function lookup(db, sessionId) {
  const req = new Request(`https://api.example.com/api/booking?session_id=${encodeURIComponent(sessionId)}`);
  return handleBookingLookup(req, { DB: db });
}

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

describe('GET /api/booking (post-payment confirmation lookup)', () => {
  test('a confirmed booking returns status=confirmed + safe fields, discount applied', async () => {
    seedRoute(db, { currency: 'EUR', price_cents: 2995 });
    seedBooking(db, { party: 2, discount_cents: 500, name: 'Anna de Vries' });
    const res = await lookup(db, 'cs_test_confirmed');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'confirmed');
    assert.equal(body.route_name, 'Rotterdam Route 1');
    assert.equal(body.city, 'Rotterdam');
    assert.equal(body.party, 2);
    assert.equal(body.currency, 'EUR');
    assert.equal(body.amount_cents, 2995 * 2 - 500); // 5490
    assert.equal(body.first_name, 'Anna');
    assert.equal(body.id, 'b_test1');
    // must NOT leak PII beyond the first name
    assert.ok(!('email' in body) && !('phone' in body) && !('name' in body));
  });

  test('a still-held booking (webhook not processed yet) reports status=pending', async () => {
    seedRoute(db);
    seedBooking(db, { status: 'hold', stripe_session: 'cs_test_pending' });
    const res = await lookup(db, 'cs_test_pending');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'pending');
    assert.equal(body.route_name, 'Rotterdam Route 1');
  });

  test('a confirmed_conflict booking still reports confirmed', async () => {
    seedRoute(db);
    seedBooking(db, { status: 'confirmed_conflict', stripe_session: 'cs_test_conflict' });
    const body = await (await lookup(db, 'cs_test_conflict')).json();
    assert.equal(body.status, 'confirmed');
  });

  test('an unknown session id returns 404', async () => {
    seedRoute(db);
    const res = await lookup(db, 'cs_does_not_exist');
    assert.equal(res.status, 404);
  });

  test('a missing session_id is a 400', async () => {
    const req = new Request('https://api.example.com/api/booking');
    const res = await handleBookingLookup(req, { DB: db });
    assert.equal(res.status, 400);
  });

  test('a GBP route reports GBP with no euro assumption', async () => {
    seedRoute(db, { currency: 'GBP', price_cents: 3495 });
    seedBooking(db, { party: 2, stripe_session: 'cs_test_gbp' });
    const body = await (await lookup(db, 'cs_test_gbp')).json();
    assert.equal(body.currency, 'GBP');
    assert.equal(body.amount_cents, 3495 * 2);
  });
});
