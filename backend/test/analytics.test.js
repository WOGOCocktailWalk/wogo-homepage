// test/analytics.test.js — business analytics (migrations/0025's
// idx_bookings_created, BUILD §19): the pure logic.js:buildBookingAnalytics
// aggregator on a seeded fixture (incl. comp bookings and a gift-card-paid
// booking), and the two full-stack endpoints
// (GET /admin/api/analytics, GET /admin/api/analytics/kpi) against a real
// seeded D1-shaped SQLite db.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { buildBookingAnalytics, analyticsRevenueCents } from '../src/logic.js';
import { handleAnalytics, handleAnalyticsKpi } from '../src/admin_api.js';
import { toPositional } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) {
  return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8');
}
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0017_map_by_weekday.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql', '0020_route_names.sql', '0021_inquiries.sql',
  '0022_bar_locale.sql', '0023_route_names_simple.sql', '0024_subscribers.sql', '0025_admin_users.sql', '0027_booking_utm.sql', '0028_bookings_email_lower_index.sql',
].map(migration).join('\n');

function run(db, sql, params = {}) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

// ---------------------------------------------------------------------------
// Pure aggregator — the core math, fully isolated from the DB.
// ---------------------------------------------------------------------------

describe('analyticsRevenueCents', () => {
  test('web booking: price × party, net of discount', () => {
    assert.equal(analyticsRevenueCents({ source: 'web', price_cents: 3000, party: 3, discount_cents: 500 }), 8500);
  });
  test('manual + payment_status comp -> 0, regardless of price', () => {
    assert.equal(analyticsRevenueCents({ source: 'manual', payment_status: 'comp', price_cents: 3000, party: 6 }), 0);
  });
  test('manual + payment_status free -> 0', () => {
    assert.equal(analyticsRevenueCents({ source: 'manual', payment_status: 'free', price_cents: 3000, party: 2 }), 0);
  });
  test('manual + paid_invoice -> full price (not comped)', () => {
    assert.equal(analyticsRevenueCents({ source: 'manual', payment_status: 'paid_invoice', price_cents: 3000, party: 2 }), 6000);
  });
  test('gift-card-paid booking: gift_applied_cents is deducted (money already recognized at card purchase)', () => {
    assert.equal(analyticsRevenueCents({ source: 'web', price_cents: 3000, party: 2, gift_applied_cents: 4000 }), 2000);
  });
  test('floors at 0 — a discount/gift amount bigger than the price never goes negative', () => {
    assert.equal(analyticsRevenueCents({ source: 'web', price_cents: 3000, party: 1, discount_cents: 9000 }), 0);
  });
});

