// test/realtime_behavior_marketing.test.js — the three remaining Analytics
// sub-pages (BUILD §19.4): Real-time (GA4 only), Behavior (GA4 + logic.js:
// pageViewsByCity), and Marketing (GA4 + D1 subscribers/discounts/gift
// cards). Each GA4 report is its own call (one bad dimension/metric
// combination degrades only its own section) — covered via deps injection,
// mirroring test/ga4.test.js's style.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional } from '../src/db.js';
import { getRealtimeSummary, getBehaviorSummary, getMarketingTraffic } from '../src/ga4.js';
import {
  handleAnalyticsRealtime, handleAnalyticsBehavior, handleAnalyticsMarketing,
} from '../src/admin_api.js';

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

function metricRow(dims, metrics) {
  return { dimensionValues: dims.map((v) => ({ value: v })), metricValues: metrics.map((v) => ({ value: String(v) })) };
}

const BASE_ENV = (db) => ({ DB: db, GA4_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: 'unused-with-deps' }), GA4_PROPERTY_ID: '123' });

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

// ---------------------------------------------------------------------------
// getRealtimeSummary (ga4.js) — direct unit tests via deps injection
// ---------------------------------------------------------------------------

describe('getRealtimeSummary', () => {
  test('unconfigured env -> {configured:false}, no fetch', async () => {
    const result = await getRealtimeSummary({});
    assert.deepEqual(result, { configured: false });
  });

  test('shapes activeUsers overview + by_page/by_country/by_device, each its own report', async () => {
    const seen = [];
    const deps = {
      getAccessToken: async () => 'tok',
      runRealtimeReport: async (token, propertyId, body) => {
        seen.push(body);
        const dims = (body.dimensions || []).map((d) => d.name);
        if (dims.length === 0) return { rows: [metricRow([], [42])] };
        if (dims[0] === 'unifiedScreenName') return { rows: [metricRow(['/amsterdam/book/'], [10]), metricRow(['/'], [8])] };
        if (dims[0] === 'country') return { rows: [metricRow(['Netherlands'], [30])] };
        if (dims[0] === 'deviceCategory') return { rows: [metricRow(['mobile'], [25]), metricRow(['desktop'], [17])] };
        throw new Error('unexpected: ' + JSON.stringify(body));
      },
    };
    const result = await getRealtimeSummary(BASE_ENV(null), deps);
    assert.equal(result.configured, true);
    assert.equal(result.active_users, 42);
    assert.deepEqual(result.by_page[0], { page: '/amsterdam/book/', active_users: 10 });
    assert.deepEqual(result.by_country[0], { country: 'Netherlands', active_users: 30 });
    assert.deepEqual(result.by_device[0], { device: 'mobile', active_users: 25 });
    // one dimension per report — never unifiedScreenName AND pagePath/country/device combined
    assert.equal(seen.length, 4);
    seen.forEach((b) => assert.ok((b.dimensions || []).length <= 1));
  });

  test('a failing individual report degrades to empty rather than failing the whole summary', async () => {
    const deps = {
      getAccessToken: async () => 'tok',
      runRealtimeReport: async (token, propertyId, body) => {
        if ((body.dimensions || []).length === 0) throw new Error('overview failed');
        return { rows: [] };
      },
    };
    const result = await getRealtimeSummary(BASE_ENV(null), deps);
    assert.equal(result.configured, true);
    assert.equal(result.active_users, 0);
    assert.deepEqual(result.by_page, []);
  });

  test('an auth failure returns {configured:false, error}', async () => {
    const result = await getRealtimeSummary(BASE_ENV(null), { getAccessToken: async () => { throw new Error('boom'); } });
    assert.equal(result.configured, false);
    assert.equal(result.error, 'ga4_auth_failed');
  });
});

describe('GET /admin/api/analytics/realtime', () => {
  test('unconfigured -> {configured:false}', async () => {
    const res = await handleAnalyticsRealtime(new Request('https://api.example.com/admin/api/analytics/realtime'), { DB: db });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { configured: false });
  });
});

// ---------------------------------------------------------------------------
// getBehaviorSummary (ga4.js)
// ---------------------------------------------------------------------------

describe('getBehaviorSummary', () => {
  test('unconfigured env -> {configured:false}', async () => {
    const result = await getBehaviorSummary({}, '2026-01-01', '2026-01-31');
    assert.deepEqual(result, { configured: false });
  });

  test('shapes top_pages/engagement/funnel/events, computing drop-off percentages', async () => {
    const deps = {
      getAccessToken: async () => 'tok',
      runReport: async (token, propertyId, body) => {
        const dims = (body.dimensions || []).map((d) => d.name);
        if (dims[0] === 'pagePath') return { rows: [metricRow(['/amsterdam/'], [500]), metricRow(['/rotterdam/'], [200])] };
        if (dims.length === 0) return { rows: [metricRow([], [95.2, 300, 500])] };
        if (dims[0] === 'eventName') {
          return { rows: [metricRow(['view_item'], [1000]), metricRow(['begin_checkout'], [300]), metricRow(['purchase'], [120]), metricRow(['sign_up'], [40]), metricRow(['generate_lead'], [15])] };
        }
        throw new Error('unexpected: ' + JSON.stringify(body));
      },
    };
    const result = await getBehaviorSummary(BASE_ENV(null), '2026-01-01', '2026-01-31', deps);
    assert.equal(result.configured, true);
    assert.deepEqual(result.top_pages[0], { page: '/amsterdam/', views: 500 });
    assert.equal(result.engagement.avg_session_duration, 95.2);
    assert.equal(result.engagement.engaged_sessions, 300);
    assert.equal(result.funnel.view_item, 1000);
    assert.equal(result.funnel.begin_checkout, 300);
    assert.equal(result.funnel.purchase, 120);
    assert.equal(result.funnel.pct_checkout_of_view, 30);
    assert.equal(result.funnel.pct_purchase_of_checkout, 40);
    assert.equal(result.funnel.drop_off_view_to_checkout, 700);
    assert.equal(result.funnel.drop_off_checkout_to_purchase, 180);
    assert.equal(result.events.sign_up, 40);
    assert.equal(result.events.generate_lead, 15);
  });

  test('a zero-view_item funnel never divides by zero', async () => {
    const deps = {
      getAccessToken: async () => 'tok',
      runReport: async (token, propertyId, body) => {
        const dims = (body.dimensions || []).map((d) => d.name);
        if (dims[0] === 'eventName') return { rows: [] };
        return { rows: [] };
      },
    };
    const result = await getBehaviorSummary(BASE_ENV(null), '2026-01-01', '2026-01-31', deps);
    assert.equal(result.funnel.pct_checkout_of_view, 0);
    assert.equal(result.funnel.pct_purchase_of_checkout, 0);
  });
});

