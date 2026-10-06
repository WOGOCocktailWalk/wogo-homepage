// src/admin_api.js — handlers for /admin/api/* (SPEC.md §7, §12.1).
// Every handler here assumes auth.requireSession(request, env) has already
// passed (checked centrally in index.js/router wiring).

import * as db from './db.js';
import {
  toCsv, aggregateCustomers, computeLoginLockout, nowSqlite, sqliteMinutesAgo, sqliteMinutesFromNow,
  validateNotes, isValidCurrencyCode, isValidIanaTimeZone, buildBookingAnalytics, addDaysToDateStr,
  buildHighlightsSales, computePctDelta, pageViewsByCity,
} from './logic.js';
import {
  LOGIN_FAIL_THRESHOLD,
  LOGIN_LOCK_BASE_MINUTES,
  LOGIN_LOCK_MAX_MINUTES,
  LOGIN_FAIL_WINDOW_MINUTES,
  MAX_TOKEN_LENGTH,
  BREVO_FOLDER_NAME,
  BREVO_LIST_NAME,
  BREVO_CONTACT_ATTRIBUTES,
  BREVO_LIST_ID_SETTING_KEY,
  WELCOME_CODE,
  WELCOME_DISCOUNT_PERCENT,
  SUBSCRIBE_NAME_MAX_LENGTH,
  SUBSCRIBE_CITY_MAX_LENGTH,
  LOGIN_LINK_TOKEN_EXPIRY_MINUTES,
  LOGIN_LINK_ATTEMPTS_PER_WINDOW,
  LOGIN_LINK_ATTEMPT_WINDOW_MINUTES,
  ADMIN_EMAIL_MAX_LENGTH,
  ANALYTICS_MAX_RANGE_DAYS,
} from './config.js';
import {
  checkAdminToken, createSessionCookieValue, sessionSetCookieHeader, sessionClearCookieHeader,
  hasCsrfHeader, getSession, roleAtLeast, generateLoginLinkToken, sha256Hex,
} from './auth.js';
import {
  sendGuestConfirmationEmails, notifyBars,
  sendGuestRescheduleEmail, notifyBarsReschedule,
  sendGuestCancellationEmail, notifyBarsCancellation,
} from './webhook.js';
import { verifyTurnstile } from './turnstile.js';
import { runHealthCheck } from './healthcheck.js';
import { ensureContactFolder, ensureContactList, ensureContactAttribute, sendTransactional } from './brevo.js';
import { ensureWelcomePromotionCode } from './stripe.js';
import { importSubscribers, handleConfirmedBookingOptIn } from './subscribers.js';
import { sendWithRetry } from './email_retry.js';
import { renderAdminLoginLink } from './emails.js';
import {
  getTrafficSummary, isGa4Configured, CACHE_TTL_SECONDS as GA4_CACHE_TTL_SECONDS,
  getRealtimeSummary, REALTIME_CACHE_TTL_SECONDS,
  getHighlightsTraffic, getBehaviorSummary, getMarketingTraffic,
} from './ga4.js';
import { sendReviewRequestForBooking } from './reviews.js';
import { posterUrlFor, EMAIL_SENDER } from './config.js';
import { upsertTransactionalTemplate } from './brevo.js';
import { buildReferenceTemplateSet } from './emails.js';

// ---------------------------------------------------------------------------
// Admin mutation audit trail (owner audit item #8, migrations/0007). Called
// AFTER a mutation succeeds — a failed/rejected request (400/404/403) never
// reaches here, since it never actually changed anything. Never throws: a
// logging failure must not turn a successful mutation into a 500 for the
// owner. `detail` is a small plain object, JSON-stringified for storage.
// ---------------------------------------------------------------------------

