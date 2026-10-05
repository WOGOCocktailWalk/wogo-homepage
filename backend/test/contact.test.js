// test/contact.test.js — POST /api/contact (migrations/0021, audit item 9):
// the contact + group-booking-request form backend. No route, no seat hold —
// a lead inbox. Covers validation, the honeypot, its OWN rate-limit bucket
// (separate from 'book'/'giftcard'), storage, and the two emails sent
// (owner notification with reply-to, guest auto-ack) — respecting
// EMAIL_TEST_REDIRECT like every other mail in this codebase.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import * as realDb from '../src/db.js';
import { handleContact } from '../src/guest_api.js';
import { handleListInquiries } from '../src/admin_api.js';
import { HOLD_ATTEMPTS_PER_WINDOW } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql', '0021_inquiries.sql',
  '0022_bar_locale.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

function validContactBody(overrides = {}) {
  return {
    kind: 'contact',
    name: 'Anna Guest',
    email: 'anna@example.com',
    message: 'Hi, quick question about your Rotterdam route.',
    locale: 'en',
    ...overrides,
  };
}

function validGroupBody(overrides = {}) {
  return {
    kind: 'group',
    name: 'Bram Planner',
    email: 'bram@example.com',
    phone: '+31600000000',
    city: 'Utrecht',
    date: 'mid November',
    party_size: 18,
    message: 'We are a group of 18 looking to book a private walk.',
    locale: 'nl',
    ...overrides,
  };
}

function contactRequest(body, headers = {}) {
  return new Request('https://api.example.com/api/contact', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.6.6.1', Origin: 'http://localhost:8000', ...headers },
  });
}

let db;
let sent;
const realFetch = global.fetch;
beforeEach(() => {
  db = makeTestDb(schemaSql);
  sent = [];
  global.fetch = async (url, opts) => {
    sent.push({ url: String(url), body: JSON.parse(opts.body) });
    return new Response('{}', { status: 200 });
  };
});
afterEach(() => { global.fetch = realFetch; });

describe('POST /api/contact — validation', () => {
  test('a valid contact message succeeds and stores a row', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    const res = await handleContact(contactRequest(validContactBody()), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.id);

    const rows = await realDb.listInquiries(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'contact');
    assert.equal(rows[0].email, 'anna@example.com');
    assert.equal(rows[0].status, 'new');
  });

  test('a valid group booking request succeeds and stores city/date/party_size', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    const res = await handleContact(contactRequest(validGroupBody()), env);
    assert.equal(res.status, 200);
    const rows = await realDb.listInquiries(db);
    assert.equal(rows[0].kind, 'group');
    assert.equal(rows[0].city, 'Utrecht');
    assert.equal(rows[0].date, 'mid November');
    assert.equal(rows[0].party_size, 18);
  });

  test('rejects an invalid kind', async () => {
    const env = { DB: db };
    const res = await handleContact(contactRequest(validContactBody({ kind: 'spam' })), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'bad_request');
  });

  test('rejects a missing name', async () => {
    const env = { DB: db };
    const b = validContactBody(); delete b.name;
    const res = await handleContact(contactRequest(b), env);
    assert.equal(res.status, 400);
  });

  test('rejects an invalid email', async () => {
    const env = { DB: db };
    const res = await handleContact(contactRequest(validContactBody({ email: 'not-an-email' })), env);
    assert.equal(res.status, 400);
  });

  test('rejects a missing/blank message', async () => {
    const env = { DB: db };
    const res = await handleContact(contactRequest(validContactBody({ message: '   ' })), env);
    assert.equal(res.status, 400);
  });

  test('rejects an oversized message', async () => {
    const env = { DB: db };
    const res = await handleContact(contactRequest(validContactBody({ message: 'x'.repeat(6000) })), env);
    assert.equal(res.status, 400);
  });

  test('rejects a non-integer or absurd party_size', async () => {
    const env = { DB: db };
    const res1 = await handleContact(contactRequest(validGroupBody({ party_size: 'lots' })), env);
    assert.equal(res1.status, 400);
    const res2 = await handleContact(contactRequest(validGroupBody({ party_size: 99999 })), env);
    assert.equal(res2.status, 400);
  });

  test('a browser Origin not on the allowlist is rejected with 403', async () => {
    const env = { DB: db };
    const res = await handleContact(contactRequest(validContactBody(), { Origin: 'https://evil.example.com' }), env);
    assert.equal(res.status, 403);
  });
});

describe('POST /api/contact — honeypot', () => {
  test('a filled honeypot field is silently absorbed: 200 ok, but NO row and NO emails', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    const res = await handleContact(contactRequest(validContactBody({ website: 'http://spam.example.com' })), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const rows = await realDb.listInquiries(db);
    assert.equal(rows.length, 0, 'a honeypot hit must not create an inquiry row');
    assert.equal(sent.length, 0, 'a honeypot hit must not send any email');
  });

  test('an empty honeypot field is a normal, real submission', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    const res = await handleContact(contactRequest(validContactBody({ website: '' })), env);
    assert.equal(res.status, 200);
    const rows = await realDb.listInquiries(db);
    assert.equal(rows.length, 1);
  });
});