describe('buildBookingAnalytics — seeded fixture', () => {
  const rows = [
    // Amsterdam, web, EN, Thursday 2026-01-01 (ISO weekday 4), 18:00, 2 guests, WELCOME10 discount
    { id: 'b1', route_id: 'ams', route_name: 'WOGO Amsterdam', city: 'Amsterdam', date: '2026-01-01', slot: '18:00', party: 2, created_at: '2025-12-20 10:00:00', source: 'web', locale: 'en', payment_status: null, discount_code: 'WELCOME10', discount_cents: 500, gift_applied_cents: 0, price_cents: 3000 },
    // Rotterdam, web, NL, Friday 2026-01-02 (weekday 5), 19:00, 4 guests, gift-card paid
    { id: 'b2', route_id: 'rot', route_name: 'Rotterdam Route 2', city: 'Rotterdam', date: '2026-01-02', slot: '19:00', party: 4, created_at: '2025-12-22 11:00:00', source: 'web', locale: 'nl', payment_status: null, discount_code: null, discount_cents: 0, gift_applied_cents: 6000, price_cents: 3000 },
    // Amsterdam, manual, comp booking -> 0 revenue
    { id: 'b3', route_id: 'ams', route_name: 'WOGO Amsterdam', city: 'Amsterdam', date: '2026-01-02', slot: '18:00', party: 6, created_at: '2026-01-02 09:00:00', source: 'manual', locale: 'en', payment_status: 'comp', discount_code: null, discount_cents: 0, gift_applied_cents: 0, price_cents: 3000 },
    // Amsterdam, manual, paid_invoice -> full revenue, same day as b1's walk-month but later week
    { id: 'b4', route_id: 'ams', route_name: 'WOGO Amsterdam', city: 'Amsterdam', date: '2026-01-10', slot: '18:00', party: 1, created_at: '2026-01-05 09:00:00', source: 'manual', locale: 'en', payment_status: 'paid_invoice', discount_code: null, discount_cents: 0, gift_applied_cents: 0, price_cents: 3000 },
  ];

  test('totals sum bookings/guests/revenue correctly, comp contributes 0 revenue but counts as a booking+guests', () => {
    const a = buildBookingAnalytics(rows, { group: 'day' });
    assert.equal(a.totals.bookings, 4);
    assert.equal(a.totals.guests, 2 + 4 + 6 + 1);
    // b1: 2*3000-500=5500, b2: 4*3000-6000=6000, b3: 0, b4: 3000
    assert.equal(a.totals.revenue_cents, 5500 + 6000 + 0 + 3000);
    assert.equal(a.totals.avg_party, a.totals.guests / 4);
  });

  test('day grouping: one bucket per distinct date', () => {
    const a = buildBookingAnalytics(rows, { group: 'day', dateField: 'date' });
    const periods = a.series.map((s) => s.period);
    assert.deepEqual(periods, ['2026-01-01', '2026-01-02', '2026-01-10']);
    const jan2 = a.series.find((s) => s.period === '2026-01-02');
    assert.equal(jan2.bookings, 2); // b2 + b3
    assert.equal(jan2.guests, 10);
    assert.equal(jan2.revenue_cents, 6000); // b2 only — b3 is comp
  });

  test('month grouping folds every January row into one bucket', () => {
    const a = buildBookingAnalytics(rows, { group: 'month', dateField: 'date' });
    assert.equal(a.series.length, 1);
    assert.equal(a.series[0].period, '2026-01');
    assert.equal(a.series[0].bookings, 4);
  });

  test('week grouping buckets by the ISO week\'s Monday', () => {
    const a = buildBookingAnalytics(rows, { group: 'week', dateField: 'date' });
    // 2026-01-01/02 are Thu/Fri of the week starting Mon 2025-12-29;
    // 2026-01-10 is a Saturday of the week starting Mon 2026-01-05.
    const periods = a.series.map((s) => s.period).sort();
    assert.deepEqual(periods, ['2025-12-29', '2026-01-05']);
  });

  test('dateField=created_at re-buckets by SALE date instead of walk date', () => {
    const a = buildBookingAnalytics(rows, { group: 'day', dateField: 'created_at' });
    const periods = a.series.map((s) => s.period).sort();
    assert.deepEqual(periods, ['2025-12-20', '2025-12-22', '2026-01-02', '2026-01-05']);
  });

  test('by_route / by_city breakdowns', () => {
    const a = buildBookingAnalytics(rows, {});
    const ams = a.by_route.find((r) => r.route_id === 'ams');
    assert.equal(ams.bookings, 3); // b1, b3, b4
    assert.equal(ams.guests, 2 + 6 + 1);
    assert.equal(ams.revenue_cents, 5500 + 0 + 3000);
    const amsCity = a.by_city.find((c) => c.city === 'Amsterdam');
    assert.equal(amsCity.bookings, 3);
  });

  test('by_weekday always returns all 7 days, Monday..Sunday, zeroed where absent', () => {
    const a = buildBookingAnalytics(rows, {});
    assert.equal(a.by_weekday.length, 7);
    assert.equal(a.by_weekday[0].label, 'Mon');
    assert.equal(a.by_weekday[6].label, 'Sun');
    // 2026-01-01 is a Thursday (weekday 4) -> index 3
    assert.equal(a.by_weekday[3].bookings, 1);
    // Tuesday (index 1) has nothing in this fixture
    assert.equal(a.by_weekday[1].bookings, 0);
  });

  test('by_source and by_locale', () => {
    const a = buildBookingAnalytics(rows, {});
    const web = a.by_source.find((s) => s.source === 'web');
    const manual = a.by_source.find((s) => s.source === 'manual');
    assert.equal(web.bookings, 2);
    assert.equal(manual.bookings, 2);
    const en = a.by_locale.find((l) => l.locale === 'en');
    const nl = a.by_locale.find((l) => l.locale === 'nl');
    assert.equal(en.bookings, 3);
    assert.equal(nl.bookings, 1);
  });

  test('discount_usage counts uses and sums discount_cents per code', () => {
    const a = buildBookingAnalytics(rows, {});
    assert.equal(a.discount_usage.length, 1);
    assert.equal(a.discount_usage[0].code, 'WELCOME10');
    assert.equal(a.discount_usage[0].uses, 1);
    assert.equal(a.discount_usage[0].total_discount_cents, 500);
  });

  test('an empty row set returns zeroed totals and a 7-row (all-zero) by_weekday, not an exception', () => {
    const a = buildBookingAnalytics([], {});
    assert.equal(a.totals.bookings, 0);
    assert.equal(a.totals.avg_party, 0);
    assert.equal(a.by_weekday.length, 7);
    assert.deepEqual(a.series, []);
  });
});

