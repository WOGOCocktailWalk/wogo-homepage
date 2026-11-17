// test/privacy_tools.test.js — export / erase one person: summary and file,
// field-by-field erase, shared anonymisation, future-walk guard, typed
// confirmation, audit without the clear email, role checks.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, rows, sql, addBooking } from './data_tools_helpers.js';
import worker from '../src/index.js';
import { ROUTE_ROLES } from '../src/admin_api.js';
import { cleanPersonEmail } from '../src/privacy_tools.js';
import { createSessionCookieValue, COOKIE_NAME } from '../src/auth.js';

const PERSON = 'anna.test@example.com';
const OTHER = 'ben.other@example.com';
let testDb, env;

beforeEach(() => {
  testDb = freshDb();
  env = { DB: testDb, ADMIN_SESSION_SECRET: 's3cret', ENVIRONMENT: 'production' };
  sql(testDb, `INSERT INTO routes (id, name, city, price_cents, open_days, slots) VALUES ('r1', 'Test Route', 'Amsterdam', 3000, '[1]', '["18:00"]')`);
});

async function call(path, body, role = 'owner') {
  const value = await createSessionCookieValue('s3cret', { uid: null, role, email: 'owner@example.com' });
  return worker.fetch(new Request('https://worker.example.com' + path, {
    method: 'POST',
    headers: { Cookie: `${COOKIE_NAME}=${value}`, 'X-Requested-With': 'wogo-admin', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} });
}

function seed() {
  addBooking(testDb, { id: 'bk_old', email: 'Anna.Test@Example.com', name: 'Anna', notes: 'nuts', addon_notes: 'vegan', utm_source: 'ig', date: '2020-05-01', discount_cents: 300, stripe_payment_intent: 'pi_1' });
  addBooking(testDb, { id: 'bk_other', email: OTHER, name: 'Ben', addon_notes: 'keep' });
  sql(testDb, `INSERT INTO gift_cards (id, code, initial_cents, balance_cents, buyer_email, buyer_name, recipient_name, recipient_email, message, status)
               VALUES ('gc1', 'WOGO-AAAA-BBBB', 5000, 2000, ?, 'Anna', 'Ben', ?, 'Happy birthday Ben', 'active'),
                      ('gc2', 'WOGO-CCCC-DDDD', 3000, 3000, ?, 'Ben', 'Anna', ?, 'For Anna', 'active'),
                      ('gc3', 'WOGO-EEEE-FFFF', 1000, 0, ?, 'Ben', 'Cleo', 'cleo@example.com', 'x', 'depleted'),
                      ('gc4', 'WOGO-GGGG-HHHH', 1000, 1000, ?, 'Anna', 'Print', '', 'x', 'active')`, PERSON, OTHER, OTHER, PERSON, OTHER, PERSON);
  sql(testDb, `INSERT INTO gift_card_redemptions (id, gift_card_code, booking_id, amount_cents) VALUES ('gcr1', 'WOGO-AAAA-BBBB', 'bk_old', 3000)`);
  sql(testDb, `INSERT INTO inquiries (id, kind, name, email, phone, message) VALUES
     ('i1', 'contact', 'Anna', ?, '+31600000001', 'question'),
     ('i2', 'contact', 'Anna', ?, NULL, '[Utrecht waitlist]

Added by hand'),
     ('i3', 'contact', 'Ben', ?, NULL, 'other'),
     ('i4', 'contact', 'Phone Only', '', '+31600000002', 'no email')`, PERSON.toUpperCase(), PERSON, OTHER);
  sql(testDb, `INSERT INTO subscribers (id, email, first_name, source, status, unsubscribe_token, confirm_token) VALUES
     ('s1', ?, 'Anna', 'footer', 'confirmed', 'unsub-secret', 'confirm-secret'), ('s2', ?, 'Ben', 'footer', 'confirmed', 'u2', 'c2')`, PERSON, OTHER);
  sql(testDb, `INSERT INTO reminder_optouts (email_lower) VALUES (?)`, PERSON);
  sql(testDb, `INSERT INTO brevo_sync_queue (kind, payload, status) VALUES
     ('contact_upsert', ?, 'pending'), ('contact_upsert', ?, 'done'), ('contact_upsert', ?, 'pending')`,
    JSON.stringify({ email: 'Anna.Test@example.com' }), JSON.stringify({ email: 'joanna.test@example.com' }), JSON.stringify({ email: OTHER }));
  sql(testDb, `INSERT INTO failed_email (to_email, subject, html_content, kind) VALUES
     (?, 'Your booking', '<p>Hi Anna</p>', 'guest_confirmation'),
     ('owner@example.com', 'New booking', ?, 'owner_notification'),
     ('owner@example.com', 'Unrelated', '<p>nothing</p>', 'owner_notification')`, PERSON, `<p>Booking by ${PERSON}</p>`);
}

describe('cleanPersonEmail', () => {
  test('trims and lower-cases; refuses empty, malformed and placeholder addresses', () => {
    assert.equal(cleanPersonEmail('  Anna@Example.com '), 'anna@example.com');
    for (const bad of ['', '   ', null, undefined, 'nope', 'a@b', 'x@wogoamsterdam.invalid', 'a"b@example.com']) assert.equal(cleanPersonEmail(bad), null, String(bad));
  });
});

describe('export', () => {
  test('summary counts and one downloadable file, matching case-insensitively, other people excluded, tokens left out', async () => {
    seed();
    const res = await call('/admin/api/privacy/export', { email: ' ANNA.TEST@example.com ' });
    assert.equal(res.status, 200);
    const out = await res.json();
    const s = out.summary;
    assert.equal(s.bookings, 1);
    assert.equal(s.gift_cards_bought, 2);
    assert.equal(s.gift_cards_received, 1);
    assert.equal(s.gift_cards_total, 3);
    assert.equal(s.waiting_list_entries, 1);
    assert.equal(s.enquiries, 1);
    assert.equal(s.newsletter, 'confirmed');
    assert.equal(s.reminder_opt_out, true);
    assert.equal(s.queued_sync_items, 1);
    assert.equal(s.queued_mail_copies, 2);
    assert.equal(out.empty, false);
    const text = JSON.stringify(out.export);
    assert.ok(!text.includes('unsub-secret') && !text.includes('confirm-secret'));
    assert.ok(!text.includes('ben.other@example.com') || out.export.gift_cards.some((g) => g.buyer_email === OTHER), 'other person only appears as the other side of a shared gift card');
    assert.equal(out.export.bookings[0].notes, 'nuts');
    assert.equal(out.export.bookings[0].route_name, 'Test Route');
    assert.equal(out.export.gift_card_redemptions.length, 1);
    assert.ok(!('ip' in out.export.bookings[0]));
  });

  test('an unknown address gives an empty summary, not an error', async () => {
    const out = await (await call('/admin/api/privacy/export', { email: 'nobody@example.com' })).json();
    assert.equal(out.empty, true);
  });

  test('is audited with a reference, not the address', async () => {
    seed();
    await call('/admin/api/privacy/export', { email: PERSON });
    const [a] = rows(testDb, `SELECT * FROM admin_audit WHERE action = 'privacy.export'`);
    assert.ok(a && !JSON.stringify(a).toLowerCase().includes('anna'));
  });
});

describe('erase', () => {
  test('needs the typed word', async () => {
    seed();
    for (const confirm of [undefined, '', 'erase', 'yes']) {
      assert.equal((await call('/admin/api/privacy/erase', { email: PERSON, confirm })).status, 400);
    }
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM subscribers WHERE email = ?`, PERSON)[0].n, 1);
  });

  test('field by field: anonymises bookings, cleans gift cards, deletes the rest, leaves other people alone', async () => {
    seed();
    const res = await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.done.bookings_anonymised, 1);
    assert.equal(out.done.gift_cards_cleaned, 3);
    assert.equal(out.done.enquiries_and_waiting_list_deleted, 2);
    assert.equal(out.done.newsletter_subscription_deleted, 1);
    assert.equal(out.done.queued_sync_items_deleted, 1);
    assert.equal(out.done.queued_mail_copies_deleted, 2);
    assert.equal(out.audit_logged, true);
    assert.ok(out.do_by_hand.some((t) => /Stripe/.test(t)) && out.do_by_hand.some((t) => /Brevo/.test(t)) && out.do_by_hand.some((t) => /60 days/.test(t)) && out.do_by_hand.some((t) => /Gmail/.test(t)));
    assert.ok(out.kept.length > 0);
    assert.deepEqual(out.gift_cards_with_balance.map((g) => g.code).sort(), ['WOGO-AAAA-BBBB', 'WOGO-CCCC-DDDD', 'WOGO-GGGG-HHHH']);

    const [b] = rows(testDb, `SELECT * FROM bookings WHERE id = 'bk_old'`);
    assert.equal(b.name, '[deleted]');
    assert.equal(b.email, 'deleted-bk_old@wogoamsterdam.invalid');
    for (const c of ['phone', 'notes', 'addon_notes', 'utm_source']) assert.equal(b[c], null, c);
    assert.equal(b.date, '2020-05-01');
    assert.equal(b.discount_cents, 300);
    assert.equal(b.stripe_payment_intent, 'pi_1');

    const gc = Object.fromEntries(rows(testDb, 'SELECT * FROM gift_cards').map((g) => [g.id, g]));
    assert.equal(gc.gc1.buyer_name, '[deleted]');
    assert.match(gc.gc1.buyer_email, /@wogoamsterdam\.invalid$/);
    assert.equal(gc.gc1.message, null);
    assert.equal(gc.gc1.recipient_name, 'Ben');           // the other person's side stays
    assert.equal(gc.gc1.balance_cents, 2000);              // balance and code keep working
    assert.equal(gc.gc2.recipient_name, '[deleted]');
    assert.equal(gc.gc2.buyer_email, OTHER);
    assert.equal(gc.gc4.buyer_name, '[deleted]');
    assert.equal(gc.gc4.recipient_name, 'Print');
    assert.equal(gc.gc3.message, 'x');                     // unrelated card untouched
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM gift_card_redemptions`)[0].n, 1);

    assert.deepEqual(rows(testDb, 'SELECT id FROM inquiries ORDER BY id').map((r) => r.id), ['i3', 'i4']);
    assert.deepEqual(rows(testDb, 'SELECT id FROM subscribers').map((r) => r.id), ['s2']);
    assert.equal(rows(testDb, 'SELECT COUNT(*) AS n FROM reminder_optouts')[0].n, 1, 'opt-out kept on purpose');
    // exact match only: joanna.test@... and the other person's queue row survive
    assert.equal(rows(testDb, 'SELECT COUNT(*) AS n FROM brevo_sync_queue')[0].n, 2);
    assert.deepEqual(rows(testDb, 'SELECT subject FROM failed_email').map((r) => r.subject), ['Unrelated']);
    // the other person's booking is untouched
    const [o] = rows(testDb, `SELECT * FROM bookings WHERE id = 'bk_other'`);
    assert.equal(o.name, 'Ben');
    assert.equal(o.addon_notes, 'keep');
  });

  test('audit row exists, carries counts and a reference, never the clear email', async () => {
    seed();
    const out = await (await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' })).json();
    const [a] = rows(testDb, `SELECT * FROM admin_audit WHERE action = 'privacy.erase'`);
    assert.equal(a.entity_id, out.reference);
    assert.equal(a.actor, 'owner@example.com');
    assert.ok(!JSON.stringify(a).toLowerCase().includes('anna'));
    assert.equal(JSON.parse(a.detail).bookings_anonymised, 1);
  });

  test('erasing twice is harmless and the second report says zero', async () => {
    seed();
    await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' });
    const out = await (await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' })).json();
    assert.equal(out.done.bookings_anonymised, 0);
    assert.equal(out.done.newsletter_subscription_deleted, 0);
  });

  test('refuses an empty or placeholder address, so phone-only rows can never be wiped', async () => {
    seed();
    for (const email of ['', 'x@wogoamsterdam.invalid']) {
      assert.equal((await call('/admin/api/privacy/erase', { email, confirm: 'ERASE' })).status, 400);
    }
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM inquiries WHERE id = 'i4'`)[0].n, 1);
  });
});

describe('walks that have not happened yet', () => {
  function future(offsetDays, status = 'confirmed', extra = {}) {
    const d = new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);
    return addBooking(testDb, { id: `bk_f${offsetDays}${status}`, email: PERSON, name: 'Anna', date: d, status, ...extra });
  }

  test('erase is blocked with a 409 and the list of walks; nothing at all is changed', async () => {
    seed();
    future(10);
    const res = await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' });
    assert.equal(res.status, 409);
    const out = await res.json();
    assert.equal(out.error, 'future_bookings');
    assert.equal(out.upcoming_walks.length, 1);
    assert.equal(rows(testDb, `SELECT name FROM bookings WHERE id = 'bk_old'`)[0].name, 'Anna');
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM subscribers WHERE email = ?`, PERSON)[0].n, 1);
  });

  test('the export summary lists the upcoming walks', async () => {
    seed(); future(3);
    const out = await (await call('/admin/api/privacy/export', { email: PERSON })).json();
    assert.equal(out.summary.upcoming_walks.length, 1);
  });

  test('with include_future true the upcoming booking is erased too', async () => {
    seed(); future(10);
    const res = await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE', include_future: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).done.bookings_anonymised, 2);
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM bookings WHERE LOWER(email) = ?`, PERSON)[0].n, 0);
  });

  test('a cancelled future booking and a past walk do not block', async () => {
    seed(); future(10, 'cancelled'); future(-5);
    assert.equal((await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' })).status, 200);
  });

  test('an unexpired hold blocks; an expired hold does not', async () => {
    seed();
    future(4, 'hold', { hold_expires: new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' ') });
    assert.equal((await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' })).status, 200);
    seed2();
    function seed2() {
      addBooking(testDb, { id: 'bk_live_hold', email: PERSON, name: 'Anna', date: new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10), status: 'hold', hold_expires: new Date(Date.now() + 3600e3).toISOString().slice(0, 19).replace('T', ' ') });
    }
    assert.equal((await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' })).status, 409);
  });

  test("today's walk counts as not happened yet", async () => {
    seed(); future(0);
    assert.equal((await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' })).status, 409);
  });
});

describe('roles', () => {
  test('both routes are owner-only in the table', () => {
    assert.equal(ROUTE_ROLES['POST /admin/api/privacy/export'], 'owner');
    assert.equal(ROUTE_ROLES['POST /admin/api/privacy/erase'], 'owner');
  });
  test('staff and viewer get 403 and nothing is read or changed', async () => {
    seed();
    for (const role of ['staff', 'viewer']) {
      assert.equal((await call('/admin/api/privacy/export', { email: PERSON }, role)).status, 403);
      assert.equal((await call('/admin/api/privacy/erase', { email: PERSON, confirm: 'ERASE' }, role)).status, 403);
    }
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM subscribers WHERE email = ?`, PERSON)[0].n, 1);
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM admin_audit WHERE action LIKE 'privacy.%'`)[0].n, 0);
  });
  test('without a session: 401', async () => {
    const res = await worker.fetch(new Request('https://worker.example.com/admin/api/privacy/erase', { method: 'POST', headers: { 'X-Requested-With': 'wogo-admin' }, body: '{}' }), env, { waitUntil() {} });
    assert.equal(res.status, 401);
  });
});
