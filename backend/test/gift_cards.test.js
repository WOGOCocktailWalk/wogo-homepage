// test/gift_cards.test.js — migrations/0018 (gift_cards) + 0019
// (gift_card_redemptions, bookings.gift_code/gift_applied_cents): the
// balance-tracked gift-card system. D1 (this test's real sqlite adapter) is
// the source of truth for balance_cents; Stripe only ever processes the
// leftover payment via a one-time coupon (src/stripe.js).
//
// Covers: purchase -> code + balance creation, partial + full redemption,
// currency-mismatch rejection, the double-spend/idempotency guard, a fully-
// covered (€0) booking, and proof a normal (no gift_code) booking is
// byte-for-byte unchanged by this feature.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import * as realDb from '../src/db.js';
import { toPositional, getBooking } from '../src/db.js';
import { handleGiftCardCheckout, handleBook } from '../src/guest_api.js';
import { handleWebhook, handleGiftCardPurchaseCompleted, applyGiftCardRedemption } from '../src/webhook.js';
import { generateGiftCardCode } from '../src/logic.js';
import worker from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

function exec(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(db, overrides = {}) {
  const route = {
    id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 50, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00"]',
    slot_capacity: '{}', map_url: null, active: 1,
    ...overrides,
  };
  const cols = Object.keys(route);
  exec(db, `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, route);
  return route;
}

const TODAY = new Date().toISOString().slice(0, 10);

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

function seedGiftCard(overrides = {}) {
  return realDb.createGiftCard(db, {
    initial_cents: 3000,
    currency: 'EUR',
    buyer_email: 'buyer@example.com',
    buyer_name: 'Buyer Bea',
    recipient_name: 'Rita Recipient',
    recipient_email: 'rita@example.com',
    message: 'Enjoy!',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// logic.js — code generation
// ---------------------------------------------------------------------------

describe('generateGiftCardCode', () => {
  test('shape is WOGO-XXXX-XXXX, no confusing characters', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateGiftCardCode();
      assert.match(code, /^WOGO-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// db.js — createGiftCard / getGiftCardByCode
// ---------------------------------------------------------------------------

describe('db.js — createGiftCard', () => {
  test('creates a card with a unique code, balance = initial', async () => {
    const card = await seedGiftCard({ initial_cents: 6000 });
    assert.match(card.code, /^WOGO-/);
    assert.equal(card.initial_cents, 6000);
    assert.equal(card.balance_cents, 6000);
    assert.equal(card.status, 'active');
    assert.equal(card.currency, 'EUR');
  });

  test('getGiftCardByCode normalizes case + whitespace', async () => {
    const card = await seedGiftCard();
    const found = await realDb.getGiftCardByCode(db, `  ${card.code.toLowerCase()}  `);
    assert.ok(found);
    assert.equal(found.code, card.code);
  });

  test('a redelivered purchase webhook event does not mint a second card for the same stripe_session', async () => {
    const card = await seedGiftCard({ stripe_session: 'cs_gift_1' });
    const again = await realDb.getGiftCardByStripeSession(db, 'cs_gift_1');
    assert.equal(again.id, card.id);
    const all = await realDb.listGiftCards(db);
    assert.equal(all.length, 1);
  });
});

// ---------------------------------------------------------------------------
// db.js — redeemGiftCard: partial + full deduction, double-spend, idempotency
// ---------------------------------------------------------------------------

describe('db.js — redeemGiftCard', () => {
  test('partial redemption deducts exactly the applied amount, card stays active', async () => {
    const card = await seedGiftCard({ initial_cents: 3000 });
    const result = await realDb.redeemGiftCard(db, { code: card.code, applied_cents: 1200, booking_id: 'b_1' });
    assert.equal(result.status, 'redeemed');
    assert.equal(result.gift_card.balance_cents, 1800);
    assert.equal(result.gift_card.status, 'active');
    const redemptions = await realDb.listGiftCardRedemptions(db, card.code);
    assert.equal(redemptions.length, 1);
    assert.equal(redemptions[0].amount_cents, 1200);
    assert.equal(redemptions[0].booking_id, 'b_1');
  });

  test('full redemption drains the balance to 0 and flips status to depleted', async () => {
    const card = await seedGiftCard({ initial_cents: 3000 });
    const result = await realDb.redeemGiftCard(db, { code: card.code, applied_cents: 3000, booking_id: 'b_1' });
    assert.equal(result.status, 'redeemed');
    assert.equal(result.gift_card.balance_cents, 0);
    assert.equal(result.gift_card.status, 'depleted');
  });

  test('idempotent: redeeming the SAME booking_id twice (a webhook retry) deducts only once', async () => {
    const card = await seedGiftCard({ initial_cents: 3000 });
    const first = await realDb.redeemGiftCard(db, { code: card.code, applied_cents: 1000, booking_id: 'b_retry' });
    assert.equal(first.status, 'redeemed');
    const second = await realDb.redeemGiftCard(db, { code: card.code, applied_cents: 1000, booking_id: 'b_retry' });
    assert.equal(second.status, 'already_redeemed');
    assert.equal(second.gift_card.balance_cents, 2000, 'balance must not be deducted a second time');
    const redemptions = await realDb.listGiftCardRedemptions(db, card.code);
    assert.equal(redemptions.length, 1);
  });

  test('double-spend guard: two DIFFERENT bookings racing for a nearly-empty card cannot over-deduct', async () => {
    const card = await seedGiftCard({ initial_cents: 1000 });
    const first = await realDb.redeemGiftCard(db, { code: card.code, applied_cents: 700, booking_id: 'b_a' });
    const second = await realDb.redeemGiftCard(db, { code: card.code, applied_cents: 700, booking_id: 'b_b' });
    assert.equal(first.status, 'redeemed');
    assert.equal(second.status, 'insufficient_balance');
    const final = await realDb.getGiftCardByCode(db, card.code);
    assert.equal(final.balance_cents, 300, 'balance must never go negative — only the first redemption lands');
    const redemptions = await realDb.listGiftCardRedemptions(db, card.code);
    assert.equal(redemptions.length, 1, 'the failed redemption must not write an audit row');
  });

  test('redeeming an unknown code returns not_found', async () => {
    const result = await realDb.redeemGiftCard(db, { code: 'WOGO-0000-0000', applied_cents: 100, booking_id: 'b_x' });
    assert.equal(result.status, 'not_found');
    assert.equal(result.gift_card, null);
  });

  test('a voided card cannot be redeemed', async () => {
    const card = await seedGiftCard({ initial_cents: 3000 });
    await realDb.voidGiftCard(db, card.code);
    const result = await realDb.redeemGiftCard(db, { code: card.code, applied_cents: 100, booking_id: 'b_1' });
    assert.equal(result.status, 'insufficient_balance');
    assert.equal(result.gift_card.status, 'void');
  });
});

describe('db.js — voidGiftCard', () => {
  test('voids an active card', async () => {
    const card = await seedGiftCard();
    const ok = await realDb.voidGiftCard(db, card.code);
    assert.equal(ok, true);
    const found = await realDb.getGiftCardByCode(db, card.code);
    assert.equal(found.status, 'void');
  });

  test('does not touch an already-depleted card', async () => {
    const card = await seedGiftCard({ initial_cents: 500 });
    await realDb.redeemGiftCard(db, { code: card.code, applied_cents: 500, booking_id: 'b_1' });
    const ok = await realDb.voidGiftCard(db, card.code);
    assert.equal(ok, false);
    const found = await realDb.getGiftCardByCode(db, card.code);
    assert.equal(found.status, 'depleted');
  });
});

// ---------------------------------------------------------------------------
// guest_api.js — POST /api/giftcard/checkout (purchase)
// ---------------------------------------------------------------------------

describe('handleGiftCardCheckout', () => {
  const realFetch = global.fetch;
  let capturedBody;
  beforeEach(() => {
    capturedBody = null;
    global.fetch = async (url, opts) => {
      capturedBody = opts.body;
      return new Response(JSON.stringify({ id: 'cs_gift_1', url: 'https://checkout.stripe.com/gift1' }), { status: 200 });
    };
  });
  afterEach(() => { global.fetch = realFetch; });

  function validBody(overrides = {}) {
    return {
      amount_cents: 6000,
      buyer_name: 'Buyer Bea', buyer_email: 'buyer@example.com',
      recipient_name: 'Rita Recipient', recipient_email: 'rita@example.com',
      message: 'Happy birthday!',
      ...overrides,
    };
  }

  test('a tier amount (€60) creates a session and returns its url', async () => {
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const res = await handleGiftCardCheckout(new Request('https://api.example.com/api/giftcard/checkout', {
      method: 'POST', body: JSON.stringify(validBody()),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.2.2.1', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.url, 'https://checkout.stripe.com/gift1');
    assert.equal(capturedBody.get('metadata[type]'), 'giftcard');
    assert.equal(capturedBody.get('metadata[amount_cents]'), '6000');
    assert.equal(capturedBody.get('metadata[recipient_email]'), 'rita@example.com');
    assert.equal(capturedBody.get('line_items[0][price_data][unit_amount]'), '6000');
    assert.equal(capturedBody.get('line_items[0][price_data][currency]'), 'eur');
  });

  test('a valid custom amount (between the tiers) is accepted', async () => {
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const res = await handleGiftCardCheckout(new Request('https://api.example.com/api/giftcard/checkout', {
      method: 'POST', body: JSON.stringify(validBody({ amount_cents: 4500 })),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.2.2.2', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 200);
  });

  test('rejects an amount below the custom minimum', async () => {
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const res = await handleGiftCardCheckout(new Request('https://api.example.com/api/giftcard/checkout', {
      method: 'POST', body: JSON.stringify(validBody({ amount_cents: 500 })),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.2.2.3', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 400);
  });

  test('rejects a missing recipient email', async () => {
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const body = validBody(); delete body.recipient_email;
    const res = await handleGiftCardCheckout(new Request('https://api.example.com/api/giftcard/checkout', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.2.2.4', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 400);
  });

  test('gift-card purchase attempts use their OWN rate-limit bucket, separate from booking', async () => {
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const ip = '10.2.2.5';
    let last;
    for (let i = 0; i < 6; i++) {
      last = await handleGiftCardCheckout(new Request('https://api.example.com/api/giftcard/checkout', {
        method: 'POST', body: JSON.stringify(validBody()),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: 'http://localhost:8000' },
      }), env);
    }
    assert.equal(last.status, 429);
    // A normal booking attempt from the SAME ip, same moment, is unaffected
    // (proves 'giftcard' and 'book' don't share one rate bucket).
    seedRoute(db);
    const bookRes = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST',
      body: JSON.stringify({
        route_id: 'testroute', date: TODAY, slot: '18:00', party: 1,
        name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
      }),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: 'http://localhost:8000' },
    }), env);
    assert.notEqual(bookRes.status, 429);
  });
});

// ---------------------------------------------------------------------------
// guest_api.js — POST /api/book with gift_code (redemption at booking time)
// ---------------------------------------------------------------------------

describe('handleBook — gift_code redemption', () => {
  const realFetch = global.fetch;
  let calls;
  beforeEach(() => {
    calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: opts.body });
      if (String(url).includes('/v1/coupons')) {
        return new Response(JSON.stringify({ id: 'coupon_test_1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'cs_book_1', url: 'https://checkout.stripe.com/book1' }), { status: 200 });
    };
  });
  afterEach(() => { global.fetch = realFetch; });

  function bookBody(overrides = {}) {
    return {
      route_id: 'testroute', date: TODAY, slot: '18:00', party: 2,
      name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
      ...overrides,
    };
  }

  test('an unknown gift code is rejected before any hold/checkout is created', async () => {
    seedRoute(db);
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const res = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST', body: JSON.stringify(bookBody({ gift_code: 'WOGO-0000-0000' })),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.3.3.1', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_gift_card');
    assert.equal(calls.length, 0, 'no Stripe call should happen for a rejected gift code');
  });

  test('a currency-mismatched gift card is rejected', async () => {
    seedRoute(db, { id: 'gbproute', currency: 'GBP' });
    const card = await seedGiftCard({ currency: 'EUR' });
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const res = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST', body: JSON.stringify(bookBody({ route_id: 'gbproute', gift_code: card.code })),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.3.3.2', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'gift_card_currency_mismatch');
  });

  test('a partial-balance gift card reduces the Stripe charge via a one-time coupon, promo codes turned off', async () => {
    seedRoute(db); // price_cents 2995 * party 2 = 5990
    const card = await seedGiftCard({ initial_cents: 2000 }); // less than the total
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const res = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST', body: JSON.stringify(bookBody({ gift_code: card.code })),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.3.3.3', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 200);
    const body = await res.json();

    const couponCall = calls.find((c) => c.url.includes('/v1/coupons'));
    const sessionCall = calls.find((c) => c.url.includes('/v1/checkout/sessions'));
    assert.ok(couponCall, 'a one-time coupon must be created for the applied amount');
    assert.equal(couponCall.body.get('amount_off'), '2000', 'applied = min(balance, total) = full balance here');
    assert.equal(couponCall.body.get('max_redemptions'), '1');
    assert.ok(sessionCall);
    assert.equal(sessionCall.body.get('discounts[0][coupon]'), 'coupon_test_1');
    assert.equal(sessionCall.body.get('allow_promotion_codes'), null, 'promo codes must be OFF on a gift-card session');

    const booking = await getBooking(db, body.booking_id);
    assert.equal(booking.gift_code, card.code);
    assert.equal(booking.gift_applied_cents, 2000);
  });

  test('a gift card covering the ENTIRE total still goes through Stripe with a full-amount coupon (€0 due)', async () => {
    seedRoute(db); // total = 2995 * 2 = 5990
    const card = await seedGiftCard({ initial_cents: 10000 }); // more than enough
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const res = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST', body: JSON.stringify(bookBody({ gift_code: card.code })),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.3.3.4', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    const couponCall = calls.find((c) => c.url.includes('/v1/coupons'));
    assert.equal(couponCall.body.get('amount_off'), '5990', 'applied = min(balance, total) = the full booking total');

    const booking = await getBooking(db, body.booking_id);
    assert.equal(booking.gift_applied_cents, 5990);
  });

  test('a normal booking with NO gift_code is byte-for-byte unchanged: exactly one Stripe call, no coupon, promo codes stay on', async () => {
    seedRoute(db);
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x' };
    const res = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST', body: JSON.stringify(bookBody()),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.3.3.5', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(calls.length, 1, 'no coupon call for a booking with no gift card');
    assert.ok(calls[0].url.includes('/v1/checkout/sessions'));
    assert.equal(calls[0].body.get('allow_promotion_codes'), 'true');
    assert.equal(calls[0].body.get('discounts[0][coupon]'), null);

    const booking = await getBooking(db, body.booking_id);
    assert.equal(booking.gift_code, null);
    assert.equal(booking.gift_applied_cents, 0);
  });
});

// ---------------------------------------------------------------------------
// webhook.js — gift-card purchase completion + redemption side effects
// ---------------------------------------------------------------------------

describe('handleGiftCardPurchaseCompleted', () => {
  test('mints a gift card from session.metadata and emails recipient + buyer', async () => {
    const sent = [];
    const session = {
      id: 'cs_gift_purchase_1',
      currency: 'eur',
      metadata: {
        type: 'giftcard', amount_cents: '6000',
        buyer_name: 'Buyer Bea', buyer_email: 'buyer@example.com',
        recipient_name: 'Rita Recipient', recipient_email: 'rita@example.com',
        message: 'Enjoy the walk!', locale: 'en',
      },
    };
    await handleGiftCardPurchaseCompleted({ DB: db }, session, {
      database: realDb,
      sendTransactional: async (env, msg) => { sent.push(msg); },
    });
    const card = await realDb.getGiftCardByStripeSession(db, 'cs_gift_purchase_1');
    assert.ok(card);
    assert.equal(card.initial_cents, 6000);
    assert.equal(card.balance_cents, 6000);
    assert.equal(card.recipient_email, 'rita@example.com');
    assert.equal(sent.length, 2, 'recipient + buyer each get one email');
    assert.ok(sent.some((m) => m.to === 'rita@example.com'));
    assert.ok(sent.some((m) => m.to === 'buyer@example.com'));
  });

  test('a redelivered event for the SAME purchase session does not mint a second card', async () => {
    const session = {
      id: 'cs_gift_purchase_2', currency: 'eur',
      metadata: {
        type: 'giftcard', amount_cents: '3000',
        buyer_name: 'B', buyer_email: 'b@example.com',
        recipient_name: 'R', recipient_email: 'r@example.com', locale: 'en',
      },
    };
    await handleGiftCardPurchaseCompleted({ DB: db }, session, { database: realDb, sendTransactional: async () => {} });
    await handleGiftCardPurchaseCompleted({ DB: db }, session, { database: realDb, sendTransactional: async () => {} });
    const all = await realDb.listGiftCards(db);
    assert.equal(all.filter((c) => c.stripe_session === 'cs_gift_purchase_2').length, 1);
  });

  test('does NOT create a booking row', async () => {
    const session = {
      id: 'cs_gift_purchase_3', currency: 'eur',
      metadata: {
        type: 'giftcard', amount_cents: '3000',
        buyer_name: 'B', buyer_email: 'b@example.com',
        recipient_name: 'R', recipient_email: 'r@example.com', locale: 'en',
      },
    };
    await handleGiftCardPurchaseCompleted({ DB: db }, session, { database: realDb, sendTransactional: async () => {} });
    const row = db.prepare('SELECT COUNT(*) AS n FROM bookings').bind().first();
    assert.equal(row.n, 0);
  });
});

describe('applyGiftCardRedemption', () => {
  test('a successful redemption sends NO owner alert', async () => {
    const card = await seedGiftCard({ initial_cents: 3000 });
    const alerts = [];
    const booking = { id: 'b_ok', gift_code: card.code, gift_applied_cents: 1000, name: 'Anna', email: 'a@a.com', date: TODAY, slot: '18:00' };
    const result = await applyGiftCardRedemption({ DB: db }, booking, {
      database: realDb,
      sendTransactional: async (env, msg) => { alerts.push(msg); },
    });
    assert.equal(result.status, 'redeemed');
    assert.equal(alerts.length, 0);
  });

  test('an insufficient-balance redemption sends the owner an alert with the gift code + booking id', async () => {
    const card = await seedGiftCard({ initial_cents: 500 });
    const alerts = [];
    const booking = { id: 'b_short', gift_code: card.code, gift_applied_cents: 900, name: 'Anna', email: 'a@a.com', date: TODAY, slot: '18:00' };
    const result = await applyGiftCardRedemption({ DB: db }, booking, {
      database: realDb,
      sendTransactional: async (env, msg) => { alerts.push(msg); },
    });
    assert.equal(result.status, 'insufficient_balance');
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].htmlContent, /b_short/);
    assert.match(alerts[0].htmlContent, new RegExp(card.code));
  });

  test('running redemption twice for the same booking (webhook retry) only deducts once', async () => {
    const card = await seedGiftCard({ initial_cents: 3000 });
    const booking = { id: 'b_dup', gift_code: card.code, gift_applied_cents: 1000, name: 'Anna', email: 'a@a.com', date: TODAY, slot: '18:00' };
    await applyGiftCardRedemption({ DB: db }, booking, { database: realDb, sendTransactional: async () => {} });
    await applyGiftCardRedemption({ DB: db }, booking, { database: realDb, sendTransactional: async () => {} });
    const final = await realDb.getGiftCardByCode(db, card.code);
    assert.equal(final.balance_cents, 2000);
  });
});

// ---------------------------------------------------------------------------
// Router registration (src/index.js) — these two endpoints must actually be
// reachable through the real Worker fetch handler, not just exist as
// exported functions. A 404 here would mean the route was never wired up
// (exactly the bug this regression test exists to catch); a non-404 status
// proves the router found and called the handler.
// ---------------------------------------------------------------------------

describe('src/index.js — gift-card routes are registered', () => {
  const ctx = { waitUntil: () => {} };

  test('POST /api/giftcard/checkout is reachable (public route)', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/api/giftcard/checkout', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }), { DB: db }, ctx);
    assert.notEqual(res.status, 404, 'route must be registered — got 404 not_found');
    assert.equal(res.status, 400, 'empty body should fail validation, proving the real handler ran');
  });

  test('GET /admin/api/gift-cards is registered and session-guarded', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/admin/api/gift-cards'), { DB: db }, ctx);
    assert.notEqual(res.status, 404, 'route must be registered — got 404 not_found');
    assert.equal(res.status, 401, 'unauthenticated request to a guarded admin route');
  });

  test('POST /admin/api/gift-cards/:code/void is registered and session-guarded', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/admin/api/gift-cards/WOGO-0000-0000/void', {
      method: 'POST',
    }), { DB: db }, ctx);
    assert.notEqual(res.status, 404, 'route must be registered — got 404 not_found');
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: handleBook -> handleWebhook (full stack, real db)
// ---------------------------------------------------------------------------

describe('end-to-end — gift card redeemed through the full webhook confirm path', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = async (url, opts) => {
      if (String(url).includes('/v1/coupons')) return new Response(JSON.stringify({ id: 'coupon_e2e' }), { status: 200 });
      return new Response(JSON.stringify({ id: 'cs_e2e_1', url: 'https://checkout.stripe.com/e2e' }), { status: 200 });
    };
  });
  afterEach(() => { global.fetch = realFetch; });

  test('booking confirms, gift card balance deducts exactly once, discount fields stay untouched', async () => {
    seedRoute(db);
    const card = await seedGiftCard({ initial_cents: 2000 });
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };

    const bookRes = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST',
      body: JSON.stringify({
        route_id: 'testroute', date: TODAY, slot: '18:00', party: 2,
        name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
        gift_code: card.code,
      }),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.4.4.1', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(bookRes.status, 200);
    const { booking_id } = await bookRes.json();

    const sentEmails = [];
    const webhookDeps = {
      db: realDb,
      verifyStripeSignature: async () => true,
      sendTransactional: async (e, msg) => { sentEmails.push(msg); },
      sendPurchaseEvent: async () => {},
    };
    const event = {
      id: 'evt_e2e_1', type: 'checkout.session.completed',
      data: { object: { id: 'cs_e2e_1', client_reference_id: booking_id, payment_intent: 'pi_1', currency: 'eur', total_details: { amount_discount: 0 } } },
    };
    const webhookRes = await handleWebhook(new Request('https://api.example.com/webhooks/stripe', {
      method: 'POST', body: JSON.stringify(event), headers: { 'stripe-signature': 'x' },
    }), env, webhookDeps);
    assert.equal(webhookRes.status, 200);

    const booking = await getBooking(db, booking_id);
    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.discount_cents, 0, 'a gift-card redemption must never populate the PROMO discount columns');
    assert.equal(booking.discount_code, null);

    const card2 = await realDb.getGiftCardByCode(db, card.code);
    assert.equal(card2.balance_cents, 0, '2000 initial - 2000 applied (full cover) = 0');
    assert.equal(card2.status, 'depleted');

    const redemptions = await realDb.listGiftCardRedemptions(db, card.code);
    assert.equal(redemptions.length, 1);
    assert.equal(redemptions[0].booking_id, booking_id);

    // Redeliver the SAME event (Stripe retry semantics) — must be a true
    // duplicate at the event level and must NOT deduct the balance again.
    const webhookRes2 = await handleWebhook(new Request('https://api.example.com/webhooks/stripe', {
      method: 'POST', body: JSON.stringify(event), headers: { 'stripe-signature': 'x' },
    }), env, webhookDeps);
    const body2 = await webhookRes2.json();
    assert.equal(body2.duplicate, true);
    const card3 = await realDb.getGiftCardByCode(db, card.code);
    assert.equal(card3.balance_cents, 0, 'balance must not move on a duplicate event delivery');

    // Guest confirmation email shows the gift-card line.
    const guestMail = sentEmails.find((m) => m.to === 'anna@example.com');
    assert.ok(guestMail);
    assert.match(guestMail.htmlContent, new RegExp(card.code));
  });
});
