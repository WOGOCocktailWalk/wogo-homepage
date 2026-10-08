// test/highlights.test.js — the Highlights page (BUILD §19.4): the pure
// math (logic.js:buildHighlightsSales/computePctDelta/computeConversionRate/
// pageViewsByCity) and the full GET /admin/api/analytics/highlights endpoint
// against a real seeded D1-shaped SQLite db (GA4 unconfigured + configured
// via a mocked global.fetch, mirroring test/ga4.test.js's pattern).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import {
  buildHighlightsSales, computePctDelta, computeConversionRate, pageViewsByCity, DIRECT_SOURCE_LABEL,
} from '../src/logic.js';
import { handleAnalyticsHighlights } from '../src/admin_api.js';
import { toPositional } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0017_map_by_weekday.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql', '0020_route_names.sql', '0021_inquiries.sql',
  '0022_bar_locale.sql', '0023_route_names_simple.sql', '0024_subscribers.sql', '0025_admin_users.sql',
  '0027_booking_utm.sql', '0028_bookings_email_lower_index.sql', '0029_route_booking_cutoff.sql',
].map(migration).join('\n');

function run(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

describe('computePctDelta', () => {
  test('a plain increase/decrease', () => {
    assert.equal(computePctDelta(150, 100), 50);
    assert.equal(computePctDelta(50, 100), -50);
  });
  test('zero -> zero is 0% (no change, not "new")', () => {
    assert.equal(computePctDelta(0, 0), 0);
  });
  test('zero previous, some current -> null ("new this period", not Infinity)', () => {
    assert.equal(computePctDelta(500, 0), null);
  });
});

describe('computeConversionRate', () => {
  test('orders / sessions as a plain ratio', () => {
    assert.equal(computeConversionRate(5, 100), 0.05);
  });
  test('zero sessions -> 0, never NaN/Infinity', () => {
    assert.equal(computeConversionRate(5, 0), 0);
    assert.equal(computeConversionRate(0, 0), 0);
  });
  test('null/undefined sessions -> 0', () => {
    assert.equal(computeConversionRate(3, null), 0);
    assert.equal(computeConversionRate(3, undefined), 0);
  });
});

describe('pageViewsByCity', () => {
  test('groups by the page path\'s first segment, drops unknown segments, drops zero-view cities', () => {
    const rows = [
      { page: '/amsterdam/book/', views: 40 }, { page: '/amsterdam/', views: 60 },
      { page: '/rotterdam/route-1/', views: 20 }, { page: '/faq/', views: 15 }, { page: '/', views: 500 },
    ];
    const result = pageViewsByCity(rows);
    assert.deepEqual(result.find((r) => r.city === 'amsterdam'), { city: 'amsterdam', views: 100 });
    assert.deepEqual(result.find((r) => r.city === 'rotterdam'), { city: 'rotterdam', views: 20 });
    assert.equal(result.find((r) => r.city === 'utrecht'), undefined, 'a city with zero views is dropped, not zeroed');
    assert.equal(result.length, 2);
  });
});

describe('buildHighlightsSales', () => {
  const rows = [
    { id: 'b1', route_id: 'ams', route_name: 'WOGO Amsterdam', city: 'Amsterdam', date: '2026-02-01', party: 2, email: 'anna@x.com', name: 'Anna', price_cents: 3000, discount_cents: 0, gift_applied_cents: 0, utm_source: 'facebook' },
    { id: 'b2', route_id: 'ams', route_name: 'WOGO Amsterdam', city: 'Amsterdam', date: '2026-02-01', party: 3, email: 'bob@x.com', name: 'Bob', price_cents: 3000, discount_cents: 0, gift_applied_cents: 0, utm_source: null },
    { id: 'b3', route_id: 'rot', route_name: 'Rotterdam', city: 'Rotterdam', date: '2026-02-03', party: 1, email: 'anna@x.com', name: 'Anna', city_from_row: true, price_cents: 3000, discount_cents: 0, gift_applied_cents: 0, utm_source: 'facebook' },
  ];

  test('daily is zero-filled across the whole range, never skipping a day', () => {
    const r = buildHighlightsSales(rows, '2026-02-01', '2026-02-03', { dateField: 'date' });
    assert.equal(r.daily.length, 3);
    assert.deepEqual(r.daily.map((d) => d.date), ['2026-02-01', '2026-02-02', '2026-02-03']);
    assert.equal(r.daily[1].orders, 0);
    assert.equal(r.daily[1].customers, 0);
  });

  test('a single-day range still returns exactly one zero-filled day', () => {
    const r = buildHighlightsSales([], '2026-03-01', '2026-03-01', { dateField: 'date' });
    assert.equal(r.daily.length, 1);
    assert.equal(r.daily[0].date, '2026-03-01');
  });

  test('customers is DISTINCT emails per day and per period, not a sum (a repeat guest counts once)', () => {
    const r = buildHighlightsSales(rows, '2026-02-01', '2026-02-03', { dateField: 'date' });
    assert.equal(r.daily[0].customers, 2); // anna + bob on 02-01
    assert.equal(r.daily[2].customers, 1); // anna again on 02-03
    assert.equal(r.totals.customers, 2); // anna + bob, period-wide — anna's 2nd order doesn't make it 3
  });

  test('totals.avg_order_value_cents = revenue / orders, rounded', () => {
    const r = buildHighlightsSales(rows, '2026-02-01', '2026-02-03', { dateField: 'date' });
    assert.equal(r.totals.orders, 3);
    assert.equal(r.totals.revenue_cents, 6000 + 9000 + 3000);
    assert.equal(r.totals.avg_order_value_cents, Math.round((6000 + 9000 + 3000) / 3));
  });

  test('an empty row set still returns a zero-filled daily series and zeroed totals, never an exception', () => {
    const r = buildHighlightsSales([], '2026-02-01', '2026-02-02', { dateField: 'date' });
    assert.equal(r.daily.length, 2);
    assert.equal(r.totals.orders, 0);
    assert.equal(r.totals.avg_order_value_cents, 0);
    assert.deepEqual(r.by_route, []);
    assert.deepEqual(r.top_customers, []);
  });

  test('by_route sums revenue/guests/orders per route, revenue-descending', () => {
    const r = buildHighlightsSales(rows, '2026-02-01', '2026-02-03', { dateField: 'date' });
    assert.equal(r.by_route[0].route_id, 'ams');
    assert.equal(r.by_route[0].revenue_cents, 6000 + 9000);
    assert.equal(r.by_route[0].guests, 5);
    assert.equal(r.by_route[1].route_id, 'rot');
  });

  test('by_source groups utm_source, falling back to DIRECT_SOURCE_LABEL for null', () => {
    const r = buildHighlightsSales(rows, '2026-02-01', '2026-02-03', { dateField: 'date' });
    const fb = r.by_source.find((s) => s.source === 'facebook');
    const direct = r.by_source.find((s) => s.source === DIRECT_SOURCE_LABEL);
    assert.equal(fb.orders, 2); // b1 + b3
    assert.equal(fb.revenue_cents, 6000 + 3000);
    assert.equal(direct.orders, 1); // b2
  });

  test('top_customers sorts by total_cents descending, aggregating repeat guests, with their MOST RECENT name/city', () => {
    const r = buildHighlightsSales(rows, '2026-02-01', '2026-02-03', { dateField: 'date' });
    assert.equal(r.top_customers[0].email, 'anna@x.com');
    assert.equal(r.top_customers[0].orders, 2);
    assert.equal(r.top_customers[0].total_cents, 6000 + 3000);
    assert.equal(r.top_customers[0].city, 'Rotterdam'); // 02-03 is her latest booking
  });

  test('respects opts.topCustomersLimit', () => {
    const manyRows = Array.from({ length: 15 }, (_, i) => ({
      id: `b${i}`, route_id: 'ams', route_name: 'WOGO Amsterdam', city: 'Amsterdam', date: '2026-02-01',
      party: 1, email: `guest${i}@x.com`, name: `Guest ${i}`, price_cents: 1000 * (i + 1), discount_cents: 0, gift_applied_cents: 0,
    }));
    const r = buildHighlightsSales(manyRows, '2026-02-01', '2026-02-01', { topCustomersLimit: 5, dateField: 'date' });
    assert.equal(r.top_customers.length, 5);
    assert.equal(r.top_customers[0].email, 'guest14@x.com'); // highest price_cents
  });

  test('defaults to created_at (SALE date) when dateField is omitted — matches the Highlights endpoint\'s actual call', () => {
    const soldAndWalkedSameDay = { id: 'x1', route_id: 'ams', route_name: 'WOGO Amsterdam', city: 'Amsterdam', date: '2026-05-01', created_at: '2026-02-02 10:00:00', party: 2, email: 'a@x.com', name: 'A', price_cents: 3000, discount_cents: 0, gift_applied_cents: 0 };
    const r = buildHighlightsSales([soldAndWalkedSameDay], '2026-02-01', '2026-02-03');
    assert.equal(r.daily.find((d) => d.date === '2026-02-02').orders, 1, 'bucketed by created_at (02-02), not the 05-01 walk date');
    assert.equal(r.totals.orders, 1);
  });
});

// ---------------------------------------------------------------------------
// Full-stack endpoint
// ---------------------------------------------------------------------------

function seedRoute(db, { id, city = 'Amsterdam', price_cents = 3000 } = {}) {
  run(db, `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,active)
            VALUES (:id,:name,:city,:price,10,6,'[1,2,3,4,5,6,7]','["18:00"]',1)`,
    { id, name: `Route ${id}`, city, price: price_cents });
}

function seedBooking(db, { id, route_id, date, slot = '18:00', party = 2, status = 'confirmed', created_at, email = 'guest@example.com', name = 'Guest', utm_source = null }) {
  run(db, `INSERT INTO bookings
      (id, route_id, date, slot, party, name, email, phone, locale, marketing_opt_in, status, created_at, source, utm_source)
     VALUES (:id, :route_id, :date, :slot, :party, :name, :email, NULL, 'en', 0, :status, :created_at, 'web', :utm_source)`,
    { id, route_id, date, slot, party, name, email, status, created_at: created_at || `${date} 09:00:00`, utm_source });
}

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

function req(pathAndQuery) { return new Request(`https://api.example.com${pathAndQuery}`); }

describe('GET /admin/api/analytics/highlights', () => {
  test('rejects a missing/invalid range', async () => {
    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights'), { DB: db });
    assert.equal(res.status, 400);
  });

  test('previous period is the SAME length immediately preceding [from, to]', async () => {
    seedRoute(db, { id: 'ams' });
    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), { DB: db });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.previous_from, '2026-01-25');
    assert.equal(body.previous_to, '2026-02-07');
  });

  test('Highlights is SALE-date (created_at), not walk date — a booking sold in-range for a walk outside it still counts, and vice versa is excluded', async () => {
    seedRoute(db, { id: 'ams' });
    // Sold inside [2026-02-08, 2026-02-21], but the WALK itself is in March —
    // must still count (this is "what sold in this period").
    seedBooking(db, { id: 'sold_in_range', route_id: 'ams', date: '2026-03-15', party: 2, created_at: '2026-02-10 09:00:00' });
    // The WALK falls inside the range, but it was SOLD back in January —
    // must NOT count toward this period's sales.
    seedBooking(db, { id: 'walk_in_range_only', route_id: 'ams', date: '2026-02-12', party: 9, created_at: '2026-01-05 09:00:00' });

    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), { DB: db });
    const body = await res.json();
    assert.equal(body.sales.totals.orders, 1, 'only the booking SOLD in-range counts');
    assert.equal(body.sales.totals.guests, 2, 'the 9-guest booking (walk in-range, sold in January) must be excluded');
  });

  test('sales totals/daily reflect the current period; previous_sales reflects the preceding one', async () => {
    seedRoute(db, { id: 'ams' });
    seedBooking(db, { id: 'cur1', route_id: 'ams', date: '2026-02-10', party: 3, created_at: '2026-02-10 09:00:00' });
    seedBooking(db, { id: 'prev1', route_id: 'ams', date: '2026-01-29', party: 5, created_at: '2026-01-29 09:00:00' });

    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), { DB: db });
    const body = await res.json();
    assert.equal(body.sales.totals.orders, 1);
    assert.equal(body.sales.totals.guests, 3);
    assert.equal(body.previous_sales.totals.orders, 1);
    assert.equal(body.previous_sales.totals.guests, 5);
  });

  test('top_selling_items carries a poster_url and a pct_delta vs the previous period', async () => {
    seedRoute(db, { id: 'amsterdam', city: 'Amsterdam' });
    seedBooking(db, { id: 'cur1', route_id: 'amsterdam', date: '2026-02-10', party: 2, created_at: '2026-02-10 09:00:00' });
    seedBooking(db, { id: 'prev1', route_id: 'amsterdam', date: '2026-01-29', party: 1, created_at: '2026-01-29 09:00:00' });

    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), { DB: db });
    const body = await res.json();
    const item = body.top_selling_items.find((i) => i.route_id === 'amsterdam');
    assert.ok(item.poster_url, 'every item carries a poster_url (falls back to the branded banner)');
    assert.equal(item.pct_delta, 100); // 6000 now vs 3000 before -> +100%
  });

  test('a route with no previous-period rows at all shows pct_delta null ("new"), not a crash', async () => {
    seedRoute(db, { id: 'ams' });
    seedBooking(db, { id: 'cur1', route_id: 'ams', date: '2026-02-10', party: 1, created_at: '2026-02-10 09:00:00' });
    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), { DB: db });
    const body = await res.json();
    assert.equal(body.top_selling_items[0].pct_delta, null);
  });

  test('sales_by_source groups by utm_source with a delta, falling back to Direct / unknown', async () => {
    seedRoute(db, { id: 'ams' });
    seedBooking(db, { id: 'cur1', route_id: 'ams', date: '2026-02-10', party: 2, utm_source: 'facebook', created_at: '2026-02-10 09:00:00' });
    seedBooking(db, { id: 'cur2', route_id: 'ams', date: '2026-02-11', party: 1, created_at: '2026-02-11 09:00:00' });
    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), { DB: db });
    const body = await res.json();
    const fb = body.sales_by_source.find((s) => s.source === 'facebook');
    const direct = body.sales_by_source.find((s) => s.source === 'Direct / unknown');
    assert.ok(fb);
    assert.ok(direct);
  });

  test('top_paying_customers surfaces distinct guests sorted by spend', async () => {
    seedRoute(db, { id: 'ams' });
    seedBooking(db, { id: 'cur1', route_id: 'ams', date: '2026-02-10', party: 4, email: 'big@x.com', name: 'Big Spender', created_at: '2026-02-10 09:00:00' });
    seedBooking(db, { id: 'cur2', route_id: 'ams', date: '2026-02-11', party: 1, email: 'small@x.com', name: 'Small', created_at: '2026-02-11 09:00:00' });
    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), { DB: db });
    const body = await res.json();
    assert.equal(body.top_paying_customers[0].email, 'big@x.com');
  });

  test('GA4 unconfigured -> traffic.configured is false, the rest of the response still works', async () => {
    seedRoute(db, { id: 'ams' });
    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), { DB: db });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.traffic.configured, false);
    assert.ok(Array.isArray(body.sales.daily));
  });
});

