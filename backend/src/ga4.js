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

// ---------------------------------------------------------------------------
// Realtime (BUILD §19.4's "Real-time" page) — GA4's SEPARATE runRealtimeReport
// endpoint (no dateRanges; "right now", a rolling ~30-minute window Google
// defines server-side). Each dimension is its own report (advisor/SPEC note:
// one bad dimension/metric combination degrades only ITS OWN report, not the
// whole page — unifiedScreenName + pagePath in one report would have made a
// single failure read as "no realtime data at all").
// ---------------------------------------------------------------------------

async function runRealtimeReport(accessToken, propertyId, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runRealtimeReport`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ga4_run_realtime_report_failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Fetches the Real-time page's data: total active users right now, and the
 * top 10 by screen/page, country, and device — each its own report so one
 * failing combination degrades to an empty array rather than failing the
 * whole call. Returns `{ configured: false }` when GA4 isn't set up.
 */
export async function getRealtimeSummary(env, deps = {}) {
  const parsed = readCredentials(env);
  if (!parsed) return { configured: false };
  const { credentials, propertyId } = parsed;
  const run = deps.runRealtimeReport || runRealtimeReport;
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
      console.error('ga4_realtime_report_failed', err);
      return fallback;
    }
  };

  const [overview, byPage, byCountry, byDevice] = await Promise.all([
    safeRun({ metrics: [{ name: 'activeUsers' }] }, null),
    safeRun({ dimensions: [{ name: 'unifiedScreenName' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 10 }, null),
    safeRun({ dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 10 }, null),
    safeRun({ dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'activeUsers' }] }, null),
  ]);

  const overviewRow = rowsOf(overview)[0];
  return {
    configured: true,
    active_users: overviewRow ? metric(overviewRow, 0) : 0,
    by_page: rowsOf(byPage).map((r) => ({ page: dim(r, 0), active_users: metric(r, 0) })),
    by_country: rowsOf(byCountry).map((r) => ({ country: dim(r, 0), active_users: metric(r, 0) })),
    by_device: rowsOf(byDevice).map((r) => ({ device: dim(r, 0), active_users: metric(r, 0) })),
  };
}

export const REALTIME_CACHE_TTL_SECONDS = 30; // SPEC §19: auto-refreshes every 60s while open; cache stays well under that

// ---------------------------------------------------------------------------
// Highlights traffic (BUILD §19.4 Highlights "Key stats" grid) — current +
// previous period in ONE runReport call via GA4's own dual-dateRanges
// feature: passing two `dateRanges` entries makes GA4 append an implicit
// trailing `dateRange` dimension to every row ('date_range_0' = the FIRST
// entry = current, 'date_range_1' = the second = previous) — see
// https://developers.google.com/analytics/devguides/reporting/data/v1/basics#comparing_date_ranges.
// Combined with an explicit `date` dimension this gives a zero-request way
// to get BOTH periods' daily series in one call, instead of two full
// round trips.
// ---------------------------------------------------------------------------

/**
 * @returns `{ configured: false }`, or
 * { configured: true, totals, previous_totals,
 *   daily: [{date, sessions, page_views, unique_visitors}],
 *   previous_daily: [...] } — `daily`/`previous_daily` are NOT zero-filled
 * here (GA4 simply omits a day with zero sessions); admin_api.js zero-fills
 * against the known [from,to] window the same way buildHighlightsSales does
 * for D1 bookings, so the two series line up index-for-index for a
 * sparkline.
 */
export async function getHighlightsTraffic(env, from, to, previousFrom, previousTo, deps = {}) {
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

  let report;
  try {
    report = await run(accessToken, propertyId, {
      dateRanges: [{ startDate: from, endDate: to }, { startDate: previousFrom, endDate: previousTo }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 1000,
    });
  } catch (err) {
    console.error('ga4_report_failed', err);
    const zeroTotals = { sessions: 0, page_views: 0, unique_visitors: 0 };
    return { configured: true, error: 'ga4_report_failed', totals: { ...zeroTotals }, previous_totals: { ...zeroTotals }, daily: [], previous_daily: [] };
  }

  const daily = [];
  const previousDaily = [];
  for (const row of rowsOf(report)) {
    // dimensionValues: [date, dateRange] — `dateRange` is GA4's own implicit
    // trailing dimension (NOT one this code declared in `dimensions` above),
    // appended automatically whenever 2+ dateRanges are requested.
    const date = dim(row, 0);
    const rangeTag = row.dimensionValues[1] ? row.dimensionValues[1].value : 'date_range_0';
    const entry = { date, sessions: metric(row, 0), page_views: metric(row, 1), unique_visitors: metric(row, 2) };
    if (rangeTag === 'date_range_1') previousDaily.push(entry);
    else daily.push(entry);
  }

  const sum = (arr, key) => arr.reduce((a, r) => a + r[key], 0);
  const totalsOf = (arr) => ({ sessions: sum(arr, 'sessions'), page_views: sum(arr, 'page_views'), unique_visitors: sum(arr, 'unique_visitors') });

  return {
    configured: true,
    totals: totalsOf(daily),
    previous_totals: totalsOf(previousDaily),
    daily,
    previous_daily: previousDaily,
  };
}

// ---------------------------------------------------------------------------
// Behavior (BUILD §19.4's "Behavior" page) — top pages, overall engagement,
// the view→checkout→purchase funnel with drop-off, sign_up/generate_lead
// event counts, and page views per city (logic.js:pageViewsByCity groups
// `by_page` by its first path segment).
// ---------------------------------------------------------------------------

export async function getBehaviorSummary(env, from, to, deps = {}) {
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

  const [topPages, engagement, events] = await Promise.all([
    safeRun({ dateRanges: dateRange(from, to), dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 20 }, null),
    safeRun({ dateRanges: dateRange(from, to), metrics: [{ name: 'averageSessionDuration' }, { name: 'engagedSessions' }, { name: 'sessions' }] }, null),
    safeRun({
      dateRanges: dateRange(from, to),
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['view_item', 'begin_checkout', 'purchase', 'sign_up', 'generate_lead'] } } },
    }, null),
  ]);

  const byPage = rowsOf(topPages).map((r) => ({ page: dim(r, 0), views: metric(r, 0) }));
  const engagementRow = rowsOf(engagement)[0];
  const eventCounts = {};
  for (const row of rowsOf(events)) eventCounts[dim(row, 0)] = metric(row, 0);

  const viewItem = eventCounts.view_item || 0;
  const beginCheckout = eventCounts.begin_checkout || 0;
  const purchase = eventCounts.purchase || 0;

  return {
    configured: true,
    from, to,
    top_pages: byPage,
    engagement: engagementRow
      ? { avg_session_duration: metric(engagementRow, 0), engaged_sessions: metric(engagementRow, 1), sessions: metric(engagementRow, 2) }
      : { avg_session_duration: 0, engaged_sessions: 0, sessions: 0 },
    funnel: {
      view_item: viewItem,
      begin_checkout: beginCheckout,
      purchase,
      pct_checkout_of_view: viewItem > 0 ? (beginCheckout / viewItem) * 100 : 0,
      pct_purchase_of_checkout: beginCheckout > 0 ? (purchase / beginCheckout) * 100 : 0,
      drop_off_view_to_checkout: viewItem > 0 ? viewItem - beginCheckout : 0,
      drop_off_checkout_to_purchase: beginCheckout > 0 ? beginCheckout - purchase : 0,
    },
    events: { sign_up: eventCounts.sign_up || 0, generate_lead: eventCounts.generate_lead || 0 },
    by_page: byPage, // raw rows — admin_api.js runs logic.js:pageViewsByCity over these
  };
}

// ---------------------------------------------------------------------------
// Marketing (BUILD §19.4's "Marketing" page) — sessions/purchases/revenue by
// sessionSource×sessionMedium, and by sessionCampaignName (top 15).
// ---------------------------------------------------------------------------

export async function getMarketingTraffic(env, from, to, deps = {}) {
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

  const [bySourceMedium, byCampaign] = await Promise.all([
    safeRun({
      dateRanges: dateRange(from, to),
      dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      metrics: [{ name: 'sessions' }, { name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 20,
    }, null),
    safeRun({
      dateRanges: dateRange(from, to),
      dimensions: [{ name: 'sessionCampaignName' }],
      metrics: [{ name: 'sessions' }, { name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 15,
    }, null),
  ]);

  return {
    configured: true,
    from, to,
    by_source_medium: rowsOf(bySourceMedium).map((r) => ({
      source: dim(r, 0), medium: dim(r, 1), sessions: metric(r, 0), purchases: metric(r, 1), revenue: metric(r, 2),
    })),
    by_campaign: rowsOf(byCampaign)
      .map((r) => ({ campaign: dim(r, 0), sessions: metric(r, 0), purchases: metric(r, 1), revenue: metric(r, 2) }))
      .filter((r) => r.campaign !== '(not set)'),
  };
}

export { CACHE_TTL_SECONDS };
