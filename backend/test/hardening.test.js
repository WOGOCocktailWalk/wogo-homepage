// test/hardening.test.js — production-readiness hardening (2026-07, owner
// audit). Covers everything NOT already exercised by db.test.js / logic.test.js
// / security.test.js / webhook.test.js:
//   security headers, error tracking + throttled crash alerts, the admin
//   mutation audit trail, the health-check cron, GDPR retention, Turnstile
//   (config-gated), failed-email retry, and the R2 backup export.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { withSecurityHeaders } from '../src/security_headers.js';
import { captureError } from '../src/errors.js';
import { alertOwnerThrottled } from '../src/alerts.js';
import { runHealthCheck } from '../src/healthcheck.js';
import { runGdprRetention } from '../src/retention.js';
import { verifyTurnstile } from '../src/turnstile.js';
import { sendWithRetry, retryFailedEmails } from '../src/email_retry.js';
import { exportBackupToR2 } from '../src/backup.js';
import { FAILED_EMAIL_MAX_ATTEMPTS } from '../src/config.js';
import {
  toPositional, listRecentErrors, listAdminAudit, listAllRoutesForBackup,
} from '../src/db.js';
import {
  handleCreateRoute, handleAddBar, handleDeleteOverride, handleCreateOverride,
  handleAuditLog, handleErrorLog, handleFailedEmails, handlePublicConfig, handleLogin,
} from '../src/admin_api.js';
import worker from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) {
  return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8');
}
// Full schema, every migration applied in order — needed here because this
// file exercises the production-hardening tables (0006-0009) together with
// the pre-existing ones (route/booking creation, admin login).
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
].map(migration).join('\n');

