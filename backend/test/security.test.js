// test/security.test.js — SPEC.md §15: seat-hold abuse protection + admin
// login brute-force protection. Uses the same real-SQLite adapter as
// db.test.js (see test/sqlite-d1-adapter.js) so the D1-backed counters are
// exercised against actual SQL, not a hand-rolled fake.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { computeHoldExpiry, sqliteMinutesAgo } from '../src/logic.js';
import {
  createHold,
  countActiveHoldsByEmail,
  countActiveHoldsByIp,
  recordRateEvent,
  countRateEventsSince,
  pruneRateEvents,
  recordAuthEvent,
  listRecentLoginFailures,
  countLoginFailuresSince,
  listLoginFailures,
  pruneAuthEvents,
  expireHolds,
  cancelIfHold,
  toPositional,
} from '../src/db.js';

// The adapter is strict positional-only (like real D1); route named-param
// fixture SQL through the same translator production uses.
function exec(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values);
}
import { handleBook } from '../src/guest_api.js';
import { handleLogin, handleLoginAttempts } from '../src/admin_api.js';
import {
  MAX_ACTIVE_HOLDS_PER_EMAIL,
  MAX_ACTIVE_HOLDS_PER_IP,
  HOLD_ATTEMPTS_PER_WINDOW,
  HOLD_ATTEMPT_WINDOW_MINUTES,
  LOGIN_FAIL_THRESHOLD,
} from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql =
  readFileSync(path.join(__dirname, '../migrations/0001_init.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0003_slot_capacity.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0004_customers_manual_discount.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0005_security.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0006_error_log.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0007_admin_audit.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0008_failed_email.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0009_webhook_processing_status.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0010_booking_notes.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0011_currency_timezone.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0012_map_url_nl.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0014_weekday_capacity.sql'), 'utf8') +
  '\n' +
  readFileSync(path.join(__dirname, '../migrations/0015_weekday_bars.sql'), 'utf8');

// A near-future date that's always inside the 90-day booking horizon no
// matter when this suite runs (the seeded route is open every weekday) —
// avoids hardcoding an absolute date that silently drifts into the past.
const FUTURE_DATE = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function seedRoute(db, overrides = {}) {
  const route = {
    id: 'testroute',
    name: 'Test Route',
    city: 'Testville',
    price_cents: 2995,
    capacity: 50,
    max_party: 6,
    open_days: '[1,2,3,4,5,6,7]',
    slots: '["18:00"]',
    slot_capacity: '{}',
    map_url: null,
    active: 1,
    ...overrides,
  };
  exec(
    db,
    `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
     VALUES (:id, :name, :city, :price_cents, :capacity, :max_party, :open_days, :slots, :slot_capacity, :map_url, :active)`,
    route
  ).run();
  return route;
}

function makeHoldParams(overrides = {}) {
  return {
    id: `b_${Math.random().toString(36).slice(2)}`,
    route_id: 'testroute',
    date: FUTURE_DATE,
    slot: '18:00',
    party: 1,
    name: 'Anna',
    email: 'anna@example.com',
    phone: null,
    locale: 'en',
    marketing_opt_in: false,
    hold_expires: computeHoldExpiry(15),
    ip: '1.2.3.4',
    ...overrides,
  };
}

let db;
beforeEach(() => {
  db = makeTestDb(schemaSql);
  seedRoute(db);
});

// ---------------------------------------------------------------------------
// db.js — active-hold counters (SPEC.md §15.1)
// ---------------------------------------------------------------------------

