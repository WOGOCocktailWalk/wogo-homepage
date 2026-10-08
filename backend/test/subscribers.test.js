// test/subscribers.test.js — newsletter subscriber plumbing (migrations/0024,
// BUILD §17): the site-footer double opt-in signup, confirm, unsubscribe,
// the booking-opt-in consent path (webhook + manual booking), the Brevo
// contact-model setup endpoint, the Stripe welcome-code bootstrap, the admin
// list/CSV/import endpoints, and the brevo_sync_queue retry drain.
//
// Brevo + Stripe are both faked via a single `global.fetch` router (see
// makeExternalApiMock below) that keeps small in-memory state — enough to
// exercise the REAL idempotent ensure*/upsert/getContact logic in
// src/brevo.js and src/stripe.js without hitting the network, same spirit as
// every other test file's `global.fetch` override (contact.test.js, db.test.js).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import * as realDb from '../src/db.js';
import {
  handleSubscribe, handleSubscribeConfirm, handleUnsubscribe,
} from '../src/guest_api.js';
import {
  handleBrevoSetup, handleEnsureWelcomeCode, handleListSubscribers,
  handleSubscribersCsv, handleImportSubscribers, handleBrevoSyncQueue,
  handleCreateManualBooking,
} from '../src/admin_api.js';
import { handleWebhook } from '../src/webhook.js';
import { computeStripeSignatureHeader } from '../src/stripe.js';
import { createHold } from '../src/db.js';
import { computeHoldExpiry } from '../src/logic.js';
import { retryBrevoSyncQueue } from '../src/brevo_sync.js';
import { HOLD_ATTEMPTS_PER_WINDOW, WELCOME_CODE } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0007_admin_audit.sql', '0008_failed_email.sql', '0009_webhook_processing_status.sql',
  '0010_booking_notes.sql', '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0022_bar_locale.sql', '0025_admin_users.sql', '0027_booking_utm.sql', '0028_bookings_email_lower_index.sql', '0029_route_booking_cutoff.sql',
  '0024_subscribers.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

const STRIPE_SECRET = 'whsec_test_secret';

