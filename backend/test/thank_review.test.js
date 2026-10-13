// test/thank_review.test.js — POST /admin/api/bookings/:id/thank-review
// (migrations/0031): the staff-triggered post-review thank-you. No webhook
// exists for this (Trustpilot/Google don't push events), so this is purely
// staff-initiated — covers CSRF, 404, the idempotent review_thanked_at
// claim (409 on a repeat), audit logging, the newest-active-route pull
// (never hardcoded), the single-active-route fallback, EN/NL rendering, and
// the no-discount-when-empty default.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional } from '../src/db.js';
import * as db from '../src/db.js';
import { handleThankReview, ROUTE_ROLES } from '../src/admin_api.js';
import { renderReviewThankYou } from '../src/emails.js';
import { THANKYOU_CODE } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0022_bar_locale.sql', '0025_admin_users.sql', '0026_review_requests.sql',
  '0031_abandoned_reminders.sql',
].map(migration).join('\n');

function run(testDb, sql, params = {}) {
  const t = toPositional(sql, params);
  return testDb.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(testDb, { id, name = 'Route', city = 'Amsterdam', active = 1, created_at } = {}) {
  run(
    testDb,
    `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,active,created_at)
     VALUES (:id,:name,:city,3000,10,6,'[1,2,3,4,5,6,7]','["18:00"]',:active, COALESCE(:created_at, datetime('now')))`,
    { id, name, city, active, created_at: created_at || null }
  );
}

function seedBooking(testDb, { id, route_id = 'r1', status = 'confirmed', email = 'guest@example.com', name = 'Guest', locale = 'en', review_thanked_at = null }) {
  run(
    testDb,
    `INSERT INTO bookings (id, route_id, date, slot, party, name, email, phone, locale, marketing_opt_in, status, created_at, source, review_thanked_at)
     VALUES (:id, :route_id, '2026-01-01', '18:00', 2, :name, :email, NULL, :locale, 0, :status, datetime('now'), 'web', :review_thanked_at)`,
    { id, route_id, name, email, locale, status, review_thanked_at }
  );
}

let testDb;
const sentEmails = [];

function req(method, pathAndQuery) {
  return new Request(`https://api.example.com${pathAndQuery}`, { method, headers: { 'X-Requested-With': 'wogo-admin' } });
}

let realFetch;
beforeEach(() => {
  testDb = makeTestDb(schemaSql);
  sentEmails.length = 0;
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/v3/smtp/email')) {
      sentEmails.push(JSON.parse(opts.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error('unmocked fetch: ' + u);
  };
});
afterEach(() => { global.fetch = realFetch; });

const ENV = () => ({ DB: testDb, BREVO_API_KEY: 'k' });

describe('ROUTE_ROLES — the new endpoint is registered', () => {
  test('thank-review requires at least staff', () => {
    assert.equal(ROUTE_ROLES['POST /admin/api/bookings/:id/thank-review'], 'staff');
  });
});

describe('handleThankReview', () => {
  test('sends a thank-you, invites the NEWEST active route (excluding the booking\'s own), and audits it', async () => {
    seedRoute(testDb, { id: 'old-route', name: 'Old Town Walk', city: 'Amsterdam', created_at: '2026-01-01 00:00:00' });
    seedRoute(testDb, { id: 'newest-route', name: 'Newest Walk', city: 'Delft', created_at: '2026-09-01 00:00:00' });
    seedBooking(testDb, { id: 'rev1', route_id: 'old-route', email: 'rev1@example.com', name: 'Anna' });

    const res = await handleThankReview(req('POST', '/admin/api/bookings/rev1/thank-review'), ENV(), { id: 'rev1' });
    assert.equal(res.status, 200);
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].htmlContent, /Newest Walk/);
    assert.match(sentEmails[0].htmlContent, /Delft/);

    const audit = await db.listAdminAudit(testDb, 5);
    assert.ok(audit.some((a) => a.action === 'booking.thank_review' && a.entity_id === 'rev1'));
  });

  test('excludes the booking\'s OWN route even if it happens to be the newest', async () => {
    seedRoute(testDb, { id: 'only-newer', name: 'Only Newer Walk', created_at: '2026-01-01 00:00:00' });
    seedRoute(testDb, { id: 'own-route', name: 'The One They Walked', created_at: '2026-09-01 00:00:00' });
    seedBooking(testDb, { id: 'rev2', route_id: 'own-route', email: 'rev2@example.com' });

    await handleThankReview(req('POST', '/admin/api/bookings/rev2/thank-review'), ENV(), { id: 'rev2' });
    assert.match(sentEmails[0].htmlContent, /Only Newer Walk/);
    assert.doesNotMatch(sentEmails[0].htmlContent, /The One They Walked/);
  });

  test('falls back gracefully (no invite section, no broken link) when no OTHER active route exists', async () => {
    seedRoute(testDb, { id: 'own-only', name: 'Solo Route' });
    seedBooking(testDb, { id: 'rev3', route_id: 'own-only', email: 'rev3@example.com' });

    const res = await handleThankReview(req('POST', '/admin/api/bookings/rev3/thank-review'), ENV(), { id: 'rev3' });
    assert.equal(res.status, 200);
    assert.equal(sentEmails.length, 1);
    assert.doesNotMatch(sentEmails[0].htmlContent, /href="[^"]*undefined/);
  });

  test('409s on a booking that already got a thank-you', async () => {
    seedRoute(testDb, { id: 'r1' });
    seedBooking(testDb, { id: 'rev4', route_id: 'r1', email: 'rev4@example.com' });
    await handleThankReview(req('POST', '/admin/api/bookings/rev4/thank-review'), ENV(), { id: 'rev4' });
    const second = await handleThankReview(req('POST', '/admin/api/bookings/rev4/thank-review'), ENV(), { id: 'rev4' });
    assert.equal(second.status, 409);
    assert.equal(sentEmails.length, 1, 'no second send');
  });

  test('404s on an unknown booking', async () => {
    const res = await handleThankReview(req('POST', '/admin/api/bookings/nope/thank-review'), ENV(), { id: 'nope' });
    assert.equal(res.status, 404);
  });

  test('requires the CSRF header', async () => {
    seedRoute(testDb, { id: 'r1' });
    seedBooking(testDb, { id: 'rev5', route_id: 'r1' });
    const res = await handleThankReview(
      new Request('https://api.example.com/admin/api/bookings/rev5/thank-review', { method: 'POST' }),
      ENV(), { id: 'rev5' }
    );
    assert.equal(res.status, 403);
  });

  test('a cancelled booking cannot be thanked', async () => {
    seedRoute(testDb, { id: 'r1' });
    seedBooking(testDb, { id: 'rev6', route_id: 'r1', status: 'cancelled' });
    const res = await handleThankReview(req('POST', '/admin/api/bookings/rev6/thank-review'), ENV(), { id: 'rev6' });
    assert.equal(res.status, 409);
  });

  test('an email that opted out of reminders never gets the thank-you — the discount/upsell mail honours the SAME opt-out', async () => {
    seedRoute(testDb, { id: 'r1' });
    seedBooking(testDb, { id: 'rev7', route_id: 'r1', email: 'optout@example.com' });
    await db.recordReminderOptOut(testDb, 'optout@example.com');
    const res = await handleThankReview(req('POST', '/admin/api/bookings/rev7/thank-review'), ENV(), { id: 'rev7' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'reminder_opted_out');
    assert.equal(sentEmails.length, 0);
    // The idempotency claim is NOT burned by a blocked send — a later
    // genuine attempt (e.g. after the owner clears the opt-out by hand)
    // would still be possible, not silently permanently blocked.
    assert.equal((await db.getBooking(testDb, 'rev7')).review_thanked_at, null);
  });
});