describe('countActiveHoldsByEmail / countActiveHoldsByIp', () => {
  test('counts only unexpired holds for the given email', async () => {
    await createHold(db, makeHoldParams({ email: 'anna@example.com', slot: '18:00' }));
    await createHold(db, makeHoldParams({ email: 'anna@example.com', slot: '18:00' }));
    await createHold(db, makeHoldParams({ email: 'bram@example.com', slot: '18:00' }));
    assert.equal(await countActiveHoldsByEmail(db, 'anna@example.com'), 2);
    assert.equal(await countActiveHoldsByEmail(db, 'ANNA@EXAMPLE.COM'), 2, 'case-insensitive');
    assert.equal(await countActiveHoldsByEmail(db, 'bram@example.com'), 1);
    assert.equal(await countActiveHoldsByEmail(db, 'nobody@example.com'), 0);
  });

  test('an expired hold does not count', async () => {
    const past = '2000-01-01 00:00:00';
    await createHold(db, makeHoldParams({ email: 'anna@example.com', hold_expires: past }));
    assert.equal(await countActiveHoldsByEmail(db, 'anna@example.com'), 0);
  });

  test('counts only unexpired holds for the given IP', async () => {
    await createHold(db, makeHoldParams({ ip: '9.9.9.9', email: 'a@example.com' }));
    await createHold(db, makeHoldParams({ ip: '9.9.9.9', email: 'b@example.com' }));
    await createHold(db, makeHoldParams({ ip: '8.8.8.8', email: 'c@example.com' }));
    assert.equal(await countActiveHoldsByIp(db, '9.9.9.9'), 2);
    assert.equal(await countActiveHoldsByIp(db, '8.8.8.8'), 1);
    assert.equal(await countActiveHoldsByIp(db, 'unseen'), 0);
  });

  test('ip is cleared once a hold resolves (confirm/cancel/expire) — never retained', async () => {
    const params = makeHoldParams({ ip: '5.5.5.5' });
    const { booking } = await createHold(db, params);
    assert.equal(await countActiveHoldsByIp(db, '5.5.5.5'), 1);

    await cancelIfHold(db, booking.id);
    assert.equal(await countActiveHoldsByIp(db, '5.5.5.5'), 0);

    const row = exec(db, `SELECT ip FROM bookings WHERE id = :id`, { id: booking.id }).first();
    assert.equal(row.ip, null);
  });

  test('expireHolds clears ip on swept rows too', async () => {
    const params = makeHoldParams({ ip: '6.6.6.6', hold_expires: '2000-01-01 00:00:00' });
    const { booking } = await createHold(db, params);
    await expireHolds(db);
    const row = exec(db, `SELECT ip, status FROM bookings WHERE id = :id`, { id: booking.id }).first();
    assert.equal(row.status, 'expired');
    assert.equal(row.ip, null);
  });
});

// ---------------------------------------------------------------------------
// db.js — rate_events sliding window (SPEC.md §15.1)
// ---------------------------------------------------------------------------

