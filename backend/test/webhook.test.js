import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyStripeSignature, computeStripeSignatureHeader } from '../src/stripe.js';
import { handleWebhook } from '../src/webhook.js';

const SECRET = 'whsec_test_secret_12345';

describe('verifyStripeSignature', () => {
  test('accepts a correctly-computed fake signature', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const header = await computeStripeSignatureHeader(body, SECRET);
    const ok = await verifyStripeSignature(body, header, SECRET);
    assert.equal(ok, true);
  });

  test('rejects wrong secret', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const header = await computeStripeSignatureHeader(body, SECRET);
    await assert.rejects(() => verifyStripeSignature(body, header, 'wrong_secret'));
  });

  test('rejects tampered body', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const header = await computeStripeSignatureHeader(body, SECRET);
    const tamperedBody = JSON.stringify({ id: 'evt_2' });
    await assert.rejects(() => verifyStripeSignature(tamperedBody, header, SECRET));
  });

  test('rejects a timestamp older than tolerance', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 999999;
    const header = await computeStripeSignatureHeader(body, SECRET, oldTimestamp);
    await assert.rejects(() => verifyStripeSignature(body, header, SECRET, 300), /signature_too_old/);
  });

  test('rejects a malformed header', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    await assert.rejects(() => verifyStripeSignature(body, 'garbage', SECRET), /malformed_signature/);
    await assert.rejects(() => verifyStripeSignature(body, null, SECRET), /malformed_signature/);
  });
});