// ---------------------------------------------------------------------------
// Full-stack endpoints against a real seeded D1-shaped SQLite db.
// ---------------------------------------------------------------------------

function seedRoute(db, { id, city = 'Amsterdam', price_cents = 3000 } = {}) {
  run(db, `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,active)
            VALUES (:id,:name,:city,:price,10,6,'[1,2,3,4,5,6,7]','["18:00"]',1)`,
    { id, name: `Route ${id}`, city, price: price_cents });
}

function seedBooking(db, { id, route_id, date, slot = '18:00', party = 2, status = 'confirmed', source = 'web', locale = 'en', created_at, payment_status = null, discount_code = null, discount_cents = 0, gift_applied_cents = 0, email = 'guest@example.com' }) {
  run(db, `INSERT INTO bookings
      (id, route_id, date, slot, party, name, email, phone, locale, marketing_opt_in, status, created_at, source, payment_status, discount_code, discount_cents, gift_code, gift_applied_cents)
     VALUES (:id, :route_id, :date, :slot, :party, 'Guest', :email, NULL, :locale, 0, :status, :created_at, :source, :payment_status, :discount_code, :discount_cents, NULL, :gift_applied_cents)`,
    { id, route_id, date, slot, party, email, locale, status, created_at: created_at || `${date} 09:00:00`, source, payment_status, discount_code, discount_cents, gift_applied_cents });
}

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

function req(pathAndQuery) {
  return new Request(`https://api.example.com${pathAndQuery}`);
}

