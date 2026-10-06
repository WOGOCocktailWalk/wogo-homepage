// test/admin_users.test.js — personal team logins, roles, per-user audit
// (migrations/0025_admin_users.sql, BUILD §18).
//
// Covers: the ROUTE_ROLES completeness guarantee (every registered
// /admin/api/* route has an explicit minimum role, nothing stale), the full
// magic-link lifecycle (request -> email -> click -> session, expiry, reuse,
// disabled user, enumeration-safe response, rate limiting in its own two
// buckets), the role-guard matrix end-to-end through the real worker.fetch,
// the owner-only user-management endpoints (invite, update, last-owner
// protection), session backward compatibility (a pre-0025 cookie payload
// still works as owner), and the audit trail's new `actor` column.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import worker, { router } from '../src/index.js';
import { ROUTE_ROLES, resolveSession } from '../src/admin_api.js';
import { createSessionCookieValue, COOKIE_NAME, roleAtLeast, sha256Hex } from '../src/auth.js';
import * as db from '../src/db.js';
import { toPositional } from '../src/db.js';
import { sqliteMinutesAgo } from '../src/logic.js';
import { LOGIN_LINK_ATTEMPTS_PER_WINDOW } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) {
  return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8');
}
// The full non-seed schema — this file exercises the ENTIRE /admin/api/*
// route surface (the role matrix), so it needs every table any of those
// routes might touch, not just the team-login tables.
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0017_map_by_weekday.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql', '0020_route_names.sql', '0021_inquiries.sql',
  '0022_bar_locale.sql', '0023_route_names_simple.sql', '0024_subscribers.sql', '0025_admin_users.sql',
].map(migration).join('\n');

const SESSION_SECRET = 'test-session-secret';
const BASE_ENV = (testDb) => ({
  DB: testDb, ADMIN_SESSION_SECRET: SESSION_SECRET, ADMIN_TOKEN: 'emergency-token',
  ENVIRONMENT: 'production', BREVO_API_KEY: 'k',
});
const CTX = { waitUntil: () => {} };

async function cookieHeaderFor(identity) {
  const value = await createSessionCookieValue(SESSION_SECRET, identity);
  return `${COOKIE_NAME}=${value}`;
}