// `actor` (migrations/0025) is read off `request.adminSession` — set by
// src/index.js right after it resolves the request's session, BEFORE the
// matched handler ever runs (see resolveSession below). Reading it back off
// the Request object rather than threading a `session` parameter through
// every one of this file's ~20 handler signatures keeps every existing
// handler's signature untouched; a handler that genuinely NEEDS the session
// object (not just the audit actor string) reads the same property — see
// handleMe/handleInviteUser/handleUpdateUser. A request that never went
// through index.js's gate (every existing unit test that calls a handler
// directly) simply has no `adminSession` — `actor` falls back to 'token',
// matching this table's pre-0025 meaning (one shared ADMIN_TOKEN, no
// per-user identity).
async function audit(env, request, action, entity_type, entity_id, detail) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const session = request.adminSession;
    const actor = session && session.email ? session.email : 'token';
    await db.insertAdminAudit(env.DB, {
      ip, action, entity_type,
      entity_id: entity_id == null ? null : String(entity_id),
      detail: detail ? JSON.stringify(detail) : null,
      actor,
    });
  } catch (err) {
    console.error('admin_audit_write_failed', action, err);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function errorJson(code, message, status) {
  return json({ error: code, message: message || code }, status);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function handleLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Brute-force lockout (SPEC.md §15.2): failed attempts from this IP since
  // its last successful login. While locked, the token is never even checked
  // and the attempt is NOT recorded (hammering can't extend the current lock),
  // but each post-lockout failure escalates: 15 → 30 → 60 → ... → 240 min.
  const recentFails = await db.listRecentLoginFailures(
    env.DB, ip, sqliteMinutesAgo(LOGIN_FAIL_WINDOW_MINUTES)
  );
  const lock = computeLoginLockout(recentFails, nowSqlite(), {
    threshold: LOGIN_FAIL_THRESHOLD,
    baseMinutes: LOGIN_LOCK_BASE_MINUTES,
    maxMinutes: LOGIN_LOCK_MAX_MINUTES,
  });
  if (lock.locked) {
    return json(
      { error: 'too_many_attempts', message: 'too many attempts — try again later' },
      429,
      { 'Retry-After': String(lock.retryAfterSeconds) }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }

  // Bot protection (owner audit items #1/#10): config-gated and INERT until
  // env.TURNSTILE_SECRET_KEY is set — verifyTurnstile() returns { ok: true,
  // skipped: true } with no key configured, so this is a no-op today. Once
  // live, a failed/missing Turnstile token counts as a failed attempt (same
  // as a wrong token) so it also feeds the lockout counter above — a bot that
  // skips solving the widget can't get unlimited free tries at the token.
  const turnstile = await verifyTurnstile(env, body && body.turnstile_token, ip);
  if (!turnstile.ok) {
    await db.recordAuthEvent(env.DB, ip, 0);
    return errorJson('turnstile_failed', 'verification failed, please retry', 400);
  }

  const { token } = body || {};
  const submitted = typeof token === 'string' && token.length <= MAX_TOKEN_LENGTH ? token : '';
  if (!checkAdminToken(submitted, env.ADMIN_TOKEN)) {
    await db.recordAuthEvent(env.DB, ip, 0);
    return errorJson('invalid_token', null, 401);
  }
  await db.recordAuthEvent(env.DB, ip, 1); // audit trail + resets this IP's fail count
  // Emergency owner login (migrations/0025): no admin_users row behind this
  // path by design — `uid`/`email` stay null, role is fixed 'owner'. See
  // auth.js:createSessionCookieValue's doc comment for the payload shape.
  const cookieValue = await createSessionCookieValue(env.ADMIN_SESSION_SECRET, { uid: null, role: 'owner', email: null });
  const secure = env.ENVIRONMENT !== 'development';
  return json({ ok: true }, 200, { 'Set-Cookie': sessionSetCookieHeader(cookieValue, secure) });
}

/**
 * GET /admin/public-config (unauthenticated, by design — see index.js's
 * PUBLIC_ADMIN_PATHS) — tells the login form whether to render the Turnstile
 * widget and, if so, with which site key. The site key is PUBLIC by design
 * (Cloudflare embeds it in the page HTML on every Turnstile site); only
 * TURNSTILE_SECRET_KEY is sensitive and never leaves the Worker.
 */
export async function handlePublicConfig(request, env) {
  return json({ turnstile_site_key: env.TURNSTILE_SITE_KEY || null });
}

/**
 * GET /admin/api/security/login-attempts (session-guarded) — the audit view:
 * how many failed admin logins happened recently, and from where. Rows are
 * pruned after AUTH_EVENTS_RETENTION_MINUTES (30 days) by the cron sweep.
 */
export async function handleLoginAttempts(request, env) {
  const failed24h = await db.countLoginFailuresSince(env.DB, sqliteMinutesAgo(24 * 60));
  const failed7d = await db.countLoginFailuresSince(env.DB, sqliteMinutesAgo(7 * 24 * 60));
  const recent = await db.listLoginFailures(env.DB, 50);
  return json({ failed_24h: failed24h, failed_7d: failed7d, recent_failures: recent });
}

export async function handleLogout(request, env) {
  const secure = env.ENVIRONMENT !== 'development';
  return json({ ok: true }, 200, { 'Set-Cookie': sessionClearCookieHeader(secure) });
}

// ---------------------------------------------------------------------------
// Personal team logins (migrations/0025_admin_users.sql, BUILD §18).
// ---------------------------------------------------------------------------

const ROLES = new Set(['owner', 'staff', 'viewer']);

/**
 * The authoritative minimum-role-per-route table (owner audit item: "table
 * in SPEC" — mirrored verbatim in SPEC.md §18). Keyed exactly as
 * `${method} ${pattern}`, `pattern` being the route's ORIGINAL registration
 * string from src/index.js (e.g. '/admin/api/bookings/:id'), which
 * src/router.js's `match()` now round-trips. Enforced CENTRALLY in
 * src/index.js, right after the router matches a request and before the
 * handler ever runs — a table beats a guard copy-pasted into every handler
 * because a newly-added route that's missing from this table fails CLOSED
 * (default-deny 'owner', see index.js), and test/admin_users.test.js asserts
 * every registered /admin/api/* route has an explicit entry here, so a
 * missing row is a test failure, not a silent security gap.
 *
 * 'viewer' = read-only: bookings list/detail, analytics, routes (needed just
 * to boot the dashboard shell and label things — see admin.js:boot()).
 * 'staff' = day-to-day booking ops: manual booking, reschedule/cancel/resend,
 * date overrides, gift card view/void, read-only routes/bars/subscribers/
 * inquiries/customers (incl. editing a customer's own contact details — a
 * routine CS task, not a settings change).
 * 'owner' = everything else: user management, route/bar STRUCTURE changes
 * (the "settings" the owner role covers), Brevo/Stripe setup, CSV exports,
 * subscriber import, and every internal-observability endpoint (audit log,
 * error log, failed emails, health, login-attempt security audit) — none of
 * that was asked for by name for staff/viewer, so it defaults to the most
 * restrictive role rather than guessing wider.
 */
export const ROUTE_ROLES = {
  'GET /admin/api/me': 'viewer',
  'GET /admin/api/routes': 'viewer',
  'GET /admin/api/bookings': 'viewer',
  'GET /admin/api/bookings/:id': 'viewer',
  'GET /admin/api/analytics': 'viewer',
  'GET /admin/api/analytics/kpi': 'viewer',
  'GET /admin/api/analytics/traffic': 'viewer',
  'GET /admin/api/analytics/highlights': 'viewer',
  'GET /admin/api/analytics/realtime': 'viewer',
  'GET /admin/api/analytics/behavior': 'viewer',
  'GET /admin/api/analytics/marketing': 'viewer',

  'GET /admin/api/participants-per-hour': 'staff',
  'GET /admin/api/routes/:id/bars': 'staff',
  'POST /admin/api/bookings/:id/resend': 'staff',
  'POST /admin/api/bookings/:id/reschedule': 'staff',
  'POST /admin/api/bookings/:id/cancel': 'staff',
  'POST /admin/api/bookings/:id/send-review': 'staff',
  'POST /admin/api/bookings/manual': 'staff',
  'GET /admin/api/date-overrides': 'staff',
  'POST /admin/api/date-overrides': 'staff',
  'DELETE /admin/api/date-overrides/:id': 'staff',
  'GET /admin/api/customers': 'staff',
  'GET /admin/api/customers/:email': 'staff',
  'PUT /admin/api/customers/:email': 'staff',
  'GET /admin/api/gift-cards': 'staff',
  'POST /admin/api/gift-cards/:code/void': 'staff',
  'GET /admin/api/inquiries': 'staff',
  'GET /admin/api/subscribers': 'staff',

  'POST /admin/api/routes': 'owner',
  'PUT /admin/api/routes/:id': 'owner',
  'POST /admin/api/routes/:id/bars': 'owner',
  'PUT /admin/api/routes/:id/bars': 'owner',
  'PUT /admin/api/routes/:id/bars/:barId': 'owner',
  'DELETE /admin/api/routes/:id/bars/:barId': 'owner',
  'GET /admin/api/bookings.csv': 'owner',
  'GET /admin/api/security/login-attempts': 'owner',
  'GET /admin/api/audit-log': 'owner',
  'GET /admin/api/error-log': 'owner',
  'GET /admin/api/failed-emails': 'owner',
  'GET /admin/api/health': 'owner',
  'POST /admin/api/brevo/setup': 'owner',
  'POST /admin/api/brevo/push-reference-templates': 'owner',
  'POST /admin/api/stripe/ensure-welcome-code': 'owner',
  'GET /admin/api/subscribers.csv': 'owner',
  'POST /admin/api/subscribers/import': 'owner',
  'GET /admin/api/subscribers/sync-queue': 'owner',
  'GET /admin/api/users': 'owner',
  'POST /admin/api/users': 'owner',
  'PUT /admin/api/users/:id': 'owner',
};

/**
 * Resolves the LIVE identity behind an admin request — wraps
 * auth.js:getSession (pure cookie decode) with a fresh DB read for any
 * personal (uid-bearing) session, so a role change or a disable takes effect
 * on this user's VERY NEXT request rather than waiting up to 12h for their
 * cookie to expire. The emergency ADMIN_TOKEN session (uid === null) skips
 * the DB read entirely — there's no admin_users row behind it to re-check.
 * Returns `null` if there's no session, it's expired/invalid, or (for a
 * personal session) the user row is gone or `status !== 'active'`.
 */
export async function resolveSession(request, env) {
  const session = await getSession(request, env);
  if (!session) return null;
  if (session.uid == null) return session; // token login — role fixed 'owner', nothing to re-check
  const user = await db.getAdminUserById(env.DB, session.uid);
  if (!user || user.status !== 'active') return null;
  return { exp: session.exp, uid: user.id, role: user.role, email: user.email, name: user.name };
}

/** GET /admin/api/me (viewer+) — what the dashboard shell needs to know
 * about who's signed in: fills the sidebar's "Signed in" line and lets
 * admin.js hide owner/staff-only UI affordances client-side (the server-side
 * ROUTE_ROLES table above is the REAL control; this is just so the UI
 * doesn't dangle buttons a 403 will reject). */
export async function handleMe(request, env) {
  const session = request.adminSession;
  if (!session) return errorJson('unauthenticated', null, 401); // defensive only — index.js already gates this
  return json({
    uid: session.uid,
    email: session.email,
    name: session.name || null,
    role: session.role,
  });
}

/** POST /admin/login/request {email} — self-serve magic-link request
 * (BUILD §18). ALWAYS responds 200 {ok:true}, whether or not the email
 * belongs to an active admin_users row — this is the enumeration-safety
 * requirement: an attacker probing emails can't distinguish "exists" from
 * "doesn't" by status code, timing-sensitive branch, or response shape.
 * Rate-limited in TWO own buckets (per-IP and per-email, src/config.js) —
 * reuses the generic `rate_events` sliding-window mechanism §15.1 already
 * built (kind='login_link_ip'/'login_link_email'); hitting either bucket
 * also returns a plain 200 (never 429) so a rate-limited probe looks
 * identical to a successful one from the outside. */
export async function handleLoginLinkRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const emailRaw = body && body.email;
  if (typeof emailRaw !== 'string' || emailRaw.length > ADMIN_EMAIL_MAX_LENGTH || !EMAIL_RE.test(emailRaw)) {
    return errorJson('bad_request', 'valid email required', 400);
  }
  const email = emailRaw.trim().toLowerCase();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  await db.recordRateEvent(env.DB, 'login_link_ip', ip);
  await db.recordRateEvent(env.DB, 'login_link_email', email);
  const since = sqliteMinutesAgo(LOGIN_LINK_ATTEMPT_WINDOW_MINUTES);
  const [ipCount, emailCount] = await Promise.all([
    db.countRateEventsSince(env.DB, 'login_link_ip', ip, since),
    db.countRateEventsSince(env.DB, 'login_link_email', email, since),
  ]);
  if (ipCount > LOGIN_LINK_ATTEMPTS_PER_WINDOW || emailCount > LOGIN_LINK_ATTEMPTS_PER_WINDOW) {
    return json({ ok: true }, 200); // silently dropped — see doc comment above
  }

  const user = await db.getAdminUserByEmail(env.DB, email);
  if (user && user.status === 'active') {
    await sendLoginLinkEmail(request, env, user, { invite: false });
  }
  return json({ ok: true }, 200);
}

/** Shared by the self-serve request above and handleInviteUser below — mints
 * one single-use token, stores only its hash, and sends the branded mail.
 * Never throws (sendWithRetry already queues a failed send for retry; a
 * DB-write failure here is logged, same posture as the `audit()` helper —
 * an owner inviting a teammate must still get their 201, the mail is a
 * best-effort side effect). */
async function sendLoginLinkEmail(request, env, user, opts) {
  try {
    const rawToken = generateLoginLinkToken();
    const tokenHash = await sha256Hex(rawToken);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    await db.createLoginLink(env.DB, {
      token_hash: tokenHash,
      user_id: user.id,
      expires_at: sqliteMinutesFromNow(LOGIN_LINK_TOKEN_EXPIRY_MINUTES),
      ip_hash: ip === 'unknown' ? null : await sha256Hex(ip),
    });
    const baseUrl = new URL(request.url).origin;
    const magicUrl = `${baseUrl}/admin/login/magic?token=${rawToken}`;
    const mail = renderAdminLoginLink(user, magicUrl, opts);
    // NOTE: sendWithRetry's first backoff step is 5 minutes (src/config.js's
    // FAILED_EMAIL_RETRY_BACKOFF_MINUTES) while this link expires in
    // LOGIN_LINK_TOKEN_EXPIRY_MINUTES (15) — a retried send could in
    // principle deliver a link that's already dead. Acceptable: the common
    // case is an immediate successful send, and the person can just click
    // "log in" again for a fresh one if a retry ever does land late.
    await sendWithRetry(
      env,
      { to: user.email, subject: mail.subject, htmlContent: mail.html },
      { database: db, sendTransactional, kind: opts.invite ? 'admin_invite' : 'admin_login_link' }
    );
  } catch (err) {
    console.error('admin_login_link_send_failed', user.email, err);
  }
}

/**
 * GET /admin/login/magic?token=... (public — the link clicked out of an
 * email, never a fetch() call, so this always responds with a 302 redirect,
 * never JSON). Single-use: db.consumeLoginLink is ONE atomic guarded UPDATE
 * (unused + not expired), so a mail client prefetching the link, or the
 * person clicking it twice, can't double-spend it. Sets the SAME session
 * cookie mechanism as the ADMIN_TOKEN login, carrying this user's real
 * id/role/email.
 */
export async function handleLoginLinkMagic(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const invalidRedirect = () => new Response(null, { status: 302, headers: { Location: `${url.origin}/admin/login?state=invalid` } });
  if (!token || typeof token !== 'string') return invalidRedirect();

  const tokenHash = await sha256Hex(token);
  const consumed = await db.consumeLoginLink(env.DB, tokenHash);
  if (!consumed) return invalidRedirect();

  const user = await db.getAdminUserById(env.DB, consumed.user_id);
  if (!user || user.status !== 'active') return invalidRedirect(); // disabled since the link was sent

  await db.touchAdminUserLogin(env.DB, user.id);
  const cookieValue = await createSessionCookieValue(env.ADMIN_SESSION_SECRET, { uid: user.id, role: user.role, email: user.email });
  const secure = env.ENVIRONMENT !== 'development';
  // Built as a plain Response, NOT Response.redirect(url, 302) — a redirect
  // Response's headers cannot reliably have Set-Cookie appended afterward,
  // so the cookie has to be set at construction time, in the same object
  // that carries the Location header.
  return new Response(null, {
    status: 302,
    headers: { Location: `${url.origin}/admin`, 'Set-Cookie': sessionSetCookieHeader(cookieValue, secure) },
  });
}

/** GET /admin/api/users (owner only) — the Team tab's list. */
export async function handleListUsers(request, env) {
  const users = await db.listAdminUsers(env.DB);
  return json({ users });
}

/**
 * POST /admin/api/users (owner only) — invite a NEW teammate: creates the
 * admin_users row and sends the magic link as the invite mail (same
 * mechanism as a self-serve login request, just with invite-flavored copy).
 * 409s if the email already has a row (active OR disabled) — re-activating
 * a disabled user or resending an active one's link is PUT's/the self-serve
 * request endpoint's job respectively, kept separate so "invite" always
 * unambiguously means "brand new person".
 */
export async function handleInviteUser(request, env) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const emailRaw = body && body.email;
  const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  const role = body && typeof body.role === 'string' ? body.role : '';
  if (typeof emailRaw !== 'string' || emailRaw.length > ADMIN_EMAIL_MAX_LENGTH || !EMAIL_RE.test(emailRaw)) {
    return errorJson('bad_request', 'valid email required', 400);
  }
  if (!name) return errorJson('bad_request', 'name is required', 400);
  if (!ROLES.has(role)) return errorJson('bad_request', 'role must be owner, staff or viewer', 400);

  const email = emailRaw.trim().toLowerCase();
  const existing = await db.getAdminUserByEmail(env.DB, email);
  if (existing) return errorJson('user_exists', 'a user with this email already exists', 409);

  const session = request.adminSession;
  const user = await db.createAdminUser(env.DB, {
    id: `admuser_${crypto.randomUUID()}`,
    email, name, role, status: 'active', locale: null,
    invited_by: session && session.email ? session.email : null,
  });
  await audit(env, request, 'admin_user.invite', 'admin_user', user.id, { email, role });
  await sendLoginLinkEmail(request, env, user, { invite: true });
  return json({ user }, 201);
}

