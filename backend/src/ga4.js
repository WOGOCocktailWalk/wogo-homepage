// src/ga4.js — Google Analytics 4 Data API client (BUILD §19's "Traffic"
// section). €0: a GA4 service account has its own free quota, no Google Ads
// account or paid tier needed — just a Cloud project (also free) to mint the
// service-account key.
//
// Auth is a Google "server-to-server" OAuth2 flow with NO stored refresh
// token: sign a short-lived JWT ourselves (RS256, Web Crypto — Workers-safe,
// no Node crypto per PORTABILITY.md) asserting we ARE the service account,
// trade it for an access token at Google's token endpoint, then call the
// Data API's runReport with that bearer token. Every step is a plain fetch;
// nothing here is Cloudflare-specific.
//
// Config-gated like Turnstile/Brevo elsewhere in this codebase: with
// env.GA4_SERVICE_ACCOUNT_JSON / env.GA4_PROPERTY_ID unset, every exported
// function here returns `{ configured: false }` rather than throwing — the
// dashboard shows a "connect Google Analytics" card instead of an error.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour — stays far under GA4's Data API quota

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n" (the
 * shape every GA4 service-account JSON key's `private_key` field has) ->
 * a CryptoKey, via crypto.subtle (no Node `crypto`, Workers-safe). The key
 * is PKCS8-DER base64-wrapped in PEM headers — strip them, base64-decode,
 * and hand the raw DER bytes to importKey. */
async function importPrivateKey(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Signs a Google-flavored JWT assertion for the `urn:ietf:params:oauth:grant-type:jwt-bearer`
 * grant — the standard "service account acting as itself" flow (no user,
 * no refresh token to store). `credentials` is the parsed service-account
 * JSON key ({client_email, private_key}). */
async function signAssertion(credentials, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: credentials.client_email,
    scope: GA4_SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encClaim = base64url(new TextEncoder().encode(JSON.stringify(claim)));
  const signingInput = `${encHeader}.${encClaim}`;
  const key = await importPrivateKey(credentials.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

/** Exchanges the signed assertion for a short-lived (1h) bearer access
 * token. Not cached across requests (a Worker isolate's lifetime is too
 * short-lived to make that worthwhile, and this one extra round trip is
 * cheap compared to the runReport calls it unlocks). */
async function getAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signAssertion(credentials, now);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`ga4_token_exchange_failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

/** One GA4 Data API `runReport` call. `body` is the raw GA4 request shape
 * ({dateRanges, dimensions, metrics, ...}) — this function does not
 * interpret it, just signs+sends it and returns GA4's raw response. */
async function runReport(accessToken, propertyId, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ga4_run_report_failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Parses env.GA4_SERVICE_ACCOUNT_JSON once per call — returns `null` if
 * either secret is missing/unparseable, never throws (the config-gated
 * contract every caller relies on). */
function readCredentials(env) {
  if (!env.GA4_SERVICE_ACCOUNT_JSON || !env.GA4_PROPERTY_ID) return null;
  try {
    const parsed = JSON.parse(env.GA4_SERVICE_ACCOUNT_JSON);
    if (!parsed.client_email || !parsed.private_key) return null;
    return { credentials: parsed, propertyId: String(env.GA4_PROPERTY_ID) };
  } catch {
    return null;
  }
}

export function isGa4Configured(env) {
  return readCredentials(env) !== null;
}

// ---------------------------------------------------------------------------
// Report shaping — GA4 returns {dimensionHeaders, metricHeaders, rows: [{dimensionValues, metricValues}]}
// for every report; these helpers turn that into the plain arrays/objects
// admin_api.js hands the dashboard.
// ---------------------------------------------------------------------------

function rowsOf(report) {
  return (report && report.rows) || [];
}
function dim(row, i) { return row.dimensionValues[i].value; }
function metric(row, i) { return Number(row.metricValues[i].value) || 0; }

function dateRange(from, to) {
  return [{ startDate: from, endDate: to }];
}

/**
 * Fetches the full "Traffic" tab's data for [from, to] (both 'YYYY-MM-DD') —
 * one access-token exchange, then every report requested in parallel.
 * Returns `{ configured: false }` if GA4 isn't set up; otherwise the shape
 * admin.js's Traffic sub-page renders (see src/admin/admin.js:paintAnalyticsTraffic).
 * NEVER throws on a Google-side failure — a report that fails comes back
 * as empty rather than taking down the whole Analytics tab (same
 * "one bad side-effect doesn't fail the rest" posture as webhook.js).
 */
export async function getTrafficSummary(env, from, to, deps = {}) {
  const parsed = readCredentials(env);
  if (!parsed) return { configured: false };
  const { credentials, propertyId } = parsed;
  const run = deps.runReport || runReport;
  const getToken = deps.getAccessToken || getAccessToken;

  let accessToken;
  try {
    accessToken = await getToken(credentials);
  } catch (err) {
    console.error('ga4_auth_failed', err);
    return { configured: false, error: 'ga4_auth_failed' };
  }

  const safeRun = async (body, fallback) => {
    try {
      return await run(accessToken, propertyId, body);
    } catch (err) {
      console.error('ga4_report_failed', err);
      return fallback;
    }
  };

  const [overview, bySource, byPage, byDevice, byCountry, events] = await Promise.all([
    safeRun({ dateRanges: dateRange(from, to), metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'engagedSessions' }, { name: 'averageSessionDuration' }] }, null),
    safeRun({ dateRanges: dateRange(from, to), dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 }, null),
    safeRun({ dateRanges: dateRange(from, to), dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 15 }, null),
    safeRun({ dateRanges: dateRange(from, to), dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'sessions' }] }, null),
    safeRun({ dateRanges: dateRange(from, to), dimensions: [{ name: 'country' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 8 }, null),
    safeRun({
      dateRanges: dateRange(from, to),
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['view_item', 'begin_checkout', 'purchase', 'sign_up', 'generate_lead'] } } },
    }, null),
  ]);

  const overviewRow = rowsOf(overview)[0];
  const totals = overviewRow
    ? {
      sessions: metric(overviewRow, 0),
      total_users: metric(overviewRow, 1),
      new_users: metric(overviewRow, 2),
      engaged_sessions: metric(overviewRow, 3),
      avg_session_duration: metric(overviewRow, 4),
    }
    : { sessions: 0, total_users: 0, new_users: 0, engaged_sessions: 0, avg_session_duration: 0 };

  const eventCounts = {};
  for (const row of rowsOf(events)) eventCounts[dim(row, 0)] = metric(row, 0);

  return {
    configured: true,
    from, to,
    totals,
    by_source: rowsOf(bySource).map((r) => ({ source: dim(r, 0), medium: dim(r, 1), sessions: metric(r, 0) })),
    by_page: rowsOf(byPage).map((r) => ({ page: dim(r, 0), views: metric(r, 0) })),
    by_device: rowsOf(byDevice).map((r) => ({ device: dim(r, 0), sessions: metric(r, 0) })),
    by_country: rowsOf(byCountry).map((r) => ({ country: dim(r, 0), sessions: metric(r, 0) })),
    funnel: {
      view_item: eventCounts.view_item || 0,
      begin_checkout: eventCounts.begin_checkout || 0,
      purchase: eventCounts.purchase || 0,
      sign_up: eventCounts.sign_up || 0,
      generate_lead: eventCounts.generate_lead || 0,
    },
  };
}

export { CACHE_TTL_SECONDS };
