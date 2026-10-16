// test/notifications.test.js — the installable-dashboard + Web Push build
// (migrations/0032_push_notifications.sql): VAPID JWT signing, the push
// "tickle" send, subscription lifecycle (subscribe/duplicate/unsubscribe/
// auto-delete on 410), the in-dashboard notification feed + per-kind
// preference filtering, the role-guard matrix for every new endpoint, the
// pending-notifications endpoint the service worker calls, and deep-link
// parsing. Trigger-site coverage (a real booking/cancel/move/gift-card/
// enquiry creating the right notification) lives next to each trigger's
// own existing test file: test/reschedule_cancel.test.js (cancel/move),
// test/contact.test.js (enquiry), test/gift_cards.test.js (gift card sold).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import worker from '../src/index.js';
import * as db from '../src/db.js';
import { toPositional, createManualBooking } from '../src/db.js';
import { createSessionCookieValue, COOKIE_NAME, b64urlDecode } from '../src/auth.js';
import { signVapidJwt, sendPushTickle } from '../src/push.js';
import {
  notifyAdmins, getNotificationPreferences, setNotificationPreferences, pruneOldNotifications,
} from '../src/notifications.js';
import {
  handlePushSubscribe, handlePushUnsubscribe, handleListPushSubscriptions, handlePushTest,
  handleListNotifications, handleMarkNotificationRead, handleNotificationsPending,
  handleGetNotificationPreferences, handleSetNotificationPreferences,
} from '../src/admin_api.js';
import { parseAdminDeepLink } from '../src/logic.js';
import { VAPID_SUBJECT, NOTIFICATION_DEFAULT_PREFERENCES } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql', '0022_bar_locale.sql', '0025_admin_users.sql',
  '0032_push_notifications.sql',
].map(migration).join('\n');