/**
 * PUT /admin/api/users/:id (owner only) — change role/status/name of an
 * EXISTING teammate. Last-owner guard: if `user` is currently an ACTIVE
 * owner and this patch would either demote them away from 'owner' or
 * disable them, and they're the ONLY active owner right now, reject —
 * otherwise the dashboard could lock every owner out of itself with one
 * click. (A soft check, not a transactional guarantee — two concurrent PUTs
 * targeting two different owners could both pass; acceptable for a
 * small-team admin tool that isn't defending against itself.)
 */
export async function handleUpdateUser(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  const user = await db.getAdminUserById(env.DB, params.id);
  if (!user) return errorJson('not_found', null, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const patch = {};
  if (body && body.role !== undefined) {
    if (!ROLES.has(body.role)) return errorJson('bad_request', 'invalid role', 400);
    patch.role = body.role;
  }
  if (body && body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') return errorJson('bad_request', 'invalid status', 400);
    patch.status = body.status;
  }
  if (body && body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 200);
    if (!name) return errorJson('bad_request', 'name cannot be empty', 400);
    patch.name = name;
  }
  if (Object.keys(patch).length === 0) return errorJson('bad_request', 'nothing to update', 400);

  const demotingOwner = user.role === 'owner' && patch.role && patch.role !== 'owner';
  const disablingOwner = user.role === 'owner' && user.status === 'active' && patch.status === 'disabled';
  if (demotingOwner || disablingOwner) {
    const activeOwners = await db.countActiveOwners(env.DB);
    if (activeOwners <= 1) return errorJson('last_owner', 'cannot remove the last owner', 400);
  }

  const updated = await db.updateAdminUser(env.DB, params.id, patch);
  await audit(env, request, 'admin_user.update', 'admin_user', params.id, patch);
  return json({ user: updated });
}

// ---------------------------------------------------------------------------
// Bookings list / detail / CSV export
// ---------------------------------------------------------------------------

function parseBookingFilters(url) {
  const p = url.searchParams;
  return {
    route: p.get('route') || undefined,
    city: p.get('city') || undefined,
    date_from: p.get('date_from') || undefined,
    date_to: p.get('date_to') || undefined,
    status: p.get('status') || undefined,
    q: p.get('q') || undefined,
    limit: p.get('limit') ? Number(p.get('limit')) : undefined,
    offset: p.get('offset') ? Number(p.get('offset')) : undefined,
  };
}

export async function handleListBookings(request, env) {
  const url = new URL(request.url);
  const filters = parseBookingFilters(url);
  const bookings = await db.listBookings(env.DB, filters);
  return json({ bookings });
}

export async function handleGetBooking(request, env, params) {
  const booking = await db.getBooking(env.DB, params.id);
  if (!booking) return errorJson('not_found', null, 404);
  return json({ booking });
}

/** Re-sends the guest confirmation email (which includes the route-map section
 * when the route has a map for the booking's language —
 * map_url_nl for NL, map_url otherwise) for an already-confirmed
 * booking (SPEC.md §12.2 "resend confirmation email" drawer action). Does NOT
 * re-notify the bars — they already have the reservation; re-pinging them on
 * every resend click would be noise, not a fix. */
export async function handleResendConfirmation(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  const booking = await db.getBooking(env.DB, params.id);
  if (!booking) return errorJson('not_found', null, 404);
  if (booking.status !== 'confirmed' && booking.status !== 'confirmed_conflict') {
    return errorJson('bad_request', 'only confirmed bookings can be resent', 400);
  }
  const route = await db.getRoute(env.DB, booking.route_id);
  if (!route) return errorJson('route_not_found', null, 404);

  await sendGuestConfirmationEmails(env, booking, route);
  await audit(env, request, 'booking.resend_confirmation', 'booking', booking.id, { email: booking.email });
  return json({ ok: true });
}

const CSV_COLUMNS = ['id', 'route_name', 'city', 'date', 'slot', 'party', 'name', 'email', 'phone', 'notes', 'status', 'source', 'payment_status', 'discount_code', 'discount_cents', 'stripe_session', 'created_at'];