describe('GET /admin/api/analytics', () => {
  test('rejects a missing/invalid range', async () => {
    const res = await handleAnalytics(req('/admin/api/analytics'), { DB: db });
    assert.equal(res.status, 400);
  });

  test('rejects a range wider than the cap', async () => {
    const res = await handleAnalytics(req('/admin/api/analytics?from=2020-01-01&to=2026-12-31'), { DB: db });
    assert.equal(res.status, 400);
  });

  test('returns both series, breakdowns, and gift card / subscriber / inquiry figures for a seeded period', async () => {
    seedRoute(db, { id: 'ams', city: 'Amsterdam' });
    seedBooking(db, { id: 'b1', route_id: 'ams', date: '2026-02-05', party: 2, discount_code: 'WELCOME10', discount_cents: 500, created_at: '2026-02-01 10:00:00' });
    seedBooking(db, { id: 'b2', route_id: 'ams', date: '2026-02-10', party: 3, status: 'cancelled' });
    seedBooking(db, { id: 'b3', route_id: 'ams', date: '2026-02-12', party: 1, source: 'manual', payment_status: 'comp', created_at: '2026-02-12 08:00:00' });

    run(db, `INSERT INTO gift_cards (id, code, initial_cents, balance_cents, buyer_email, buyer_name, recipient_name, recipient_email, created_at)
              VALUES ('gc1','WOGO-AAAA-BBBB',5000,5000,'buyer@example.com','Buyer','Rec','rec@example.com','2026-02-03 12:00:00')`);
    run(db, `INSERT INTO inquiries (id, kind, name, email, message, created_at) VALUES ('inq1','contact','Q','q@example.com','hi','2026-02-04 12:00:00')`);
    run(db, `INSERT INTO subscribers (id, email, source, status, unsubscribe_token, confirmed_at, created_at) VALUES ('sub1','new@example.com','site_footer','confirmed','tok1','2026-02-06 12:00:00','2026-02-01 12:00:00')`);

    const res = await handleAnalytics(req('/admin/api/analytics?from=2026-02-01&to=2026-02-28&group=day'), { DB: db });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.totals.bookings, 2); // b1 + b3 (b2 cancelled, excluded)
    assert.equal(body.cancellations.count, 1);
    assert.equal(body.cancellations.guests, 3);
    assert.equal(body.gift_cards.sold_count, 1);
    assert.equal(body.gift_cards.sold_value_cents, 5000);
    assert.equal(body.gift_cards.outstanding_balance_cents, 5000);
    assert.equal(body.inquiries_by_kind.find((r) => r.kind === 'contact').n, 1);
    assert.equal(body.subscribers.new_confirmed, 1);
    assert.equal(body.subscribers.total_confirmed, 1);
    assert.ok(Array.isArray(body.series_by_booking_date));
    assert.ok(Array.isArray(body.series_by_sale_date));
    assert.equal(body.discount_usage[0].code, 'WELCOME10');
  });

  test('top_upcoming_days reflects confirmed guests on/after today, independent of the from/to window', async () => {
    seedRoute(db, { id: 'ams' });
    const today = new Date().toISOString().slice(0, 10);
    seedBooking(db, { id: 'future1', route_id: 'ams', date: today, party: 5, created_at: '2020-01-01 10:00:00' });
    const res = await handleAnalytics(req('/admin/api/analytics?from=2020-01-01&to=2020-01-02'), { DB: db });
    const body = await res.json();
    assert.ok(body.top_upcoming_days.some((d) => d.date === today && d.guests === 5));
  });
});

describe('GET /admin/api/analytics/kpi', () => {
  test('compares last 7 vs previous 7 days by sale date, and reports next-14-days guests by city', async () => {
    seedRoute(db, { id: 'ams', city: 'Amsterdam' });
    seedRoute(db, { id: 'rot', city: 'Rotterdam' });
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const daysAgo = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
    const daysAhead = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

    seedBooking(db, { id: 'k1', route_id: 'ams', date: daysAhead(5), party: 2, created_at: `${daysAgo(1)} 10:00:00` }); // last 7 days (sold)
    seedBooking(db, { id: 'k2', route_id: 'ams', date: daysAhead(5), party: 3, created_at: `${daysAgo(10)} 10:00:00` }); // previous 7 days (sold)
    seedBooking(db, { id: 'k3', route_id: 'rot', date: daysAhead(10), party: 4, created_at: `${daysAgo(1)} 10:00:00` }); // next-14-days-by-city

    const res = await handleAnalyticsKpi(req('/admin/api/analytics/kpi'), { DB: db });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.last_7_days.bookings, 2); // k1 (ams) + k3 (rot) sold in last 7 days
    assert.equal(body.previous_7_days.bookings, 1); // k2
    const amsCity = body.next_14_days_by_city.find((c) => c.city === 'Amsterdam');
    const rotCity = body.next_14_days_by_city.find((c) => c.city === 'Rotterdam');
    assert.equal(amsCity.guests, 5); // k1 (2) + k2 (3) — both walk on the same future Amsterdam date
    assert.equal(rotCity.guests, 4);
  });
});