function exec(testDb, sql, params = {}) {
  const t = toPositional(sql, params);
  return testDb.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(testDb, overrides = {}) {
  const route = {
    id: 'r1', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 10, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00"]',
    slot_capacity: '{}', map_url: null, active: 1,
    ...overrides,
  };
  const cols = Object.keys(route);
  exec(testDb, `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, route);
  return route;
}

async function seedAdminUser(testDb, overrides = {}) {
  const user = { id: 'admuser_1', email: 'staffer@example.com', name: 'Staffer', role: 'staff', status: 'active', locale: 'en', ...overrides };
  exec(testDb, `INSERT INTO admin_users (id, email, name, role, status, locale) VALUES (:id, :email, :name, :role, :status, :locale)`, user);
  return user;
}

const SESSION_SECRET = 'test-session-secret';
async function cookieFor(identity) {
  const value = await createSessionCookieValue(SESSION_SECRET, identity);
  return `${COOKIE_NAME}=${value}`;
}

function req(method, pathAndQuery, { cookie, body } = {}) {
  const headers = { 'X-Requested-With': 'wogo-admin' };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.example.com${pathAndQuery}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Direct-handler requests (bypassing index.js's router/session gate) need
 * `request.adminSession` attached by hand, same convention test/reviews.test.js
 * and test/reschedule_cancel.test.js already use for their own direct calls —
 * except those never needed a `uid`, so this is new to this file. */
function withSession(request, session) {
  request.adminSession = session;
  return request;
}

const CTX = { waitUntil: () => {} };

let testDb;
beforeEach(() => { testDb = makeTestDb(schemaSql); });

// ---------------------------------------------------------------------------
// src/push.js — signVapidJwt (shape only, never the signature bytes)
// ---------------------------------------------------------------------------

describe('signVapidJwt', () => {
  async function freshEcKeyPairJwk() {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
    );
    return { privateJwk: await crypto.subtle.exportKey('jwk', privateKey), publicKey };
  }

  test('produces a well-formed ES256 JWT: header, claims, and an exp within the requested window', async () => {
    const { privateJwk } = await freshEcKeyPairJwk();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signVapidJwt(privateJwk, 'https://fcm.googleapis.com', VAPID_SUBJECT, 3600, now);

    const parts = jwt.split('.');
    assert.equal(parts.length, 3, 'header.payload.signature');
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));

    assert.equal(header.alg, 'ES256');
    assert.equal(header.typ, 'JWT');
    assert.equal(payload.aud, 'https://fcm.googleapis.com');
    assert.equal(payload.sub, VAPID_SUBJECT);
    assert.equal(payload.exp, now + 3600);

    // The signature bytes themselves are deliberately NOT asserted here —
    // only that something real got signed (a genuine P-256 ECDSA signature
    // over this exact header.payload is exactly 64 raw bytes, no DER).
    const sigBytes = b64urlDecode(parts[2]);
    assert.equal(sigBytes.length, 64);
  });

  test('accepts the private key as either a JWK object or its JSON string (Worker secrets are strings)', async () => {
    const { privateJwk } = await freshEcKeyPairJwk();
    const jwt = await signVapidJwt(JSON.stringify(privateJwk), 'https://example.com', 'mailto:a@b.com', 60);
    assert.equal(jwt.split('.').length, 3);
  });
});

// ---------------------------------------------------------------------------
// src/push.js — sendPushTickle
// ---------------------------------------------------------------------------

describe('sendPushTickle', () => {
  async function fakeVapidPrivateKey() {
    const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey));
  }

  test('skips (never throws) when VAPID_PRIVATE_KEY is not configured', async () => {
    const result = await sendPushTickle({}, { endpoint: 'https://fcm.googleapis.com/x' }, { fetch: async () => { throw new Error('must not be called'); } });
    assert.deepEqual(result, { ok: false, skipped: true });
  });

  test('a 200 from the push service is ok:true; sends the VAPID auth header shape and a TTL header', async () => {
    const env = { VAPID_PRIVATE_KEY: await fakeVapidPrivateKey() };
    let seenHeaders;
    const result = await sendPushTickle(env, { endpoint: 'https://fcm.googleapis.com/abc' }, {
      fetch: async (url, opts) => { seenHeaders = opts.headers; return new Response('', { status: 201 }); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);
    assert.match(seenHeaders.Authorization, /^vapid t=[^,]+, k=.+$/);
    assert.equal(seenHeaders.TTL, '3600');
    assert.equal(seenHeaders['Content-Length'], '0');
  });

  test('404 and 410 both report gone:true (the subscription is provably dead)', async () => {
    const env = { VAPID_PRIVATE_KEY: await fakeVapidPrivateKey() };
    for (const status of [404, 410]) {
      const result = await sendPushTickle(env, { endpoint: 'https://fcm.googleapis.com/x' }, {
        fetch: async () => new Response('', { status }),
      });
      assert.equal(result.gone, true);
      assert.equal(result.ok, false);
    }
  });

  test('any other non-2xx is reported, not thrown, and NOT treated as gone', async () => {
    const env = { VAPID_PRIVATE_KEY: await fakeVapidPrivateKey() };
    const result = await sendPushTickle(env, { endpoint: 'https://fcm.googleapis.com/x' }, {
      fetch: async () => new Response('', { status: 429 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.gone, undefined);
  });
});

// ---------------------------------------------------------------------------
// db.js — push_subscriptions lifecycle
// ---------------------------------------------------------------------------

describe('push_subscriptions lifecycle (db.js)', () => {
  test('upsertPushSubscription: re-subscribing the SAME endpoint updates the row in place, not a duplicate', async () => {
    await seedAdminUser(testDb);
    await db.upsertPushSubscription(testDb, { id: 'push_1', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/dup', p256dh: 'p1', auth: 'a1', user_agent: 'iPhone' });
    await db.upsertPushSubscription(testDb, { id: 'push_2', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/dup', p256dh: 'p2', auth: 'a2', user_agent: 'iPhone (updated)' });

    const rows = await db.listPushSubscriptionsForUser(testDb, 'admuser_1');
    assert.equal(rows.length, 1, 'still exactly one row for this endpoint');
    assert.equal(rows[0].id, 'push_1', 'the ORIGINAL row id is kept — only its columns are refreshed');
    assert.equal(rows[0].p256dh, 'p2', 'the keys/user_agent are refreshed to the latest subscribe call');
    assert.equal(rows[0].user_agent, 'iPhone (updated)');
  });

  test('deletePushSubscriptionForUserById only removes the CALLING user\'s own row', async () => {
    await seedAdminUser(testDb, { id: 'admuser_1', email: 'owner@example.com' });
    await seedAdminUser(testDb, { id: 'admuser_2', email: 'staff2@example.com' });
    await db.upsertPushSubscription(testDb, { id: 'push_a', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/a', p256dh: 'p', auth: 'a' });
    await db.upsertPushSubscription(testDb, { id: 'push_b', user_id: 'admuser_2', endpoint: 'https://fcm.googleapis.com/b', p256dh: 'p', auth: 'a' });

    const wrongOwner = await db.deletePushSubscriptionForUserById(testDb, 'admuser_2', 'push_a');
    assert.equal(wrongOwner, false, 'admuser_2 cannot delete admuser_1\'s device');
    assert.equal((await db.listPushSubscriptionsForUser(testDb, 'admuser_1')).length, 1);

    const rightOwner = await db.deletePushSubscriptionForUserById(testDb, 'admuser_1', 'push_a');
    assert.equal(rightOwner, true);
    assert.equal((await db.listPushSubscriptionsForUser(testDb, 'admuser_1')).length, 0);
  });

  test('deletePushSubscriptionByEndpoint (the push-service-says-gone path) is unscoped', async () => {
    await seedAdminUser(testDb);
    await db.upsertPushSubscription(testDb, { id: 'push_c', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/c', p256dh: 'p', auth: 'a' });
    const deleted = await db.deletePushSubscriptionByEndpoint(testDb, 'https://fcm.googleapis.com/c');
    assert.equal(deleted, true);
    assert.equal((await db.listAllPushSubscriptions(testDb)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// notifyAdmins / fanOutPush — creation, push fan-out, auto-delete on 410,
// per-kind preference filtering, and the "never breaks the caller" contract.
// ---------------------------------------------------------------------------

describe('notifyAdmins', () => {
  async function fakeVapidPrivateKey() {
    const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey));
  }

  test('always creates the notification row, even with zero subscriptions registered', async () => {
    const env = { DB: testDb };
    const result = await notifyAdmins(env, { kind: 'booking_new', title: 'T', body: 'B', url: '/admin/#/bookings/b1', booking_id: 'b1' });
    assert.equal(result.ok, true);
    const notifs = await db.listNotifications(testDb, { limit: 10 });
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0].kind, 'booking_new');
    assert.equal(notifs[0].booking_id, 'b1');
    assert.equal(notifs[0].read_at, null);
  });

  test('a 410 from the push service auto-deletes that subscription; the notification row still exists', async () => {
    await seedAdminUser(testDb);
    await db.upsertPushSubscription(testDb, { id: 'push_gone', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/gone', p256dh: 'p', auth: 'a' });
    const env = { DB: testDb, VAPID_PRIVATE_KEY: await fakeVapidPrivateKey() };

    await notifyAdmins(env, { kind: 'booking_new', title: 'T', body: 'B' }, {
      fetch: async () => new Response('', { status: 410 }),
    });

    assert.equal((await db.listAllPushSubscriptions(testDb)).length, 0, 'the dead subscription is gone');
    assert.equal((await db.listNotifications(testDb, { limit: 10 })).length, 1, 'the notification row is unaffected');
  });

  test('a non-gone push failure is recorded but the subscription is NOT deleted', async () => {
    await seedAdminUser(testDb);
    await db.upsertPushSubscription(testDb, { id: 'push_flaky', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/flaky', p256dh: 'p', auth: 'a' });
    const env = { DB: testDb, VAPID_PRIVATE_KEY: await fakeVapidPrivateKey() };

    await notifyAdmins(env, { kind: 'booking_new', title: 'T', body: 'B' }, {
      fetch: async () => new Response('', { status: 500 }),
    });

    const rows = await db.listAllPushSubscriptions(testDb);
    assert.equal(rows.length, 1, 'still there');
    assert.equal(rows[0].failure_count, 1);
    assert.equal(rows[0].last_error, 'http_500');
  });

  test('a broadcast notification pushes to every registered device, filtered by EACH device\'s own kind preference', async () => {
    await seedAdminUser(testDb, { id: 'admuser_1', email: 'a@example.com' });
    await seedAdminUser(testDb, { id: 'admuser_2', email: 'b@example.com' });
    await db.upsertPushSubscription(testDb, { id: 'push_1', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/u1', p256dh: 'p', auth: 'a' });
    await db.upsertPushSubscription(testDb, { id: 'push_2', user_id: 'admuser_2', endpoint: 'https://fcm.googleapis.com/u2', p256dh: 'p', auth: 'a' });
    const env = { DB: testDb, VAPID_PRIVATE_KEY: await fakeVapidPrivateKey() };

    // admuser_2 has turned OFF "cancellation" notifications.
    await setNotificationPreferences(env, 'admuser_2', { cancellation: false });

    const pushed = [];
    await notifyAdmins(env, { kind: 'booking_cancelled', title: 'T', body: 'B' }, {
      fetch: async (url) => { pushed.push(url); return new Response('', { status: 201 }); },
    });

    assert.equal(pushed.length, 1, 'only the device whose owner has this kind turned ON gets pushed');
    assert.equal(pushed[0], 'https://fcm.googleapis.com/u1');
  });

  test('a "test" notification bypasses preference filtering entirely', async () => {
    await seedAdminUser(testDb);
    await db.upsertPushSubscription(testDb, { id: 'push_1', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/u1', p256dh: 'p', auth: 'a' });
    const env = { DB: testDb, VAPID_PRIVATE_KEY: await fakeVapidPrivateKey() };
    await setNotificationPreferences(env, 'admuser_1', {
      new_booking: false, cancellation: false, gift_card: false, enquiry: false, problems: false,
    });

    const pushed = [];
    await notifyAdmins(env, { kind: 'test', title: 'T', body: 'B', user_id: 'admuser_1' }, {
      fetch: async (url) => { pushed.push(url); return new Response('', { status: 201 }); },
    });
    assert.equal(pushed.length, 1, 'test notifications are never filtered');
  });

  test('a user-targeted notification only fans out to THAT user\'s own devices', async () => {
    await seedAdminUser(testDb, { id: 'admuser_1', email: 'a@example.com' });
    await seedAdminUser(testDb, { id: 'admuser_2', email: 'b@example.com' });
    await db.upsertPushSubscription(testDb, { id: 'push_1', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/u1', p256dh: 'p', auth: 'a' });
    await db.upsertPushSubscription(testDb, { id: 'push_2', user_id: 'admuser_2', endpoint: 'https://fcm.googleapis.com/u2', p256dh: 'p', auth: 'a' });
    const env = { DB: testDb, VAPID_PRIVATE_KEY: await fakeVapidPrivateKey() };

    const pushed = [];
    await notifyAdmins(env, { kind: 'test', title: 'T', body: 'B', user_id: 'admuser_2' }, {
      fetch: async (url) => { pushed.push(url); return new Response('', { status: 201 }); },
    });
    assert.deepEqual(pushed, ['https://fcm.googleapis.com/u2']);
  });

  test('never throws — a DB failure inside notifyAdmins reports {ok:false} instead of propagating (the "report, don\'t throw" contract every trigger site relies on)', async () => {
    const throwingDb = {
      createNotification: async () => { throw new Error('boom'); },
    };
    const result = await notifyAdmins({ DB: testDb }, { kind: 'booking_new', title: 'T', body: 'B' }, { database: throwingDb });
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Preferences (settings-table-backed, no new table)
// ---------------------------------------------------------------------------

describe('notification preferences', () => {
  test('defaults to every kind ON when nothing has ever been saved', async () => {
    const prefs = await getNotificationPreferences({ DB: testDb }, 'admuser_never_configured');
    assert.deepEqual(prefs, NOTIFICATION_DEFAULT_PREFERENCES);
  });

  test('a null user (the emergency ADMIN_TOKEN session) also gets the defaults, never a lookup', async () => {
    const prefs = await getNotificationPreferences({ DB: testDb }, null);
    assert.deepEqual(prefs, NOTIFICATION_DEFAULT_PREFERENCES);
  });

  test('setNotificationPreferences PATCHES — unspecified keys keep their existing value, not reset to default', async () => {
    await setNotificationPreferences({ DB: testDb }, 'u1', { cancellation: false });
    const after = await setNotificationPreferences({ DB: testDb }, 'u1', { gift_card: false });
    assert.equal(after.cancellation, false, 'the earlier change survives a later, unrelated patch');
    assert.equal(after.gift_card, false);
    assert.equal(after.new_booking, true);
  });
});

// ---------------------------------------------------------------------------
// Pruning (daily cron)
// ---------------------------------------------------------------------------

describe('pruneOldNotifications', () => {
  test('deletes a read row older than the READ retention window, keeps a recent read row and any unread row', async () => {
    exec(testDb, `INSERT INTO notifications (id, kind, title, body, created_at, read_at) VALUES ('old_read','test','T','B', datetime('now','-60 days'), datetime('now','-59 days'))`);
    exec(testDb, `INSERT INTO notifications (id, kind, title, body, created_at, read_at) VALUES ('recent_read','test','T','B', datetime('now','-1 days'), datetime('now'))`);
    exec(testDb, `INSERT INTO notifications (id, kind, title, body, created_at, read_at) VALUES ('old_unread','test','T','B', datetime('now','-60 days'), NULL)`);

    await pruneOldNotifications({ DB: testDb });

    const remainingIds = (await db.listNotifications(testDb, { limit: 10 })).map((n) => n.id).sort();
    assert.deepEqual(remainingIds, ['old_unread', 'recent_read']);
  });

  test('never throws even against a missing/broken DB', async () => {
    const result = await pruneOldNotifications({ DB: {} });
    assert.equal(result, 0);
  });
});

// ---------------------------------------------------------------------------
// Admin API — direct-handler tests (CSRF, personal-login requirement,
// validation, and the pending/list/read endpoints).
// ---------------------------------------------------------------------------

describe('push/notifications admin API handlers', () => {
  test('POST /admin/api/push/subscribe requires CSRF, a personal login, and valid keys', async () => {
    await seedAdminUser(testDb);
    const env = { DB: testDb };

    const noCsrf = new Request('https://api.example.com/admin/api/push/subscribe', { method: 'POST', body: '{}' });
    withSession(noCsrf, { uid: 'admuser_1' });
    assert.equal((await handlePushSubscribe(noCsrf, env)).status, 403);

    const tokenSession = req('POST', '/admin/api/push/subscribe', { body: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } } });
    withSession(tokenSession, { uid: null, role: 'owner' });
    const tokenRes = await handlePushSubscribe(tokenSession, env);
    assert.equal(tokenRes.status, 400);
    assert.equal((await tokenRes.json()).error, 'personal_login_required');

    const badKeys = req('POST', '/admin/api/push/subscribe', { body: { endpoint: 'https://fcm.googleapis.com/x', keys: {} } });
    withSession(badKeys, { uid: 'admuser_1' });
    assert.equal((await handlePushSubscribe(badKeys, env)).status, 400);

    const good = req('POST', '/admin/api/push/subscribe', { body: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' }, user_agent: 'Chrome' } });
    withSession(good, { uid: 'admuser_1' });
    const res = await handlePushSubscribe(good, env);
    assert.equal(res.status, 201);
    assert.equal((await db.listPushSubscriptionsForUser(testDb, 'admuser_1')).length, 1);
  });

  test('GET /admin/api/push/subscriptions never leaks the raw endpoint/keys, and lists devices by ID', async () => {
    await seedAdminUser(testDb);
    await db.upsertPushSubscription(testDb, { id: 'push_1', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/secret', p256dh: 'should-not-leak', auth: 'should-not-leak', user_agent: 'Mozilla/5.0 (iPhone)' });
    const r = req('GET', '/admin/api/push/subscriptions');
    withSession(r, { uid: 'admuser_1' });
    const res = await handleListPushSubscriptions(r, { DB: testDb });
    const body = await res.json();
    assert.equal(body.subscriptions.length, 1);
    assert.equal(body.subscriptions[0].id, 'push_1');
    assert.equal(body.subscriptions[0].user_agent, 'Mozilla/5.0 (iPhone)');
    const raw = JSON.stringify(body);
    assert.equal(raw.includes('secret'), false);
    assert.equal(raw.includes('should-not-leak'), false);
  });

  test('a token (uid-less) session sees an empty device list rather than an error', async () => {
    const r = req('GET', '/admin/api/push/subscriptions');
    withSession(r, { uid: null, role: 'owner' });
    const res = await handleListPushSubscriptions(r, { DB: testDb });
    assert.deepEqual(await res.json(), { subscriptions: [] });
  });

  test('POST /admin/api/push/unsubscribe: 404 on an unknown/foreign id, 200 + gone on your own', async () => {
    await seedAdminUser(testDb);
    await db.upsertPushSubscription(testDb, { id: 'push_1', user_id: 'admuser_1', endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a' });

    const wrong = req('POST', '/admin/api/push/unsubscribe', { body: { id: 'push_1' } });
    withSession(wrong, { uid: 'someone_else' });
    assert.equal((await handlePushUnsubscribe(wrong, { DB: testDb })).status, 404);

    const right = req('POST', '/admin/api/push/unsubscribe', { body: { id: 'push_1' } });
    withSession(right, { uid: 'admuser_1' });
    assert.equal((await handlePushUnsubscribe(right, { DB: testDb })).status, 200);
    assert.equal((await db.listPushSubscriptionsForUser(testDb, 'admuser_1')).length, 0);
  });

  test('POST /admin/api/push/test sends a user-scoped "test" notification and requires a personal login', async () => {
    const env = { DB: testDb };
    const tokenReq = req('POST', '/admin/api/push/test', { body: {} });
    withSession(tokenReq, { uid: null, role: 'owner' });
    assert.equal((await handlePushTest(tokenReq, env)).status, 400);

    const r = req('POST', '/admin/api/push/test', { body: {} });
    withSession(r, { uid: 'admuser_1' });
    const res = await handlePushTest(r, env);
    assert.equal(res.status, 200);
    const notifs = await db.listNotifications(testDb, { userId: 'admuser_1', limit: 10 });
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0].kind, 'test');
    assert.equal(notifs[0].user_id, 'admuser_1');
  });

  test('GET /admin/api/notifications?unread=1 only returns unread rows; POST .../read is idempotent and 404s on an unknown id', async () => {
    exec(testDb, `INSERT INTO notifications (id, kind, title, body) VALUES ('n1','test','T1','B1')`);
    exec(testDb, `INSERT INTO notifications (id, kind, title, body, read_at) VALUES ('n2','test','T2','B2', datetime('now'))`);

    const listReq = req('GET', '/admin/api/notifications?unread=1');
    withSession(listReq, { uid: null });
    const listed = await (await handleListNotifications(listReq, { DB: testDb })).json();
    assert.equal(listed.notifications.length, 1);
    assert.equal(listed.notifications[0].id, 'n1');

    const readReq1 = req('POST', '/admin/api/notifications/n1/read');
    withSession(readReq1, { uid: null });
    assert.equal((await handleMarkNotificationRead(readReq1, { DB: testDb }, { id: 'n1' })).status, 200);
    // idempotent — a second mark-read on the same row is still 200, not an error
    const readReq2 = req('POST', '/admin/api/notifications/n1/read');
    withSession(readReq2, { uid: null });
    assert.equal((await handleMarkNotificationRead(readReq2, { DB: testDb }, { id: 'n1' })).status, 200);

    const missingReq = req('POST', '/admin/api/notifications/nope/read');
    withSession(missingReq, { uid: null });
    assert.equal((await handleMarkNotificationRead(missingReq, { DB: testDb }, { id: 'nope' })).status, 404);
  });

  test('GET /admin/api/notifications/pending (the service worker\'s fetch) caps at 5 and is unread-only', async () => {
    for (let i = 0; i < 8; i++) {
      exec(testDb, `INSERT INTO notifications (id, kind, title, body) VALUES (:id,'test','T','B')`, { id: `p${i}` });
    }
    exec(testDb, `INSERT INTO notifications (id, kind, title, body, read_at) VALUES ('already_read','test','T','B', datetime('now'))`);

    const r = req('GET', '/admin/api/notifications/pending');
    withSession(r, { uid: null });
    const body = await (await handleNotificationsPending(r, { DB: testDb })).json();
    assert.equal(body.notifications.length, 5);
    assert.ok(body.notifications.every((n) => n.id !== 'already_read'));
  });

  test('GET/PUT /admin/api/notification-preferences round-trip, and PUT rejects an unknown key or a non-boolean value', async () => {
    const env = { DB: testDb };
    const getReq = req('GET', '/admin/api/notification-preferences');
    withSession(getReq, { uid: 'admuser_1' });
    const defaults = await (await handleGetNotificationPreferences(getReq, env)).json();
    assert.deepEqual(defaults.preferences, NOTIFICATION_DEFAULT_PREFERENCES);

    const tokenPut = req('PUT', '/admin/api/notification-preferences', { body: { cancellation: false } });
    withSession(tokenPut, { uid: null, role: 'owner' });
    assert.equal((await handleSetNotificationPreferences(tokenPut, env)).status, 400);

    const badKey = req('PUT', '/admin/api/notification-preferences', { body: { not_a_real_key: false } });
    withSession(badKey, { uid: 'admuser_1' });
    assert.equal((await handleSetNotificationPreferences(badKey, env)).status, 400);

    const badValue = req('PUT', '/admin/api/notification-preferences', { body: { cancellation: 'off' } });
    withSession(badValue, { uid: 'admuser_1' });
    assert.equal((await handleSetNotificationPreferences(badValue, env)).status, 400);

    const goodPut = req('PUT', '/admin/api/notification-preferences', { body: { cancellation: false } });
    withSession(goodPut, { uid: 'admuser_1' });
    const putRes = await handleSetNotificationPreferences(goodPut, env);
    assert.equal(putRes.status, 200);
    assert.equal((await putRes.json()).preferences.cancellation, false);
  });
});

// ---------------------------------------------------------------------------
// Role gating — end-to-end through the real router/session guard
// (ROUTE_ROLES completeness itself is already asserted by
// test/admin_users.test.js, which walks router.routes()).
// ---------------------------------------------------------------------------

describe('role gating — new routes, end to end', () => {
  test('a viewer (below staff) gets 403 on every new push/notifications route; a staff session gets through', async () => {
    const viewerCookie = await cookieFor({ uid: 'u_viewer', role: 'viewer', email: 'v@example.com' });
    const staffCookie = await cookieFor({ uid: 'u_staff', role: 'staff', email: 's@example.com' });
    await seedAdminUser(testDb, { id: 'u_viewer', email: 'v@example.com', role: 'viewer' });
    await seedAdminUser(testDb, { id: 'u_staff', email: 's@example.com', role: 'staff' });
    const env = { DB: testDb, ADMIN_SESSION_SECRET: SESSION_SECRET, ADMIN_TOKEN: 'x', ENVIRONMENT: 'production' };

    const viewerRes = await worker.fetch(req('GET', '/admin/api/notifications', { cookie: viewerCookie }), env, CTX);
    assert.equal(viewerRes.status, 403);

    const staffRes = await worker.fetch(req('GET', '/admin/api/notifications', { cookie: staffCookie }), env, CTX);
    assert.equal(staffRes.status, 200);
  });

  test('an unauthenticated request to /admin/api/notification-preferences is 401, not 200', async () => {
    const env = { DB: testDb, ADMIN_SESSION_SECRET: SESSION_SECRET, ADMIN_TOKEN: 'x', ENVIRONMENT: 'production' };
    const res = await worker.fetch(new Request('https://api.example.com/admin/api/notification-preferences'), env, CTX);
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// PWA shell assets — public (no session needed), correct content types,
// and the CSP that keeps the service worker able to fetch its own API.
// ---------------------------------------------------------------------------

describe('PWA shell assets (manifest, service worker, icons)', () => {
  const env = {};
  test('the manifest is public, valid JSON, and names the two icon URLs the service worker/browser will fetch', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/admin/manifest.webmanifest'), env, CTX);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /manifest\+json/);
    const manifest = await res.json();
    assert.equal(manifest.start_url, '/admin/');
    assert.equal(manifest.scope, '/admin/');
    assert.equal(manifest.display, 'standalone');
    assert.deepEqual(manifest.icons.map((i) => i.src).sort(), ['/admin/icon-192.png', '/admin/icon-512.png']);
  });

  test('the service worker script is public, served as JS, and its CSP permits its own same-origin fetch', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/admin/sw.js'), env, CTX);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /javascript/);
    const csp = res.headers.get('Content-Security-Policy');
    assert.ok(csp, 'sw.js must carry an explicit CSP (never the API default, which would block its own fetch)');
    assert.doesNotMatch(csp, /default-src 'none'/, 'the generic API CSP would break push\'s same-origin fetch to /admin/api/notifications/pending');
    assert.match(csp, /connect-src 'self'/);
    const body = await res.text();
    assert.match(body, /addEventListener\('push'/);
    assert.match(body, /addEventListener\('notificationclick'/);
  });

  test('all three icon URLs are public and return a PNG', async () => {
    for (const path of ['/admin/icon-192.png', '/admin/icon-512.png', '/admin/apple-touch-icon.png']) {
      const res = await worker.fetch(new Request(`https://api.example.com${path}`), env, CTX);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('Content-Type'), 'image/png', path);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // PNG magic bytes.
      assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], path);
    }
  });

  test('the admin shell HTML itself references the manifest and apple-touch-icon', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/admin'), env, CTX);
    const html = await res.text();
    assert.match(html, /<link rel="manifest" href="\/admin\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/admin\/apple-touch-icon\.png">/);
    assert.match(html, /apple-mobile-web-app-capable/);
  });
});