function seedRoute(db, overrides = {}) {
  const route = {
    id: 'amsterdam', name: 'WOGO Cocktail Walk Amsterdam', city: 'Amsterdam',
    price_cents: 2995, capacity: 10, max_party: 6,
    open_days: '[1,2,3,4,5,6,7]', slots: '["18:00"]', slot_capacity: '{}',
    map_url: 'https://maps.example.com/ams', active: 1,
    ...overrides,
  };
  db._raw
    .prepare(
      `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(route.id, route.name, route.city, route.price_cents, route.capacity, route.max_party, route.open_days, route.slots, route.slot_capacity, route.map_url, route.active);
  return route;
}

function subscribeRequest(body, headers = {}) {
  return new Request('https://api.example.com/api/subscribe', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.9.1', Origin: 'http://localhost:8000', ...headers },
  });
}

function confirmRequest(token) {
  return new Request(`https://api.example.com/api/subscribe/confirm?token=${encodeURIComponent(token || '')}`);
}

function unsubscribeRequest(token) {
  return new Request(`https://api.example.com/api/unsubscribe?token=${encodeURIComponent(token || '')}`);
}

function adminRequest(url, { method = 'GET', body } = {}) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function redirectLocation(res) {
  // Node's Response.redirect() surfaces the target via the Location header.
  return res.headers.get('Location') || res.headers.get('location');
}

/**
 * A tiny in-memory fake of the two external HTTP APIs this feature calls —
 * enough to exercise the REAL idempotent logic in src/brevo.js/src/stripe.js
 * (find-by-name-then-create, find-by-code-then-create, merge-not-replace
 * attributes) rather than re-asserting "fetch was called with X", which would
 * just restate the implementation. State is reset per-test via beforeEach.
 */
function makeExternalApiMock() {
  const state = {
    sent: [],              // captured Brevo smtp/email sends: {to, subject, htmlContent}
    folders: [],           // Brevo folders [{id, name}]
    lists: [],             // Brevo lists [{id, name, folderId}]
    attributes: [],        // Brevo attributes [{name, type}]
    contacts: new Map(),   // email -> {email, attributes, listIds}
    promotionCodes: [],    // Stripe promotion codes [{id, code, coupon}]
    failEmails: new Set(), // emails whose /contacts POST should fail once
    nextFolderId: 1,
    nextListId: 1,
    nextPromoId: 1,
  };

  async function fetchMock(url, opts = {}) {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const bodyText = opts.body ? String(opts.body) : '';

    // --- Brevo: transactional email -----------------------------------
    if (u.includes('/v3/smtp/email')) {
      const payload = JSON.parse(bodyText);
      state.sent.push({ to: payload.to[0].email, subject: payload.subject, htmlContent: payload.htmlContent });
      return new Response('{}', { status: 200 });
    }

    // --- Brevo: folders --------------------------------------------------
    if (u.includes('/v3/contacts/folders') && method === 'GET') {
      return new Response(JSON.stringify({ folders: state.folders }), { status: 200 });
    }
    if (u.includes('/v3/contacts/folders') && method === 'POST') {
      const { name } = JSON.parse(bodyText);
      const folder = { id: state.nextFolderId++, name };
      state.folders.push(folder);
      return new Response(JSON.stringify(folder), { status: 201 });
    }

    // --- Brevo: lists ------------------------------------------------------
    if (u.includes('/v3/contacts/lists') && method === 'GET') {
      return new Response(JSON.stringify({ lists: state.lists }), { status: 200 });
    }
    if (u.includes('/v3/contacts/lists') && method === 'POST') {
      const { name, folderId } = JSON.parse(bodyText);
      const list = { id: state.nextListId++, name, folderId };
      state.lists.push(list);
      return new Response(JSON.stringify(list), { status: 201 });
    }

    // --- Brevo: attributes ---------------------------------------------------
    if (u.includes('/v3/contacts/attributes') && method === 'GET') {
      return new Response(JSON.stringify({ attributes: state.attributes }), { status: 200 });
    }
    if (u.match(/\/v3\/contacts\/attributes\/normal\//) && method === 'POST') {
      const name = decodeURIComponent(u.split('/').pop());
      const { type } = JSON.parse(bodyText);
      state.attributes.push({ name, type });
      return new Response('{}', { status: 201 });
    }

    // --- Brevo: contacts -------------------------------------------------------
    if (u.endsWith('/v3/contacts') && method === 'POST') {
      const { email, attributes, listIds } = JSON.parse(bodyText);
      if (state.failEmails.has(email)) {
        state.failEmails.delete(email); // fail once, then succeed on retry
        return new Response(JSON.stringify({ message: 'simulated failure' }), { status: 500 });
      }
      const existed = state.contacts.has(email);
      const prev = state.contacts.get(email) || { email, attributes: {}, listIds: [] };
      state.contacts.set(email, {
        email,
        attributes: { ...prev.attributes, ...(attributes || {}) }, // Brevo MERGES attributes
        listIds: listIds && listIds.length ? [...new Set([...(prev.listIds || []), ...listIds])] : prev.listIds,
      });
      return new Response(existed ? null : JSON.stringify({ id: 1 }), { status: existed ? 204 : 201 });
    }
    if (u.match(/\/v3\/contacts\/[^/]+$/) && method === 'GET') {
      const email = decodeURIComponent(u.split('/').pop());
      const contact = state.contacts.get(email);
      if (!contact) return new Response(JSON.stringify({ message: 'Contact does not exist' }), { status: 404 });
      return new Response(JSON.stringify(contact), { status: 200 });
    }
    if (u.match(/\/v3\/contacts\/[^/]+$/) && method === 'PUT') {
      const email = decodeURIComponent(u.split('/').pop());
      const patch = JSON.parse(bodyText);
      const prev = state.contacts.get(email);
      if (!prev) return new Response(JSON.stringify({ message: 'Contact does not exist' }), { status: 404 });
      const next = { ...prev };
      if (patch.attributes) next.attributes = { ...prev.attributes, ...patch.attributes };
      if (patch.listIds) next.listIds = [...new Set([...(prev.listIds || []), ...patch.listIds])];
      if (patch.unlinkListIds) next.listIds = (prev.listIds || []).filter((id) => !patch.unlinkListIds.includes(id));
      if (patch.emailBlacklisted !== undefined) next.emailBlacklisted = patch.emailBlacklisted;
      state.contacts.set(email, next);
      return new Response(null, { status: 204 });
    }

    // --- Stripe: promotion codes / coupons ------------------------------------
    if (u.includes('api.stripe.com/v1/promotion_codes') && method === 'GET') {
      const codeParam = new URL(u).searchParams.get('code');
      const match = state.promotionCodes.filter((p) => p.code === codeParam);
      return new Response(JSON.stringify({ data: match }), { status: 200 });
    }
    if (u.includes('api.stripe.com/v1/coupons') && method === 'POST') {
      return new Response(JSON.stringify({ id: `coupon_${state.nextPromoId}` }), { status: 200 });
    }
    if (u.includes('api.stripe.com/v1/promotion_codes') && method === 'POST') {
      const params = new URLSearchParams(bodyText);
      const promo = { id: `promo_${state.nextPromoId++}`, code: params.get('code'), coupon: params.get('promotion[coupon]') || params.get('coupon') };
      state.promotionCodes.push(promo);
      return new Response(JSON.stringify(promo), { status: 200 });
    }

    throw new Error(`unmocked fetch: ${method} ${u}`);
  }

  return { fetchMock, state };
}

let db;
let mock;
const realFetch = global.fetch;
beforeEach(() => {
  db = makeTestDb(schemaSql);
  mock = makeExternalApiMock();
  global.fetch = mock.fetchMock;
});
afterEach(() => { global.fetch = realFetch; });

const BASE_ENV = () => ({ DB: db, BREVO_API_KEY: 'key_x', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });

// ---------------------------------------------------------------------------
// POST /api/subscribe — validation, honeypot, rate limit
// ---------------------------------------------------------------------------

describe('POST /api/subscribe — validation', () => {
  test('a valid signup creates a pending row and sends a confirmation email', async () => {
    const env = BASE_ENV();
    const res = await handleSubscribe(subscribeRequest({ email: 'anna@example.com', locale: 'en', source: 'site_footer' }), env);
    assert.equal(res.status, 200);
    const row = await realDb.getSubscriberByEmail(db, 'anna@example.com');
    assert.equal(row.status, 'pending');
    assert.ok(row.confirm_token);
    assert.ok(row.unsubscribe_token);
    assert.equal(mock.state.sent.length, 1);
    assert.ok(mock.state.sent[0].htmlContent.includes(row.confirm_token));
  });

  test('email is lowercased for storage/uniqueness', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'Anna@Example.com', locale: 'en', source: 'site_footer' }), env);
    const row = await realDb.getSubscriberByEmail(db, 'anna@example.com');
    assert.ok(row);
    assert.equal(row.email, 'anna@example.com');
  });

  test('rejects an invalid source', async () => {
    const env = BASE_ENV();
    const res = await handleSubscribe(subscribeRequest({ email: 'a@example.com', locale: 'en', source: 'not_a_real_source' }), env);
    assert.equal(res.status, 400);
  });

  test('rejects an invalid email', async () => {
    const env = BASE_ENV();
    const res = await handleSubscribe(subscribeRequest({ email: 'nope', locale: 'en', source: 'site_footer' }), env);
    assert.equal(res.status, 400);
  });

  test('rejects an oversized city', async () => {
    const env = BASE_ENV();
    const res = await handleSubscribe(subscribeRequest({ email: 'a@example.com', locale: 'en', source: 'site_footer', city: 'x'.repeat(300) }), env);
    assert.equal(res.status, 400);
  });

  test('a browser Origin not on the allowlist is rejected with 403', async () => {
    const env = BASE_ENV();
    const res = await handleSubscribe(subscribeRequest({ email: 'a@example.com', locale: 'en', source: 'site_footer' }, { Origin: 'https://evil.example.com' }), env);
    assert.equal(res.status, 403);
  });
});