function req(method, pathAndQuery, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers['Cookie'] = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'DELETE') headers['X-Requested-With'] = 'wogo-admin';
  else if (method === 'DELETE') headers['X-Requested-With'] = 'wogo-admin';
  return new Request(`https://api.example.com${pathAndQuery}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function run(testDb, sql, params = {}) {
  const t = toPositional(sql, params);
  return testDb.prepare(t.sql).bind(...t.values).run();
}

let testDb;
beforeEach(() => { testDb = makeTestDb(schemaSql); });

// ---------------------------------------------------------------------------
// ROUTE_ROLES completeness — the table IS the control; this test is what
// keeps it honest as routes get added or removed.
// ---------------------------------------------------------------------------

describe('ROUTE_ROLES — completeness against the real router', () => {
  test('every registered /admin/api/* route has an explicit, valid role entry', () => {
    const adminApiRoutes = router.routes().filter((r) => r.pattern.startsWith('/admin/api/'));
    assert.ok(adminApiRoutes.length > 10, 'sanity: router should have many admin API routes registered');
    for (const r of adminApiRoutes) {
      const key = `${r.method} ${r.pattern}`;
      assert.ok(Object.prototype.hasOwnProperty.call(ROUTE_ROLES, key), `missing ROUTE_ROLES entry for ${key}`);
      assert.ok(['owner', 'staff', 'viewer'].includes(ROUTE_ROLES[key]), `invalid role for ${key}`);
    }
  });

  test('no stale entries — every ROUTE_ROLES key still matches a registered route', () => {
    const known = new Set(router.routes().map((r) => `${r.method} ${r.pattern}`));
    for (const key of Object.keys(ROUTE_ROLES)) {
      assert.ok(known.has(key), `stale ROUTE_ROLES entry, no such route: ${key}`);
    }
  });
});

describe('roleAtLeast — pure comparison', () => {
  test('owner satisfies every minimum; viewer satisfies only viewer', () => {
    assert.equal(roleAtLeast('owner', 'owner'), true);
    assert.equal(roleAtLeast('owner', 'staff'), true);
    assert.equal(roleAtLeast('owner', 'viewer'), true);
    assert.equal(roleAtLeast('staff', 'owner'), false);
    assert.equal(roleAtLeast('staff', 'staff'), true);
    assert.equal(roleAtLeast('viewer', 'staff'), false);
    assert.equal(roleAtLeast('viewer', 'viewer'), true);
    assert.equal(roleAtLeast('bogus', 'viewer'), false);
  });
});

// ---------------------------------------------------------------------------
// Session backward compatibility (a pre-0025 cookie survives as owner).
// ---------------------------------------------------------------------------

describe('session backward compatibility', () => {
  test('a pre-0025 cookie payload ({exp} only) still authenticates as owner', async () => {
    const env = BASE_ENV(testDb);
    const oldCookie = await createSessionCookieValue(SESSION_SECRET); // no identity arg — old shape
    const session = await resolveSession(req('GET', '/admin/api/routes', { cookie: `${COOKIE_NAME}=${oldCookie}` }), env);
    assert.ok(session);
    assert.equal(session.role, 'owner');
    assert.equal(session.uid, null);
  });

  test('the emergency ADMIN_TOKEN login round-trips to role=owner, uid=null', async () => {
    const env = BASE_ENV(testDb);
    const res = await worker.fetch(req('POST', '/admin/login', { body: { token: 'emergency-token' } }), env, CTX);
    assert.equal(res.status, 200);
    const cookie = res.headers.get('Set-Cookie').split(';')[0];
    const session = await resolveSession(req('GET', '/admin/api/routes', { cookie }), env);
    assert.equal(session.role, 'owner');
    assert.equal(session.uid, null);
    assert.equal(session.email, null);
  });
});

// ---------------------------------------------------------------------------
// Role-guard matrix, end-to-end through worker.fetch.
// ---------------------------------------------------------------------------

describe('role guard — end-to-end through worker.fetch', () => {
  test('viewer can read bookings and analytics, but is forbidden from a staff route and an owner route', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'viewer', email: 'v@example.com' });

    const bookings = await worker.fetch(req('GET', '/admin/api/bookings', { cookie }), env, CTX);
    assert.equal(bookings.status, 200);

    const analytics = await worker.fetch(req('GET', '/admin/api/analytics?from=2026-01-01&to=2026-01-31', { cookie }), env, CTX);
    assert.equal(analytics.status, 200);

    const staffRoute = await worker.fetch(req('GET', '/admin/api/inquiries', { cookie }), env, CTX);
    assert.equal(staffRoute.status, 403);

    const ownerRoute = await worker.fetch(req('GET', '/admin/api/audit-log', { cookie }), env, CTX);
    assert.equal(ownerRoute.status, 403);
  });

  test('staff can act on bookings and view gift cards, but is forbidden from an owner-only route', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });

    const giftCards = await worker.fetch(req('GET', '/admin/api/gift-cards', { cookie }), env, CTX);
    assert.equal(giftCards.status, 200);

    const csv = await worker.fetch(req('GET', '/admin/api/bookings.csv', { cookie }), env, CTX);
    assert.equal(csv.status, 403);

    const users = await worker.fetch(req('GET', '/admin/api/users', { cookie }), env, CTX);
    assert.equal(users.status, 403);
  });

  test('owner can reach everything, including user management and CSV export', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'o@example.com' });

    const users = await worker.fetch(req('GET', '/admin/api/users', { cookie }), env, CTX);
    assert.equal(users.status, 200);

    const csv = await worker.fetch(req('GET', '/admin/api/bookings.csv', { cookie }), env, CTX);
    assert.equal(csv.status, 200);
  });

  test('a disabled personal user is rejected on their very next request, not just next login', async () => {
    const env = BASE_ENV(testDb);
    const user = await db.createAdminUser(testDb, { id: 'admuser_x', email: 'x@example.com', name: 'X', role: 'staff', status: 'active' });
    const cookie = await cookieHeaderFor({ uid: user.id, role: user.role, email: user.email });

    const before = await worker.fetch(req('GET', '/admin/api/bookings', { cookie }), env, CTX);
    assert.equal(before.status, 200);

    await db.updateAdminUser(testDb, user.id, { status: 'disabled' });

    const after = await worker.fetch(req('GET', '/admin/api/bookings', { cookie }), env, CTX);
    assert.equal(after.status, 401); // same cookie, now dead — not a stale 12h window
  });

  test('a role change (not just a disable) takes effect on the very next request', async () => {
    const env = BASE_ENV(testDb);
    const user = await db.createAdminUser(testDb, { id: 'admuser_y', email: 'y@example.com', name: 'Y', role: 'owner', status: 'active' });
    const cookie = await cookieHeaderFor({ uid: user.id, role: 'owner', email: user.email });

    await db.updateAdminUser(testDb, user.id, { role: 'viewer' });

    const res = await worker.fetch(req('GET', '/admin/api/audit-log', { cookie }), env, CTX);
    assert.equal(res.status, 403); // the cookie still SAYS 'owner' — the live DB row wins
  });
});

// ---------------------------------------------------------------------------
// Magic-link lifecycle.
// ---------------------------------------------------------------------------

function makeEmailCaptureFetch() {
  const sent = [];
  return {
    sent,
    fetchMock: async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/v3/smtp/email')) {
        const payload = JSON.parse(opts.body);
        sent.push({ to: payload.to[0].email, subject: payload.subject, html: payload.htmlContent });
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unmocked fetch in admin_users.test.js: ${u}`);
    },
  };
}