export async function handleExportCsv(request, env) {
  const url = new URL(request.url);
  const filters = parseBookingFilters(url);
  filters.limit = 10000;
  const bookings = await db.listBookings(env.DB, filters);
  const csv = toCsv(bookings, CSV_COLUMNS);
  const today = new Date().toISOString().slice(0, 10);
  // A CSV export is a full-PII data pull (owner audit item #8 explicitly
  // lists it) — worth an audit row even though it's a GET, unlike every
  // other audited action here which is a state-changing POST/PUT/DELETE.
  await audit(env, request, 'bookings.export_csv', null, null, { rows: bookings.length, filters });
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="wogo-bookings-${today}.csv"`,
    },
  });
}

// ---------------------------------------------------------------------------
// Participants per hour
// ---------------------------------------------------------------------------

export async function handleParticipantsPerHour(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const route = url.searchParams.get('route') || undefined;
  if (!date) return errorJson('bad_request', 'date is required', 400);
  // Raw per-route-per-slot rows ({route_id, route_name, slot, guests, bookings}) —
  // the admin dashboard groups/stacks these client-side for its bar chart.
  // (logic.js's buildHourBars — a flat pct-normalized view — stays available
  // and unit-tested for any consumer that wants a single-series bar instead.)
  const rows = await db.participantsPerHour(env.DB, date, route);
  return json({ date, rows });
}

// ---------------------------------------------------------------------------
// Route manager
// ---------------------------------------------------------------------------

function requireCsrf(request) {
  return hasCsrfHeader(request);
}

export async function handleListAllRoutes(request, env) {
  const routes = await db.listAllRoutes(env.DB);
  return json({ routes });
}

export async function handleCreateRoute(request, env) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const { id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, weekday_capacity, map_url, map_url_nl, active, currency, timezone } = body || {};
  if (!id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    return errorJson('bad_request', 'id must be a lowercase-kebab slug', 400);
  }
  if (!name || !city || !Number.isInteger(price_cents)) {
    return errorJson('bad_request', 'name, city, price_cents are required', 400);
  }
  const slotsResult = parseSlotsField(slots);
  if (!slotsResult.ok) return errorJson('bad_request', slotsResult.message, 400);

  // Different-start-times-per-weekday (SPEC): when slots is the per-weekday
  // OBJECT shape, routes.open_days is DERIVED from which weekday keys carry
  // >=1 time — never taken from the client — so the two columns can never
  // drift apart. The plain ARRAY shape keeps the original behaviour exactly:
  // open_days is whatever the client sent, validated as before.
  let openDaysStr;
  if (slotsResult.shape === 'object') {
    openDaysStr = JSON.stringify(slotsResult.openDays);
  } else {
    let openDaysArr;
    try {
      openDaysArr = JSON.parse(open_days);
    } catch {
      return errorJson('bad_request', 'open_days and slots must be JSON arrays', 400);
    }
    if (!Array.isArray(openDaysArr) || !openDaysArr.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
      return errorJson('bad_request', 'open_days must be ints 1-7', 400);
    }
    openDaysStr = open_days;
  }
  let slotCapacityStr = '{}';
  if (slot_capacity !== undefined) {
    const validated = validateSlotCapacityMap(slot_capacity);
    if (!validated.ok) return errorJson('bad_request', validated.message, 400);
    slotCapacityStr = validated.raw;
  }
  // migrations/0014: optional per-weekday capacity default — NULL (falls
  // through to db.createRoute's own NULL default) unless given.
  let weekdayCapacityStr = null;
  if (weekday_capacity !== undefined) {
    const validatedWeekday = validateWeekdayCapacityMap(weekday_capacity);
    if (!validatedWeekday.ok) return errorJson('bad_request', validatedWeekday.message, 400);
    weekdayCapacityStr = validatedWeekday.raw;
  }
  // migrations/0011: optional per-route currency (ISO 4217) + timezone (IANA
  // zone) — both default (falling straight through to db.createRoute's own
  // 'EUR'/'Europe/Amsterdam' defaults) when omitted, so nothing about
  // creating an NL route changes; only validated (not defaulted) when given,
  // so a typo'd zone/code is rejected at creation time, not silently stored.
  if (currency !== undefined && !isValidCurrencyCode(currency)) {
    return errorJson('bad_request', 'currency must be a 3-letter ISO code (e.g. EUR, GBP, USD)', 400);
  }
  if (timezone !== undefined && !isValidIanaTimeZone(timezone)) {
    return errorJson('bad_request', 'timezone must be a valid IANA zone (e.g. Europe/London)', 400);
  }
  const existing = await db.getRoute(env.DB, id);
  if (existing) return errorJson('bad_request', 'route id already exists', 400);

  const route = await db.createRoute(env.DB, {
    id, name, city, price_cents,
    capacity: capacity ?? 10,
    max_party: max_party ?? 6,
    open_days: openDaysStr,
    slots: slotsResult.raw,
    slot_capacity: slotCapacityStr,
    weekday_capacity: weekdayCapacityStr,
    map_url: map_url || null,
    map_url_nl: map_url_nl || null,
    active: active === undefined ? 1 : (active ? 1 : 0),
    currency,
    timezone,
  });
  await audit(env, request, 'route.create', 'route', route.id, { name, city, price_cents, currency: route.currency, timezone: route.timezone });
  return json({ route }, 201);
}

/**
 * Validates + classifies routes.slots — POLYMORPHIC (different start times
 * on different weekdays):
 *   - a JSON ARRAY of "HH:MM" strings -> same start times every open day.
 *     Validated EXACTLY as before this feature (bare regex, no behaviour
 *     change for any existing route).
 *   - a JSON OBJECT keyed by ISO weekday string "1".."7" (Mon=1 .. Sun=7),
 *     each value an array of unique "HH:MM" strings -> per-weekday start
 *     times; a weekday absent (or present but empty) has none.
 * Returns { ok: true, shape: 'array', raw } or
 *         { ok: true, shape: 'object', openDays, raw } — openDays is the
 *         derived, ascending list of weekday ints that have >=1 time, which
 *         the caller uses as the single source of truth for routes.open_days
 *         whenever slots is object-shaped; `raw` is the value re-stringified
 *         in canonical form (same pattern as validateSlotCapacityMap below)
 *         — persisting THIS rather than the caller's original `value` is
 *         what keeps a non-string `slots` (a bare object/array in the JSON
 *         body, rather than a JSON-encoded string) from ever reaching D1,
 *         which can only bind strings/numbers/null — or { ok: false, message }.
 */
function parseSlotsField(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return { ok: false, message: 'slots must be a JSON array or object' };
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every((s) => /^\d{2}:\d{2}$/.test(s))) {
      return { ok: false, message: 'slots must be HH:MM strings' };
    }
    return { ok: true, shape: 'array', raw: JSON.stringify(parsed) };
  }
  if (parsed && typeof parsed === 'object') {
    const openDays = [];
    for (const key of Object.keys(parsed)) {
      if (!/^[1-7]$/.test(key)) {
        return { ok: false, message: `slots key "${key}" must be a weekday 1-7 (Mon=1 .. Sun=7)` };
      }
      const times = parsed[key];
      if (!Array.isArray(times) || !times.every((s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s))) {
        return { ok: false, message: `slots["${key}"] must be an array of HH:MM strings` };
      }
      if (new Set(times).size !== times.length) {
        return { ok: false, message: `slots["${key}"] contains duplicate times` };
      }
      if (times.length > 0) openDays.push(Number(key));
    }
    openDays.sort((a, b) => a - b);
    return { ok: true, shape: 'object', openDays, raw: JSON.stringify(parsed) };
  }
  return { ok: false, message: 'slots must be a JSON array or object' };
}

/**
 * Shared validator for the "{ HH:MM: capacity, ... }" JSON shape used by
 * both routes.slot_capacity (route-level per-slot default, SPEC.md §7.6)
 * and date_overrides' 'slot_capacity_override' payload (date+slot override).
 * `raw` is the value re-stringified in canonical form, ready to persist.
 */
function validateSlotCapacityMap(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return { ok: false, message: 'slot_capacity must be a JSON object of {"HH:MM": capacity}' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'slot_capacity must be a JSON object of {"HH:MM": capacity}' };
  }
  for (const [slot, cap] of Object.entries(parsed)) {
    if (!/^\d{2}:\d{2}$/.test(slot)) {
      return { ok: false, message: `slot_capacity key "${slot}" must be an HH:MM time` };
    }
    if (!Number.isInteger(cap) || cap < 0) {
      return { ok: false, message: `slot_capacity["${slot}"] must be a non-negative integer` };
    }
  }
  return { ok: true, raw: JSON.stringify(parsed) };
}

/**
 * Validates the optional "{ "1".."7": capacity, ... }" JSON shape used by
 * routes.weekday_capacity (migrations/0014, per-weekday capacity default —
 * e.g. Saturdays cap 6 seats while every other open day stays at the route's
 * normal 10). Keys are ISO weekday strings (Mon=1..Sun=7); values must be
 * POSITIVE integers (unlike slot_capacity's 0-allowed "closed that slot"
 * shape — a weekday-level 0 has no such meaning, so it's rejected instead of
 * silently accepted). An empty object is valid and normalizes to NULL (the
 * column's own "not using this feature" default), matching the DB layer's
 * NULL = "no per-weekday capacity" convention throughout this feature.
 */
function validateWeekdayCapacityMap(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return { ok: false, message: 'weekday_capacity must be a JSON object of {"1".."7": capacity}' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'weekday_capacity must be a JSON object of {"1".."7": capacity}' };
  }
  for (const [wd, cap] of Object.entries(parsed)) {
    if (!/^[1-7]$/.test(wd)) {
      return { ok: false, message: `weekday_capacity key "${wd}" must be a weekday 1-7 (Mon=1 .. Sun=7)` };
    }
    if (!Number.isInteger(cap) || cap < 1) {
      return { ok: false, message: `weekday_capacity["${wd}"] must be a positive integer` };
    }
  }
  const raw = Object.keys(parsed).length === 0 ? null : JSON.stringify(parsed);
  return { ok: true, raw };
}

export async function handleUpdateRoute(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const existing = await db.getRoute(env.DB, params.id);
  if (!existing) return errorJson('not_found', null, 404);

  const patch = {};
  for (const k of ['name', 'city', 'price_cents', 'capacity', 'max_party', 'map_url', 'map_url_nl']) {
    if (k in body) patch[k] = body[k];
  }
  // Different-start-times-per-weekday (SPEC): when 'slots' is part of THIS
  // patch and is the per-weekday OBJECT shape, open_days is DERIVED from it
  // and any 'open_days' also present in the same request body is ignored —
  // the two columns can never be told to disagree in one PUT.
  let slotsIsObjectShape = false;
  if ('slots' in body) {
    const slotsResult = parseSlotsField(body.slots);
    if (!slotsResult.ok) return errorJson('bad_request', slotsResult.message, 400);
    patch.slots = slotsResult.raw;
    if (slotsResult.shape === 'object') {
      slotsIsObjectShape = true;
      patch.open_days = JSON.stringify(slotsResult.openDays);
    }
  }
  if ('open_days' in body && !slotsIsObjectShape) {
    // 'slots' wasn't part of THIS patch — but if the route ALREADY has
    // per-weekday slots, open_days is still owned by that shape (it's never
    // a free-standing field once a route uses per-weekday slots), so a
    // lone open_days edit can't desync the two columns either.
    let existingSlotsIsObject = false;
    try {
      const existingParsed = JSON.parse(existing.slots);
      existingSlotsIsObject = !!(existingParsed && typeof existingParsed === 'object' && !Array.isArray(existingParsed));
    } catch {
      existingSlotsIsObject = false;
    }
    if (existingSlotsIsObject) {
      return errorJson(
        'bad_request',
        'this route uses different start times per weekday — edit slots (not open_days) to change which days are open',
        400
      );
    }
    try {
      const arr = JSON.parse(body.open_days);
      if (!Array.isArray(arr) || !arr.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) throw new Error();
      patch.open_days = body.open_days;
    } catch {
      return errorJson('bad_request', 'open_days must be a JSON array of ints 1-7', 400);
    }
  }
  if ('slot_capacity' in body) {
    const validated = validateSlotCapacityMap(body.slot_capacity);
    if (!validated.ok) return errorJson('bad_request', validated.message, 400);
    patch.slot_capacity = validated.raw;
  }
  if ('weekday_capacity' in body) {
    const validatedWeekday = validateWeekdayCapacityMap(body.weekday_capacity);
    if (!validatedWeekday.ok) return errorJson('bad_request', validatedWeekday.message, 400);
    patch.weekday_capacity = validatedWeekday.raw;
  }
  if ('active' in body) patch.active = body.active ? 1 : 0;
  // migrations/0011: currency/timezone edits — validated the same way as at
  // creation; a route not touching these fields is entirely unaffected.
  if ('currency' in body) {
    if (!isValidCurrencyCode(body.currency)) {
      return errorJson('bad_request', 'currency must be a 3-letter ISO code (e.g. EUR, GBP, USD)', 400);
    }
    patch.currency = body.currency;
  }
  if ('timezone' in body) {
    if (!isValidIanaTimeZone(body.timezone)) {
      return errorJson('bad_request', 'timezone must be a valid IANA zone (e.g. Europe/London)', 400);
    }
    patch.timezone = body.timezone;
  }

  const route = await db.updateRoute(env.DB, params.id, patch);
  await audit(env, request, 'route.update', 'route', params.id, patch);
  return json({ route });
}

// ---------------------------------------------------------------------------
// Bars CRUD
// ---------------------------------------------------------------------------

export async function handleListBars(request, env, params) {
  const bars = await db.listBars(env.DB, params.id);
  return json({ bars });
}

export async function handleAddBar(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  if (!body.bar_name || !body.bar_email || !Number.isInteger(body.ord)) {
    return errorJson('bad_request', 'ord, bar_name, bar_email are required', 400);
  }
  const bar = await db.addBar(env.DB, params.id, body);
  await audit(env, request, 'bar.create', 'bar', bar.id, { route_id: params.id, bar_name: body.bar_name });
  return json({ bar }, 201);
}

export async function handleUpdateBar(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const bar = await db.updateBar(env.DB, Number(params.barId), body);
  await audit(env, request, 'bar.update', 'bar', params.barId, body);
  return json({ bar });
}

export async function handleDeleteBar(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  const ok = await db.deleteBar(env.DB, Number(params.barId));
  await audit(env, request, 'bar.delete', 'bar', params.barId, null);
  return json({ ok });
}

/** Bulk-replace the whole bar list for a route — what the admin dashboard's
 * "Save bars" button sends: body { bars: [{ord, bar_name, bar_email, minutes_offset}, ...], weekday? }.
 * `weekday` (migrations/0015, additive, optional): omitted/null replaces the
 * DEFAULT set (today's behaviour, unchanged); an ISO weekday 1-7 replaces
 * ONLY that weekday's own recurring bar set, leaving every other weekday's
 * set (and the default set) untouched. */
export async function handleReplaceBars(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const bars = body && body.bars;
  if (!Array.isArray(bars) || !bars.every((b) => b && b.bar_name && b.bar_email)) {
    return errorJson('bad_request', 'bars must be an array of {bar_name, bar_email, minutes_offset}', 400);
  }
  let weekday = null;
  if (body.weekday !== undefined && body.weekday !== null) {
    if (!Number.isInteger(body.weekday) || body.weekday < 1 || body.weekday > 7) {
      return errorJson('bad_request', 'weekday must be an int 1-7 (Mon=1 .. Sun=7)', 400);
    }
    weekday = body.weekday;
  }
  const route = await db.getRoute(env.DB, params.id);
  if (!route) return errorJson('route_not_found', null, 404);

  const saved = await db.replaceBars(env.DB, params.id, bars, weekday);
  await audit(env, request, 'bar.replace_all', 'route', params.id, { count: bars.length, weekday });
  return json({ bars: saved });
}

// ---------------------------------------------------------------------------
// Date overrides
// ---------------------------------------------------------------------------

export async function handleListOverrides(request, env) {
  const url = new URL(request.url);
  const route = url.searchParams.get('route');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  if (!route) return errorJson('bad_request', 'route is required', 400);
  const overrides = await db.listOverrides(env.DB, route, dateFrom, dateTo);
  return json({ overrides });
}

const VALID_ACTIONS = new Set([
  'closed', 'alternate_bars', 'extra_slot', 'remove_slot', 'capacity_override', 'slot_capacity_override',
]);

export async function handleCreateOverride(request, env) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const { route_id, date, action, payload } = body || {};
  if (!route_id || !date || !VALID_ACTIONS.has(action)) {
    return errorJson('bad_request', 'route_id, date, and a valid action are required', 400);
  }
  const route = await db.getRoute(env.DB, route_id);
  if (!route) return errorJson('route_not_found', null, 404);

  // 'slot_capacity_override' payload is { "HH:MM": capacity, ... } — this
  // upsert REPLACES the whole map for (route_id, date), same as every other
  // action here (INSERT OR REPLACE); the caller (admin UI) is responsible
  // for merging in any existing overrides before submitting, exactly like
  // the "Save bars" bulk-replace pattern elsewhere in this file.
  let storedPayload = payload ?? null;
  if (action === 'slot_capacity_override') {
    const validated = validateSlotCapacityMap(payload);
    if (!validated.ok) return errorJson('bad_request', validated.message, 400);
    storedPayload = validated.raw;
  }

  const override = await db.upsertOverride(env.DB, { route_id, date, action, payload: storedPayload });
  await audit(env, request, 'date_override.create', 'date_override', override.id, { route_id, date, action });
  return json({ override }, 201);
}

export async function handleDeleteOverride(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  const ok = await db.deleteOverride(env.DB, Number(params.id));
  await audit(env, request, 'date_override.delete', 'date_override', params.id, null);
  return json({ ok });
}

// ---------------------------------------------------------------------------
// Customers (CRM) — Dashboard v2. No customers table: every row here is
// DERIVED from `bookings` by src/logic.js:aggregateCustomers (SPEC.md §12.5 /
// migrations/0004). Listing re-aggregates on every call — fine at her volume
// (a few thousand bookings), and means there is never a stale cache to
// invalidate when a booking is added/edited.
// ---------------------------------------------------------------------------

export async function handleListCustomers(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || undefined;
  const rows = await db.listCustomerBookingRows(env.DB);
  const customers = aggregateCustomers(rows, q);
  return json({ customers });
}

export async function handleGetCustomer(request, env, params) {
  // router.js already decodeURIComponent()s path params — no double-decode here.
  const email = String(params.email || '').trim().toLowerCase();
  if (!email) return errorJson('bad_request', 'email is required', 400);

  const rows = await db.listCustomerBookingRows(env.DB);
  const ownRows = rows.filter((r) => String(r.email || '').trim().toLowerCase() === email);
  if (ownRows.length === 0) return errorJson('not_found', null, 404);

  const [customer] = aggregateCustomers(ownRows);
  // Newest-first, so the detail drawer reads like a timeline of this person.
  const bookings = ownRows
    .slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return json({ customer, bookings });
}

/**
 * Edits a customer's name/phone/email and propagates the change onto every
 * one of their booking rows (owner requirement: "fix a typo once, it's fixed
 * everywhere" — see db.js:updateCustomer). `params.email` is the CURRENT
 * (old) email being edited; the body may include a new `email` to move them
 * to, which re-points every row to that new address in one statement.
 */
export async function handleUpdateCustomer(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  const oldEmail = String(params.email || '').trim().toLowerCase();
  if (!oldEmail) return errorJson('bad_request', 'email is required', 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }

  const patch = {};
  if ('name' in body) {
    if (!body.name || typeof body.name !== 'string') return errorJson('bad_request', 'name must be a non-empty string', 400);
    patch.name = body.name;
  }
  if ('phone' in body) patch.phone = body.phone || null;
  if ('email' in body) {
    if (!body.email || !EMAIL_RE.test(body.email)) return errorJson('bad_request', 'email must be a valid address', 400);
    patch.email = body.email;
  }

  const result = await db.updateCustomer(env.DB, oldEmail, patch);
  if (result.updated === 0) return errorJson('not_found', 'no bookings found for that email', 404);
  await audit(env, request, 'customer.update', 'customer', oldEmail, patch);
  return json({ ok: true, updated: result.updated });
}

// ---------------------------------------------------------------------------
// Manual (phone) booking — Dashboard v2 owner requirement #2. Lands straight
// as a CONFIRMED, source='manual' booking (no Stripe checkout), guarded by
// the exact same atomic seat-capacity SQL as the guest widget's hold
// (db.js:createManualBooking / SPEC.md §12.6) — so a booking taken over the
// phone can never oversell a bar the same way a web booking can't.
// ---------------------------------------------------------------------------

const VALID_PAYMENT_STATUS = new Set(['paid_invoice', 'free', 'comp']);

export async function handleCreateManualBooking(request, env) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }

  const { route_id, date, slot, party, name, email, phone, notes, locale, marketing_opt_in, payment_status, discount_code, discount_cents } = body || {};

  if (!route_id || typeof route_id !== 'string') return errorJson('bad_request', 'route_id is required', 400);
  if (!date || !DATE_RE.test(date)) return errorJson('bad_request', 'date must be YYYY-MM-DD', 400);
  if (!slot || typeof slot !== 'string') return errorJson('bad_request', 'slot is required', 400);
  if (!Number.isInteger(party) || party < 1) return errorJson('bad_request', 'party must be a positive integer', 400);
  if (!name || typeof name !== 'string') return errorJson('bad_request', 'name is required', 400);
  if (!email || !EMAIL_RE.test(email)) return errorJson('bad_request', 'a valid email is required', 400);
  if (payment_status !== undefined && !VALID_PAYMENT_STATUS.has(payment_status)) {
    return errorJson('bad_request', `payment_status must be one of ${[...VALID_PAYMENT_STATUS].join(', ')}`, 400);
  }
  if (discount_cents !== undefined && (!Number.isInteger(discount_cents) || discount_cents < 0)) {
    return errorJson('bad_request', 'discount_cents must be a non-negative integer', 400);
  }
  // Same rules as the guest widget's /api/book (logic.js:validateNotes) —
  // the phone-booking path must not become a backdoor for junk notes.
  const notesCheck = validateNotes(notes);
  if (!notesCheck.ok) return errorJson('bad_request', notesCheck.message, 400);

  // route need only exist (any active state) — a manual entry is the owner
  // overriding the normal open/closed/max_party guest-facing rules on
  // purpose, per db.js:createManualBooking's doc comment. Only the physical
  // seat count is kept a hard, atomic guard.
  const route = await db.getRoute(env.DB, route_id);
  if (!route) return errorJson('route_not_found', null, 404);

  const bookingId = `b_${crypto.randomUUID()}`;
  const result = await db.createManualBooking(env.DB, {
    id: bookingId,
    route_id,
    date,
    slot,
    party,
    name,
    email,
    phone: phone || null,
    notes: notesCheck.notes,
    locale: locale === 'nl' ? 'nl' : 'en',
    marketing_opt_in: !!marketing_opt_in,
    payment_status: payment_status || 'paid_invoice',
    discount_code: discount_code || null,
    discount_cents: discount_cents || 0,
  });

  if (!result.created) {
    return errorJson('sold_out', `only ${result.seats_left} seat(s) left for that date/slot`, 409);
  }

  // Same guest-facing confirmation + bar heads-up a web booking gets — the
  // guest booked over the phone still deserves a real confirmation email,
  // and the bar still needs to know these guests are coming. No owner
  // notification: she's the one who just typed this in.
  await sendGuestConfirmationEmails(env, result.booking, route);
  await notifyBars(env, result.booking, route);
  // Newsletter subscriber plumbing (BUILD item #3) — a manual (phone) booking
  // is just as real a consent act as a web one; never throws, see
  // src/subscribers.js's own try/catch contract.
  const baseUrl = new URL(request.url).origin;
  await handleConfirmedBookingOptIn(env, result.booking, route, { baseUrl });
  await audit(env, request, 'booking.create_manual', 'booking', bookingId, { route_id, date, slot, party, email });

  return json({ booking: result.booking }, 201);
}

// ---------------------------------------------------------------------------
// Move / Cancel — owner drawer actions on an already-CONFIRMED booking
// (SPEC addendum). Both mirror handleCreateManualBooking's shape: CSRF →
// parse/validate → load route → atomic db op → map failure codes → send the
// already-approved emails → audit → json(). Refunds are OUT OF SCOPE here —
// cancelling only frees the seat and emails guest+bars; any money movement
// is the owner's own manual Stripe-dashboard action. The cancel email's
// optional `message` is where she pastes refund wording, if any.
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/bookings/:id/reschedule — body { date, slot }. Moves a
 * confirmed booking to a new date/slot ON THE SAME ROUTE, guarded by the
 * same atomic seat check every other booking write uses (db.rescheduleBooking).
 * Same date+slot as today is accepted as a no-op (200, booking unchanged,
 * no emails) rather than an error — a deliberate choice so an owner who
 * re-submits the form with nothing changed doesn't spam the guest and every
 * bar with a "your booking moved" email that describes no actual change.
 */
export async function handleRescheduleBooking(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const { date, slot } = body || {};
  if (!date || !DATE_RE.test(date)) return errorJson('bad_request', 'date must be YYYY-MM-DD', 400);
  if (!slot || typeof slot !== 'string') return errorJson('bad_request', 'slot is required', 400);

  const existing = await db.getBooking(env.DB, params.id);
  if (!existing) return errorJson('not_found', null, 404);
  const route = await db.getRoute(env.DB, existing.route_id);
  if (!route) return errorJson('route_not_found', null, 404);

  const result = await db.rescheduleBooking(env.DB, { id: params.id, date, slot });
  if (result.not_found) return errorJson('not_found', null, 404);
  if (result.not_movable) return errorJson('not_movable', 'only confirmed bookings can be moved', 409);
  if (result.moved === false) {
    return errorJson('sold_out', `only ${result.seats_left} seat(s) left for that date/slot`, 409);
  }

  if (!result.noop) {
    await sendGuestRescheduleEmail(env, result.booking, route, { previous: result.previous });
    await notifyBarsReschedule(env, result.booking, route, { previous: result.previous });
  }
  await audit(env, request, 'booking.reschedule', 'booking', params.id, {
    from: result.previous, to: { date, slot }, noop: !!result.noop,
  });
  return json({ booking: result.booking });
}

const MAX_CANCEL_MESSAGE_LENGTH = 2000;

/**
 * POST /admin/api/bookings/:id/cancel — body { message? }. Cancels a
 * confirmed booking, freeing its seats (cancelled bookings never count
 * toward capacity — see every SUM guard in db.js), and emails the guest +
 * every bar. `message` is an optional free-text note the owner can attach to
 * the guest email (e.g. refund wording) — it does NOT trigger any refund by
 * itself; refunds stay a manual Stripe-dashboard action.
 */
export async function handleCancelBooking(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  const { message } = body || {};
  if (message !== undefined && message !== null) {
    if (typeof message !== 'string') return errorJson('bad_request', 'message must be a string', 400);
    if (message.length > MAX_CANCEL_MESSAGE_LENGTH) {
      return errorJson('bad_request', `message must be ${MAX_CANCEL_MESSAGE_LENGTH} characters or fewer`, 400);
    }
  }

  const existing = await db.getBooking(env.DB, params.id);
  if (!existing) return errorJson('not_found', null, 404);
  const route = await db.getRoute(env.DB, existing.route_id);
  if (!route) return errorJson('route_not_found', null, 404);

  const result = await db.cancelBooking(env.DB, { id: params.id });
  if (result.not_found) return errorJson('not_found', null, 404);
  if (result.not_cancellable) return errorJson('not_cancellable', 'only confirmed bookings can be cancelled', 409);

  const trimmedMessage = message && String(message).trim() ? message : undefined;
  await sendGuestCancellationEmail(env, result.booking, route, { message: trimmedMessage });
  await notifyBarsCancellation(env, result.booking, route);
  await audit(env, request, 'booking.cancel', 'booking', params.id, { message: !!trimmedMessage });
  return json({ booking: result.booking });
}

/**
 * POST /admin/api/bookings/:id/send-review (staff+, migrations/0026, BUILD
 * §20) — manual trigger for the "how was your walk?" email, for testing a
 * specific booking without waiting for the next day's cron. Uses the SAME
 * atomic claim (src/reviews.js:sendReviewRequestForBooking) the cron uses,
 * so this can't double-send a review request the cron already sent (or vice
 * versa) — only a booking that's 'confirmed' and hasn't been sent one yet
 * actually goes out.
 */
export async function handleSendReviewRequest(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  const booking = await db.getBooking(env.DB, params.id);
  if (!booking) return errorJson('not_found', null, 404);
  const route = await db.getRoute(env.DB, booking.route_id);
  if (!route) return errorJson('route_not_found', null, 404);

  const result = await sendReviewRequestForBooking(env, { ...booking, route_name: route.name, city: route.city, route_id: route.id });
  if (!result.sent) return errorJson(result.reason || 'not_sent', 'could not send a review request for this booking', 409);
  await audit(env, request, 'booking.send_review', 'booking', params.id, { email: booking.email });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Production hardening (2026-07): dashboard-readable observability for the
// error_log (item #5), admin_audit (item #8), and failed_email (item #12)
// tables, plus an on-demand health-check endpoint (item #6) so the owner can
// see current status without waiting for the next cron tick or a crash
// alert email. All session-guarded like every other /admin/api/* route.
// ---------------------------------------------------------------------------

export async function handleAuditLog(request, env) {
  const entries = await db.listAdminAudit(env.DB, 200);
  return json({ entries });
}

export async function handleErrorLog(request, env) {
  const errors = await db.listRecentErrors(env.DB, 100);
  const count24h = await db.countErrorsSince(env.DB, sqliteMinutesAgo(24 * 60));
  return json({ count_24h: count24h, errors });
}

export async function handleFailedEmails(request, env) {
  const emails = await db.listRecentFailedEmails(env.DB, 100);
  return json({ emails });
}

export async function handleHealthCheck(request, env) {
  const result = await runHealthCheck(env);
  return json(result, result.ok ? 200 : 503);
}

// ---------------------------------------------------------------------------
// Gift cards (migrations/0018/0019) — dashboard visibility + owner "void".
// Balances themselves only ever change via src/db.js:redeemGiftCard (the
// atomic guarded UPDATE called from the Stripe webhook) — nothing here ever
// edits balance_cents directly.
// ---------------------------------------------------------------------------

export async function handleListGiftCards(request, env) {
  const gift_cards = await db.listGiftCards(env.DB);
  return json({ gift_cards });
}

// ---------------------------------------------------------------------------
// Contact + group-booking inquiries (migrations/0021, audit item 9)
// ---------------------------------------------------------------------------

/** GET /admin/api/inquiries — session-guarded like every /admin/api/* route
 * (index.js). Read-only list for now; the admin UI to mark one read/replied
 * is a follow-up (SETUP.md notes this as the next step). */
export async function handleListInquiries(request, env) {
  const inquiries = await db.listInquiries(env.DB);
  return json({ inquiries });
}

/** POST /admin/api/gift-cards/:code/void — owner cancels an active card (e.g.
 * a refunded purchase). Already-depleted/void cards are left untouched. */
export async function handleVoidGiftCard(request, env, params) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  const ok = await db.voidGiftCard(env.DB, params.code);
  if (!ok) return errorJson('not_found', 'no active gift card with that code', 404);
  await audit(env, request, 'gift_card.void', 'gift_card', params.code, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Newsletter subscribers (migrations/0024, BUILD §17) — Brevo contact model
// setup, the Stripe welcome-code bootstrap, admin list/CSV, and the Wix
// import. Session-guarded like every other /admin/api/* route.
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/brevo/setup — idempotently ensures the folder, list, and
 * every custom contact attribute the subscriber plumbing needs exist in
 * Brevo (BUILD item #1). Safe to call repeatedly: each ensure* helper
 * (src/brevo.js) checks for an existing match by name before creating
 * anything. The resulting list id is stored in `settings` (BREVO_LIST_ID_SETTING_KEY)
 * so every later contact upsert/unsubscribe (src/subscribers.js) knows which
 * list to add to/remove from without re-querying Brevo each time.
 */
export async function handleBrevoSetup(request, env) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  if (!env.BREVO_API_KEY) return errorJson('bad_request', 'BREVO_API_KEY is not configured', 400);

  let folder, list;
  try {
    folder = await ensureContactFolder(env, BREVO_FOLDER_NAME);
    list = await ensureContactList(env, BREVO_LIST_NAME, folder.id);
    await db.setSetting(env.DB, BREVO_LIST_ID_SETTING_KEY, String(list.id));
  } catch (err) {
    return errorJson('brevo_error', String(err && err.message ? err.message : err), 502);
  }

  const attributes = [];
  for (const attr of BREVO_CONTACT_ATTRIBUTES) {
    try {
      attributes.push(await ensureContactAttribute(env, attr.name, attr.type));
    } catch (err) {
      attributes.push({ name: attr.name, type: attr.type, created: false, error: String(err && err.message ? err.message : err) });
    }
  }

  await audit(env, request, 'brevo.setup', null, null, {
    folder, list, attributes_created: attributes.filter((a) => a.created).length,
  });
  return json({ folder, list, attributes });
}

/**
 * POST /admin/api/brevo/push-reference-templates (owner only, BUILD §19's
 * Brevo reference-copy pass) — renders every transactional email this
 * codebase can send (src/emails.js:buildReferenceTemplateSet, realistic
 * sample data) and idempotently creates/updates one INACTIVE
 * "[REFERENCE] ..." template per email in the Brevo account, via
 * brevo.js:upsertTransactionalTemplate (lookup-by-name, PUT if it already
 * exists, POST if not). Purely a reviewable COPY inside Brevo's own UI —
 * editing a pushed template there changes nothing about what WOGO actually
 * sends (every real send still goes through sendTransactional's owned-HTML
 * path, never a Brevo template id). Safe to re-run any time; re-running
 * after an emails.js copy change updates the existing reference templates
 * in place rather than piling up duplicates.
 *
 * A per-template Brevo failure is collected and reported rather than
 * aborting the whole run — one bad template (a transient Brevo error, a
 * rate limit) shouldn't block the other 20 from being pushed.
 */
export async function handleBrevoPushReferenceTemplates(request, env) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  if (!env.BREVO_API_KEY) return errorJson('bad_request', 'BREVO_API_KEY is not configured', 400);

  const templates = buildReferenceTemplateSet();
  const results = [];
  for (const tpl of templates) {
    try {
      const result = await upsertTransactionalTemplate(env, {
        templateName: tpl.name,
        subject: tpl.subject,
        sender: EMAIL_SENDER,
        htmlContent: tpl.html,
        isActive: false,
      });
      results.push({ name: tpl.name, id: result.id, created: result.created });
    } catch (err) {
      results.push({ name: tpl.name, error: String(err && err.message ? err.message : err) });
    }
  }

  const pushed = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => r.error).length;
  await audit(env, request, 'brevo.push_reference_templates', null, null, { pushed, failed });
  return json({ pushed, failed, templates: results });
}

/**
 * POST /admin/api/stripe/ensure-welcome-code — idempotently creates the
 * WELCOME10 Stripe Promotion Code (10% off, see src/stripe.js's doc comment
 * on the "once per customer" approximation it actually applies). Stripe's own
 * error body is surfaced on failure rather than a generic message, so the
 * owner can see exactly why Stripe rejected the create.
 */
export async function handleEnsureWelcomeCode(request, env) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  if (!env.STRIPE_SECRET_KEY) return errorJson('bad_request', 'STRIPE_SECRET_KEY is not configured', 400);
  try {
    const result = await ensureWelcomePromotionCode(env, WELCOME_CODE, WELCOME_DISCOUNT_PERCENT);
    await audit(env, request, 'stripe.ensure_welcome_code', null, null, { created: result.created, code: result.code });
    return json(result);
  } catch (err) {
    return errorJson('stripe_error', String(err && err.message ? err.message : err), 502);
  }
}

function parseSubscriberFilters(url) {
  const p = url.searchParams;
  return {
    status: p.get('status') || undefined,
    source: p.get('source') || undefined,
    locale: p.get('locale') || undefined,
    q: p.get('q') || undefined,
    limit: p.get('limit') ? Number(p.get('limit')) : undefined,
    offset: p.get('offset') ? Number(p.get('offset')) : undefined,
  };
}

/** GET /admin/api/subscribers?status=&source=&locale=&q=&page= — list +
 * counts by status/source/locale for the dashboard's Subscribers tab. `page`
 * (1-based, optional) is a convenience over raw limit/offset: page N with the
 * request's own `limit` (default 200) maps to offset = (N-1)*limit. */
export async function handleListSubscribers(request, env) {
  const url = new URL(request.url);
  const filters = parseSubscriberFilters(url);
  const page = url.searchParams.get('page') ? Math.max(1, Number(url.searchParams.get('page'))) : 1;
  const limit = filters.limit || 200;
  filters.limit = limit;
  filters.offset = (page - 1) * limit;

  const subscribers = await db.listSubscribers(env.DB, filters);
  const total = await db.countSubscribersFiltered(env.DB, filters);
  const by_status = await db.countSubscribersByStatus(env.DB);
  const by_source = await db.countSubscribersBySource(env.DB);
  const by_locale = await db.countSubscribersByLocale(env.DB);
  return json({ subscribers, total, page, limit, counts: { by_status, by_source, by_locale } });
}

const SUBSCRIBER_CSV_COLUMNS = ['id', 'email', 'first_name', 'locale', 'city', 'source', 'status', 'created_at', 'confirmed_at', 'unsubscribed_at'];

export async function handleSubscribersCsv(request, env) {
  const url = new URL(request.url);
  const filters = parseSubscriberFilters(url);
  filters.limit = 10000;
  filters.offset = 0;
  const subscribers = await db.listSubscribers(env.DB, filters);
  const csv = toCsv(subscribers, SUBSCRIBER_CSV_COLUMNS);
  const today = new Date().toISOString().slice(0, 10);
  await audit(env, request, 'subscribers.export_csv', null, null, { rows: subscribers.length, filters });
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="wogo-subscribers-${today}.csv"`,
    },
  });
}

