// test/reviews.test.js — "how was your walk?" review-request email
// (migrations/0026_review_requests.sql, BUILD §20): the daily cron's date
// math (DST-safe, exactly yesterday in Europe/Amsterdam), candidate
// selection (skips cancelled/already-sent/wrong-source), the atomic
// claim-before-send idempotency guard, EN/NL rendering, and the manual
// POST /admin/api/bookings/:id/send-review trigger.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional } from '../src/db.js';
import * as db from '../src/db.js';
import { sendReviewRequestForBooking, sendDailyReviewRequests } from '../src/reviews.js';
import { renderReviewRequest } from '../src/emails.js';
import { handleSendReviewRequest } from '../src/admin_api.js';
import { todayInTimezone, addDaysToDateStr } from '../src/logic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0022_bar_locale.sql',
  '0025_admin_users.sql', '0026_review_requests.sql',
].map(migration).join('\n');

function run(testDb, sql, params = {}) {
  const t = toPositional(sql, params);
  return testDb.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(testDb, id = 'r1') {
  run(testDb, `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,active)
                VALUES (:id,'Route One','Amsterdam',3000,10,6,'[1,2,3,4,5,6,7]','["18:00"]',1)`, { id });
}

function seedBooking(testDb, { id, route_id = 'r1', date, status = 'confirmed', source = 'web', locale = 'en', review_sent_at = null, email = 'guest@example.com', name = 'Guest' }) {
  run(testDb, `INSERT INTO bookings
      (id, route_id, date, slot, party, name, email, phone, locale, marketing_opt_in, status, created_at, source, review_sent_at)
     VALUES (:id, :route_id, :date, '18:00', 2, :name, :email, NULL, :locale, 0, :status, datetime('now'), :source, :review_sent_at)`,
    { id, route_id, date, name, email, locale, status, source, review_sent_at });
}

let testDb;
const sentEmails = [];
function fakeSendTransactional(env, msg) {
  sentEmails.push(msg);
  return Promise.resolve({ ok: true });
}

beforeEach(() => { testDb = makeTestDb(schemaSql); sentEmails.length = 0; });

// ---------------------------------------------------------------------------
// renderReviewRequest — EN/NL, Google button omitted when REVIEW_GOOGLE_URL is empty
// ---------------------------------------------------------------------------

describe('renderReviewRequest', () => {
  test('EN: Trustpilot button present, Google button omitted (REVIEW_GOOGLE_URL is empty by default)', () => {
    const mail = renderReviewRequest({ locale: 'en', name: 'Anna' }, { name: 'WOGO Amsterdam', city: 'Amsterdam' });
    assert.match(mail.subject, /How was your WOGO Cocktail Walk/);
    assert.match(mail.html, /trustpilot\.com\/evaluate\/wogoamsterdam\.com/);
    assert.doesNotMatch(mail.html, /Review on Google/);
    assert.match(mail.html, /Thanks for walking with us, Anna/);
  });

  test('NL: Dutch subject/copy and the NL Trustpilot domain', () => {
    const mail = renderReviewRequest({ locale: 'nl', name: 'Anke' }, { name: 'WOGO Amsterdam', city: 'Amsterdam' });
    assert.match(mail.subject, /Hoe was je WOGO Cocktail Walk/);
    assert.match(mail.html, /nl\.trustpilot\.com\/evaluate\/wogoamsterdam\.com/);
    assert.match(mail.html, /Bedankt dat je met ons mee liep, Anke/);
  });

  test('never carries an unsubscribe link (transactional, one-off)', () => {
    const mail = renderReviewRequest({ locale: 'en', name: 'A' }, { name: 'R', city: 'C' });
    assert.doesNotMatch(mail.html, /unsubscribe/i);
  });
});

// ---------------------------------------------------------------------------
// sendReviewRequestForBooking — the atomic claim.
// ---------------------------------------------------------------------------

describe('sendReviewRequestForBooking', () => {
  test('sends once, and the SAME booking is rejected on a second call (idempotent claim)', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b1', date: '2026-01-01' });
    const booking = { ...(await db.getBooking(testDb, 'b1')), route_name: 'Route One', city: 'Amsterdam', route_id: 'r1' };

    const first = await sendReviewRequestForBooking({ DB: testDb }, booking, { sendTransactional: fakeSendTransactional });
    assert.equal(first.sent, true);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, 'guest@example.com');

    const second = await sendReviewRequestForBooking({ DB: testDb }, booking, { sendTransactional: fakeSendTransactional });
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'already_sent_or_not_confirmed');
    assert.equal(sentEmails.length, 1); // no second send
  });

  test('a cancelled booking cannot be claimed', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b2', date: '2026-01-01', status: 'cancelled' });
    const booking = { ...(await db.getBooking(testDb, 'b2')), route_name: 'Route One', city: 'Amsterdam', route_id: 'r1' };
    const result = await sendReviewRequestForBooking({ DB: testDb }, booking, { sendTransactional: fakeSendTransactional });
    assert.equal(result.sent, false);
    assert.equal(sentEmails.length, 0);
  });
});

