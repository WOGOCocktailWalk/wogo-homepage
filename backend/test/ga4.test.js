// test/ga4.test.js — GA4 Data API client (src/ga4.js, BUILD §19 "Traffic").
// Every Google call is mocked via global.fetch (token exchange + runReport)
// — no real network, no real service account needed. Covers: the
// unconfigured path ({configured:false}), the JWT/token-exchange + runReport
// happy path shaped into admin.js's expected response, a failing individual
// report degrading gracefully instead of failing the whole summary, and the
// admin_api.js endpoint's 1h settings-table cache.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getTrafficSummary, isGa4Configured } from '../src/ga4.js';
import { handleAnalyticsTraffic } from '../src/admin_api.js';
import { makeTestDb } from './sqlite-d1-adapter.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = ['0001_init.sql'].map(migration).join('\n'); // settings table lives in 0001

// A GENUINELY valid RSA PKCS8 private key, generated fresh at test-run time
// via Web Crypto (not hand-typed/fake) — needed because the "real fetch
// mock" describe block below exercises the REAL signAssertion/
// importPrivateKey path (RS256 JWT signing), not just mocked deps. Export ->
// base64 -> PEM-wrap mirrors exactly what a downloaded GA4 service-account
// JSON key's `private_key` field looks like.
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

const FAKE_CREDENTIALS_JSON = JSON.stringify({
  client_email: 'wogo-ga4@test-project.iam.gserviceaccount.com',
  private_key: TEST_PRIVATE_KEY_PEM,
});

const BASE_ENV = (db) => ({ DB: db, GA4_SERVICE_ACCOUNT_JSON: FAKE_CREDENTIALS_JSON, GA4_PROPERTY_ID: '123456789' });

let realFetch;
afterEach(() => { if (realFetch) global.fetch = realFetch; });

// ---------------------------------------------------------------------------
// isGa4Configured / unconfigured path — no fetch mock needed, these never call out.
// ---------------------------------------------------------------------------

describe('isGa4Configured / unconfigured fallback', () => {
  test('both secrets missing -> not configured', () => {
    assert.equal(isGa4Configured({}), false);
  });
  test('missing property id only -> not configured', () => {
    assert.equal(isGa4Configured({ GA4_SERVICE_ACCOUNT_JSON: FAKE_CREDENTIALS_JSON }), false);
  });
  test('malformed JSON -> not configured, never throws', () => {
    assert.equal(isGa4Configured({ GA4_SERVICE_ACCOUNT_JSON: 'not json', GA4_PROPERTY_ID: '1' }), false);
  });
  test('getTrafficSummary on an unconfigured env returns {configured:false} without any fetch', async () => {
    const result = await getTrafficSummary({}, '2026-01-01', '2026-01-31');
    assert.deepEqual(result, { configured: false });
  });
});

// ---------------------------------------------------------------------------
// Happy path — deps injection bypasses the real crypto/token exchange so
// this test exercises getTrafficSummary's ORCHESTRATION (parallel reports,
// shaping into admin.js's expected arrays) without needing a real signable
// key or a real Google endpoint.
// ---------------------------------------------------------------------------

describe('getTrafficSummary — report shaping (mocked runReport/getAccessToken)', () => {
  function metricRow(dims, metrics) {
    return { dimensionValues: dims.map((v) => ({ value: v })), metricValues: metrics.map((v) => ({ value: String(v) })) };
  }

  test('shapes overview/source/page/device/country/funnel reports into the expected plain-object/array shape', async () => {
    const deps = {
      getAccessToken: async () => 'fake-access-token',
      runReport: async (token, propertyId, body) => {
        assert.equal(token, 'fake-access-token');
        assert.equal(propertyId, '123456789');
        const dims = (body.dimensions || []).map((d) => d.name);
        if (dims.length === 0) return { rows: [metricRow([], [500, 300, 120, 200, 95.4])] };
        if (dims[0] === 'sessionSource') return { rows: [metricRow(['google', 'organic'], [250]), metricRow(['instagram', 'social'], [100])] };
        if (dims[0] === 'pagePath') return { rows: [metricRow(['/amsterdam/'], [400]), metricRow(['/'], [250])] };
        if (dims[0] === 'deviceCategory') return { rows: [metricRow(['mobile'], [350]), metricRow(['desktop'], [150])] };
        if (dims[0] === 'country') return { rows: [metricRow(['Netherlands'], [420]), metricRow(['Germany'], [80])] };
        if (dims[0] === 'eventName') {
          return { rows: [
            metricRow(['view_item'], [300]), metricRow(['begin_checkout'], [90]), metricRow(['purchase'], [40]),
          ] };
        }
        throw new Error('unexpected report: ' + JSON.stringify(body));
      },
    };
    const result = await getTrafficSummary(BASE_ENV(null), '2026-01-01', '2026-01-31', deps);
    assert.equal(result.configured, true);
    assert.equal(result.totals.sessions, 500);
    assert.equal(result.totals.total_users, 300);
    assert.equal(result.totals.new_users, 120);
    assert.equal(result.totals.engaged_sessions, 200);
    assert.equal(result.totals.avg_session_duration, 95.4);
    assert.deepEqual(result.by_source[0], { source: 'google', medium: 'organic', sessions: 250 });
    assert.deepEqual(result.by_page[0], { page: '/amsterdam/', views: 400 });
    assert.deepEqual(result.by_device[0], { device: 'mobile', sessions: 350 });
    assert.deepEqual(result.by_country[0], { country: 'Netherlands', sessions: 420 });
    assert.equal(result.funnel.view_item, 300);
    assert.equal(result.funnel.begin_checkout, 90);
    assert.equal(result.funnel.purchase, 40);
    assert.equal(result.funnel.sign_up, 0); // absent from the mocked rows -> defaults to 0, not undefined
  });

  test('a token-exchange failure returns {configured:false, error} rather than throwing', async () => {
    const deps = { getAccessToken: async () => { throw new Error('boom'); } };
    const result = await getTrafficSummary(BASE_ENV(null), '2026-01-01', '2026-01-31', deps);
    assert.equal(result.configured, false);
    assert.equal(result.error, 'ga4_auth_failed');
  });

  test('one failing individual report degrades to empty rows instead of failing the whole summary', async () => {
    const deps = {
      getAccessToken: async () => 'tok',
      runReport: async (token, propertyId, body) => {
        const dims = (body.dimensions || []).map((d) => d.name);
        if (dims.length === 0) throw new Error('overview report failed');
        return { rows: [] };
      },
    };
    const result = await getTrafficSummary(BASE_ENV(null), '2026-01-01', '2026-01-31', deps);
    assert.equal(result.configured, true);
    assert.equal(result.totals.sessions, 0); // overview failed -> zeroed defaults, not an exception
    assert.deepEqual(result.by_source, []);
  });
});

