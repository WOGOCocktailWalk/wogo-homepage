// A guest pays for seats that are no longer free what the
// webhook does. Fake db / fake mail — nothing real is sent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleWebhook } from '../src/webhook.js';
import { renderGuestPaymentSlotFull } from '../src/emails.js';
import { OWNER_ALERT_EMAIL } from '../src/config.js';

// No real network, ever: anything that tries fetch() gets a stubbed 401.
globalThis.fetch = async () => new Response('{}', { status: 401 });

const BOOKING = {
  id: 'b_late', route_id: 'amsterdam', date: '2026-08-06', slot: '18:00',
  party: 2, name: 'Anna de Vries', email: 'anna@example.com', phone: '+31600000000', locale: 'en',
};
const ROUTE = { id: 'amsterdam', name: 'WOGO Cocktail Walk Amsterdam', city: 'Amsterdam', price_cents: 2995, map_url: 'https://maps.example.com/x' };

function setup({ status = 'confirmed_conflict', booking = BOOKING, failMail = false } = {}) {
  const calls = { mails: [], notifications: [], barLookups: 0, metaEvents: 0, giftRedeems: 0 };
  const events = new Map();
  const fakeDb = {
    beginWebhookProcessing: async (_d, id) => { const s = events.get(id); if (s === 'done') return 'duplicate'; events.set(id, 'processing'); return s ? 'retry' : 'new'; },
    finishWebhookProcessing: async (_d, id) => { events.set(id, 'done'); },
    queueFailedEmail: async () => {},
    confirmBooking: async () => ({ status, booking: { ...booking } }),
    getRoute: async () => ROUTE,
    listBarsForDate: async () => { calls.barLookups++; return [{ ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com', minutes_offset: 0 }]; },
    listOverridesForDate: async () => [],
    getAddonsForBooking: async () => [],
    createNotification: async (_d, n) => { calls.notifications.push(n); },
    listAllPushSubscriptions: async () => [],
    setBookingDiscount: async () => {},
  };
  const body = JSON.stringify({ id: `evt_${Math.random()}`, type: 'checkout.session.completed', data: { object: { client_reference_id: booking.id, id: 'cs_1', payment_intent: 'pi_1' } } });
  const request = () => new Request('https://api.example.com/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': 'x' } });
  const deps = {
    db: fakeDb,
    verifyStripeSignature: async () => true,
    sendTransactional: async (_e, opts) => { if (failMail) throw new Error('brevo down'); calls.mails.push(opts); },
    sendPurchaseEvent: async () => { calls.metaEvents++; },
  };
  return { calls, run: () => handleWebhook(request(), { DB: {}, STRIPE_WEBHOOK_SECRET: 's' }, deps) };
}

describe('payment arrives for seats that are gone', () => {
  test('owner gets email + push, guest gets NO automatic mail (owner contacts them), bars get NOTHING, no Meta purchase', async () => {
    const { calls, run } = setup();
    const res = await run();
    assert.equal(res.status, 200);

    const to = calls.mails.map((m) => m.to);
    assert.ok(!to.includes('anna@example.com'), 'no automatic mail to the guest (owner decision 18 Nov 2026)');
    assert.ok(to.includes(OWNER_ALERT_EMAIL), 'owner gets the alert email');
    assert.ok(!to.includes('bara@example.com'), 'bars are NOT told about this booking');
    assert.equal(calls.barLookups, 0, 'bars are not even looked up');
    assert.equal(calls.mails.length, 1, 'only the owner alert');
    assert.equal(calls.metaEvents, 0, 'not counted as a sale in Meta');

    assert.ok(!calls.mails.some((m) => /you['’]re booked/i.test(m.subject)), 'nobody gets a normal confirmation');

    assert.equal(calls.notifications.length, 1, 'owner push notification row created');
    assert.equal(calls.notifications[0].kind, 'booking_conflict');
    assert.equal(calls.notifications[0].booking_id, 'b_late');
  });

  test('owner push still happens when every email fails (Brevo down)', async () => {
    const { calls, run } = setup({ failMail: true });
    const res = await run();
    assert.equal(res.status, 200, 'webhook still acks — the payment must not be retried into a storm');
    assert.equal(calls.notifications.length, 1);
    assert.equal(calls.notifications[0].kind, 'booking_conflict');
  });

  test('a normal confirmed booking is unchanged: bars mailed, no conflict push', async () => {
    const { calls, run } = setup({ status: 'confirmed' });
    await run();
    const to = calls.mails.map((m) => m.to);
    assert.ok(to.includes('bara@example.com'));
    assert.ok(calls.notifications.every((n) => n.kind !== 'booking_conflict'));
  });

  test('the owner alert never promises or performs a refund automatically', async () => {
    const { calls, run } = setup();
    await run();
    const owner = calls.mails.find((m) => m.to === OWNER_ALERT_EMAIL);
    assert.ok(/not been refunded|Nothing has been refunded/i.test(owner.htmlContent));
    assert.ok(!calls.mails.some((m) => m.to !== OWNER_ALERT_EMAIL && /refund/i.test(m.htmlContent)));
  });
});

describe('renderGuestPaymentSlotFull', () => {
  const FORBIDDEN = /refund|cancel|terugbetal|restitu|annuler|geannuleerd|annulering|you['’]re booked|bevestigd/i;

  test('EN: warm, short, names the time, promises a personal reply within one working day, no money words', () => {
    const m = renderGuestPaymentSlotFull(BOOKING, ROUTE, { locale: 'en' });
    assert.ok(/payment/i.test(m.subject));
    assert.ok(m.html.includes('within one working day'));
    assert.ok(m.html.includes('18:00'));
    assert.ok(m.html.includes('Anna'));
    assert.ok(!FORBIDDEN.test(m.subject + m.html), 'no refund/cancel/confirmation wording');
  });

  test('NL: used when the booking locale is nl, same rules', () => {
    const m = renderGuestPaymentSlotFull({ ...BOOKING, locale: 'nl' }, ROUTE);
    assert.ok(/betaling/i.test(m.subject));
    assert.ok(m.html.includes('binnen één werkdag'));
    assert.ok(!FORBIDDEN.test(m.subject + m.html));
  });

  test('guest-supplied name is escaped', () => {
    const m = renderGuestPaymentSlotFull({ ...BOOKING, name: '<script>x</script>' }, ROUTE);
    assert.ok(!m.html.includes('<script>x'));
  });

  test('an NL booking: still no automatic guest mail through the webhook', async () => {
    const { calls, run } = setup({ booking: { ...BOOKING, locale: 'nl' } });
    await run();
    assert.ok(!calls.mails.some((m) => m.to === 'anna@example.com'));
  });
});
