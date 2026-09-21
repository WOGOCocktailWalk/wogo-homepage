// test/currency_timezone.test.js — migrations/0011 (routes.currency,
// routes.timezone): end-to-end coverage the unit tests in logic.test.js
// don't reach — Stripe Checkout charging in the route's own currency, the
// admin route create/update endpoints validating + persisting both fields,
// the guest API serving them, and a full regression pass proving every
// existing NL route (default EUR / Europe/Amsterdam) is byte-for-byte
// unchanged.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional, getRoute } from '../src/db.js';
import { createCheckoutSession } from '../src/stripe.js';
import { handleCreateRoute, handleUpdateRoute } from '../src/admin_api.js';
import { handleListRoutes, handleAvailability, handleSlots, handleBook } from '../src/guest_api.js';
import { renderGuestConfirmation, renderOwnerNotification } from '../src/emails.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
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
  exec(
    db,
    `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`,
    route
  );
  return route;
}

const TODAY = new Date().toISOString().slice(0, 10);

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

// ---------------------------------------------------------------------------
// migrations/0011 itself — column defaults reproduce pre-migration behaviour
// ---------------------------------------------------------------------------

describe('migrations/0011 — routes.currency / routes.timezone defaults', () => {
  test('a route inserted WITHOUT currency/timezone (old-shaped INSERT) gets the NL defaults', async () => {
    seedRoute(db); // explicit column list, no currency/timezone
    const route = await getRoute(db, 'testroute');
    assert.equal(route.currency, 'EUR');
    assert.equal(route.timezone, 'Europe/Amsterdam');
  });

  test('a route can be seeded with an explicit non-NL currency/timezone', async () => {
    seedRoute(db, { id: 'london-test', currency: 'GBP', timezone: 'Europe/London' });
    const route = await getRoute(db, 'london-test');
    assert.equal(route.currency, 'GBP');
    assert.equal(route.timezone, 'Europe/London');
  });
});

// ---------------------------------------------------------------------------
// Stripe Checkout — charges in the route's own currency
// ---------------------------------------------------------------------------

describe('createCheckoutSession — currency per route', () => {
  const booking = { id: 'b_1', party: 2, date: TODAY, slot: '18:00', email: 'anna@example.com' };
  const env = { STRIPE_SECRET_KEY: 'sk_test_x' };

  let capturedBody;
  const realFetch = global.fetch;
  beforeEach(() => {
    capturedBody = null;
    global.fetch = async (url, opts) => {
      capturedBody = opts.body; // URLSearchParams
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/test' }), { status: 200 });
    };
  });
  afterEach(() => { global.fetch = realFetch; });

  test('an EUR route (default) checks out with currency=eur — NL unchanged', async () => {
    const route = { id: 'amsterdam', name: 'WOGO Amsterdam', price_cents: 2995, currency: 'EUR' };
    await createCheckoutSession(env, booking, route);
    assert.equal(capturedBody.get('line_items[0][price_data][currency]'), 'eur');
  });

  test('a route with no .currency at all still defaults to eur', async () => {
    const route = { id: 'amsterdam', name: 'WOGO Amsterdam', price_cents: 2995 };
    await createCheckoutSession(env, booking, route);
    assert.equal(capturedBody.get('line_items[0][price_data][currency]'), 'eur');
  });

  test('a GBP (London) route checks out with currency=gbp', async () => {
    const route = { id: 'london', name: 'WOGO London', price_cents: 3495, currency: 'GBP' };
    await createCheckoutSession(env, booking, route);
    assert.equal(capturedBody.get('line_items[0][price_data][currency]'), 'gbp');
    // unit_amount is still passed through untouched (price_cents is already
    // in the smallest unit of whatever currency the route uses).
    assert.equal(capturedBody.get('line_items[0][price_data][unit_amount]'), '3495');
  });

  test('a USD (NYC) route checks out with currency=usd', async () => {
    const route = { id: 'nyc', name: 'WOGO New York', price_cents: 3995, currency: 'USD' };
    await createCheckoutSession(env, booking, route);
    assert.equal(capturedBody.get('line_items[0][price_data][currency]'), 'usd');
  });
});