const MAX_IMPORT_ROWS = 2000;

/**
 * POST /admin/api/subscribers/import — body: a JSON array (max 2000) of
 * { email, first_name?, locale?, city?, consented_at? } (BUILD item #5).
 * `consented_at` is accepted for the owner's own record-keeping but not
 * persisted on the subscriber row today (the row's own created_at/confirmed_at
 * already mark "when WOGO's system first knew about this consent" — adding a
 * separate historical-consent-date column is a natural follow-up if Maroussia
 * wants the ORIGINAL Wix consent date preserved distinctly; flagged in
 * SETUP.md rather than silently dropped). Every row lands as a CONFIRMED,
 * source='wix_import' subscriber — see src/subscribers.js:importSubscribers
 * for the chunked Brevo upsert + per-row retry-on-failure behaviour.
 */
export async function handleImportSubscribers(request, env) {
  if (!requireCsrf(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON', 400);
  }
  if (!Array.isArray(body) || body.length === 0) {
    return errorJson('bad_request', 'body must be a non-empty JSON array of {email, first_name?, locale?, city?}', 400);
  }
  if (body.length > MAX_IMPORT_ROWS) {
    return errorJson('bad_request', `max ${MAX_IMPORT_ROWS} rows per call`, 400);
  }
  for (const row of body) {
    if (!row || typeof row.email !== 'string' || !EMAIL_RE.test(row.email)) {
      return errorJson('bad_request', `invalid or missing email in one row: ${row && row.email}`, 400);
    }
    if (row.first_name !== undefined && row.first_name !== null && (typeof row.first_name !== 'string' || row.first_name.length > SUBSCRIBE_NAME_MAX_LENGTH)) {
      return errorJson('bad_request', `invalid first_name for ${row.email}`, 400);
    }
    if (row.city !== undefined && row.city !== null && (typeof row.city !== 'string' || row.city.length > SUBSCRIBE_CITY_MAX_LENGTH)) {
      return errorJson('bad_request', `invalid city for ${row.email}`, 400);
    }
  }

  const result = await importSubscribers(env, body);
  await audit(env, request, 'subscribers.import', null, null, {
    rows: body.length, imported: result.imported, updated: result.updated,
    queued_for_retry: result.queued_for_retry, errors: result.errors.length,
  });
  return json(result, 201);
}

/** GET /admin/api/subscribers/sync-queue — dashboard visibility into the
 * Brevo retry queue (BUILD item #7), same shape as GET /admin/api/failed-emails. */
export async function handleBrevoSyncQueue(request, env) {
  const items = await db.listRecentBrevoSyncItems(env.DB, 100);
  return json({ items });
}

// ---------------------------------------------------------------------------
// Analytics (migrations/0025's idx_bookings_created, BUILD §19, viewer+).
// SPEC.md §19 documents the full response shape for a future reader (e.g. a
// skill that pulls the weekly KPI set into Maroussia's Notion tracker).
// ---------------------------------------------------------------------------

/** `from`/`to` both 'YYYY-MM-DD', from <= to, range capped at
 * ANALYTICS_MAX_RANGE_DAYS. Returns `null` on anything invalid. */
function parseAnalyticsRange(url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return null;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (!(days > 0) || days > ANALYTICS_MAX_RANGE_DAYS) return null;
  return { from, to };
}

const ANALYTICS_GROUPS = new Set(['day', 'week', 'month']);

/**
 * GET /admin/api/analytics?from&to&group=day|week|month (viewer+). Two
 * independent lenses on the SAME [from,to] window (owner requirement: "by
 * booking DATE (walk date) and also by created_at (sale date)"):
 *   - `series_by_booking_date` / every `by_*` breakdown / `totals` — built
 *     from bookings whose WALK date falls in the range ("business that
 *     happened in this period").
 *   - `series_by_sale_date` — built from bookings whose CREATED_AT falls in
 *     the range ("bookings sold in this period"); deliberately does NOT get
 *     its own by-route/by-city/etc. breakdowns (see logic.js:buildBookingAnalytics's
 *     doc comment — one well-tested function, called twice, the second
 *     call's extra breakdowns are just unused rather than duplicated as a
 *     second function).
 * `cancellations`/`inquiries_by_kind`/`subscribers.new_confirmed`/gift-card
 * sold+redeemed are period-bound the same [from,to] window (sale-side dates
 * where no walk-date concept applies — see each db.js function's doc
 * comment for exactly which date column). `gift_cards.outstanding_balance_cents`
 * and `top_upcoming_days` are deliberately NOT period-bound — they're "right
 * now" / "what's coming" snapshots, not "what happened in this window".
 */
export async function handleAnalytics(request, env) {
  const url = new URL(request.url);
  const range = parseAnalyticsRange(url);
  if (!range) {
    return errorJson('bad_request', `from and to (YYYY-MM-DD, from <= to, max ${ANALYTICS_MAX_RANGE_DAYS} days) are required`, 400);
  }
  const groupParam = url.searchParams.get('group');
  const group = ANALYTICS_GROUPS.has(groupParam) ? groupParam : 'day';
  const saleFrom = `${range.from} 00:00:00`;
  const saleTo = `${range.to} 23:59:59`;

  const [walkRows, saleRows, cancelled, upcoming, giftSales, giftRedeemedCents, giftOutstandingCents, inquiries, newSubs, subsByStatus] = await Promise.all([
    db.listBookingsForAnalyticsByWalkDate(env.DB, range.from, range.to),
    db.listBookingsForAnalyticsBySaleDate(env.DB, saleFrom, saleTo),
    db.countCancelledBookingsByWalkDate(env.DB, range.from, range.to),
    db.listUpcomingGuestsByDate(env.DB, nowSqlite().slice(0, 10), 10),
    db.giftCardSalesSummary(env.DB, saleFrom, saleTo),
    db.giftCardRedemptionsSummary(env.DB, saleFrom, saleTo),
    db.giftCardOutstandingBalance(env.DB),
    db.countInquiriesByKind(env.DB, saleFrom, saleTo),
    db.countNewConfirmedSubscribers(env.DB, saleFrom, saleTo),
    db.countSubscribersByStatus(env.DB),
  ]);

  const walkAnalytics = buildBookingAnalytics(walkRows, { group, dateField: 'date' });
  const saleAnalytics = buildBookingAnalytics(saleRows, { group, dateField: 'created_at' });
  const confirmedTotalRow = subsByStatus.find((r) => r.status === 'confirmed');

  return json({
    from: range.from,
    to: range.to,
    group,
    series_by_booking_date: walkAnalytics.series,
    series_by_sale_date: saleAnalytics.series,
    by_route: walkAnalytics.by_route,
    by_city: walkAnalytics.by_city,
    by_weekday: walkAnalytics.by_weekday,
    by_slot: walkAnalytics.by_slot,
    by_source: walkAnalytics.by_source,
    by_locale: walkAnalytics.by_locale,
    discount_usage: walkAnalytics.discount_usage,
    totals: walkAnalytics.totals,
    cancellations: { count: cancelled.n, guests: cancelled.guests },
    gift_cards: {
      sold_count: giftSales.sold_count,
      sold_value_cents: giftSales.sold_value_cents,
      redeemed_value_cents: giftRedeemedCents,
      outstanding_balance_cents: giftOutstandingCents,
    },
    inquiries_by_kind: inquiries,
    subscribers: { new_confirmed: newSubs, total_confirmed: confirmedTotalRow ? confirmedTotalRow.n : 0 },
    top_upcoming_days: upcoming,
  });
}

/**
 * GET /admin/api/analytics/kpi (viewer+) — the compact weekly set the
 * owner's Monday Notion tracker needs (a future skill can read this
 * verbatim). "Last 7 days vs previous 7" is judged by SALE date
 * (created_at) — a rolling sales-velocity read ("how much did we sell this
 * week"), matching new_subscribers/gift_cards_sold which are naturally dated
 * by when they happened, not by some future walk date. `next_14_days_by_city`
 * is the separate forward-looking WALK-date lens (guests already booked to
 * walk in the next 14 days, per city) for "what's coming up operationally".
 *
 * Response shape:
 * {
 *   last_7_days:     { bookings, guests, revenue_cents, avg_order_value_cents, new_subscribers, gift_cards_sold },
 *   previous_7_days: { same shape },
 *   next_14_days_by_city: [{city, guests}]
 * }
 */
export async function handleAnalyticsKpi(request, env) {
  const today = nowSqlite().slice(0, 10);
  const last7From = addDaysToDateStr(today, -6);
  const prev7To = addDaysToDateStr(today, -7);
  const prev7From = addDaysToDateStr(today, -13);
  const next14To = addDaysToDateStr(today, 14);

  async function windowKpi(fromDate, toDate) {
    const fromDt = `${fromDate} 00:00:00`;
    const toDt = `${toDate} 23:59:59`;
    const [rows, newSubs, giftSales] = await Promise.all([
      db.listBookingsForAnalyticsBySaleDate(env.DB, fromDt, toDt),
      db.countNewConfirmedSubscribers(env.DB, fromDt, toDt),
      db.giftCardSalesSummary(env.DB, fromDt, toDt),
    ]);
    const a = buildBookingAnalytics(rows, { group: 'day', dateField: 'created_at' });
    const avgOrder = a.totals.bookings > 0 ? Math.round(a.totals.revenue_cents / a.totals.bookings) : 0;
    return {
      bookings: a.totals.bookings,
      guests: a.totals.guests,
      revenue_cents: a.totals.revenue_cents,
      avg_order_value_cents: avgOrder,
      new_subscribers: newSubs,
      gift_cards_sold: giftSales.sold_count,
    };
  }

  const [last7, previous7, byCity] = await Promise.all([
    windowKpi(last7From, today),
    windowKpi(prev7From, prev7To),
    db.listUpcomingGuestsByCity(env.DB, today, next14To),
  ]);

  return json({
    last_7_days: last7,
    previous_7_days: previous7,
    next_14_days_by_city: byCity,
  });
}

// ---------------------------------------------------------------------------
// GA4 traffic (BUILD §19's "Traffic" sub-page, viewer+). Config-gated — see
// src/ga4.js's doc comment: with GA4_SERVICE_ACCOUNT_JSON/GA4_PROPERTY_ID
// unset, this always returns {configured:false} and the dashboard shows a
// "connect Google Analytics" card instead of an error.
//
// Cached in `settings` (the same generic k/v table alerts.js already reuses
// as a clock) for GA4_CACHE_TTL_SECONDS (1h) PER [from,to] pair — GA4's Data
// API free tier has a real daily quota, and an owner tabbing between date
// ranges a few times a session should never risk hitting it. `settings` has
// no TTL of its own, so the cached value carries its own timestamp and this
// function compares that itself.
// ---------------------------------------------------------------------------

function ga4CacheKey(from, to) {
  return `ga4_traffic:${from}:${to}`;
}

export async function handleAnalyticsTraffic(request, env) {
  const url = new URL(request.url);
  const range = parseAnalyticsRange(url);
  if (!range) {
    return errorJson('bad_request', `from and to (YYYY-MM-DD, from <= to, max ${ANALYTICS_MAX_RANGE_DAYS} days) are required`, 400);
  }
  if (!isGa4Configured(env)) return json({ configured: false });

  const cacheKey = ga4CacheKey(range.from, range.to);
  try {
    const cachedRaw = await db.getSetting(env.DB, cacheKey);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      const ageSeconds = Math.floor(Date.now() / 1000) - cached.ts;
      if (ageSeconds >= 0 && ageSeconds < GA4_CACHE_TTL_SECONDS) return json(cached.data);
    }
  } catch (err) {
    console.error('ga4_cache_read_failed', err); // fall through to a fresh fetch
  }

  const data = await getTrafficSummary(env, range.from, range.to);
  if (data.configured) {
    try {
      await db.setSetting(env.DB, cacheKey, JSON.stringify({ ts: Math.floor(Date.now() / 1000), data }));
    } catch (err) {
      console.error('ga4_cache_write_failed', err); // the response is still correct, just not cached
    }
  }
  return json(data);
}