describe('POST /api/subscribe — honeypot', () => {
  test('a filled honeypot field is silently absorbed: 200 ok, no row, no email', async () => {
    const env = BASE_ENV();
    const res = await handleSubscribe(subscribeRequest({ email: 'bot@example.com', locale: 'en', source: 'site_footer', website: 'http://spam.example.com' }), env);
    assert.equal(res.status, 200);
    const row = await realDb.getSubscriberByEmail(db, 'bot@example.com');
    assert.equal(row, null);
    assert.equal(mock.state.sent.length, 0);
  });
});

describe('POST /api/subscribe — own rate-limit bucket', () => {
  test(`the ${HOLD_ATTEMPTS_PER_WINDOW + 1}th attempt from one IP is 429 with Retry-After`, async () => {
    const env = BASE_ENV();
    const ip = '10.9.9.9';
    let last;
    for (let i = 0; i < HOLD_ATTEMPTS_PER_WINDOW + 1; i++) {
      last = await handleSubscribe(subscribeRequest({ email: `s${i}@example.com`, locale: 'en', source: 'site_footer' }, { 'CF-Connecting-IP': ip }), env);
    }
    assert.equal(last.status, 429);
    const body = await last.json();
    assert.equal(body.error, 'rate_limited');
    assert.equal(last.headers.get('Retry-After'), String(body.retry_after_seconds));
  });

  test('subscribe attempts do not share a bucket with book/contact/giftcard', async () => {
    const env = BASE_ENV();
    const ip = '10.9.9.10';
    for (let i = 0; i < HOLD_ATTEMPTS_PER_WINDOW + 1; i++) {
      await handleSubscribe(subscribeRequest({ email: `t${i}@example.com`, locale: 'en', source: 'site_footer' }, { 'CF-Connecting-IP': ip }), env);
    }
    const bookAttempts = await realDb.countRateEventsSince(db, 'book', ip, '2000-01-01 00:00:00');
    assert.equal(bookAttempts, 0);
  });
});

// ---------------------------------------------------------------------------
// The double opt-in state machine
// ---------------------------------------------------------------------------