describe('rate_events sliding window', () => {
  test('counts only events inside the window', async () => {
    // recordRateEvent writes real SQLite datetime('now'), so the window
    // cutoff must be computed against the REAL current time too (not a
    // fixed fake date) — only the one directly-inserted row is deliberately
    // stale (year 2000), simulating an event from outside the window.
    await recordRateEvent(db, 'book', '1.1.1.1');
    await recordRateEvent(db, 'book', '1.1.1.1');
    await recordRateEvent(db, 'book', '1.1.1.1');
    db.prepare(`INSERT INTO rate_events (kind, identity, created_at) VALUES ('book', '1.1.1.1', '2000-01-01 00:00:00')`).bind().run();

    const since = sqliteMinutesAgo(HOLD_ATTEMPT_WINDOW_MINUTES);
    const count = await countRateEventsSince(db, 'book', '1.1.1.1', since);
    assert.equal(count, 3, 'the stale row outside the window must not count');
  });

  test('different identities are counted separately', async () => {
    await recordRateEvent(db, 'book', 'ip-a');
    await recordRateEvent(db, 'book', 'ip-b');
    const since = sqliteMinutesAgo(HOLD_ATTEMPT_WINDOW_MINUTES);
    assert.equal(await countRateEventsSince(db, 'book', 'ip-a', since), 1);
    assert.equal(await countRateEventsSince(db, 'book', 'ip-b', since), 1);
  });

  test('pruneRateEvents deletes only rows older than the cutoff', async () => {
    db.prepare(`INSERT INTO rate_events (kind, identity, created_at) VALUES ('book', 'x', '2000-01-01 00:00:00')`).bind().run();
    await recordRateEvent(db, 'book', 'x'); // fresh, "now"
    const deleted = await pruneRateEvents(db, sqliteMinutesAgo(60));
    assert.equal(deleted, 1);
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM rate_events`).bind().first();
    assert.equal(remaining.n, 1);
  });
});

// ---------------------------------------------------------------------------
// db.js — auth_events / login lockout support (SPEC.md §15.2)
// ---------------------------------------------------------------------------

describe('auth_events', () => {
  test('listRecentLoginFailures only returns fails after the last success', async () => {
    await recordAuthEvent(db, '2.2.2.2', 0);
    await recordAuthEvent(db, '2.2.2.2', 0);
    await recordAuthEvent(db, '2.2.2.2', 1); // success resets
    await recordAuthEvent(db, '2.2.2.2', 0);

    const fails = await listRecentLoginFailures(db, '2.2.2.2', sqliteMinutesAgo(24 * 60));
    assert.equal(fails.length, 1, 'only the fail AFTER the success should count');
  });

  test('failures are scoped per IP', async () => {
    await recordAuthEvent(db, '2.2.2.2', 0);
    await recordAuthEvent(db, '3.3.3.3', 0);
    await recordAuthEvent(db, '3.3.3.3', 0);
    assert.equal((await listRecentLoginFailures(db, '2.2.2.2', sqliteMinutesAgo(60))).length, 1);
    assert.equal((await listRecentLoginFailures(db, '3.3.3.3', sqliteMinutesAgo(60))).length, 2);
  });

  test('countLoginFailuresSince / listLoginFailures power the audit endpoint', async () => {
    await recordAuthEvent(db, '4.4.4.4', 0);
    await recordAuthEvent(db, '5.5.5.5', 0);
    await recordAuthEvent(db, '5.5.5.5', 1);
    assert.equal(await countLoginFailuresSince(db, sqliteMinutesAgo(60)), 2);
    const recent = await listLoginFailures(db, 10);
    assert.equal(recent.length, 2);
    assert.ok(recent.every((r) => typeof r.ip === 'string' && typeof r.created_at === 'string'));
  });

  test('pruneAuthEvents deletes only rows older than the cutoff', async () => {
    db.prepare(`INSERT INTO auth_events (ip, ok, created_at) VALUES ('7.7.7.7', 0, '2000-01-01 00:00:00')`).bind().run();
    await recordAuthEvent(db, '7.7.7.7', 0);
    const deleted = await pruneAuthEvents(db, sqliteMinutesAgo(60));
    assert.equal(deleted, 1);
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM auth_events`).bind().first();
    assert.equal(remaining.n, 1);
  });
});

// ---------------------------------------------------------------------------
// guest_api.js: handleBook — full stack (rate limit + hold caps + validation)
// ---------------------------------------------------------------------------

function bookRequest(bodyOverrides = {}, headers = {}) {
  const body = {
    route_id: 'testroute',
    date: FUTURE_DATE,
    slot: '18:00',
    party: 1,
    name: 'Anna',
    email: 'anna@example.com',
    phone: null,
    locale: 'en',
    marketing_opt_in: false,
    ...bodyOverrides,
  };
  return new Request('https://api.example.com/api/book', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.1', ...headers },
  });
}