/** Shared settings-table cache wrapper for every GA4-backed endpoint below —
 * same read-then-maybe-fetch-then-maybe-write shape as handleAnalyticsTraffic
 * above, factored out so Realtime/Highlights/Behavior/Marketing don't each
 * hand-roll the same try/catch-and-fall-through. `fetcher()` is only called
 * on a cache miss/expiry/read-failure; its result is cached only when
 * `.configured` is true (an unconfigured response is cheap enough — and
 * changes rarely enough on its own — that caching it would just risk
 * serving a stale "not configured" after the owner DOES connect GA4).
 */
async function cachedGa4(env, cacheKey, ttlSeconds, fetcher) {
  try {
    const cachedRaw = await db.getSetting(env.DB, cacheKey);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      const ageSeconds = Math.floor(Date.now() / 1000) - cached.ts;
      if (ageSeconds >= 0 && ageSeconds < ttlSeconds) return cached.data;
    }
  } catch (err) {
    console.error('ga4_cache_read_failed', err); // fall through to a fresh fetch
  }
  const data = await fetcher();
  if (data.configured) {
    try {
      await db.setSetting(env.DB, cacheKey, JSON.stringify({ ts: Math.floor(Date.now() / 1000), data }));
    } catch (err) {
      console.error('ga4_cache_write_failed', err); // the response is still correct, just not cached
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Highlights (BUILD §19.4's "Highlights" page, viewer+): the Wix-style "Key
// stats" grid (current + previous period in one call so the dashboard
// computes deltas/sparklines client-side) and "Track your sales" (top
// selling items, sales by source, top paying customers) — the three
// explicitly-not-built-yet modules from the earlier Analytics pass.
// ---------------------------------------------------------------------------

/** Same length immediately preceding [from, to] — e.g. [2026-02-08,
 * 2026-02-21] (14 days) -> previous = [2026-01-25, 2026-02-07]. Used for
 * EVERY %-vs-previous-period comparison on this page (sales totals, traffic
 * totals, top-selling-items/sales-by-source deltas) so "previous period"
 * means the same thing everywhere on Highlights. */
function previousPeriod(from, to) {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  const previousTo = addDaysToDateStr(from, -1);
  const previousFrom = addDaysToDateStr(previousTo, -(days - 1));
  return { previousFrom, previousTo };
}

/** Zero-fills a GA4 daily-metrics array (GA4 simply omits a day with zero
 * sessions) against the full [from, to] window, so it lines up index-for-
 * index with logic.js:buildHighlightsSales' already-zero-filled D1 series
 * for a sparkline. */
function zeroFillTrafficDaily(rows, from, to) {
  const byDate = new Map((rows || []).map((r) => [r.date, r]));
  const out = [];
  // `d <= to` is a defensive bound, not load-bearing today (every caller
  // already validates from <= to via parseAnalyticsRange/previousPeriod) —
  // without it, a future bad range would spin this loop until the Worker's
  // CPU-time limit kills the request instead of just returning wrong data.
  for (let d = from; d <= to; d = addDaysToDateStr(d, 1)) {
    out.push(byDate.get(d) || { date: d, sessions: 0, page_views: 0, unique_visitors: 0 });
    if (d === to) break;
  }
  return out;
}

export async function handleAnalyticsHighlights(request, env) {
  const url = new URL(request.url);
  const range = parseAnalyticsRange(url);
  if (!range) {
    return errorJson('bad_request', `from and to (YYYY-MM-DD, from <= to, max ${ANALYTICS_MAX_RANGE_DAYS} days) are required`, 400);
  }
  const { previousFrom, previousTo } = previousPeriod(range.from, range.to);

  // Highlights is deliberately SALE-date throughout (logic.js:
  // buildHighlightsSales' doc comment) — matching §19.2's KPI endpoint and
  // the fact that utm_source/GA4 sessions are both naturally dated by when
  // the visit/purchase happened, not by some future walk date.
  const [currentRows, previousRows, trafficRaw] = await Promise.all([
    db.listBookingsForAnalyticsBySaleDate(env.DB, `${range.from} 00:00:00`, `${range.to} 23:59:59`),
    db.listBookingsForAnalyticsBySaleDate(env.DB, `${previousFrom} 00:00:00`, `${previousTo} 23:59:59`),
    isGa4Configured(env)
      ? cachedGa4(
          env,
          `ga4_highlights:${range.from}:${range.to}`,
          GA4_CACHE_TTL_SECONDS,
          () => getHighlightsTraffic(env, range.from, range.to, previousFrom, previousTo)
        )
      : Promise.resolve({ configured: false }),
  ]);

  const sales = buildHighlightsSales(currentRows, range.from, range.to, { dateField: 'created_at' });
  const previousSales = buildHighlightsSales(previousRows, previousFrom, previousTo, { dateField: 'created_at' });

  // Top selling items / sales by source: match current <-> previous rows by
  // key and attach a %-delta — a route/source with no previous-period rows
  // at all still appears (computePctDelta(cur, 0) -> null, "new").
  const previousByRoute = new Map(previousSales.by_route.map((r) => [r.route_id, r]));
  const topSellingItems = sales.by_route.map((r) => ({
    route_id: r.route_id,
    route_name: r.route_name,
    city: r.city,
    poster_url: posterUrlFor({ id: r.route_id }),
    revenue_cents: r.revenue_cents,
    guests: r.guests,
    orders: r.orders,
    pct_delta: computePctDelta(r.revenue_cents, previousByRoute.has(r.route_id) ? previousByRoute.get(r.route_id).revenue_cents : 0),
  }));

  const previousBySource = new Map(previousSales.by_source.map((r) => [r.source, r]));
  const salesBySource = sales.by_source.map((r) => ({
    source: r.source,
    revenue_cents: r.revenue_cents,
    orders: r.orders,
    pct_delta: computePctDelta(r.revenue_cents, previousBySource.has(r.source) ? previousBySource.get(r.source).revenue_cents : 0),
  }));

  const traffic = trafficRaw.configured
    ? {
        configured: true,
        daily: zeroFillTrafficDaily(trafficRaw.daily, range.from, range.to),
        previous_daily: zeroFillTrafficDaily(trafficRaw.previous_daily, previousFrom, previousTo),
        totals: trafficRaw.totals,
        previous_totals: trafficRaw.previous_totals,
      }
    : { configured: false };

  return json({
    from: range.from,
    to: range.to,
    previous_from: previousFrom,
    previous_to: previousTo,
    sales: { daily: sales.daily, totals: sales.totals },
    previous_sales: { daily: previousSales.daily, totals: previousSales.totals },
    traffic,
    top_selling_items: topSellingItems,
    sales_by_source: salesBySource,
    top_paying_customers: sales.top_customers,
  });
}

// ---------------------------------------------------------------------------
// Real-time (BUILD §19.4's "Real-time" page, viewer+) — GA4 only, config-
// gated like Traffic. Cached 30s (REALTIME_CACHE_TTL_SECONDS) — the
// dashboard itself auto-refreshes every 60s while the page is open, so this
// floor just stops a burst of near-simultaneous tabs/reloads from each
// re-hitting GA4.
// ---------------------------------------------------------------------------

export async function handleAnalyticsRealtime(request, env) {
  if (!isGa4Configured(env)) return json({ configured: false });
  const data = await cachedGa4(env, 'ga4_realtime', REALTIME_CACHE_TTL_SECONDS, () => getRealtimeSummary(env));
  return json(data);
}

// ---------------------------------------------------------------------------
// Behavior (BUILD §19.4's "Behavior" page, viewer+) — GA4 top pages/
// engagement/funnel/events, plus page-views-per-city (logic.js:pageViewsByCity
// over the same top-pages rows GA4 already returned — no extra report).
// ---------------------------------------------------------------------------

export async function handleAnalyticsBehavior(request, env) {
  const url = new URL(request.url);
  const range = parseAnalyticsRange(url);
  if (!range) {
    return errorJson('bad_request', `from and to (YYYY-MM-DD, from <= to, max ${ANALYTICS_MAX_RANGE_DAYS} days) are required`, 400);
  }
  if (!isGa4Configured(env)) return json({ configured: false });

  const data = await cachedGa4(
    env,
    `ga4_behavior:${range.from}:${range.to}`,
    GA4_CACHE_TTL_SECONDS,
    () => getBehaviorSummary(env, range.from, range.to)
  );
  if (!data.configured) return json(data);
  return json({ ...data, by_city: pageViewsByCity(data.by_page) });
}

// ---------------------------------------------------------------------------
// Marketing (BUILD §19.4's "Marketing" page, viewer+) — GA4 sessions/
// purchases/revenue by source×medium and by campaign (top 15), PLUS D1:
// subscriber growth in-period + lifetime totals by source, discount-code
// usage in-period, and gift cards sold/redeemed in-period.
// ---------------------------------------------------------------------------

/** Zero-fills db.js:subscribersGrowthByDay's sparse rows against [from,to] —
 * same reasoning as zeroFillTrafficDaily above, just for the subscribers
 * growth chart instead of GA4 traffic. */
function zeroFillSubscriberGrowth(rows, from, to) {
  const byDate = new Map((rows || []).map((r) => [r.date, r.n]));
  const out = [];
  for (let d = from; d <= to; d = addDaysToDateStr(d, 1)) {
    out.push({ date: d, new_subscribers: byDate.get(d) || 0 });
    if (d === to) break;
  }
  return out;
}

export async function handleAnalyticsMarketing(request, env) {
  const url = new URL(request.url);
  const range = parseAnalyticsRange(url);
  if (!range) {
    return errorJson('bad_request', `from and to (YYYY-MM-DD, from <= to, max ${ANALYTICS_MAX_RANGE_DAYS} days) are required`, 400);
  }
  const fromDt = `${range.from} 00:00:00`;
  const toDt = `${range.to} 23:59:59`;

  const [walkRows, subscriberGrowth, subscribersBySource, giftSales, giftRedeemedCents, traffic] = await Promise.all([
    db.listBookingsForAnalyticsByWalkDate(env.DB, range.from, range.to),
    db.subscribersGrowthByDay(env.DB, fromDt, toDt),
    db.countSubscribersBySource(env.DB),
    db.giftCardSalesSummary(env.DB, fromDt, toDt),
    db.giftCardRedemptionsSummary(env.DB, fromDt, toDt),
    isGa4Configured(env)
      ? cachedGa4(env, `ga4_marketing:${range.from}:${range.to}`, GA4_CACHE_TTL_SECONDS, () => getMarketingTraffic(env, range.from, range.to))
      : Promise.resolve({ configured: false }),
  ]);

  const walkAnalytics = buildBookingAnalytics(walkRows, { group: 'day', dateField: 'date' });

  return json({
    from: range.from,
    to: range.to,
    traffic,
    subscribers: {
      growth: zeroFillSubscriberGrowth(subscriberGrowth, range.from, range.to),
      by_source: subscribersBySource,
    },
    discount_usage: walkAnalytics.discount_usage,
    gift_cards: { sold_count: giftSales.sold_count, sold_value_cents: giftSales.sold_value_cents, redeemed_value_cents: giftRedeemedCents },
  });
}