describe('magic-link lifecycle', () => {
  let realFetch;
  let mock;
  beforeEach(() => {
    realFetch = global.fetch;
    mock = makeEmailCaptureFetch();
    global.fetch = mock.fetchMock;
  });
  afterEach(() => { global.fetch = realFetch; });

  test('request -> email sent -> click -> session cookie with the real role; link is single-use', async () => {
    const env = BASE_ENV(testDb);
    await db.createAdminUser(testDb, { id: 'admuser_z', email: 'teammate@example.com', name: 'Selin', role: 'staff', status: 'active' });

    const reqRes = await worker.fetch(req('POST', '/admin/login/request', { body: { email: 'teammate@example.com' } }), env, CTX);
    assert.equal(reqRes.status, 200);
    assert.deepEqual(await reqRes.json(), { ok: true });
    assert.equal(mock.sent.length, 1);
    assert.equal(mock.sent[0].to, 'teammate@example.com');

    const magicMatch = mock.sent[0].html.match(/token=([0-9a-f]{64})/);
    assert.ok(magicMatch, 'email body should contain the magic link with a 64-hex-char token');
    const token = magicMatch[1];

    const clickRes = await worker.fetch(req('GET', `/admin/login/magic?token=${token}`), env, CTX);
    assert.equal(clickRes.status, 302);
    assert.equal(clickRes.headers.get('Location'), 'https://api.example.com/admin');
    const cookie = clickRes.headers.get('Set-Cookie').split(';')[0];

    const session = await resolveSession(req('GET', '/admin/api/routes', { cookie }), env);
    assert.equal(session.role, 'staff');
    assert.equal(session.email, 'teammate@example.com');

    // single-use: clicking the SAME link again fails.
    const secondClick = await worker.fetch(req('GET', `/admin/login/magic?token=${token}`), env, CTX);
    assert.equal(secondClick.status, 302);
    assert.equal(secondClick.headers.get('Location'), 'https://api.example.com/admin/login?state=invalid');
    assert.equal(secondClick.headers.get('Set-Cookie'), null);
  });

  test('an expired link is rejected', async () => {
    const env = BASE_ENV(testDb);
    const user = await db.createAdminUser(testDb, { id: 'admuser_exp', email: 'exp@example.com', name: 'Exp', role: 'staff', status: 'active' });
    const rawToken = 'a'.repeat(64);
    const tokenHash = await sha256Hex(rawToken);
    run(testDb, `INSERT INTO admin_login_links (token_hash, user_id, expires_at) VALUES (:h, :u, datetime('now','-1 minute'))`, { h: tokenHash, u: user.id });

    const res = await worker.fetch(req('GET', `/admin/login/magic?token=${rawToken}`), env, CTX);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://api.example.com/admin/login?state=invalid');
  });

  test('a disabled user\'s still-valid link is rejected', async () => {
    const env = BASE_ENV(testDb);
    const user = await db.createAdminUser(testDb, { id: 'admuser_dis', email: 'dis@example.com', name: 'Dis', role: 'staff', status: 'disabled' });
    const rawToken = 'b'.repeat(64);
    const tokenHash = await sha256Hex(rawToken);
    run(testDb, `INSERT INTO admin_login_links (token_hash, user_id, expires_at) VALUES (:h, :u, datetime('now','+10 minutes'))`, { h: tokenHash, u: user.id });

    const res = await worker.fetch(req('GET', `/admin/login/magic?token=${rawToken}`), env, CTX);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://api.example.com/admin/login?state=invalid');
  });

  test('an unknown email still gets 200 {ok:true} and sends NO mail (enumeration-safe)', async () => {
    const env = BASE_ENV(testDb);
    const res = await worker.fetch(req('POST', '/admin/login/request', { body: { email: 'nobody@example.com' } }), env, CTX);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(mock.sent.length, 0);
  });

  test('a malformed email is a 400 (not an enumeration concern — basic validation)', async () => {
    const env = BASE_ENV(testDb);
    const res = await worker.fetch(req('POST', '/admin/login/request', { body: { email: 'not-an-email' } }), env, CTX);
    assert.equal(res.status, 400);
  });

  test('a missing token on the magic-link click redirects invalid', async () => {
    const env = BASE_ENV(testDb);
    const res = await worker.fetch(req('GET', '/admin/login/magic'), env, CTX);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://api.example.com/admin/login?state=invalid');
  });

  test('rate limiting: per-IP bucket — the Nth+1 request in the window is silently dropped (still 200, no mail)', async () => {
    const env = BASE_ENV(testDb);
    await db.createAdminUser(testDb, { id: 'admuser_rl', email: 'rl@example.com', name: 'RL', role: 'staff', status: 'active' });

    for (let i = 0; i < LOGIN_LINK_ATTEMPTS_PER_WINDOW; i++) {
      // different emails, SAME IP (default — no CF-Connecting-IP header set, so IP is 'unknown' for all; use distinct emails to isolate the per-email bucket)
      const res = await worker.fetch(req('POST', '/admin/login/request', { body: { email: `rl${i}@example.com` } }), env, CTX);
      assert.equal(res.status, 200);
    }
    mock.sent.length = 0;
    const res = await worker.fetch(req('POST', '/admin/login/request', { body: { email: 'rl@example.com' } }), env, CTX);
    assert.equal(res.status, 200); // never 429 — enumeration-safe even when rate-limited
    assert.equal(mock.sent.length, 0); // but silently dropped — no mail sent
  });

  test('rate limiting: per-email bucket — repeatedly requesting the SAME email stops sending after the limit, even from different IPs', async () => {
    const env = BASE_ENV(testDb);
    await db.createAdminUser(testDb, { id: 'admuser_rl2', email: 'samebody@example.com', name: 'RL2', role: 'staff', status: 'active' });

    for (let i = 0; i < LOGIN_LINK_ATTEMPTS_PER_WINDOW; i++) {
      await worker.fetch(
        new Request('https://api.example.com/admin/login/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin', 'CF-Connecting-IP': `10.0.0.${i}` },
          body: JSON.stringify({ email: 'samebody@example.com' }),
        }),
        env, CTX
      );
    }
    mock.sent.length = 0;
    const res = await worker.fetch(
      new Request('https://api.example.com/admin/login/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin', 'CF-Connecting-IP': '10.0.0.99' },
        body: JSON.stringify({ email: 'samebody@example.com' }),
      }),
      env, CTX
    );
    assert.equal(res.status, 200);
    assert.equal(mock.sent.length, 0);
  });

  test('every admin_audit row from a personal session carries the real email as actor', async () => {
    const env = BASE_ENV(testDb);
    const user = await db.createAdminUser(testDb, { id: 'admuser_act', email: 'actor@example.com', name: 'Actor', role: 'owner', status: 'active' });
    const cookie = await cookieHeaderFor({ uid: user.id, role: 'owner', email: user.email });

    await worker.fetch(req('POST', '/admin/api/brevo/setup', { cookie }), env, CTX).catch(() => {}); // may fail on real Brevo call (no mock) — only the audit-less early path matters here; skip asserting its status

    // Use a mutation that doesn't need Brevo: date-override create needs a route.
    run(testDb, `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,active) VALUES ('r1','R1','City',1000,10,6,'[1,2,3,4,5,6,7]','["18:00"]',1)`);
    const dateOverride = await worker.fetch(
      req('POST', '/admin/api/date-overrides', { cookie, body: { route_id: 'r1', date: '2026-12-24', action: 'closed' } }),
      env, CTX
    );
    assert.equal(dateOverride.status, 201);

    const rows = await db.listAdminAudit(testDb, 10);
    const row = rows.find((r) => r.action === 'date_override.create');
    assert.ok(row);
    assert.equal(row.actor, 'actor@example.com');
  });

  test('the emergency ADMIN_TOKEN login writes audit rows with actor \'token\'', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: null });
    run(testDb, `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,active) VALUES ('r1','R1','City',1000,10,6,'[1,2,3,4,5,6,7]','["18:00"]',1)`);
    await worker.fetch(
      req('POST', '/admin/api/date-overrides', { cookie, body: { route_id: 'r1', date: '2026-12-25', action: 'closed' } }),
      env, CTX
    );
    const rows = await db.listAdminAudit(testDb, 10);
    const row = rows.find((r) => r.action === 'date_override.create');
    assert.equal(row.actor, 'token');
  });
});

