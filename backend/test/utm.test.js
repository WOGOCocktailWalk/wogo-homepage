// test/utm.test.js — UTM/source capture on bookings (migrations/0027,
// BUILD §19 Marketing pass). Covers: validation (logic.js:validateUtmFields),
// storage through POST /api/book → createHold, and that the fields survive
// confirmBooking untouched (needed for "Sales by source" to read them back
// off a CONFIRMED booking later).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { validateUtmFields, UTM_FIELD_MAX_LENGTH, addDaysToDateStr } from '../src/logic.js';
import { createHold, confirmBooking, getBooking, toPositional } from '../src/db.js';
import { handleBook } from '../src/guest_api.js';

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

function seedRoute(db, overrides = {}) {
  const route = {
    id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 50, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00"]',
    slot_capacity: '{}', map_url: null, active: 1, ...overrides,
  };
  exec(
    db,
    `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
     VALUES (:id, :name, :city, :price_cents, :capacity, :max_party, :open_days, :slots, :slot_capacity, :map_url, :active)`,
    route
  );
  return route;
}

const TODAY = new Date().toISOString().slice(0, 10);
const BOOKABLE_DATE = addDaysToDateStr(TODAY, 5);

function bookRequest(bodyOverrides = {}) {
  const body = {
    route_id: 'testroute', date: BOOKABLE_DATE, slot: '18:00', party: 2,
    name: 'Anna', email: 'anna@example.com', phone: null, locale: 'en',
    marketing_opt_in: false, ...bodyOverrides,
  };
  return new Request('https://api.example.com/api/book', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.9.1', Origin: 'http://localhost:8000' },
  });
}

let db;
beforeEach(() => { db = makeTestDb(schemaSql); seedRoute(db); });

const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = async () =>
    new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/test' }), { status: 200 });
});
afterEach(() => { global.fetch = realFetch; });

// ---------------------------------------------------------------------------
// logic.js — validateUtmFields (pure)
// ---------------------------------------------------------------------------

describe('validateUtmFields', () => {
  test('every field absent/null/empty normalizes to a fully-null object', () => {
    assert.deepEqual(validateUtmFields({}), {
      ok: true,
      utm: { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, referrer: null, landing_path: null },
    });
    assert.deepEqual(validateUtmFields(undefined).ok, true);
    assert.deepEqual(validateUtmFields({ utm_source: '', referrer: '   ' }).utm.utm_source, null);
    assert.deepEqual(validateUtmFields({ utm_source: '', referrer: '   ' }).utm.referrer, null);
  });

  test('trims and keeps each field independently', () => {
    const r = validateUtmFields({ utm_source: '  facebook  ', utm_campaign: 'autumn_launch' });
    assert.equal(r.ok, true);
    assert.equal(r.utm.utm_source, 'facebook');
    assert.equal(r.utm.utm_campaign, 'autumn_launch');
    assert.equal(r.utm.utm_medium, null);
  });

  test(`rejects a field over ${UTM_FIELD_MAX_LENGTH} characters`, () => {
    assert.equal(validateUtmFields({ utm_source: 'x'.repeat(UTM_FIELD_MAX_LENGTH) }).ok, true);
    const bad = validateUtmFields({ utm_source: 'x'.repeat(UTM_FIELD_MAX_LENGTH + 1) });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /utm_source/);
  });

  test('rejects a non-string value on any field', () => {
    assert.equal(validateUtmFields({ utm_medium: 42 }).ok, false);
    assert.equal(validateUtmFields({ landing_path: { x: 1 } }).ok, false);
    assert.equal(validateUtmFields({ referrer: ['a'] }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/book — UTM fields accepted, validated, persisted on the hold,
// and survive confirmBooking (so a later "sales by source" read is correct).
// ---------------------------------------------------------------------------

describe('POST /api/book — UTM fields', () => {
  test('stores every UTM field on the hold and they survive confirmBooking', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({
      utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'ams_launch',
      utm_content: 'carousel_1', referrer: 'https://facebook.com/', landing_path: '/amsterdam/',
    }), env);
    assert.equal(res.status, 200);
    const { booking_id } = await res.json();

    let booking = await getBooking(db, booking_id);
    assert.equal(booking.utm_source, 'facebook');
    assert.equal(booking.utm_medium, 'paid_social');
    assert.equal(booking.utm_campaign, 'ams_launch');
    assert.equal(booking.utm_content, 'carousel_1');
    assert.equal(booking.referrer, 'https://facebook.com/');
    assert.equal(booking.landing_path, '/amsterdam/');

    const confirmed = await confirmBooking(db, booking_id, 'cs_x', 'pi_x');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.booking.utm_source, 'facebook', 'utm_source survives the hold -> confirm path');
    assert.equal(confirmed.booking.utm_campaign, 'ams_launch');
  });

  test('omitting every UTM field still books fine, stored as NULL (direct traffic)', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({}), env);
    assert.equal(res.status, 200);
    const { booking_id } = await res.json();
    const booking = await getBooking(db, booking_id);
    assert.equal(booking.utm_source, null);
    assert.equal(booking.utm_medium, null);
    assert.equal(booking.referrer, null);
    assert.equal(booking.landing_path, null);
  });

  test(`rejects a UTM field over ${UTM_FIELD_MAX_LENGTH} chars with 400`, async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ utm_campaign: 'x'.repeat(UTM_FIELD_MAX_LENGTH + 1) }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'bad_request');
  });

  test('rejects a non-string UTM field with 400', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ utm_source: { $gt: '' } }), env);
    assert.equal(res.status, 400);
  });

  test('createHold directly: a manual-style insert with no UTM params leaves them NULL (regression — existing callers unaffected)', async () => {
    const result = await createHold(db, {
      id: 'b_no_utm', route_id: 'testroute', date: TODAY, slot: '18:00', party: 2,
      name: 'Piet', email: 'piet@example.com', phone: null, notes: null,
      locale: 'en', marketing_opt_in: false, hold_expires: '2999-01-01 00:00:00', ip: null,
    });
    assert.equal(result.created, true);
    assert.equal(result.booking.utm_source, null);
  });
});