// ---------------------------------------------------------------------------
// Admin route create/update — currency + timezone fields
// ---------------------------------------------------------------------------

function adminRequest(method, path_, body) {
  return new Request(`https://admin.example.com${path_}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('handleCreateRoute — currency + timezone', () => {
  test('omitting currency/timezone defaults to EUR / Europe/Amsterdam (NL unchanged)', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'utrecht2', name: 'Utrecht 2', city: 'Utrecht', price_cents: 2995,
      open_days: '[1,2,3]', slots: '["18:00"]',
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.equal(route.currency, 'EUR');
    assert.equal(route.timezone, 'Europe/Amsterdam');
  });

  test('a valid GBP/Europe London route is created as given', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'london', name: 'WOGO London', city: 'London', price_cents: 3495,
      open_days: '[4,5,6]', slots: '["17:30","18:30"]',
      currency: 'GBP', timezone: 'Europe/London',
    }), env);
    assert.equal(res.status, 201);
    const { route } = await res.json();
    assert.equal(route.currency, 'GBP');
    assert.equal(route.timezone, 'Europe/London');
  });

  test('rejects a malformed currency code', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'bad1', name: 'Bad', city: 'X', price_cents: 1000,
      open_days: '[1]', slots: '["18:00"]', currency: 'eur',
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /currency/);
  });

  test('rejects an invalid IANA timezone', async () => {
    const env = { DB: db };
    const res = await handleCreateRoute(adminRequest('POST', '/admin/api/routes', {
      id: 'bad2', name: 'Bad', city: 'X', price_cents: 1000,
      open_days: '[1]', slots: '["18:00"]', timezone: 'Mars/OlympusMons',
    }), env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /timezone/);
  });
});

describe('handleUpdateRoute — currency + timezone', () => {
  test('updating currency/timezone on an existing NL route persists them', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      currency: 'GBP', timezone: 'Europe/London',
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);
    const { route } = await res.json();
    assert.equal(route.currency, 'GBP');
    assert.equal(route.timezone, 'Europe/London');
  });

  test('not touching currency/timezone in a PUT leaves them unchanged', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      price_cents: 3200,
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);
    const { route } = await res.json();
    assert.equal(route.currency, 'EUR');
    assert.equal(route.timezone, 'Europe/Amsterdam');
    assert.equal(route.price_cents, 3200);
  });

  test('rejects a malformed currency on update, leaving the stored value untouched', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      currency: 'XX',
    }), env, { id: 'testroute' });
    assert.equal(res.status, 400);
    const route = await getRoute(db, 'testroute');
    assert.equal(route.currency, 'EUR');
  });

  test('rejects an invalid timezone on update, leaving the stored value untouched', async () => {
    seedRoute(db);
    const env = { DB: db };
    const res = await handleUpdateRoute(adminRequest('PUT', '/admin/api/routes/testroute', {
      timezone: 'Not/AZone',
    }), env, { id: 'testroute' });
    assert.equal(res.status, 400);
    const route = await getRoute(db, 'testroute');
    assert.equal(route.timezone, 'Europe/Amsterdam');
  });
});

// ---------------------------------------------------------------------------
// Guest API — serves currency + timezone; NL routes behave identically
// ---------------------------------------------------------------------------

describe('guest_api.js — currency/timezone served, NL behaviour unchanged', () => {
  test('GET /api/routes includes currency + timezone per route', async () => {
    seedRoute(db);
    seedRoute(db, { id: 'london-test', city: 'London', currency: 'GBP', timezone: 'Europe/London' });
    const env = { DB: db };
    const res = await handleListRoutes(new Request('https://api.example.com/api/routes'), env);
    const { routes } = await res.json();
    const nl = routes.find((r) => r.id === 'testroute');
    const uk = routes.find((r) => r.id === 'london-test');
    assert.equal(nl.currency, 'EUR');
    assert.equal(nl.timezone, 'Europe/Amsterdam');
    assert.equal(uk.currency, 'GBP');
    assert.equal(uk.timezone, 'Europe/London');
  });

  test('GET /api/availability includes currency + timezone alongside the existing days map', async () => {
    seedRoute(db, { id: 'london-test', city: 'London', currency: 'GBP', timezone: 'Europe/London', open_days: '[1,2,3,4,5,6,7]' });
    const env = { DB: db };
    const month = TODAY.slice(0, 7);
    const res = await handleAvailability(new Request(`https://api.example.com/api/availability?route=london-test&month=${month}`), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.currency, 'GBP');
    assert.equal(body.timezone, 'Europe/London');
    assert.ok(body.days && typeof body.days === 'object');
  });

  test('GET /api/slots includes currency + timezone', async () => {
    seedRoute(db, { id: 'nyc-test', city: 'New York', currency: 'USD', timezone: 'America/New_York', open_days: '[1,2,3,4,5,6,7]' });
    const env = { DB: db };
    const res = await handleSlots(new Request(`https://api.example.com/api/slots?route=nyc-test&date=${TODAY}`), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.currency, 'USD');
    assert.equal(body.timezone, 'America/New_York');
  });

  test('an NL route (default EUR/Amsterdam) is bookable exactly as before this migration', async () => {
    seedRoute(db);
    const env = { DB: db };
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
    try {
      const res = await handleBook(new Request('https://api.example.com/api/book', {
        method: 'POST',
        body: JSON.stringify({
          route_id: 'testroute', date: TODAY, slot: '18:00', party: 2,
          name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
        }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.1.1', Origin: 'http://localhost:8000' },
      }), env);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.booking_id);
      assert.ok(body.checkout_url);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('a far-future date for a route in a DIFFERENT timezone is still correctly rejected as out of horizon', async () => {
    seedRoute(db, { id: 'nyc-test2', city: 'New York', currency: 'USD', timezone: 'America/New_York', open_days: '[1,2,3,4,5,6,7]' });
    const env = { DB: db };
    const res = await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST',
      body: JSON.stringify({
        route_id: 'nyc-test2', date: '2099-01-01', slot: '18:00', party: 2,
        name: 'Anna', email: 'anna@example.com', locale: 'en', marketing_opt_in: false,
      }),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.1.2', Origin: 'http://localhost:8000' },
    }), env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'route_closed');
  });
});