describe('GET /admin/api/analytics/behavior', () => {
  test('unconfigured -> {configured:false}', async () => {
    const res = await handleAnalyticsBehavior(new Request('https://api.example.com/admin/api/analytics/behavior?from=2026-01-01&to=2026-01-31'), { DB: db });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { configured: false });
  });

  test('rejects a missing/invalid range', async () => {
    const res = await handleAnalyticsBehavior(new Request('https://api.example.com/admin/api/analytics/behavior'), { DB: db });
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// getMarketingTraffic (ga4.js)
// ---------------------------------------------------------------------------

describe('getMarketingTraffic', () => {
  test('unconfigured env -> {configured:false}', async () => {
    const result = await getMarketingTraffic({}, '2026-01-01', '2026-01-31');
    assert.deepEqual(result, { configured: false });
  });

  test('shapes by_source_medium and by_campaign (filtering "(not set)")', async () => {
    const deps = {
      getAccessToken: async () => 'tok',
      runReport: async (token, propertyId, body) => {
        const dims = (body.dimensions || []).map((d) => d.name);
        if (dims[0] === 'sessionSource') {
          return { rows: [metricRow(['google', 'organic'], [500, 20, 60000]), metricRow(['facebook', 'paid_social'], [300, 15, 45000])] };
        }
        if (dims[0] === 'sessionCampaignName') {
          return { rows: [metricRow(['ams_launch'], [200, 10, 30000]), metricRow(['(not set)'], [400, 5, 1000])] };
        }
        throw new Error('unexpected: ' + JSON.stringify(body));
      },
    };
    const result = await getMarketingTraffic(BASE_ENV(null), '2026-01-01', '2026-01-31', deps);
    assert.equal(result.configured, true);
    assert.deepEqual(result.by_source_medium[0], { source: 'google', medium: 'organic', sessions: 500, purchases: 20, revenue: 60000 });
    assert.equal(result.by_campaign.length, 1, '"(not set)" campaigns are filtered out');
    assert.equal(result.by_campaign[0].campaign, 'ams_launch');
  });
});

function seedRoute(db, { id, city = 'Amsterdam' } = {}) {
  run(db, `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,active)
            VALUES (:id,:name,:city,3000,10,6,'[1,2,3,4,5,6,7]','["18:00"]',1)`,
    { id, name: `Route ${id}`, city });
}

describe('GET /admin/api/analytics/marketing', () => {
  test('rejects a missing/invalid range', async () => {
    const res = await handleAnalyticsMarketing(new Request('https://api.example.com/admin/api/analytics/marketing'), { DB: db });
    assert.equal(res.status, 400);
  });

  test('GA4 unconfigured -> traffic.configured false, D1 side still works', async () => {
    seedRoute(db, { id: 'ams' });
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, locale, marketing_opt_in, status, created_at, source, discount_code, discount_cents)
              VALUES ('b1','ams','2026-02-05','18:00',2,'Anna','anna@example.com','en',0,'confirmed','2026-02-05 09:00:00','web','WELCOME10',500)`);
    run(db, `INSERT INTO subscribers (id, email, source, status, unsubscribe_token, confirmed_at, created_at) VALUES ('s1','new@example.com','site_footer','confirmed','tok1','2026-02-06 12:00:00','2026-02-01 12:00:00')`);
    run(db, `INSERT INTO gift_cards (id, code, initial_cents, balance_cents, buyer_email, buyer_name, recipient_name, recipient_email, created_at)
              VALUES ('gc1','WOGO-AAAA-BBBB',5000,5000,'buyer@example.com','Buyer','Rec','rec@example.com','2026-02-03 12:00:00')`);

    const res = await handleAnalyticsMarketing(new Request('https://api.example.com/admin/api/analytics/marketing?from=2026-02-01&to=2026-02-28'), { DB: db });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.traffic.configured, false);
    assert.equal(body.discount_usage[0].code, 'WELCOME10');
    assert.equal(body.gift_cards.sold_count, 1);
    const growthDay = body.subscribers.growth.find((d) => d.date === '2026-02-06');
    assert.equal(growthDay.new_subscribers, 1);
    const zeroDay = body.subscribers.growth.find((d) => d.date === '2026-02-01');
    assert.equal(zeroDay.new_subscribers, 0, 'zero-filled, not omitted');
    assert.ok(body.subscribers.by_source.find((s) => s.source === 'site_footer'));
  });
});