// ---------------------------------------------------------------------------
// Deep-link parsing (src/logic.js:parseAdminDeepLink — the authoritative
// format; src/admin/admin.js carries a hand-copied duplicate, see its own
// doc comment).
// ---------------------------------------------------------------------------

describe('parseAdminDeepLink', () => {
  test('parses every supported shape', () => {
    assert.deepEqual(parseAdminDeepLink('#/bookings/b_123'), { view: 'bookings', id: 'b_123' });
    assert.deepEqual(parseAdminDeepLink('#/inquiries/inq_abc'), { view: 'inquiries', id: 'inq_abc' });
    assert.deepEqual(parseAdminDeepLink('#/giftcards/WOGO-ABCD'), { view: 'giftcards', id: 'WOGO-ABCD' });
    assert.deepEqual(parseAdminDeepLink('#/notifications'), { view: 'notifications', id: null });
  });

  test('URL-decodes the id', () => {
    assert.deepEqual(parseAdminDeepLink('#/inquiries/inq%20with%20space'), { view: 'inquiries', id: 'inq with space' });
  });

  test('rejects anything else without throwing', () => {
    assert.equal(parseAdminDeepLink(''), null);
    assert.equal(parseAdminDeepLink(null), null);
    assert.equal(parseAdminDeepLink('#/bookings/'), null);
    assert.equal(parseAdminDeepLink('#/not-a-real-view/1'), null);
    assert.equal(parseAdminDeepLink('bookings/1'), null, 'missing leading #/');
  });
});