// ---------------------------------------------------------------------------
// Owner-only user management: invite, update, last-owner protection.
// ---------------------------------------------------------------------------

describe('user management (owner only)', () => {
  let realFetch;
  let mock;
  beforeEach(() => {
    realFetch = global.fetch;
    mock = makeEmailCaptureFetch();
    global.fetch = mock.fetchMock;
  });
  afterEach(() => { global.fetch = realFetch; });

  test('inviting a new teammate creates the row and sends the invite mail', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'owner@example.com' });
    const res = await worker.fetch(
      req('POST', '/admin/api/users', { cookie, body: { email: 'selin@example.com', name: 'Selin', role: 'staff' } }),
      env, CTX
    );
    assert.equal(res.status, 201);
    const { user } = await res.json();
    assert.equal(user.email, 'selin@example.com');
    assert.equal(user.role, 'staff');
    assert.equal(user.status, 'active');
    assert.equal(mock.sent.length, 1);
    assert.equal(mock.sent[0].to, 'selin@example.com');
    assert.match(mock.sent[0].subject, /invited|added/i);
  });

  test('inviting an email that already exists is a 409', async () => {
    const env = BASE_ENV(testDb);
    await db.createAdminUser(testDb, { id: 'admuser_dup', email: 'dup@example.com', name: 'Dup', role: 'viewer', status: 'active' });
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'owner@example.com' });
    const res = await worker.fetch(
      req('POST', '/admin/api/users', { cookie, body: { email: 'dup@example.com', name: 'Dup Again', role: 'staff' } }),
      env, CTX
    );
    assert.equal(res.status, 409);
  });

  // The seed migration already seeds TWO owner rows (Maroussia's two
  // addresses) — disable both first so these tests exercise a genuinely
  // sole remaining owner, not a false pass hidden behind the seed data.
  async function disableSeededOwners() {
    await db.updateAdminUser(testDb, 'admuser_owner_info', { status: 'disabled' });
    await db.updateAdminUser(testDb, 'admuser_owner_gmail', { status: 'disabled' });
  }

  test('cannot demote the LAST active owner', async () => {
    const env = BASE_ENV(testDb);
    await disableSeededOwners();
    const soleOwner = await db.createAdminUser(testDb, { id: 'admuser_sole', email: 'sole@example.com', name: 'Sole', role: 'owner', status: 'active' });
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'other@example.com' });
    const res = await worker.fetch(
      req('PUT', `/admin/api/users/${soleOwner.id}`, { cookie, body: { role: 'staff' } }),
      env, CTX
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'last_owner');
  });

  test('cannot disable the LAST active owner', async () => {
    const env = BASE_ENV(testDb);
    await disableSeededOwners();
    const soleOwner = await db.createAdminUser(testDb, { id: 'admuser_sole2', email: 'sole2@example.com', name: 'Sole2', role: 'owner', status: 'active' });
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'other@example.com' });
    const res = await worker.fetch(
      req('PUT', `/admin/api/users/${soleOwner.id}`, { cookie, body: { status: 'disabled' } }),
      env, CTX
    );
    assert.equal(res.status, 400);
  });

  test('CAN demote/disable an owner when another active owner still exists', async () => {
    const env = BASE_ENV(testDb);
    const a = await db.createAdminUser(testDb, { id: 'admuser_a', email: 'a@example.com', name: 'A', role: 'owner', status: 'active' });
    await db.createAdminUser(testDb, { id: 'admuser_b', email: 'b@example.com', name: 'B', role: 'owner', status: 'active' });
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'other@example.com' });
    const res = await worker.fetch(
      req('PUT', `/admin/api/users/${a.id}`, { cookie, body: { role: 'staff' } }),
      env, CTX
    );
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.role, 'staff');
  });

  test('GET /admin/api/me reports the real signed-in identity', async () => {
    const env = BASE_ENV(testDb);
    const user = await db.createAdminUser(testDb, { id: 'admuser_me', email: 'me@example.com', name: 'Me', role: 'staff', status: 'active' });
    const cookie = await cookieHeaderFor({ uid: user.id, role: user.role, email: user.email });
    const res = await worker.fetch(req('GET', '/admin/api/me', { cookie }), env, CTX);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.email, 'me@example.com');
    assert.equal(body.role, 'staff');
    assert.equal(body.name, 'Me');
  });

  test('a staff/viewer session gets 403 on every /admin/api/users route', async () => {
    const env = BASE_ENV(testDb);
    const staffCookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const viewerCookie = await cookieHeaderFor({ uid: null, role: 'viewer', email: 'v@example.com' });
    for (const cookie of [staffCookie, viewerCookie]) {
      const list = await worker.fetch(req('GET', '/admin/api/users', { cookie }), env, CTX);
      assert.equal(list.status, 403);
      const invite = await worker.fetch(req('POST', '/admin/api/users', { cookie, body: { email: 'z@example.com', name: 'Z', role: 'viewer' } }), env, CTX);
      assert.equal(invite.status, 403);
    }
  });
});