// ---------------------------------------------------------------------------
// Emails — price line uses the route's currency; NL emails unchanged
// ---------------------------------------------------------------------------

describe('emails.js — currency-aware price line', () => {
  const booking = { id: 'b_1', date: TODAY, slot: '18:00', party: 2, name: 'Anna', email: 'anna@example.com', locale: 'en' };

  test('an EUR route (default) still renders "€" with a comma decimal', () => {
    const route = { id: 'amsterdam', name: 'WOGO Amsterdam', city: 'Amsterdam', price_cents: 2995 };
    const mail = renderGuestConfirmation(booking, route);
    assert.ok(mail.html.includes('€59,90'), 'expected total for 2 guests at €29,95 each');
  });

  test('a GBP route renders "£" with a point decimal', () => {
    const route = { id: 'london', name: 'WOGO London', city: 'London', price_cents: 3495, currency: 'GBP' };
    const mail = renderGuestConfirmation(booking, route);
    assert.ok(mail.html.includes('£69.90'), 'expected total for 2 guests at £34.95 each');
    assert.ok(!mail.html.includes('€'), 'a GBP route email must never show a euro sign');
  });

  test('owner notification revenue line is also currency-aware', () => {
    const route = { id: 'nyc', name: 'WOGO New York', city: 'New York', price_cents: 3995, currency: 'USD' };
    const mail = renderOwnerNotification(booking, route, { arrivals: [] });
    assert.ok(mail.html.includes('$79.90'));
  });
});