describe('POST /api/subscribe — double opt-in state machine', () => {
  test('re-subscribing a still-pending email re-issues a fresh token and resends', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'pending@example.com', locale: 'en', source: 'site_footer' }), env);
    const first = await realDb.getSubscriberByEmail(db, 'pending@example.com');

    await handleSubscribe(subscribeRequest({ email: 'pending@example.com', locale: 'en', source: 'site_footer' }), env);
    const second = await realDb.getSubscriberByEmail(db, 'pending@example.com');

    assert.notEqual(first.confirm_token, second.confirm_token);
    assert.equal(second.status, 'pending');
    assert.equal(mock.state.sent.length, 2, 'both the first and the resend emails should have gone out');
  });

  test('re-subscribing an already-CONFIRMED email returns {ok:true, already:true} and sends NO email', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'confirmed@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'confirmed@example.com');
    await realDb.confirmSubscriberByToken(db, pending.confirm_token);
    mock.state.sent = []; // reset — only care about what happens on the re-subscribe

    const res = await handleSubscribe(subscribeRequest({ email: 'confirmed@example.com', locale: 'en', source: 'site_footer' }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, already: true });
    assert.equal(mock.state.sent.length, 0, 'no email should be sent for an already-confirmed resubscribe');
  });

  test('re-subscribing an UNSUBSCRIBED email re-arms it as pending and resends', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'churned@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'churned@example.com');
    await realDb.confirmSubscriberByToken(db, pending.confirm_token);
    const confirmed = await realDb.getSubscriberByEmail(db, 'churned@example.com');
    await realDb.unsubscribeByToken(db, confirmed.unsubscribe_token);

    const res = await handleSubscribe(subscribeRequest({ email: 'churned@example.com', locale: 'en', source: 'site_footer' }), env);
    assert.equal(res.status, 200);
    const row = await realDb.getSubscriberByEmail(db, 'churned@example.com');
    assert.equal(row.status, 'pending');
    assert.ok(row.confirm_token);
  });
});

// ---------------------------------------------------------------------------
// GET /api/subscribe/confirm
// ---------------------------------------------------------------------------

describe('GET /api/subscribe/confirm', () => {
  test('a valid token confirms, syncs to Brevo (added to the list), and sends the welcome email with the code + unsubscribe link', async () => {
    const env = BASE_ENV();
    await handleBrevoSetup(adminRequest('https://api.example.com/admin/api/brevo/setup', { method: 'POST' }), env); // populates brevo_list_id
    await handleSubscribe(subscribeRequest({ email: 'click@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'click@example.com');
    mock.state.sent = [];

    const res = await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    assert.equal(res.status, 302);
    assert.ok(redirectLocation(res).includes('/subscribed/?state=confirmed&lang=en'));

    const confirmed = await realDb.getSubscriberByEmail(db, 'click@example.com');
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmed_at);

    const contact = mock.state.contacts.get('click@example.com');
    assert.ok(contact, 'contact should be upserted into Brevo');
    assert.ok(contact.listIds && contact.listIds.length > 0, 'contact should be added to the WOGO list');
    assert.equal(contact.attributes.CONSENT_SOURCE, 'double_opt_in');

    assert.equal(mock.state.sent.length, 1, 'exactly the welcome email should have been sent');
    assert.ok(mock.state.sent[0].htmlContent.includes(WELCOME_CODE));
    assert.ok(mock.state.sent[0].htmlContent.includes(confirmed.unsubscribe_token));
  });

  test('the welcome email is in Dutch when the subscriber locale is nl', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'klik@example.com', locale: 'nl', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'klik@example.com');
    mock.state.sent = [];
    await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    assert.ok(mock.state.sent[0].subject.toLowerCase().includes('welkom'));
  });

  test('an invalid/unknown token redirects to ?state=invalid', async () => {
    const env = BASE_ENV();
    const res = await handleSubscribeConfirm(confirmRequest('does-not-exist'), env);
    assert.equal(res.status, 302);
    assert.ok(redirectLocation(res).includes('?state=invalid'));
  });

  test('clicking an already-confirmed token again is idempotent: same success redirect, NO second welcome email', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'twice@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'twice@example.com');
    await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    mock.state.sent = [];

    const res = await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    assert.equal(res.status, 302);
    assert.ok(redirectLocation(res).includes('/subscribed/?state=confirmed&lang=en'));
    assert.equal(mock.state.sent.length, 0, 'no second welcome email on a repeat click');
  });

  test('an expired pending token redirects to ?state=invalid', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'late@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'late@example.com');
    db._raw.prepare(`UPDATE subscribers SET created_at = datetime('now', '-3 days') WHERE id = ?`).run(pending.id);

    const res = await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    assert.equal(res.status, 302);
    assert.ok(redirectLocation(res).includes('?state=invalid'));
    const row = await realDb.getSubscriberByEmail(db, 'late@example.com');
    assert.equal(row.status, 'pending', 'an expired token must not silently confirm the row');
  });

  test('a token for an already-UNSUBSCRIBED row redirects to ?state=invalid', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'gone@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'gone@example.com');
    await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    const confirmed = await realDb.getSubscriberByEmail(db, 'gone@example.com');
    await realDb.unsubscribeByToken(db, confirmed.unsubscribe_token);

    const res = await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    assert.ok(redirectLocation(res).includes('?state=invalid'));
  });
});