describe('handleWebhook — full flow with mocked db/stripe/brevo/meta', () => {
  function makeFakeDb(overrides = {}) {
    const events = new Map(); // id -> 'processing' | 'done'
    const brevoLog = [];
    return {
      // Claim/finish pair (migrations/0009, owner audit item #7) — mirrors
      // db.js:beginWebhookProcessing/finishWebhookProcessing exactly, so
      // these tests exercise the real ordering contract webhook.js relies on.
      beginWebhookProcessing: async (_dbBinding, id) => {
        const status = events.get(id);
        if (status === 'done') return 'duplicate';
        const claim = status === 'processing' ? 'retry' : 'new';
        events.set(id, 'processing');
        return claim;
      },
      finishWebhookProcessing: async (_dbBinding, id) => {
        events.set(id, 'done');
      },
      queueFailedEmail: overrides.queueFailedEmail || (async () => {}),
      confirmBooking: overrides.confirmBooking || (async () => ({
        status: 'confirmed',
        booking: {
          id: 'b_1', route_id: 'amsterdam', date: '2026-08-06', slot: '18:00',
          party: 2, name: 'Anna', email: 'anna@example.com', phone: '+31600000000',
        },
      })),
      getRoute: overrides.getRoute || (async () => ({
        id: 'amsterdam', name: 'WOGO Cocktail Walk Amsterdam', price_cents: 2995, map_url: 'https://maps.example.com/x',
      })),
      listBars: overrides.listBars || (async () => []),
      // Per-weekday bar sets (migrations/0015): webhook.js's notifyBars now
      // resolves via listBarsForDate rather than listBars — mirror it here
      // the same way listBars itself is mirrored, so this fixture keeps
      // exercising the real call shape production uses.
      listBarsForDate: overrides.listBarsForDate || (async () => (overrides.listBars ? overrides.listBars() : [])),
      listOverridesForDate: overrides.listOverridesForDate || (async () => []),
      cancelIfHold: overrides.cancelIfHold || (async () => true),
      _brevoLog: brevoLog,
    };
  }

  async function fakeSig() {
    return 't=9999999999,v1=irrelevant'; // verifyStripeSignature is mocked out below
  }

  test('duplicate event.id short-circuits before any side effect runs', async () => {
    const brevoLog = [];
    const fakeDb = makeFakeDb();
    let confirmBookingCalls = 0;
    fakeDb.confirmBooking = async () => {
      confirmBookingCalls++;
      return { status: 'confirmed', booking: { id: 'b_1', route_id: 'amsterdam', date: '2026-08-06', slot: '18:00', party: 2, name: 'Anna', email: 'a@a.com' } };
    };

    const body = JSON.stringify({ id: 'evt_dup', type: 'checkout.session.completed', data: { object: { client_reference_id: 'b_1', id: 'cs_1' } } });
    const request = new Request('https://api.example.com/webhooks/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': 'whatever' },
    });
    const env = { DB: {}, STRIPE_WEBHOOK_SECRET: SECRET };

    const deps = {
      db: fakeDb,
      verifyStripeSignature: async () => true, // signature check mocked; tested separately above
      sendTransactional: async () => { brevoLog.push('sent'); },
      sendPurchaseEvent: async () => {},
    };

    // first call — processes normally
    const res1 = await handleWebhook(request.clone(), env, deps);
    assert.equal(res1.status, 200);
    assert.equal(confirmBookingCalls, 1);
    assert.ok(brevoLog.length > 0, 'first call should send emails');

    // second call, same event id — must short-circuit before confirmBooking runs again
    const brevoLogBefore = brevoLog.length;
    const res2 = await handleWebhook(request.clone(), env, deps);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.duplicate, true);
    assert.equal(confirmBookingCalls, 1, 'confirmBooking must NOT run again on duplicate');
    assert.equal(brevoLog.length, brevoLogBefore, 'no new side effects on duplicate');
  });

  test('a booking write that throws is NEVER marked done, so Stripe redelivery retries it (owner audit item #7)', async () => {
    const fakeDb = makeFakeDb();
    let confirmBookingCalls = 0;
    fakeDb.confirmBooking = async () => {
      confirmBookingCalls++;
      if (confirmBookingCalls === 1) throw new Error('transient D1 error');
      return { status: 'confirmed', booking: { id: 'b_1', route_id: 'amsterdam', date: '2026-08-06', slot: '18:00', party: 2, name: 'Anna', email: 'a@a.com' } };
    };

    const body = JSON.stringify({ id: 'evt_retry', type: 'checkout.session.completed', data: { object: { client_reference_id: 'b_1', id: 'cs_1' } } });
    const request = new Request('https://api.example.com/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': 'x' } });
    const env = { DB: {}, STRIPE_WEBHOOK_SECRET: SECRET };
    const deps = {
      db: fakeDb,
      verifyStripeSignature: async () => true,
      sendTransactional: async () => {},
      sendPurchaseEvent: async () => {},
    };

    // First delivery: the write throws — handleWebhook must propagate (never
    // silently swallow it into a 200), and the event must NOT be marked done.
    await assert.rejects(() => handleWebhook(request.clone(), env, deps), /transient D1 error/);
    assert.equal(confirmBookingCalls, 1);

    // Stripe redelivers the SAME event — must be treated as a retry (proceed
    // and re-attempt the write), NOT a duplicate (which would silently no-op
    // and lose the booking forever).
    const res2 = await handleWebhook(request.clone(), env, deps);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.duplicate, undefined, 'a retried-after-failure event must not be treated as a duplicate');
    assert.equal(confirmBookingCalls, 2, 'the write is retried, not skipped');

    // A THIRD delivery of the same event, now that it succeeded, must be a
    // true duplicate — the write must not run a third time.
    const res3 = await handleWebhook(request.clone(), env, deps);
    const body3 = await res3.json();
    assert.equal(body3.duplicate, true);
    assert.equal(confirmBookingCalls, 2, 'a truly-done event never re-runs the write');
  });

  test('invalid signature returns 400 and never touches the db', async () => {
    const fakeDb = makeFakeDb();
    let dbTouched = false;
    fakeDb.beginWebhookProcessing = async () => { dbTouched = true; return 'new'; };

    const body = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } });
    const request = new Request('https://api.example.com/webhooks/stripe', {
      method: 'POST', body, headers: { 'stripe-signature': 'bad' },
    });
    const env = { DB: {}, STRIPE_WEBHOOK_SECRET: SECRET };
    const deps = {
      db: fakeDb,
      verifyStripeSignature: async () => { throw new Error('signature_mismatch'); },
    };

    const res = await handleWebhook(request, env, deps);
    assert.equal(res.status, 400);
    assert.equal(dbTouched, false);
  });

  test('checkout.session.completed sends ONE guest email (confirmation incl. route map), owner, and bar emails', async () => {
    const sent = [];
    const fakeDb = makeFakeDb({
      listBars: async () => [
        { ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com', minutes_offset: 0 },
        { ord: 2, bar_name: 'Bar B', bar_email: 'barb@example.com', minutes_offset: 75 },
      ],
    });
    const body = JSON.stringify({
      id: 'evt_ok', type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'b_1', id: 'cs_1', payment_intent: 'pi_1' } },
    });
    const request = new Request('https://api.example.com/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': 'x' } });
    const env = { DB: {}, STRIPE_WEBHOOK_SECRET: SECRET };
    const deps = {
      db: fakeDb,
      verifyStripeSignature: async () => true,
      sendTransactional: async (env2, opts) => { sent.push(opts); },
      sendPurchaseEvent: async () => {},
    };

    const res = await handleWebhook(request, env, deps);
    assert.equal(res.status, 200);

    const toAddresses = sent.map((s) => s.to);
    assert.ok(toAddresses.includes('anna@example.com'), 'guest gets the confirmation');
    assert.ok(toAddresses.includes('bara@example.com'));
    assert.ok(toAddresses.includes('barb@example.com'));
    assert.ok(toAddresses.includes('info@wogoamsterdam.com'), 'owner gets a "new booking" notification too');
    // 1 guest confirmation (incl. route map — no separate map email anymore)
    // + 1 owner notification + 2 bars = 4 emails
    assert.equal(sent.length, 4);

    // the single guest email carries the route-map link inside it
    const guestEmails = sent.filter((s) => s.to === 'anna@example.com');
    assert.equal(guestEmails.length, 1, 'exactly ONE guest email — map is merged into the confirmation');
    assert.ok(guestEmails[0].htmlContent.includes('https://maps.example.com/x'), 'confirmation contains the route-map link');

    // each bar email carries the guest's direct contact details
    const barEmail = sent.find((s) => s.to === 'bara@example.com');
    assert.ok(barEmail.htmlContent.includes('anna@example.com'), 'bar email shows guest email');
    assert.ok(barEmail.htmlContent.includes('+31600000000'), 'bar email shows guest phone');
  });

  test('one failing side-effect email does not block the others or fail the webhook ack', async () => {
    const sent = [];
    const fakeDb = makeFakeDb({
      listBars: async () => [{ ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com', minutes_offset: 0 }],
    });
    const body = JSON.stringify({
      id: 'evt_partial_fail', type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'b_1', id: 'cs_1' } },
    });
    const request = new Request('https://api.example.com/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': 'x' } });
    const env = { DB: {}, STRIPE_WEBHOOK_SECRET: SECRET };
    const deps = {
      db: fakeDb,
      verifyStripeSignature: async () => true,
      sendTransactional: async (env2, opts) => {
        // Simulate the guest-confirmation send failing (identifiable by its
        // subject since the "templateId" concept no longer exists
        // post-Dashboard-v2 — emails are owned HTML rendered by
        // src/emails.js, not Brevo templates).
        if (opts.subject.includes("You're booked")) throw new Error('brevo down');
        sent.push(opts);
      },
      sendPurchaseEvent: async () => {},
    };

    const res = await handleWebhook(request, env, deps);
    assert.equal(res.status, 200, 'webhook must still ack 200 even if a send fails');
    assert.ok(!sent.some((s) => s.to === 'anna@example.com'), 'the guest confirmation is the send that failed');
    assert.ok(sent.some((s) => s.to === 'info@wogoamsterdam.com'), 'owner notification still sent');
    assert.ok(sent.some((s) => s.to === 'bara@example.com'), 'bar email still sent despite the guest confirmation failing');
  });

  test('checkout.session.expired cancels a still-held booking', async () => {
    let cancelledId = null;
    const fakeDb = makeFakeDb({
      cancelIfHold: async (_db, id) => { cancelledId = id; return true; },
    });
    const body = JSON.stringify({
      id: 'evt_expired', type: 'checkout.session.expired',
      data: { object: { client_reference_id: 'b_2', id: 'cs_2' } },
    });
    const request = new Request('https://api.example.com/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': 'x' } });
    const env = { DB: {}, STRIPE_WEBHOOK_SECRET: SECRET };
    const deps = { db: fakeDb, verifyStripeSignature: async () => true };

    const res = await handleWebhook(request, env, deps);
    assert.equal(res.status, 200);
    assert.equal(cancelledId, 'b_2');
  });

  test('unknown event types are ignored but still ack 200', async () => {
    const fakeDb = makeFakeDb();
    const body = JSON.stringify({ id: 'evt_unknown', type: 'customer.created', data: { object: {} } });
    const request = new Request('https://api.example.com/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': 'x' } });
    const env = { DB: {}, STRIPE_WEBHOOK_SECRET: SECRET };
    const deps = { db: fakeDb, verifyStripeSignature: async () => true };

    const res = await handleWebhook(request, env, deps);
    assert.equal(res.status, 200);
  });
});