function exec(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

function withFakeFetch(fakeFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return fn().finally(() => { globalThis.fetch = original; });
}

// ---------------------------------------------------------------------------
// Security headers (owner audit item #9)
// ---------------------------------------------------------------------------

describe('withSecurityHeaders', () => {
  test('adds the full defense-in-depth header set to a JSON response', () => {
    const res = withSecurityHeaders(new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.ok(res.headers.get('Permissions-Policy').includes('geolocation=()'));
    assert.ok(res.headers.get('Strict-Transport-Security').includes('max-age='));
    assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    assert.equal(res.status, 200);
  });

  test('an HTML response gets the admin-flavored CSP (inline script/style allowed, same-origin only)', () => {
    const res = withSecurityHeaders(new Response('<html></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
    const csp = res.headers.get('Content-Security-Policy');
    assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
  });

  test('never clobbers a header the handler already set on purpose', () => {
    const res = withSecurityHeaders(new Response('ok', {
      headers: {
        'Set-Cookie': 'wogo_admin=abc; HttpOnly',
        'Access-Control-Allow-Origin': 'https://wogococktailwalk.com',
        'X-Frame-Options': 'SAMEORIGIN', // pretend a handler had a reason to set its own
      },
    }));
    assert.equal(res.headers.get('Set-Cookie'), 'wogo_admin=abc; HttpOnly');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://wogococktailwalk.com');
    assert.equal(res.headers.get('X-Frame-Options'), 'SAMEORIGIN', 'existing value is preserved, not overwritten');
  });

  test('preserves status and a non-JSON body (CSV export)', async () => {
    const res = withSecurityHeaders(new Response('id,name\n1,Anna', {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="x.csv"' },
    }));
    assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="x.csv"');
    assert.equal(await res.text(), 'id,name\n1,Anna');
  });
});

// ---------------------------------------------------------------------------
// Error tracking (owner audit item #5)
// ---------------------------------------------------------------------------

describe('captureError — €0 Sentry-equivalent', () => {
  let db;
  beforeEach(() => { db = makeTestDb(schemaSql); });

  test('logs every exception to error_log, but only alerts once per throttle window', async () => {
    let fetchCalls = 0;
    const env = { DB: db, BREVO_API_KEY: 'test' };
    await withFakeFetch(async () => { fetchCalls++; return { ok: true, text: async () => '' }; }, async () => {
      await captureError(env, new Error('boom one'), { url: '/api/book', method: 'POST' });
      await captureError(env, new Error('boom two'), { url: '/admin/api/routes', method: 'POST' });
    });

    const errors = await listRecentErrors(db, 10);
    assert.equal(errors.length, 2, 'every crash is logged, even throttled ones');
    assert.equal(errors[0].message, 'boom two');
    assert.equal(errors[1].url, '/api/book');
    assert.equal(fetchCalls, 1, 'the second crash inside the throttle window sends no second alert email');
  });

  test('never throws even when env.DB is completely broken', async () => {
    await withFakeFetch(async () => ({ ok: true, text: async () => '' }), async () => {
      await assert.doesNotReject(() => captureError({ DB: null }, new Error('x'), {}));
    });
  });
});

// ---------------------------------------------------------------------------
// alertOwnerThrottled — shared by errors.js / healthcheck.js / email_retry.js
// ---------------------------------------------------------------------------

describe('alertOwnerThrottled', () => {
  test('throttles repeated alerts under the SAME key but not a different key', async () => {
    const sent = [];
    const store = new Map();
    const fakeDb = {
      getSetting: async (_db, k) => store.get(k) || null,
      setSetting: async (_db, k, v) => { store.set(k, v); },
    };
    const fakeSend = async (_env, msg) => { sent.push(msg); };

    const r1 = await alertOwnerThrottled({}, 'crash', 30, 'Subject 1', '<p>x</p>', { database: fakeDb, sendTransactional: fakeSend });
    assert.equal(r1.sent, true);
    const r2 = await alertOwnerThrottled({}, 'crash', 30, 'Subject 2', '<p>y</p>', { database: fakeDb, sendTransactional: fakeSend });
    assert.deepEqual(r2, { sent: false, throttled: true });
    const r3 = await alertOwnerThrottled({}, 'health_check', 30, 'Subject 3', '<p>z</p>', { database: fakeDb, sendTransactional: fakeSend });
    assert.equal(r3.sent, true, 'a different alert key is never suppressed by another key\'s throttle');
    assert.equal(sent.length, 2);
  });

  test('never throws even if the send itself fails', async () => {
    const fakeDb = { getSetting: async () => null, setSetting: async () => {} };
    const result = await alertOwnerThrottled({}, 'x', 30, 's', 'h', {
      database: fakeDb, sendTransactional: async () => { throw new Error('brevo down'); },
    });
    assert.deepEqual(result, { sent: false, error: true });
  });
});

// ---------------------------------------------------------------------------
// Health check cron (owner audit item #6)
// ---------------------------------------------------------------------------

describe('runHealthCheck', () => {
  const okEnv = { ADMIN_TOKEN: 'x', ADMIN_SESSION_SECRET: 'y', STRIPE_SECRET_KEY: 'z', STRIPE_WEBHOOK_SECRET: 'w', BREVO_API_KEY: 'v' };

  test('reports ok when D1 is reachable and every required secret is present', async () => {
    const fakeDb = { pingDb: async () => true };
    const result = await runHealthCheck(okEnv, { database: fakeDb });
    assert.deepEqual(result, { ok: true, problems: [] });
  });

  test('flags a dead D1 and missing secrets, and sends one throttled alert', async () => {
    const fakeDb = { pingDb: async () => { throw new Error('d1 down'); }, getSetting: async () => null, setSetting: async () => {} };
    let fetchCalls = 0;
    await withFakeFetch(async () => { fetchCalls++; return { ok: true, text: async () => '' }; }, async () => {
      const result = await runHealthCheck({}, { database: fakeDb });
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((p) => p.includes('D1 query failed')));
      assert.ok(result.problems.some((p) => p === 'missing secret: ADMIN_TOKEN'));
      assert.equal(fetchCalls, 1);
    });
  });

  test('self-fetches the guest API + admin shell only when HEALTH_CHECK_BASE_URL is configured', async () => {
    const fakeDb = { pingDb: async () => true, getSetting: async () => null, setSetting: async () => {} };
    const calledUrls = [];
    const selfFetch = async (url) => { calledUrls.push(url); return { ok: !url.includes('/admin/login') }; };
    await withFakeFetch(async () => ({ ok: true, text: async () => '' }), async () => {
      const env = { ...okEnv, HEALTH_CHECK_BASE_URL: 'https://api.example.com/' };
      const result = await runHealthCheck(env, { database: fakeDb, fetch: selfFetch });
      assert.equal(calledUrls.length, 2);
      assert.equal(calledUrls[0], 'https://api.example.com/api/routes');
      assert.equal(calledUrls[1], 'https://api.example.com/admin/login');
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((p) => p.includes('admin shell returned HTTP')));
    });
  });

  test('skips the self-fetch layer entirely when HEALTH_CHECK_BASE_URL is unset (default)', async () => {
    const fakeDb = { pingDb: async () => true };
    let selfFetchCalled = false;
    const result = await runHealthCheck(okEnv, { database: fakeDb, fetch: async () => { selfFetchCalled = true; } });
    assert.equal(result.ok, true);
    assert.equal(selfFetchCalled, false);
  });
});

// ---------------------------------------------------------------------------
// GDPR retention (owner audit item #14)
// ---------------------------------------------------------------------------

describe('runGdprRetention', () => {
  test('delegates to db.anonymizeOldBookings with a cutoff GDPR_RETENTION_MONTHS ago', async () => {
    let capturedCutoff;
    const fakeDb = { anonymizeOldBookings: async (_db, cutoff) => { capturedCutoff = cutoff; return { anonymized: 3 }; } };
    const result = await runGdprRetention({ DB: {} }, { database: fakeDb });
    assert.deepEqual(result, { anonymized: 3 });
    assert.match(capturedCutoff, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(capturedCutoff < new Date().toISOString().slice(0, 19).replace('T', ' '), 'cutoff is in the past');
  });
});

// ---------------------------------------------------------------------------
// Turnstile — bot protection (owner audit items #1/#10), config-gated
// ---------------------------------------------------------------------------

describe('verifyTurnstile', () => {
  test('is a transparent no-op skip when TURNSTILE_SECRET_KEY is not configured', async () => {
    const result = await verifyTurnstile({}, 'any-token', '1.2.3.4');
    assert.deepEqual(result, { ok: true, skipped: true });
  });

  test('rejects a missing/non-string token once configured', async () => {
    const env = { TURNSTILE_SECRET_KEY: 'sk' };
    assert.deepEqual(await verifyTurnstile(env, null, '1.2.3.4'), { ok: false, reason: 'missing_token' });
    assert.deepEqual(await verifyTurnstile(env, 42, '1.2.3.4'), { ok: false, reason: 'missing_token' });
  });

  test('posts to the siteverify endpoint and passes through success', async () => {
    const env = { TURNSTILE_SECRET_KEY: 'sk' };
    let capturedUrl;
    const result = await verifyTurnstile(env, 'tok', '9.9.9.9', {
      fetch: async (url) => { capturedUrl = url; return { json: async () => ({ success: true }) }; },
    });
    assert.equal(result.ok, true);
    assert.equal(capturedUrl, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  });

  test('surfaces Cloudflare error codes on failure', async () => {
    const env = { TURNSTILE_SECRET_KEY: 'sk' };
    const result = await verifyTurnstile(env, 'tok', '9.9.9.9', {
      fetch: async () => ({ json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }),
    });
    assert.deepEqual(result, { ok: false, reason: 'invalid-input-response' });
  });

  test('never throws even if the verify request itself fails', async () => {
    const env = { TURNSTILE_SECRET_KEY: 'sk' };
    const result = await verifyTurnstile(env, 'tok', '9.9.9.9', { fetch: async () => { throw new Error('network down'); } });
    assert.deepEqual(result, { ok: false, reason: 'verify_request_failed' });
  });
});

// ---------------------------------------------------------------------------
// Email retry (owner audit item #12)
// ---------------------------------------------------------------------------

describe('sendWithRetry', () => {
  test('on success, behaves identically to a direct send — no queueing', async () => {
    const sent = [];
    const result = await sendWithRetry({}, { to: 'a@b.com', subject: 's', htmlContent: 'h' }, {
      sendTransactional: async (_env, m) => { sent.push(m); },
      database: { queueFailedEmail: async () => { throw new Error('must not be called'); } },
    });
    assert.deepEqual(result, { sent: true });
    assert.equal(sent.length, 1);
  });

  test('on failure, queues to failed_email and never throws', async () => {
    const queued = [];
    const result = await sendWithRetry({}, { to: 'a@b.com', subject: 's', htmlContent: 'h' }, {
      sendTransactional: async () => { throw new Error('brevo down'); },
      database: { queueFailedEmail: async (_db, row) => queued.push(row) },
      kind: 'guest_confirmation',
    });
    assert.deepEqual(result, { sent: false });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].kind, 'guest_confirmation');
    assert.equal(queued[0].last_error, 'brevo down');
    assert.equal(queued[0].to_email, 'a@b.com');
  });
});

describe('retryFailedEmails — cron drain', () => {
  test('resends a due row successfully and marks it sent', async () => {
    const marked = [];
    const fakeDb = {
      listDueFailedEmails: async () => [{ id: 1, to_email: 'a@b.com', subject: 's', html_content: 'h', kind: 'x', attempts: 1 }],
      markFailedEmailSent: async (_db, id) => marked.push(['sent', id]),
      markFailedEmailRetry: async (_db, id) => marked.push(['retry', id]),
      markFailedEmailPermanent: async (_db, id) => marked.push(['permanent', id]),
    };
    const result = await retryFailedEmails({}, { database: fakeDb, sendTransactional: async () => {} });
    assert.deepEqual(result, { checked: 1, sent: 1, rescheduled: 0, permanentlyFailed: 0 });
    assert.deepEqual(marked, [['sent', 1]]);
  });

  test('reschedules with backoff on a further failure below MAX_ATTEMPTS', async () => {
    const marked = [];
    const fakeDb = {
      listDueFailedEmails: async () => [{ id: 2, to_email: 'a@b.com', subject: 's', html_content: 'h', kind: 'x', attempts: 1 }],
      markFailedEmailSent: async () => {},
      markFailedEmailRetry: async (_db, id, attempts) => marked.push(['retry', id, attempts]),
      markFailedEmailPermanent: async () => {},
    };
    const result = await retryFailedEmails({}, { database: fakeDb, sendTransactional: async () => { throw new Error('still down'); } });
    assert.equal(result.rescheduled, 1);
    assert.deepEqual(marked, [['retry', 2, 2]]);
  });

  test('gives up past FAILED_EMAIL_MAX_ATTEMPTS and sends exactly ONE owner alert for the whole batch', async () => {
    const marked = [];
    const fakeDb = {
      listDueFailedEmails: async () => [
        { id: 3, to_email: 'a@b.com', subject: 's', html_content: 'h', kind: 'x', attempts: FAILED_EMAIL_MAX_ATTEMPTS - 1 },
        { id: 4, to_email: 'c@d.com', subject: 's', html_content: 'h', kind: 'y', attempts: FAILED_EMAIL_MAX_ATTEMPTS - 1 },
      ],
      markFailedEmailSent: async () => {},
      markFailedEmailRetry: async () => {},
      markFailedEmailPermanent: async (_db, id) => marked.push(id),
      getSetting: async () => null,
      setSetting: async () => {},
    };
    let fetchCalls = 0;
    await withFakeFetch(async () => { fetchCalls++; return { ok: true, text: async () => '' }; }, async () => {
      const result = await retryFailedEmails({}, { database: fakeDb, sendTransactional: async () => { throw new Error('still down'); } });
      assert.equal(result.permanentlyFailed, 2);
      assert.deepEqual(marked, [3, 4]);
      assert.equal(fetchCalls, 1, 'one alert email for the whole batch, not one per row');
    });
  });
});

// ---------------------------------------------------------------------------
// R2 backup export (owner audit item #4)
// ---------------------------------------------------------------------------

describe('exportBackupToR2', () => {
  test('is a no-op until env.BACKUP_BUCKET is bound', async () => {
    const result = await exportBackupToR2({});
    assert.deepEqual(result, { skipped: true, reason: 'no_r2_binding' });
  });

  test('writes one JSON snapshot with every configured table and prunes old snapshots past retention', async () => {
    const puts = [];
    const deletes = [];
    const todayKey = new Date().toISOString().slice(0, 10);
    const bucket = {
      put: async (key, value, opts) => { puts.push({ key, value, opts }); },
      list: async () => ({ objects: [{ key: 'daily/2000-01-01.json' }, { key: `daily/${todayKey}.json` }], truncated: false }),
      delete: async (keys) => { deletes.push(...keys); },
    };
    const fakeDb = {
      listAllRoutesForBackup: async () => [{ id: 'amsterdam' }],
      listAllBarsForBackup: async () => [{ id: 1 }],
      listAllDateOverridesForBackup: async () => [],
      listAllBookingsForBackup: async () => [{ id: 'b_1' }, { id: 'b_2' }],
    };
    const result = await exportBackupToR2({ DB: {}, BACKUP_BUCKET: bucket }, { database: fakeDb });

    assert.equal(result.ok, true);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, `daily/${todayKey}.json`);
    assert.equal(puts[0].opts.httpMetadata.contentType, 'application/json');
    const parsed = JSON.parse(puts[0].value);
    assert.equal(parsed.tables.routes.length, 1);
    assert.equal(parsed.tables.bookings.length, 2);
    assert.deepEqual(deletes, ['daily/2000-01-01.json'], 'only the ancient snapshot is pruned; today\'s survives');
  });

  test('listAllRoutesForBackup exists and reads the real routes table (db.js wiring)', async () => {
    const db = makeTestDb(schemaSql);
    exec(db, `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
              VALUES ('r1','R1','City',1000,10,6,'[1]','["18:00"]','{}',NULL,1)`);
    const rows = await listAllRoutesForBackup(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'r1');
  });
});

// ---------------------------------------------------------------------------
// Admin mutation audit trail (owner audit item #8) — integration, real D1-shaped db
// ---------------------------------------------------------------------------

describe('admin_audit — every mutation logs who/what/when', () => {
  let db;
  beforeEach(() => { db = makeTestDb(schemaSql); });

  function adminRequest(method, path, body) {
    return new Request(`https://admin.example.com${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin', 'CF-Connecting-IP': '9.9.9.9' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  test('creating a route writes an audit row with actor IP + entity + detail', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'testcity', name: 'Test City Walk', city: 'Testville', price_cents: 1999,
      open_days: '[1,2,3]', slots: '["18:00"]',
    }), env);
    assert.equal(res.status, 201);

    const entries = await listAdminAudit(db, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'route.create');
    assert.equal(entries[0].entity_type, 'route');
    assert.equal(entries[0].entity_id, 'testcity');
    assert.equal(entries[0].ip, '9.9.9.9');
    assert.equal(JSON.parse(entries[0].detail).city, 'Testville');
  });

  test('a REJECTED mutation (bad CSRF / validation) never writes an audit row', async () => {
    const env = { DB: db };
    const noCsrf = new Request('https://admin.example.com/admin/api/routes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, // no X-Requested-With
      body: JSON.stringify({ id: 'x', name: 'X', city: 'X', price_cents: 100, open_days: '[1]', slots: '["18:00"]' }),
    });
    const res = await handleCreateRoute(noCsrf, env);
    assert.equal(res.status, 403);
    assert.equal((await listAdminAudit(db, 10)).length, 0);
  });

  test('adding a bar and deleting a date override both audit, and GET /admin/api/audit-log reads them back newest-first', async () => {
    const env = { DB: db };
    exec(db, `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
              VALUES ('r1','R1','City',1000,10,6,'[1]','["18:00"]','{}',NULL,1)`);

    await handleAddBar(adminRequest('POST', '/admin/api/routes/r1/bars', { ord: 1, bar_name: 'Bar A', bar_email: 'a@bar.com' }), env, { id: 'r1' });

    const overrideRes = await handleCreateOverride(adminRequest('POST', '/admin/api/date-overrides', {
      route_id: 'r1', date: '2026-09-01', action: 'closed',
    }), env);
    const { override } = await overrideRes.json();
    await handleDeleteOverride(adminRequest('DELETE', `/admin/api/date-overrides/${override.id}`), env, { id: override.id });

    const logRes = await handleAuditLog({}, env);
    const { entries } = await logRes.json();
    assert.equal(entries.length, 3);
    // newest first
    assert.deepEqual(entries.map((e) => e.action), ['date_override.delete', 'date_override.create', 'bar.create']);
  });
});

// ---------------------------------------------------------------------------
// Dashboard-readable observability endpoints (owner audit items #5/#8/#12)
// ---------------------------------------------------------------------------

describe('GET /admin/api/error-log and /admin/api/failed-emails', () => {
  let db;
  beforeEach(() => { db = makeTestDb(schemaSql); });

  test('handleErrorLog reads back captured errors, newest first, plus a 24h count', async () => {
    const env = { DB: db, BREVO_API_KEY: 'test' };
    await withFakeFetch(async () => ({ ok: true, text: async () => '' }), async () => {
      await captureError(env, new Error('first'), {});
      await captureError(env, new Error('second'), {});
    });
    const res = await handleErrorLog({}, env);
    const body = await res.json();
    assert.equal(body.count_24h, 2);
    assert.equal(body.errors[0].message, 'second');
  });

  test('handleFailedEmails reads back the retry queue without leaking the full HTML body', async () => {
    exec(db, `INSERT INTO failed_email (to_email, subject, html_content, kind, attempts, status, next_attempt_at)
              VALUES ('a@b.com','Subj','<html>secret guest data</html>','guest_confirmation',1,'pending', datetime('now'))`);
    const res = await handleFailedEmails({}, { DB: db });
    const body = await res.json();
    assert.equal(body.emails.length, 1);
    assert.equal(body.emails[0].to_email, 'a@b.com');
    assert.equal(body.emails[0].html_content, undefined, 'the list endpoint is metadata-only, not the raw PII HTML');
  });
});

// ---------------------------------------------------------------------------
// Turnstile wired into the login endpoint (config-gated)
// ---------------------------------------------------------------------------

describe('handleLogin — Turnstile gate (config-gated, inert until TURNSTILE_SECRET_KEY is set)', () => {
  let db;
  beforeEach(() => { db = makeTestDb(schemaSql); });

  function loginRequest(body, ip = '5.5.5.5') {
    return new Request('https://admin.example.com/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify(body),
    });
  }

  test('is a no-op when TURNSTILE_SECRET_KEY is unset — existing behavior unchanged', async () => {
    const env = { DB: db, ADMIN_TOKEN: 't', ADMIN_SESSION_SECRET: 's', ENVIRONMENT: 'production' };
    const res = await handleLogin(loginRequest({ token: 't' }), env);
    assert.equal(res.status, 200);
  });

  test('rejects login without a turnstile token once configured', async () => {
    const env = { DB: db, ADMIN_TOKEN: 't', ADMIN_SESSION_SECRET: 's', ENVIRONMENT: 'production', TURNSTILE_SECRET_KEY: 'sk' };
    const res = await handleLogin(loginRequest({ token: 't' }), env);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'turnstile_failed');
  });

  test('accepts login with a valid turnstile token once configured', async () => {
    const env = { DB: db, ADMIN_TOKEN: 't', ADMIN_SESSION_SECRET: 's', ENVIRONMENT: 'production', TURNSTILE_SECRET_KEY: 'sk' };
    await withFakeFetch(async () => ({ json: async () => ({ success: true }) }), async () => {
      const res = await handleLogin(loginRequest({ token: 't', turnstile_token: 'valid' }, '5.5.5.6'), env);
      assert.equal(res.status, 200);
    });
  });

  test('GET /admin/public-config exposes the site key only when configured (never the secret key)', async () => {
    const res1 = await handlePublicConfig({}, {});
    assert.deepEqual(await res1.json(), { turnstile_site_key: null });
    const res2 = await handlePublicConfig({}, { TURNSTILE_SITE_KEY: 'pk_live_abc', TURNSTILE_SECRET_KEY: 'sk_live_should_never_appear' });
    const body2 = await res2.json();
    assert.equal(body2.turnstile_site_key, 'pk_live_abc');
    assert.equal(JSON.stringify(body2).includes('sk_live'), false);
  });
});

// ---------------------------------------------------------------------------
// index.js — end-to-end wiring: security headers on every response, public
// admin-config path excluded from the session guard, unhandled exceptions
// captured
// ---------------------------------------------------------------------------

describe('index.js — full request wiring', () => {
  test('a normal guest API response carries security headers', async () => {
    const db = makeTestDb(schemaSql);
    exec(db, `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
              VALUES ('r1','R1','City',1000,10,6,'[1,2,3,4,5,6,7]','["18:00"]','{}',NULL,1)`);
    const env = { DB: db };
    const ctx = { waitUntil: () => {} };
    const res = await worker.fetch(new Request('https://api.example.com/api/routes'), env, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  });

  test('the /admin shell is reachable without a session and carries the admin CSP', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/admin'), {}, { waitUntil: () => {} });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Content-Security-Policy').includes('unsafe-inline'));
  });

  test('GET /admin/public-config bypasses the session guard (the login form needs it pre-login)', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/admin/public-config'), {}, { waitUntil: () => {} });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { turnstile_site_key: null });
  });

  test('every other /admin/api/* route still requires a session', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/admin/api/bookings'), {}, { waitUntil: () => {} });
    assert.equal(res.status, 401);
  });

  test('a 404 still gets security headers', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/does/not/exist'), {}, { waitUntil: () => {} });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  });

  test('an unhandled exception is captured (via ctx.waitUntil) and still returns a security-headered 500', async () => {
    const brokenDb = makeTestDb(''); // no schema at all — any query throws "no such table"
    const waits = [];
    const ctx = { waitUntil: (p) => { waits.push(p); } };
    const res = await worker.fetch(new Request('https://api.example.com/api/routes'), { DB: brokenDb }, ctx);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(waits.length, 1, 'captureError was scheduled via ctx.waitUntil');
    await assert.doesNotReject(() => Promise.resolve(waits[0])); // captureError itself never throws/rejects
  });
});