// ---------------------------------------------------------------------------
// Migration sanity — the seeded owner rows exist and are idempotent.
// ---------------------------------------------------------------------------

describe('migrations/0025_admin_users.sql', () => {
  test('seeds both owner emails as active owners', async () => {
    const info = await db.getAdminUserByEmail(testDb, 'info@wogoamsterdam.com');
    const gmail = await db.getAdminUserByEmail(testDb, 'maroussiastyles@gmail.com');
    assert.equal(info.role, 'owner');
    assert.equal(info.status, 'active');
    assert.equal(gmail.role, 'owner');
    assert.equal(gmail.status, 'active');
  });

  test('the seed rows use INSERT OR IGNORE (re-running just the seed statements is idempotent)', () => {
    // Re-running the whole migration file isn't meaningful to test (CREATE
    // TABLE/ALTER TABLE aren't idempotent and wrangler never reapplies an
    // already-tracked migration) — what matters is that the SEED rows
    // specifically tolerate a second insert, which this isolates.
    const seedOnly = migration('0025_admin_users.sql')
      .split('\n')
      .filter((line) => line.startsWith('INSERT OR IGNORE') || line.startsWith("VALUES ('admuser_owner"))
      .join('\n');
    assert.doesNotThrow(() => testDb._raw.exec(seedOnly));
  });
});