// ---------------------------------------------------------------------------
// GET /api/unsubscribe
// ---------------------------------------------------------------------------

describe('GET /api/unsubscribe', () => {
  test('a valid token unsubscribes locally and in Brevo, then redirects to ?state=unsubscribed', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'bye@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'bye@example.com');
    await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    const confirmed = await realDb.getSubscriberByEmail(db, 'bye@example.com');

    const res = await handleUnsubscribe(unsubscribeRequest(confirmed.unsubscribe_token), env);
    assert.equal(res.status, 302);
    assert.ok(redirectLocation(res).includes('?state=unsubscribed'));

    const row = await realDb.getSubscriberByEmail(db, 'bye@example.com');
    assert.equal(row.status, 'unsubscribed');
    const contact = mock.state.contacts.get('bye@example.com');
    assert.equal(contact.emailBlacklisted, true);
  });

  test('an invalid token redirects to ?state=invalid', async () => {
    const env = BASE_ENV();
    const res = await handleUnsubscribe(unsubscribeRequest('nope'), env);
    assert.ok(redirectLocation(res).includes('?state=invalid'));
  });

  test('unsubscribing twice is idempotent — second click still redirects to ?state=unsubscribed', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'bye2@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'bye2@example.com');
    await handleSubscribeConfirm(confirmRequest(pending.confirm_token), env);
    const confirmed = await realDb.getSubscriberByEmail(db, 'bye2@example.com');
    await handleUnsubscribe(unsubscribeRequest(confirmed.unsubscribe_token), env);

    const res = await handleUnsubscribe(unsubscribeRequest(confirmed.unsubscribe_token), env);
    assert.ok(redirectLocation(res).includes('?state=unsubscribed'));
  });
});

// ---------------------------------------------------------------------------
// POST /admin/api/brevo/setup — idempotent contact model creation
// ---------------------------------------------------------------------------