// handleBook calls stripe.createCheckoutSession — stub fetch for every test
// below so none of them hit the network; a successful "checkout" response is
// enough to prove the request got PAST the security gates being tested.
const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = async () =>
    new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/test' }), { status: 200 });
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('POST /api/book — hold caps per email/IP', () => {
  test(`rejects the ${MAX_ACTIVE_HOLDS_PER_EMAIL + 1}th active hold for the same email with 429`, async () => {
    const env = { DB: db };
    for (let i = 0; i < MAX_ACTIVE_HOLDS_PER_EMAIL; i++) {
      const res = await handleBook(bookRequest({ email: 'cap@example.com' }, { Origin: 'http://localhost:8000' }), env);
      assert.equal(res.status, 200, `hold ${i + 1} should succeed`);
    }
    const res = await handleBook(bookRequest({ email: 'cap@example.com' }, { Origin: 'http://localhost:8000' }), env);
    const json = await res.json();
    assert.equal(res.status, 429);
    assert.equal(json.error, 'too_many_requests');
  });

  test(`rejects the ${MAX_ACTIVE_HOLDS_PER_IP + 1}th active hold for the same IP even across different emails`, async () => {
    const env = { DB: db };
    for (let i = 0; i < MAX_ACTIVE_HOLDS_PER_IP; i++) {
      const res = await handleBook(
        bookRequest({ email: `guest${i}@example.com` }, { Origin: 'http://localhost:8000', 'CF-Connecting-IP': '10.0.0.9' }),
        env
      );
      assert.equal(res.status, 200);
    }
    const res = await handleBook(
      bookRequest({ email: 'onemore@example.com' }, { Origin: 'http://localhost:8000', 'CF-Connecting-IP': '10.0.0.9' }),
      env
    );
    assert.equal(res.status, 429);
  });

  test('a DIFFERENT ip is unaffected by another IP being capped', async () => {
    const env = { DB: db };
    for (let i = 0; i < MAX_ACTIVE_HOLDS_PER_IP; i++) {
      await handleBook(
        bookRequest({ email: `x${i}@example.com` }, { Origin: 'http://localhost:8000', 'CF-Connecting-IP': '10.0.0.50' }),
        env
      );
    }
    const res = await handleBook(
      bookRequest({ email: 'fresh@example.com' }, { Origin: 'http://localhost:8000', 'CF-Connecting-IP': '10.0.0.51' }),
      env
    );
    assert.equal(res.status, 200);
  });
});