// ---------------------------------------------------------------------------
// Real token-exchange/runReport fetch mocking (end-to-end through the JWT
// signing path) — proves the RS256 signing + form-encoded token request +
// bearer-authenticated runReport call are wired correctly, using a fetch
// mock instead of deps injection.
// ---------------------------------------------------------------------------

describe('getTrafficSummary — real fetch mock (JWT signing path)', () => {
  test('signs a JWT, exchanges it at the token endpoint, and calls runReport with the bearer token', async () => {
    realFetch = global.fetch;
    let tokenRequestBody = null;
    let reportAuthHeader = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u === 'https://oauth2.googleapis.com/token') {
        tokenRequestBody = String(opts.body);
        return new Response(JSON.stringify({ access_token: 'minted-token', expires_in: 3600 }), { status: 200 });
      }
      if (u.includes('analyticsdata.googleapis.com')) {
        reportAuthHeader = opts.headers.Authorization;
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      }
      throw new Error('unmocked fetch: ' + u);
    };

    const result = await getTrafficSummary(BASE_ENV(null), '2026-01-01', '2026-01-31');
    assert.equal(result.configured, true);
    assert.ok(tokenRequestBody.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer'));
    assert.ok(tokenRequestBody.includes('assertion='));
    const assertion = new URLSearchParams(tokenRequestBody).get('assertion');
    assert.equal(assertion.split('.').length, 3); // header.claim.signature
    assert.equal(reportAuthHeader, 'Bearer minted-token');
  });
});

// ---------------------------------------------------------------------------
// admin_api.js endpoint — the {configured:false} fallback, and the 1h cache.
// ---------------------------------------------------------------------------

describe('GET /admin/api/analytics/traffic (handleAnalyticsTraffic)', () => {
  let db;
  beforeEach(() => { db = makeTestDb(schemaSql); });

  test('unconfigured env -> {configured:false}, 200, no fetch needed', async () => {
    const res = await handleAnalyticsTraffic(new Request('https://api.example.com/admin/api/analytics/traffic?from=2026-01-01&to=2026-01-31'), { DB: db });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { configured: false });
  });

  test('rejects a missing/invalid range the same way the sales endpoint does', async () => {
    const res = await handleAnalyticsTraffic(new Request('https://api.example.com/admin/api/analytics/traffic'), { DB: db });
    assert.equal(res.status, 400);
  });

  test('a second call within 1h for the SAME range is served from the settings-table cache, not a fresh GA4 call', async () => {
    realFetch = global.fetch;
    let reportCalls = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      if (u.includes('analyticsdata.googleapis.com')) { reportCalls++; return new Response(JSON.stringify({ rows: [] }), { status: 200 }); }
      throw new Error('unmocked: ' + u);
    };
    const env = BASE_ENV(db);
    const req = () => new Request('https://api.example.com/admin/api/analytics/traffic?from=2026-01-01&to=2026-01-31');

    const first = await handleAnalyticsTraffic(req(), env);
    assert.equal(first.status, 200);
    const firstReportCalls = reportCalls;
    assert.ok(firstReportCalls > 0);

    const second = await handleAnalyticsTraffic(req(), env);
    assert.equal(second.status, 200);
    assert.equal(reportCalls, firstReportCalls, 'second call within the TTL should not re-hit GA4');
  });
});