// ---------------------------------------------------------------------------
// sendDailyReviewRequests — candidate selection + DST-safe date math.
// ---------------------------------------------------------------------------

describe('sendDailyReviewRequests', () => {
  test('picks exactly confirmed web/manual bookings from YESTERDAY (Europe/Amsterdam), skipping cancelled/already-sent/wrong-source', async () => {
    seedRoute(testDb);
    const yesterday = addDaysToDateStr(todayInTimezone('Europe/Amsterdam'), -1);
    const dayBefore = addDaysToDateStr(yesterday, -1);

    seedBooking(testDb, { id: 'y1', date: yesterday, status: 'confirmed', source: 'web', email: 'y1@example.com' });
    seedBooking(testDb, { id: 'y2', date: yesterday, status: 'confirmed', source: 'manual', email: 'y2@example.com' });
    seedBooking(testDb, { id: 'y3', date: yesterday, status: 'cancelled', email: 'y3@example.com' });
    seedBooking(testDb, { id: 'y4', date: yesterday, status: 'confirmed', review_sent_at: '2026-01-01 09:00:00', email: 'y4@example.com' });
    seedBooking(testDb, { id: 'y5', date: yesterday, status: 'hold', email: 'y5@example.com' });
    seedBooking(testDb, { id: 'old', date: dayBefore, status: 'confirmed', email: 'old@example.com' }); // wrong day

    const result = await sendDailyReviewRequests({ DB: testDb }, { sendTransactional: fakeSendTransactional });
    assert.equal(result.date, yesterday);
    assert.equal(result.candidates, 2); // y1, y2 only
    assert.equal(result.sent, 2);
    const sentTo = sentEmails.map((m) => m.to).sort();
    assert.deepEqual(sentTo, ['y1@example.com', 'y2@example.com']);

    // every sent booking is now marked, a second run on the same day sends nothing more
    const again = await sendDailyReviewRequests({ DB: testDb }, { sendTransactional: fakeSendTransactional });
    assert.equal(again.candidates, 0);
    assert.equal(again.sent, 0);
  });

  test('renders in the booking\'s own locale', async () => {
    seedRoute(testDb);
    const yesterday = addDaysToDateStr(todayInTimezone('Europe/Amsterdam'), -1);
    seedBooking(testDb, { id: 'nl1', date: yesterday, locale: 'nl', email: 'nl1@example.com' });
    await sendDailyReviewRequests({ DB: testDb }, { sendTransactional: fakeSendTransactional });
    assert.match(sentEmails[0].subject, /Hoe was je/);
  });
});

// ---------------------------------------------------------------------------
// Manual trigger — POST /admin/api/bookings/:id/send-review
// ---------------------------------------------------------------------------

describe('handleSendReviewRequest', () => {
  let realFetch;
  beforeEach(() => {
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

  function req(method, pathAndQuery, body) {
    const headers = { 'X-Requested-With': 'wogo-admin' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return new Request(`https://api.example.com${pathAndQuery}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  }

  test('sends a review request for a confirmed booking and audits it', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'man1', date: '2026-01-01', email: 'man1@example.com' });
    const env = { DB: testDb, BREVO_API_KEY: 'k' };
    const res = await handleSendReviewRequest(req('POST', '/admin/api/bookings/man1/send-review'), env, { id: 'man1' });
    assert.equal(res.status, 200);
    assert.equal(sentEmails.length, 1);
    const audit = await db.listAdminAudit(testDb, 5);
    assert.ok(audit.some((a) => a.action === 'booking.send_review' && a.entity_id === 'man1'));
  });

  test('409s on a booking that already got one', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'man2', date: '2026-01-01', email: 'man2@example.com' });
    const env = { DB: testDb, BREVO_API_KEY: 'k' };
    await handleSendReviewRequest(req('POST', '/admin/api/bookings/man2/send-review'), env, { id: 'man2' });
    const second = await handleSendReviewRequest(req('POST', '/admin/api/bookings/man2/send-review'), env, { id: 'man2' });
    assert.equal(second.status, 409);
  });

  test('404s on an unknown booking', async () => {
    const env = { DB: testDb, BREVO_API_KEY: 'k' };
    const res = await handleSendReviewRequest(req('POST', '/admin/api/bookings/nope/send-review'), env, { id: 'nope' });
    assert.equal(res.status, 404);
  });

  test('requires the CSRF header', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'man3', date: '2026-01-01' });
    const env = { DB: testDb, BREVO_API_KEY: 'k' };
    const res = await handleSendReviewRequest(
      new Request('https://api.example.com/admin/api/bookings/man3/send-review', { method: 'POST' }),
      env, { id: 'man3' }
    );
    assert.equal(res.status, 403);
  });
});
