// Alert independence (O2) and payment-problem recording (O1).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { alertOwnerThrottled } from '../src/alerts.js';
import { reportPaymentProblem } from '../src/payment_alerts.js';
import { handleWebhook } from '../src/webhook.js';
import { listRecentErrors, getSetting } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.join(__dirname, '../migrations');
const schema = readdirSync(MIG).filter((f) => /^\d+.*\.sql$/.test(f)).sort()
  .map((f) => readFileSync(path.join(MIG, f), 'utf8')).join('\n');
const notifCount = (db) => db._raw.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind='problem'`).get().n;

describe('alertOwnerThrottled: push and email are independent (O2)', () => {
  test('email service down: the push notification is still created', async () => {
    const db = makeTestDb(schema);
    const r = await alertOwnerThrottled({ DB: db }, 'k1', 30, 'Subject', '<p>x</p>', {
      sendTransactional: async () => { throw new Error('brevo down'); },
    });
    assert.equal(r.sent, true);
    assert.equal(r.email, false);
    assert.equal(r.push, true);
    assert.equal(notifCount(db), 1);
  });

  test('push channel down: the email is still sent', async () => {
    const db = makeTestDb(schema);
    let mails = 0;
    db._raw.exec('DROP TABLE notifications'); // makes notifyAdmins fail
    const r = await alertOwnerThrottled({ DB: db }, 'k2', 30, 'Subject', '<p>x</p>', {
      sendTransactional: async () => { mails++; },
    });
    assert.equal(r.sent, true);
    assert.equal(r.push, false);
    assert.equal(mails, 1);
  });

  test('both down: reports error and releases the throttle so the next run retries', async () => {
    const db = makeTestDb(schema);
    db._raw.exec('DROP TABLE notifications');
    const failing = { sendTransactional: async () => { throw new Error('down'); } };
    const r = await alertOwnerThrottled({ DB: db }, 'k3', 30, 'S', 'h', failing);
    assert.equal(r.sent, false);
    assert.equal(await getSetting(db, 'alert_last_sent:k3'), null);
    let mails = 0;
    const r2 = await alertOwnerThrottled({ DB: db }, 'k3', 30, 'S', 'h', { sendTransactional: async () => { mails++; } });
    assert.equal(r2.sent, true);
    assert.equal(mails, 1);
  });

  test('a burst inside the window sends only one alert', async () => {
    const db = makeTestDb(schema);
    let mails = 0;
    const deps = { sendTransactional: async () => { mails++; } };
    for (let i = 0; i < 5; i++) await alertOwnerThrottled({ DB: db }, 'k4', 30, 'S', 'h', deps);
    assert.equal(mails, 1);
    assert.equal(notifCount(db), 1);
  });
});

describe('reportPaymentProblem (O1)', () => {
  test('logs to error_log and alerts once; a burst does not spam', async () => {
    const db = makeTestDb(schema);
    let mails = 0;
    const deps = { sendTransactional: async () => { mails++; } };
    for (let i = 0; i < 6; i++) {
      await reportPaymentProblem({ DB: db }, 'checkout_failed', new Error('No such price'), { route: 'r1' }, deps);
    }
    const errs = await listRecentErrors(db);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /refused to start a checkout.*No such price/);
    assert.equal(JSON.parse(errs[0].context).route, 'r1');
    assert.equal(mails, 1);
  });

  test('different kinds are throttled separately', async () => {
    const db = makeTestDb(schema);
    let mails = 0;
    const deps = { sendTransactional: async () => { mails++; } };
    await reportPaymentProblem({ DB: db }, 'checkout_failed', 'a', {}, deps);
    await reportPaymentProblem({ DB: db }, 'webhook_rejected', 'b', {}, deps);
    assert.equal(mails, 2);
  });

  test('never throws, even with a broken database', async () => {
    await reportPaymentProblem({ DB: {} }, 'checkout_failed', 'x', {}, {});
  });
});

describe('webhook rejection is recorded (O1)', () => {
  const mkReq = (headers) => new Request('https://x.test/webhooks/stripe', { method: 'POST', body: '{}', headers });

  test('bad signature: 400, error_log row, owner alerted', async () => {
    const db = makeTestDb(schema);
    let mails = 0;
    const res = await handleWebhook(mkReq({ 'stripe-signature': 'bad' }), { DB: db, STRIPE_WEBHOOK_SECRET: 's' }, {
      verifyStripeSignature: async () => { throw new Error('signature_mismatch'); },
      sendTransactional: async () => { mails++; },
    });
    assert.equal(res.status, 400);
    const errs = await listRecentErrors(db);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /rejected/);
    assert.equal(mails, 1);
  });

  test('no signature header at all (random probe): 400 but no log and no alert', async () => {
    const db = makeTestDb(schema);
    let mails = 0;
    const res = await handleWebhook(mkReq({}), { DB: db, STRIPE_WEBHOOK_SECRET: 's' }, { sendTransactional: async () => { mails++; } });
    assert.equal(res.status, 400);
    assert.equal((await listRecentErrors(db)).length, 0);
    assert.equal(mails, 0);
  });
});
