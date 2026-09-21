// test/notes.test.js — the optional "Allergies / notes" field, end to end
// (migrations/0010). Covers: validation (logic.js:validateNotes), storage
// through POST /api/book → createHold and through the admin manual-booking
// insert, survival across confirmBooking, the prominent (and HTML-escaped)
// "⚠️ Allergies / notes" block in the BAR + OWNER emails, the guest echo,
// the no-notes-no-block rule, and the CSV export column.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { computeHoldExpiry, validateNotes, MAX_NOTES_LENGTH } from '../src/logic.js';
import {
  createHold,
  confirmBooking,
  createManualBooking,
  getBooking,
  anonymizeOldBookings,
  toPositional,
} from '../src/db.js';
import { handleBook } from '../src/guest_api.js';
import { handleCreateManualBooking, handleExportCsv } from '../src/admin_api.js';
import {
  renderGuestConfirmation,
  renderOwnerNotification,
  renderBarNotification,
} from '../src/emails.js';

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
    id: 'testroute',
    name: 'Test Route',
    city: 'Testville',
    price_cents: 2995,
    capacity: 50,
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

// Today, so requests always sit inside the booking horizon (route is open all
// 7 weekdays, so any "today" works).
const TODAY = new Date().toISOString().slice(0, 10);

function bookRequest(bodyOverrides = {}, headers = {}) {
  const body = {
    route_id: 'testroute',
    date: TODAY,
    slot: '18:00',
    party: 2,
    name: 'Anna',
    email: 'anna@example.com',
    phone: null,
    locale: 'en',
    marketing_opt_in: false,
    ...bodyOverrides,
  };
  return new Request('https://api.example.com/api/book', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.9.1', Origin: 'http://localhost:8000', ...headers },
  });
}

let db;
beforeEach(() => {
  db = makeTestDb(schemaSql);
  seedRoute(db);
});

// handleBook reaches stripe.createCheckoutSession — stub fetch so no test
// touches the network (same pattern as security.test.js).
const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = async () =>
    new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/test' }), { status: 200 });
});
afterEach(() => {
  global.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// logic.js — validateNotes
// ---------------------------------------------------------------------------

describe('validateNotes', () => {
  test('absent / null / empty all normalize to null (optional field)', () => {
    assert.deepEqual(validateNotes(undefined), { ok: true, notes: null });
    assert.deepEqual(validateNotes(null), { ok: true, notes: null });
    assert.deepEqual(validateNotes(''), { ok: true, notes: null });
    assert.deepEqual(validateNotes('   '), { ok: true, notes: null });
  });

  test('trims and returns the cleaned string', () => {
    assert.deepEqual(validateNotes('  nut allergy  '), { ok: true, notes: 'nut allergy' });
  });

  test('newlines (a textarea produces them) are allowed', () => {
    const r = validateNotes('nut allergy\nwheelchair access');
    assert.equal(r.ok, true);
    assert.equal(r.notes, 'nut allergy\nwheelchair access');
  });

  test('rejects non-strings', () => {
    assert.equal(validateNotes(42).ok, false);
    assert.equal(validateNotes({ evil: true }).ok, false);
    assert.equal(validateNotes(['a']).ok, false);
  });

  test(`rejects more than ${MAX_NOTES_LENGTH} characters`, () => {
    assert.equal(validateNotes('x'.repeat(MAX_NOTES_LENGTH)).ok, true);
    assert.equal(validateNotes('x'.repeat(MAX_NOTES_LENGTH + 1)).ok, false);
  });

  test('rejects control characters (NUL, BEL, ESC, DEL)', () => {
    for (const code of [0, 7, 27, 127]) {
      const cc = String.fromCharCode(code);
      assert.equal(validateNotes(`ok${cc}bad`).ok, false, `control char ${code} must be rejected`);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/book — notes accepted, validated, persisted on the hold
// ---------------------------------------------------------------------------

describe('POST /api/book — notes field', () => {
  test('stores trimmed notes on the hold, and they survive confirmBooking', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ notes: '  Nut allergy — one guest is coeliac  ' }), env);
    assert.equal(res.status, 200);
    const { booking_id } = await res.json();

    let booking = await getBooking(db, booking_id);
    assert.equal(booking.notes, 'Nut allergy — one guest is coeliac');

    const confirmed = await confirmBooking(db, booking_id, 'cs_x', 'pi_x');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.booking.notes, 'Nut allergy — one guest is coeliac', 'notes survive the hold→confirm path');
  });

  test('empty notes are stored as NULL, not an empty string', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ notes: '   ' }), env);
    assert.equal(res.status, 200);
    const { booking_id } = await res.json();
    const booking = await getBooking(db, booking_id);
    assert.equal(booking.notes, null);
  });

  test('omitting notes entirely still books fine (fully optional)', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({}), env);
    assert.equal(res.status, 200);
    const { booking_id } = await res.json();
    const booking = await getBooking(db, booking_id);
    assert.equal(booking.notes, null);
  });

  test(`rejects notes over ${MAX_NOTES_LENGTH} chars with 400`, async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ notes: 'x'.repeat(MAX_NOTES_LENGTH + 1) }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'bad_request');
  });

  test('rejects notes containing control characters with 400', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ notes: 'haha' + String.fromCharCode(7) + 'bell' }), env);
    assert.equal(res.status, 400);
  });

  test('rejects non-string notes with 400', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ notes: { $gt: '' } }), env);
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Manual (phone) booking — same field, same rules
// ---------------------------------------------------------------------------