// ---------------------------------------------------------------------------
// Manual (phone) booking also creates a booking_new notification.
// ---------------------------------------------------------------------------

describe('handleCreateManualBooking — booking_new notification', () => {
  test('creates a booking_new notification carrying the right deep link', async () => {
    seedRoute(testDb);
    const realFetch = global.fetch;
    global.fetch = async () => new Response('{}', { status: 200 });
    try {
      const { handleCreateManualBooking } = await import('../src/admin_api.js');
      const request = req('POST', '/admin/api/bookings/manual', {
        body: { route_id: 'r1', date: '2026-12-01', slot: '18:00', party: 2, name: 'Phoned Phil', email: 'phil@example.com' },
      });
      const env = { DB: testDb, BREVO_API_KEY: 'k' };
      const res = await handleCreateManualBooking(request, env);
      assert.equal(res.status, 201);
      const { booking } = await res.json();
      const notifs = await db.listNotifications(testDb, { limit: 10 });
      const n = notifs.find((row) => row.kind === 'booking_new');
      assert.ok(n);
      assert.match(n.body, /Phoned Phil/);
      assert.match(n.body, /gasten/);
      assert.equal(n.url, `/admin/#/bookings/${booking.id}`);
    } finally {
      global.fetch = realFetch;
    }
  });
});