// ---------------------------------------------------------------------------
// GA4 configured path — real fetch mock (token + runReport), proves the
// dual-dateRanges call is shaped and zero-filled correctly.
// ---------------------------------------------------------------------------

async function generateTestPrivateKeyPem() {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const der = await crypto.subtle.exportKey('pkcs8', privateKey);
  const bin = String.fromCharCode(...new Uint8Array(der));
  const b64 = btoa(bin);
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}
const TEST_PRIVATE_KEY_PEM = await generateTestPrivateKeyPem();

describe('GET /admin/api/analytics/highlights — GA4 configured', () => {
  let realFetch;
  afterEach(() => { if (realFetch) global.fetch = realFetch; });

  test('splits the dual-dateRanges report into daily/previous_daily, zero-filled, with correct totals', async () => {
    seedRoute(db, { id: 'ams' });
    realFetch = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      if (u.includes('analyticsdata.googleapis.com')) {
        return new Response(JSON.stringify({
          rows: [
            { dimensionValues: [{ value: '2026-02-10' }, { value: 'date_range_0' }], metricValues: [{ value: '50' }, { value: '120' }, { value: '40' }] },
            { dimensionValues: [{ value: '2026-01-27' }, { value: 'date_range_1' }], metricValues: [{ value: '30' }, { value: '80' }, { value: '25' }] },
          ],
        }), { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    };
    const env = { DB: db, GA4_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: TEST_PRIVATE_KEY_PEM }), GA4_PROPERTY_ID: '123' };

    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.traffic.configured, true);
    assert.equal(body.traffic.daily.length, 14);
    assert.equal(body.traffic.previous_daily.length, 14);
    const day10 = body.traffic.daily.find((d) => d.date === '2026-02-10');
    assert.equal(day10.sessions, 50);
    const zeroDay = body.traffic.daily.find((d) => d.date === '2026-02-09');
    assert.equal(zeroDay.sessions, 0, 'a day with no GA4 row zero-fills rather than being omitted');
    assert.equal(body.traffic.totals.sessions, 50);
    assert.equal(body.traffic.previous_totals.sessions, 30);
  });

  test('a failing GA4 report still returns ZEROED numeric totals, never the literal "undefined" the dashboard would otherwise render', async () => {
    seedRoute(db, { id: 'ams' });
    realFetch = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      if (u.includes('analyticsdata.googleapis.com')) return new Response('server error', { status: 500 });
      throw new Error('unmocked: ' + u);
    };
    const env = { DB: db, GA4_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: TEST_PRIVATE_KEY_PEM }), GA4_PROPERTY_ID: '123' };

    const res = await handleAnalyticsHighlights(req('/admin/api/analytics/highlights?from=2026-02-08&to=2026-02-21'), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.traffic.configured, true);
    assert.equal(body.traffic.totals.sessions, 0);
    assert.equal(body.traffic.totals.page_views, 0);
    assert.equal(body.traffic.totals.unique_visitors, 0);
    assert.equal(body.traffic.previous_totals.sessions, 0);
    assert.notEqual(typeof body.traffic.totals.sessions, 'undefined');
  });
});