describe('manual booking — notes field', () => {
  test('createManualBooking persists notes', async () => {
    const result = await createManualBooking(db, {
      id: 'b_manual_notes', route_id: 'testroute', date: TODAY, slot: '18:00',
      party: 2, name: 'Piet', email: 'piet@example.com', notes: 'Shellfish allergy',
    });
    assert.equal(result.created, true);
    assert.equal(result.booking.notes, 'Shellfish allergy');
  });

  test('handleCreateManualBooking accepts notes and rejects oversize ones', async () => {
    const env = { DB: db };
    const make = (notes) => new Request('https://api.example.com/admin/api/bookings/manual', {
      method: 'POST',
      body: JSON.stringify({
        route_id: 'testroute', date: TODAY, slot: '18:00', party: 2,
        name: 'Piet', email: 'piet@example.com', notes,
      }),
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
    });

    const bad = await handleCreateManualBooking(make('x'.repeat(MAX_NOTES_LENGTH + 1)), env);
    assert.equal(bad.status, 400);

    const ok = await handleCreateManualBooking(make(' Birthday table, gluten-free guest '), env);
    assert.equal(ok.status, 201);
    const { booking } = await ok.json();
    assert.equal(booking.notes, 'Birthday table, gluten-free guest');
  });
});

// ---------------------------------------------------------------------------
// Emails — the whole point: the bar (and owner) must SEE the notes, escaped
// ---------------------------------------------------------------------------

const XSS_NOTES = 'Nut allergy <script>alert("pwn")</script> & "quotes"';