describe('POST /api/contact — own rate-limit bucket', () => {
  test(`the ${HOLD_ATTEMPTS_PER_WINDOW + 1}th attempt from one IP is 429 rate_limited with Retry-After`, async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    const ip = '10.6.6.9';
    let last;
    for (let i = 0; i < HOLD_ATTEMPTS_PER_WINDOW + 1; i++) {
      last = await handleContact(contactRequest(validContactBody({ email: `c${i}@example.com` }), { 'CF-Connecting-IP': ip }), env);
    }
    assert.equal(last.status, 429);
    const body = await last.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(Number.isInteger(body.retry_after_seconds) && body.retry_after_seconds > 0);
    assert.equal(last.headers.get('Retry-After'), String(body.retry_after_seconds));
  });

  test('contact-form attempts do not share a rate bucket with book or giftcard', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    const ip = '10.6.6.10';
    for (let i = 0; i < HOLD_ATTEMPTS_PER_WINDOW + 1; i++) {
      await handleContact(contactRequest(validContactBody({ email: `d${i}@example.com` }), { 'CF-Connecting-IP': ip }), env);
    }
    const bookAttempts = await realDb.countRateEventsSince(db, 'book', ip, '2000-01-01 00:00:00');
    assert.equal(bookAttempts, 0, "contact attempts must not count toward the 'book' bucket");
  });

  test('requests rejected by validation do NOT count toward the rate limit', async () => {
    const env = { DB: db };
    const ip = '10.6.6.11';
    for (let i = 0; i < HOLD_ATTEMPTS_PER_WINDOW + 3; i++) {
      const res = await handleContact(contactRequest(validContactBody({ email: 'not-an-email' }), { 'CF-Connecting-IP': ip }), env);
      assert.equal(res.status, 400);
    }
    const envWithMail = { DB: db, BREVO_API_KEY: 'key_x' };
    const res = await handleContact(contactRequest(validContactBody({ email: 'finally-valid@example.com' }), { 'CF-Connecting-IP': ip }), envWithMail);
    assert.equal(res.status, 200, 'the rate limit must not have been tripped by requests that failed validation');
  });
});

describe('POST /api/contact — emails', () => {
  test('sends an owner notification with reply-to set to the guest, and a guest auto-ack', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    await handleContact(contactRequest(validGroupBody()), env);
    assert.equal(sent.length, 2);

    const ownerMail = sent.find((s) => s.body.to[0].email === 'info@wogoamsterdam.com');
    assert.ok(ownerMail, 'owner notification must be sent to the owner alert address');
    assert.ok(ownerMail.body.subject.includes('Group booking request'));
    assert.ok(ownerMail.body.subject.includes('Utrecht'));
    assert.deepEqual(ownerMail.body.replyTo, { email: 'bram@example.com', name: 'Bram Planner' });

    const guestMail = sent.find((s) => s.body.to[0].email === 'bram@example.com');
    assert.ok(guestMail, 'guest auto-ack must be sent to the guest');
    assert.ok(guestMail.body.htmlContent.includes('Bram'));
  });

  test('a plain contact message subject is "Contact form · <name>"', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    await handleContact(contactRequest(validContactBody()), env);
    const ownerMail = sent.find((s) => s.body.to[0].email === 'info@wogoamsterdam.com');
    assert.equal(ownerMail.body.subject, 'Contact form · Anna Guest');
  });

  test('the guest auto-ack is in Dutch when locale is nl', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    await handleContact(contactRequest(validGroupBody({ locale: 'nl' })), env);
    const guestMail = sent.find((s) => s.body.to[0].email === 'bram@example.com');
    assert.ok(guestMail.body.subject.includes('bericht') || guestMail.body.htmlContent.includes('ontvangen'));
  });

  test('respects EMAIL_TEST_REDIRECT like every other mail', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x', EMAIL_TEST_REDIRECT: 'test-inbox@example.com' };
    await handleContact(contactRequest(validContactBody()), env);
    for (const s of sent) {
      assert.equal(s.body.to[0].email, 'test-inbox@example.com');
      assert.ok(s.body.subject.startsWith('[TEST'));
    }
  });

  test('a storage success is not undone by an email failure (row still saved)', async () => {
    global.fetch = async () => { throw new Error('brevo down'); };
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    const res = await handleContact(contactRequest(validContactBody()), env);
    assert.equal(res.status, 200, 'the guest still gets a success response');
    const rows = await realDb.listInquiries(db);
    assert.equal(rows.length, 1);
  });
});

describe('GET /admin/api/inquiries', () => {
  test('lists stored inquiries, newest first', async () => {
    const env = { DB: db, BREVO_API_KEY: 'key_x' };
    await handleContact(contactRequest(validContactBody({ email: 'first@example.com' })), env);
    await handleContact(contactRequest(validGroupBody({ email: 'second@example.com' })), env);
    const res = await handleListInquiries(new Request('https://api.example.com/admin/api/inquiries'), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.inquiries.length, 2);
    assert.equal(body.inquiries[0].email, 'second@example.com', 'newest first');
  });
});