// ---------------------------------------------------------------------------
// renderReviewThankYou — EN/NL rendering, no discount by default, no
// unsubscribe link (transactional, one-off — not governed by the reminder
// opt-out or the marketing subscribers list).
// ---------------------------------------------------------------------------

describe('renderReviewThankYou', () => {
  const booking = { name: 'Anna', locale: 'en' };
  const newRoute = { id: 'delft', name: 'WOGO Delft', city: 'Delft' };

  test('EN: subject, invite copy, no unsubscribe link', () => {
    const mail = renderReviewThankYou(booking, newRoute);
    assert.match(mail.subject, /Thank you for your review/);
    assert.match(mail.html, /small Amsterdam business/);
    assert.match(mail.html, /WOGO Delft/);
    assert.doesNotMatch(mail.html, /unsubscribe/i);
  });

  test('NL: subject, warm tone', () => {
    const mail = renderReviewThankYou({ ...booking, locale: 'nl' }, newRoute);
    assert.match(mail.subject, /Bedankt voor je review/);
    assert.match(mail.html, /klein Amsterdams bedrijf/);
  });

  test('no discount block when THANKYOU_CODE is empty (the owner default)', () => {
    assert.equal(THANKYOU_CODE, '', 'sanity: default must be empty');
    const mail = renderReviewThankYou(booking, newRoute);
    assert.doesNotMatch(mail.html, /Use this code/i);
  });

  test('omits the invite section entirely when there is no newRoute', () => {
    const mail = renderReviewThankYou(booking, null);
    assert.doesNotMatch(mail.html, /href="undefined"/);
  });
});