function fixtureBooking(overrides = {}) {
  return {
    id: 'b_1', route_id: 'testroute', date: '2026-08-06', slot: '18:00',
    party: 2, name: 'Anna', email: 'anna@example.com', phone: '+31600000000',
    locale: 'en', notes: null, ...overrides,
  };
}
const fixtureRoute = { id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995, map_url: 'https://maps.example.com/x' };
const fixtureBar = { ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com', arrival_time: '18:00' };

describe('emails — allergies/notes rendering', () => {
  test('BAR email prominently shows the "⚠️ Allergies / notes:" block, HTML-escaped', () => {
    const mail = renderBarNotification(fixtureBar, fixtureBooking({ notes: XSS_NOTES }), fixtureRoute);
    assert.ok(mail.html.includes('Allergies / notes:'), 'bar email must carry the labelled allergies block');
    assert.ok(mail.html.includes('&#9888;'), 'block carries the warning symbol so staff cannot miss it');
    assert.ok(mail.html.includes('&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;'), 'notes are HTML-escaped');
    assert.ok(!mail.html.includes('<script>'), 'raw guest HTML must never reach the email');
    // Prominence: the block sits BEFORE the booking detail panel.
    assert.ok(mail.html.indexOf('Allergies / notes:') < mail.html.indexOf('Arrival time'), 'allergies block renders above the details');
  });

  test('BAR email with no notes has NO allergies block (no empty label)', () => {
    for (const empty of [null, undefined, '', '   ']) {
      const mail = renderBarNotification(fixtureBar, fixtureBooking({ notes: empty }), fixtureRoute);
      assert.ok(!mail.html.includes('Allergies / notes'), `empty notes (${JSON.stringify(empty)}) must omit the block`);
    }
  });

  test('BAR email preserves the notes\' line breaks as <br>', () => {
    const mail = renderBarNotification(fixtureBar, fixtureBooking({ notes: 'Nut allergy\nWheelchair user' }), fixtureRoute);
    assert.ok(mail.html.includes('Nut allergy<br>Wheelchair user'));
  });

  test('OWNER notification shows the escaped allergies block too, and omits it when empty', () => {
    const withNotes = renderOwnerNotification(fixtureBooking({ notes: XSS_NOTES }), fixtureRoute, { arrivals: [] });
    assert.ok(withNotes.html.includes('Allergies / notes:'));
    assert.ok(withNotes.html.includes('&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;'));
    assert.ok(!withNotes.html.includes('<script>'));

    const without = renderOwnerNotification(fixtureBooking(), fixtureRoute, { arrivals: [] });
    assert.ok(!without.html.includes('Allergies / notes'));
  });

  test('GUEST confirmation echoes the note back ("Your note to us"), escaped, EN + NL', () => {
    const en = renderGuestConfirmation(fixtureBooking({ notes: XSS_NOTES }), fixtureRoute);
    assert.ok(en.html.includes('Your note to us:'));
    assert.ok(en.html.includes('&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;'));
    assert.ok(!en.html.includes('<script>'));

    const nl = renderGuestConfirmation(fixtureBooking({ notes: 'Notenallergie', locale: 'nl' }), fixtureRoute);
    assert.ok(nl.html.includes('Je notitie aan ons:'));
    assert.ok(nl.html.includes('Notenallergie'));
  });

  test('GUEST confirmation with no notes has no echo line', () => {
    const mail = renderGuestConfirmation(fixtureBooking(), fixtureRoute);
    assert.ok(!mail.html.includes('Your note to us'));
  });
});

// ---------------------------------------------------------------------------
// GDPR retention — notes are guest PII (allergies are even special-category
// data), so the anonymization sweep must clear them along with name/email/phone
// ---------------------------------------------------------------------------

describe('GDPR retention — notes wiped by anonymizeOldBookings', () => {
  test('an old confirmed booking loses its notes when anonymized', async () => {
    await createHold(db, {
      id: 'b_gdpr', route_id: 'testroute', date: TODAY, slot: '18:00', party: 2,
      name: 'Anna', email: 'anna@example.com', phone: null, notes: 'Nut allergy',
      locale: 'en', marketing_opt_in: false, hold_expires: computeHoldExpiry(15), ip: null,
    });
    await confirmBooking(db, 'b_gdpr', 'cs_g', 'pi_g');
    // Backdate it past any cutoff, then sweep with a cutoff of "now".
    exec(db, `UPDATE bookings SET created_at = '2000-01-01 00:00:00' WHERE id = :id`, { id: 'b_gdpr' });
    const result = await anonymizeOldBookings(db, '2020-01-01 00:00:00');
    assert.equal(result.anonymized, 1);
    const booking = await getBooking(db, 'b_gdpr');
    assert.equal(booking.name, '[deleted]');
    assert.equal(booking.notes, null, 'notes must be wiped with the rest of the PII');
  });
});

// ---------------------------------------------------------------------------
// CSV export — notes column present
// ---------------------------------------------------------------------------

describe('CSV export — notes column', () => {
  test('bookings.csv includes a notes column with the stored value', async () => {
    const env = { DB: db };
    await createHold(db, {
      id: 'b_csv', route_id: 'testroute', date: TODAY, slot: '18:00', party: 2,
      name: 'Anna', email: 'anna@example.com', phone: null, notes: 'Nut allergy',
      locale: 'en', marketing_opt_in: false, hold_expires: computeHoldExpiry(15), ip: null,
    });
    await confirmBooking(db, 'b_csv', 'cs_csv', 'pi_csv');

    const res = await handleExportCsv(new Request('https://api.example.com/admin/api/bookings.csv'), env);
    assert.equal(res.status, 200);
    const csv = await res.text();
    const header = csv.split('\r\n')[0];
    assert.ok(header.split(',').includes('notes'), 'CSV header has a notes column');
    assert.ok(csv.includes('Nut allergy'), 'CSV body carries the stored notes');
  });
});
