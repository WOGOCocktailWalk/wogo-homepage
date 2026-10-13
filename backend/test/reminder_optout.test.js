// test/reminder_optout.test.js — the one-click reminder opt-out
// (migrations/0031): the self-contained HMAC token (src/reminder_optout.js),
// GET /api/reminders/unsubscribe (src/guest_api.js:handleReminderUnsubscribe),
// and that it's a SEPARATE table/flag from the marketing `subscribers` list
// — opting out of reminders must never touch newsletter consent.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional } from '../src/db.js';
import * as db from '../src/db.js';
import { computeReminderUnsubscribeToken, verifyReminderUnsubscribeToken, buildReminderUnsubscribeUrl } from '../src/reminder_optout.js';
import { handleReminderUnsubscribe } from '../src/guest_api.js';
import { SITE_URL } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0024_subscribers.sql',
  '0025_admin_users.sql', '0031_abandoned_reminders.sql',
].map(migration).join('\n');

let testDb;
beforeEach(() => { testDb = makeTestDb(schemaSql); });

const ENV = { ADMIN_SESSION_SECRET: 'the-real-secret' };

describe('computeReminderUnsubscribeToken / verifyReminderUnsubscribeToken', () => {
  test('round-trips: a token computed for an email verifies back to that SAME email', async () => {
    const token = await computeReminderUnsubscribeToken(ENV, 'Guest@Example.com');
    const email = await verifyReminderUnsubscribeToken(ENV, token);
    assert.equal(email, 'guest@example.com');
  });

  test('a tampered token (different email, same signature position) fails verification', async () => {
    const token = await computeReminderUnsubscribeToken(ENV, 'a@example.com');
    const tampered = token.replace(/^[^.]+/, Buffer.from('b@example.com').toString('base64url'));
    const email = await verifyReminderUnsubscribeToken(ENV, tampered);
    assert.equal(email, null);
  });

  test('a token signed with a DIFFERENT secret is rejected', async () => {
    const token = await computeReminderUnsubscribeToken(ENV, 'a@example.com');
    const email = await verifyReminderUnsubscribeToken({ ADMIN_SESSION_SECRET: 'wrong-secret' }, token);
    assert.equal(email, null);
  });

  test('malformed input (no dot, empty, null) is rejected without throwing', async () => {
    assert.equal(await verifyReminderUnsubscribeToken(ENV, 'not-a-real-token'), null);
    assert.equal(await verifyReminderUnsubscribeToken(ENV, ''), null);
    assert.equal(await verifyReminderUnsubscribeToken(ENV, null), null);
  });

  test('buildReminderUnsubscribeUrl embeds a verifiable token at the expected path', async () => {
    const url = await buildReminderUnsubscribeUrl(ENV, 'https://worker.example.com', 'guest@example.com');
    assert.match(url, /^https:\/\/worker\.example\.com\/api\/reminders\/unsubscribe\?token=/);
    const token = decodeURIComponent(url.split('token=')[1]);
    assert.equal(await verifyReminderUnsubscribeToken(ENV, token), 'guest@example.com');
  });
});

describe('GET /api/reminders/unsubscribe', () => {
  function req(url) {
    return new Request(url, { method: 'GET' });
  }

  test('a valid token records the opt-out and redirects to the shared unsubscribed state', async () => {
    const token = await computeReminderUnsubscribeToken(ENV, 'optout@example.com');
    const res = await handleReminderUnsubscribe(req(`https://worker.example.com/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`), { ...ENV, DB: testDb });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), `${SITE_URL}/subscribed/?state=unsubscribed`);
    assert.equal(await db.isReminderOptedOut(testDb, 'optout@example.com'), true);
  });

  test('clicking it twice is idempotent — still redirects to unsubscribed, no error', async () => {
    const token = await computeReminderUnsubscribeToken(ENV, 'twice@example.com');
    const env = { ...ENV, DB: testDb };
    await handleReminderUnsubscribe(req(`https://worker.example.com/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`), env);
    const second = await handleReminderUnsubscribe(req(`https://worker.example.com/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`), env);
    assert.equal(second.status, 302);
    assert.equal(second.headers.get('Location'), `${SITE_URL}/subscribed/?state=unsubscribed`);
  });

  test('a missing/invalid token redirects to the invalid state and records nothing', async () => {
    const res = await handleReminderUnsubscribe(req('https://worker.example.com/api/reminders/unsubscribe?token=garbage'), { ...ENV, DB: testDb });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), `${SITE_URL}/subscribed/?state=invalid`);
    assert.equal(await db.isReminderOptedOut(testDb, 'garbage'), false);
  });

  test('a missing token param also redirects to invalid', async () => {
    const res = await handleReminderUnsubscribe(req('https://worker.example.com/api/reminders/unsubscribe'), { ...ENV, DB: testDb });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), `${SITE_URL}/subscribed/?state=invalid`);
  });

  test('opting out of reminders does NOT touch the marketing subscribers table', async () => {
    // A confirmed newsletter subscriber at the same email...
    await db.upsertConfirmedSubscriber(testDb, {
      id: 'sub_1', email: 'both@example.com', first_name: null, locale: 'en', city: null,
      source: 'booking_opt_in', unsubscribe_token: 'tok123', ip_hash: null,
    });
    const before = await db.getSubscriberByEmail(testDb, 'both@example.com');
    assert.equal(before.status, 'confirmed');

    const token = await computeReminderUnsubscribeToken(ENV, 'both@example.com');
    await handleReminderUnsubscribe(req(`https://worker.example.com/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`), { ...ENV, DB: testDb });

    const after = await db.getSubscriberByEmail(testDb, 'both@example.com');
    assert.equal(after.status, 'confirmed', 'the newsletter subscription is completely unaffected');
    assert.equal(await db.isReminderOptedOut(testDb, 'both@example.com'), true);
  });
});

describe('isReminderOptedOut / recordReminderOptOut', () => {
  test('is case-insensitive and idempotent to record twice', async () => {
    await db.recordReminderOptOut(testDb, 'Case@Example.com');
    await db.recordReminderOptOut(testDb, 'case@example.com'); // should not throw (INSERT OR IGNORE)
    assert.equal(await db.isReminderOptedOut(testDb, 'CASE@EXAMPLE.COM'), true);
    assert.equal(await db.isReminderOptedOut(testDb, 'someone-else@example.com'), false);
  });
});