describe('POST /admin/api/brevo/setup', () => {
  test('creates the folder, list, and every attribute on first run', async () => {
    const env = BASE_ENV();
    const res = await handleBrevoSetup(adminRequest('https://api.example.com/admin/api/brevo/setup', { method: 'POST' }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folder.created, true);
    assert.equal(body.list.created, true);
    assert.ok(body.attributes.every((a) => a.created === true));
    const storedListId = await realDb.getSetting(db, 'brevo_list_id');
    assert.equal(Number(storedListId), body.list.id);
  });

  test('running it again finds everything already there — nothing created twice', async () => {
    const env = BASE_ENV();
    await handleBrevoSetup(adminRequest('https://api.example.com/admin/api/brevo/setup', { method: 'POST' }), env);
    const res2 = await handleBrevoSetup(adminRequest('https://api.example.com/admin/api/brevo/setup', { method: 'POST' }), env);
    const body2 = await res2.json();
    assert.equal(body2.folder.created, false);
    assert.equal(body2.list.created, false);
    assert.ok(body2.attributes.every((a) => a.created === false));
    assert.equal(mock.state.folders.length, 1);
    assert.equal(mock.state.lists.length, 1);
  });

  test('missing CSRF header is rejected', async () => {
    const env = BASE_ENV();
    const res = await handleBrevoSetup(new Request('https://api.example.com/admin/api/brevo/setup', { method: 'POST' }), env);
    assert.equal(res.status, 403);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/api/stripe/ensure-welcome-code
// ---------------------------------------------------------------------------

describe('POST /admin/api/stripe/ensure-welcome-code', () => {
  test('creates the WELCOME10 promotion code on first run', async () => {
    const env = BASE_ENV();
    const res = await handleEnsureWelcomeCode(adminRequest('https://api.example.com/admin/api/stripe/ensure-welcome-code', { method: 'POST' }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.code, WELCOME_CODE);
    assert.equal(body.created, true);
  });

  test('running it again finds the existing code — created:false', async () => {
    const env = BASE_ENV();
    await handleEnsureWelcomeCode(adminRequest('https://api.example.com/admin/api/stripe/ensure-welcome-code', { method: 'POST' }), env);
    const res2 = await handleEnsureWelcomeCode(adminRequest('https://api.example.com/admin/api/stripe/ensure-welcome-code', { method: 'POST' }), env);
    const body2 = await res2.json();
    assert.equal(body2.created, false);
    assert.equal(mock.state.promotionCodes.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Admin: list / CSV / import
// ---------------------------------------------------------------------------

describe('GET /admin/api/subscribers', () => {
  test('lists subscribers with counts by status/source/locale', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'one@example.com', locale: 'en', source: 'site_footer' }), env);
    await handleSubscribe(subscribeRequest({ email: 'two@example.com', locale: 'nl', source: 'contact_form' }), env);
    const res = await handleListSubscribers(new Request('https://api.example.com/admin/api/subscribers'), env);
    const body = await res.json();
    assert.equal(body.subscribers.length, 2);
    assert.equal(body.total, 2);
    assert.ok(body.counts.by_status.some((r) => r.status === 'pending' && r.n === 2));
  });

  test('filters by status', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'p1@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'p1@example.com');
    await realDb.confirmSubscriberByToken(db, pending.confirm_token);
    await handleSubscribe(subscribeRequest({ email: 'p2@example.com', locale: 'en', source: 'site_footer' }), env);

    const res = await handleListSubscribers(new Request('https://api.example.com/admin/api/subscribers?status=confirmed'), env);
    const body = await res.json();
    assert.equal(body.subscribers.length, 1);
    assert.equal(body.subscribers[0].email, 'p1@example.com');
  });
});

describe('GET /admin/api/subscribers.csv', () => {
  test('returns a CSV with a header row and one row per subscriber', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'csv@example.com', locale: 'en', source: 'site_footer' }), env);
    const res = await handleSubscribersCsv(new Request('https://api.example.com/admin/api/subscribers.csv'), env);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Content-Type').includes('text/csv'));
    const text = await res.text();
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('email'));
    assert.ok(lines[1].includes('csv@example.com'));
  });
});

describe('POST /admin/api/subscribers/import', () => {
  test('imports a batch as confirmed, source=wix_import, and syncs each to Brevo', async () => {
    const env = BASE_ENV();
    const rows = [
      { email: 'wix1@example.com', first_name: 'Wix One', locale: 'nl', city: 'Utrecht' },
      { email: 'wix2@example.com' },
    ];
    const res = await handleImportSubscribers(adminRequest('https://api.example.com/admin/api/subscribers/import', { method: 'POST', body: rows }), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.imported, 2);
    assert.equal(body.updated, 0);

    const row1 = await realDb.getSubscriberByEmail(db, 'wix1@example.com');
    assert.equal(row1.status, 'confirmed');
    assert.equal(row1.source, 'wix_import');
    assert.equal(row1.first_name, 'Wix One');
    assert.ok(mock.state.contacts.has('wix1@example.com'));
    assert.equal(mock.state.contacts.get('wix1@example.com').attributes.CONSENT_SOURCE, 'wix_import');
  });

  test('re-importing the same email updates rather than duplicates', async () => {
    const env = BASE_ENV();
    await handleImportSubscribers(adminRequest('https://api.example.com/admin/api/subscribers/import', { method: 'POST', body: [{ email: 'dup@example.com' }] }), env);
    const res = await handleImportSubscribers(adminRequest('https://api.example.com/admin/api/subscribers/import', { method: 'POST', body: [{ email: 'dup@example.com', first_name: 'Updated' }] }), env);
    const body = await res.json();
    assert.equal(body.imported, 0);
    assert.equal(body.updated, 1);
    const row = await realDb.getSubscriberByEmail(db, 'dup@example.com');
    assert.equal(row.first_name, 'Updated');
  });

  test('a Brevo failure for one row queues it for retry instead of failing the whole import', async () => {
    const env = BASE_ENV();
    mock.state.failEmails.add('flaky@example.com');
    const res = await handleImportSubscribers(adminRequest('https://api.example.com/admin/api/subscribers/import', { method: 'POST', body: [{ email: 'flaky@example.com' }, { email: 'fine@example.com' }] }), env);
    const body = await res.json();
    assert.equal(body.imported, 2, 'both local rows should still be created');
    assert.equal(body.queued_for_retry, 1);

    const queue = await realDb.listRecentBrevoSyncItems(db, 10);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'subscriber_confirm');
  });

  test('rejects an empty array', async () => {
    const env = BASE_ENV();
    const res = await handleImportSubscribers(adminRequest('https://api.example.com/admin/api/subscribers/import', { method: 'POST', body: [] }), env);
    assert.equal(res.status, 400);
  });

  test('rejects an invalid email in the batch', async () => {
    const env = BASE_ENV();
    const res = await handleImportSubscribers(adminRequest('https://api.example.com/admin/api/subscribers/import', { method: 'POST', body: [{ email: 'not-an-email' }] }), env);
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Booking opt-in (BUILD item #3) — real webhook confirm flow + manual booking
// ---------------------------------------------------------------------------

describe('Booking opt-in — confirmed booking via the Stripe webhook', () => {
  async function confirmBookingViaWebhook(env, bookingId, sessionId = 'cs_1') {
    const body = JSON.stringify({
      id: `evt_${bookingId}`, type: 'checkout.session.completed',
      data: { object: { client_reference_id: bookingId, id: sessionId, payment_intent: 'pi_1' } },
    });
    const sig = await computeStripeSignatureHeader(body, STRIPE_SECRET);
    const request = new Request('https://worker.example.com/webhooks/stripe', {
      method: 'POST', body, headers: { 'stripe-signature': sig },
    });
    return handleWebhook(request, env);
  }

  test('opted-in guest becomes a CONFIRMED subscriber, added to the Brevo list, CONSENT_SOURCE=booking', async () => {
    const env = BASE_ENV();
    await handleBrevoSetup(adminRequest('https://api.example.com/admin/api/brevo/setup', { method: 'POST' }), env);
    seedRoute(db);
    const holdExpires = computeHoldExpiry(15);
    const hold = await createHold(db, {
      id: 'b_optin', route_id: 'amsterdam', date: '2026-09-10', slot: '18:00', party: 2,
      name: 'Opted In', email: 'optin@example.com', locale: 'en', marketing_opt_in: true, hold_expires: holdExpires, ip: '1.2.3.4',
    });
    assert.ok(hold.created);

    const res = await confirmBookingViaWebhook(env, 'b_optin');
    assert.equal(res.status, 200);

    const subscriber = await realDb.getSubscriberByEmail(db, 'optin@example.com');
    assert.equal(subscriber.status, 'confirmed');
    assert.equal(subscriber.source, 'booking_opt_in');

    const contact = mock.state.contacts.get('optin@example.com');
    assert.ok(contact.listIds && contact.listIds.length > 0);
    assert.equal(contact.attributes.CONSENT_SOURCE, 'booking');
    assert.equal(contact.attributes.LAST_ROUTE, 'WOGO Cocktail Walk Amsterdam');
    assert.equal(contact.attributes.BOOKINGS_COUNT, 1);

    const welcomeMail = mock.state.sent.find((s) => s.htmlContent.includes(WELCOME_CODE));
    assert.ok(welcomeMail, 'a welcome email with the code should be sent on first opt-in');
  });

  test('a SECOND opted-in booking from an already-confirmed subscriber does not re-send the welcome email', async () => {
    const env = BASE_ENV();
    seedRoute(db);
    const holdExpires = computeHoldExpiry(15);
    await createHold(db, {
      id: 'b_optin2a', route_id: 'amsterdam', date: '2026-09-10', slot: '18:00', party: 1,
      name: 'Repeat', email: 'repeat@example.com', locale: 'en', marketing_opt_in: true, hold_expires: holdExpires, ip: '1.2.3.5',
    });
    await confirmBookingViaWebhook(env, 'b_optin2a');
    mock.state.sent = [];

    await createHold(db, {
      id: 'b_optin2b', route_id: 'amsterdam', date: '2026-09-17', slot: '18:00', party: 1,
      name: 'Repeat', email: 'repeat@example.com', locale: 'en', marketing_opt_in: true, hold_expires: holdExpires, ip: '1.2.3.5',
    });
    await confirmBookingViaWebhook(env, 'b_optin2b');

    const welcomeMail = mock.state.sent.find((s) => s.htmlContent.includes(WELCOME_CODE));
    assert.equal(welcomeMail, undefined, 'no second welcome/code email for an already-confirmed subscriber');
    const contact = mock.state.contacts.get('repeat@example.com');
    assert.equal(contact.attributes.BOOKINGS_COUNT, 2, 'bookings count should still increment');
  });

  test('a NON-opted-in guest who is NOT already a Brevo contact creates NO subscriber and NO Brevo contact', async () => {
    const env = BASE_ENV();
    seedRoute(db);
    const holdExpires = computeHoldExpiry(15);
    await createHold(db, {
      id: 'b_noconsent', route_id: 'amsterdam', date: '2026-09-10', slot: '18:00', party: 1,
      name: 'No Consent', email: 'noconsent@example.com', locale: 'en', marketing_opt_in: false, hold_expires: holdExpires, ip: '1.2.3.6',
    });
    await confirmBookingViaWebhook(env, 'b_noconsent');

    const subscriber = await realDb.getSubscriberByEmail(db, 'noconsent@example.com');
    assert.equal(subscriber, null);
    assert.equal(mock.state.contacts.has('noconsent@example.com'), false);
  });

  test('a NON-opted-in guest who IS already a Brevo contact gets LAST_BOOKING_DATE/LAST_ROUTE/BOOKINGS_COUNT updated, without being added to any list or re-consented', async () => {
    const env = BASE_ENV();
    seedRoute(db);
    // Pre-seed a Brevo contact that exists for some OTHER reason (e.g. a
    // manually-added contact in Brevo itself) but was never one of OUR
    // confirmed local subscribers.
    mock.state.contacts.set('existing@example.com', { email: 'existing@example.com', attributes: { BOOKINGS_COUNT: 3 }, listIds: [] });

    const holdExpires = computeHoldExpiry(15);
    await createHold(db, {
      id: 'b_existing', route_id: 'amsterdam', date: '2026-09-20', slot: '18:00', party: 1,
      name: 'Existing', email: 'existing@example.com', locale: 'en', marketing_opt_in: false, hold_expires: holdExpires, ip: '1.2.3.7',
    });
    await confirmBookingViaWebhook(env, 'b_existing');

    const subscriber = await realDb.getSubscriberByEmail(db, 'existing@example.com');
    assert.equal(subscriber, null, 'local subscribers table is untouched for the no-opt-in path');

    const contact = mock.state.contacts.get('existing@example.com');
    assert.equal(contact.attributes.BOOKINGS_COUNT, 4);
    assert.equal(contact.attributes.LAST_ROUTE, 'WOGO Cocktail Walk Amsterdam');
    assert.equal(contact.attributes.LAST_BOOKING_DATE, '2026-09-20');
    assert.deepEqual(contact.listIds, [], 'must not be added to the list — no new consent was given');
  });
});

describe('Booking opt-in — manual (phone) booking', () => {
  test('an opted-in manual booking subscribes the guest the same way a web booking does', async () => {
    const env = BASE_ENV();
    seedRoute(db);
    const res = await handleCreateManualBooking(
      adminRequest('https://api.example.com/admin/api/bookings/manual', {
        method: 'POST',
        body: {
          route_id: 'amsterdam', date: '2026-09-10', slot: '18:00', party: 2,
          name: 'Phone Guest', email: 'phone@example.com', locale: 'en', marketing_opt_in: true,
        },
      }),
      env
    );
    assert.equal(res.status, 201);
    const subscriber = await realDb.getSubscriberByEmail(db, 'phone@example.com');
    assert.equal(subscriber.status, 'confirmed');
    assert.equal(subscriber.source, 'booking_opt_in');
    assert.ok(mock.state.contacts.has('phone@example.com'));
  });
});

// ---------------------------------------------------------------------------
// brevo_sync_queue retry drain
// ---------------------------------------------------------------------------

describe('retryBrevoSyncQueue', () => {
  test('a queued item succeeds on retry and is marked done', async () => {
    const env = BASE_ENV();
    await handleSubscribe(subscribeRequest({ email: 'retry@example.com', locale: 'en', source: 'site_footer' }), env);
    const pending = await realDb.getSubscriberByEmail(db, 'retry@example.com');

    // Simulate the live confirm call having failed by queuing it directly,
    // as src/subscribers.js's withRetryQueue would have.
    await realDb.queueBrevoSync(db, {
      kind: 'subscriber_confirm', payload: { subscriber_id: pending.id },
      last_error: 'simulated', next_attempt_at: '2000-01-01 00:00:00',
    });

    const result = await retryBrevoSyncQueue(env);
    assert.equal(result.done, 1);
    assert.ok(mock.state.contacts.has('retry@example.com'));
    const queue = await realDb.listRecentBrevoSyncItems(db, 10);
    assert.equal(queue[0].status, 'done');
  });

  test('a permanently-failing item is marked failed_permanent after max attempts and alerts the owner once', async () => {
    const env = BASE_ENV();
    await realDb.queueBrevoSync(db, {
      kind: 'subscriber_unsubscribe', payload: { email: 'ghost@example.com' },
      last_error: 'simulated', next_attempt_at: '2000-01-01 00:00:00',
    });
    // unsubscribeContact on a contact that never existed in the mock still
    // 404s cleanly (no-op) in real Brevo — force a hard failure instead by
    // pointing at a kind the mock doesn't implement a success path for.
    const deps = {
      replaySyncItem: async () => { throw new Error('still broken'); },
    };
    // Run past FAILED attempts: first 4 reschedule, 5th gives up.
    for (let i = 0; i < 5; i++) {
      await db._raw.prepare(`UPDATE brevo_sync_queue SET next_attempt_at = '2000-01-01 00:00:00'`).run();
      await retryBrevoSyncQueue(env, deps);
    }
    const queue = await realDb.listRecentBrevoSyncItems(db, 10);
    assert.equal(queue[0].status, 'failed_permanent');
    const alertMail = mock.state.sent.find((s) => s.subject.includes('Brevo sync'));
    assert.ok(alertMail, 'an owner alert should have been sent');
  });
});