describe('POST /api/book — per-IP attempt rate limit (sliding window)', () => {

  test(`the ${HOLD_ATTEMPTS_PER_WINDOW + 1}th attempt in the window from one IP is 429, even against DIFFERENT emails/slots`, async () => {
    // Use different emails each time so the hold-cap layer isn't what trips
    // it — this isolates the rate-limit layer specifically. Route has
    // capacity 50 so seat capacity isn't the limiter either.
    const env = { DB: db };
    let lastStatus;
    for (let i = 0; i < HOLD_ATTEMPTS_PER_WINDOW + 1; i++) {
      const res = await handleBook(
        bookRequest({ email: `rl${i}@example.com` }, { Origin: 'http://localhost:8000', 'CF-Connecting-IP': '10.0.0.77' }),
        env
      );
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });

  test('attempts outside the window are not counted (old rate_events pruned/ignored)', async () => {
    const env = { DB: db };
    // Manually insert HOLD_ATTEMPTS_PER_WINDOW stale attempts far outside the window.
    for (let i = 0; i < HOLD_ATTEMPTS_PER_WINDOW; i++) {
      db.prepare(`INSERT INTO rate_events (kind, identity, created_at) VALUES ('book', '10.0.0.88', '2000-01-01 00:00:00')`).bind().run();
    }
    const res = await handleBook(
      bookRequest({ email: 'fresh2@example.com' }, { Origin: 'http://localhost:8000', 'CF-Connecting-IP': '10.0.0.88' }),
      env
    );
    assert.equal(res.status, 200, 'stale attempts outside the window must not count toward the limit');
  });
});

describe('POST /api/book — origin check (defense in depth beyond CORS)', () => {
  test('a browser Origin not on the allowlist is rejected with 403', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({}, { Origin: 'https://evil.example.com' }), env);
    assert.equal(res.status, 403);
  });
  test('no Origin header (server-to-server / curl) is not origin-blocked', async () => {
    const env = { DB: db };
    const req = bookRequest({}, {});
    req.headers.delete = req.headers.delete; // no-op, Request headers are immutable after construction
    const res = await handleBook(new Request(req.url, { method: 'POST', body: JSON.stringify({
      route_id: 'testroute', date: FUTURE_DATE, slot: '18:00', party: 1, name: 'Anna', email: 'noorigin@example.com',
    }), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.5' } }), env);
    assert.equal(res.status, 200);
  });
});

describe('POST /api/book — input validation hardening', () => {
  test('rejects a syntactically-valid but non-existent calendar date', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ date: '2026-02-30' }, { Origin: 'http://localhost:8000' }), env);
    assert.equal(res.status, 400);
  });
  test('rejects a date far outside the booking horizon', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ date: '2030-01-01' }, { Origin: 'http://localhost:8000' }), env);
    assert.equal(res.status, 409);
  });
  test('rejects a slot that does not exist for the route', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ slot: '03:00' }, { Origin: 'http://localhost:8000' }), env);
    assert.equal(res.status, 409);
  });
  test('rejects an absurd party size before it ever reaches route.max_party', async () => {
    const env = { DB: db };
    const res = await handleBook(bookRequest({ party: 10000 }, { Origin: 'http://localhost:8000' }), env);
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// admin_api.js: handleLogin — lockout after N failed attempts
// ---------------------------------------------------------------------------

function loginRequest(token, ip = '20.0.0.1') {
  return new Request('https://api.example.com/admin/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  });
}

describe('POST /admin/login — brute-force lockout', () => {
  const env = () => ({ DB: db, ADMIN_TOKEN: 'correct-horse-battery-staple', ADMIN_SESSION_SECRET: 'sess-secret', ENVIRONMENT: 'production' });

  test('wrong token fails with 401 and is recorded', async () => {
    const res = await handleLogin(loginRequest('wrong'), env());
    assert.equal(res.status, 401);
  });

  test(`locks out after ${LOGIN_FAIL_THRESHOLD} failed attempts from the same IP`, async () => {
    const e = env();
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD; i++) {
      const res = await handleLogin(loginRequest('wrong', '20.0.0.2'), e);
      assert.equal(res.status, 401, `attempt ${i + 1} should be a plain 401`);
    }
    // Now locked — even the CORRECT token must be rejected without being checked.
    const res = await handleLogin(loginRequest('correct-horse-battery-staple', '20.0.0.2'), e);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, 'too_many_attempts');
    assert.ok(res.headers.get('Retry-After'));
  });

  test('a DIFFERENT ip is not affected by another IP being locked out', async () => {
    const e = env();
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD; i++) {
      await handleLogin(loginRequest('wrong', '20.0.0.3'), e);
    }
    const res = await handleLogin(loginRequest('correct-horse-battery-staple', '20.0.0.4'), e);
    assert.equal(res.status, 200);
  });

  test('a successful login resets the fail count for that IP', async () => {
    const e = env();
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD - 1; i++) {
      await handleLogin(loginRequest('wrong', '20.0.0.5'), e);
    }
    const okRes = await handleLogin(loginRequest('correct-horse-battery-staple', '20.0.0.5'), e);
    assert.equal(okRes.status, 200);

    // Fail count should be back to 0 — this IP can fail LOGIN_FAIL_THRESHOLD-1
    // more times without being locked.
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD - 1; i++) {
      const res = await handleLogin(loginRequest('wrong', '20.0.0.5'), e);
      assert.equal(res.status, 401, 'should not be locked yet — count was reset by the success');
    }
  });

  test('correct token succeeds and sets a HttpOnly/Secure/SameSite=Strict cookie', async () => {
    const res = await handleLogin(loginRequest('correct-horse-battery-staple', '20.0.0.6'), env());
    assert.equal(res.status, 200);
    const cookie = res.headers.get('Set-Cookie');
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('Secure'));
    assert.ok(cookie.includes('SameSite=Strict'));
  });

  test('an oversized token is rejected before any comparison (defensive cap)', async () => {
    const res = await handleLogin(loginRequest('x'.repeat(10000), '20.0.0.7'), env());
    assert.equal(res.status, 401);
  });
});

describe('GET /admin/api/security/login-attempts — audit endpoint', () => {
  test('reports failed-login counts and a recent list', async () => {
    const e = { DB: db, ADMIN_TOKEN: 't', ADMIN_SESSION_SECRET: 's', ENVIRONMENT: 'production' };
    await handleLogin(loginRequest('wrong', '21.0.0.1'), e);
    await handleLogin(loginRequest('wrong', '21.0.0.2'), e);

    const res = await handleLoginAttempts(new Request('https://api.example.com/admin/api/security/login-attempts'), e);
    const body = await res.json();
    assert.equal(body.failed_24h, 2);
    assert.equal(body.recent_failures.length, 2);
  });
});
