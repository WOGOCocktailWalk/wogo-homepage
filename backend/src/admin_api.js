// src/admin_api.js — handlers for /admin/api/* (SPEC.md §7, §12.1).
// Every handler here assumes auth.requireSession(request, env) has already
// passed (checked centrally in index.js/router wiring).

import * as db from './db.js';
import {
  toCsv, aggregateCustomers, computeLoginLockout, nowSqlite, sqliteMinutesAgo, validateNotes,
  isValidCurrencyCode, isValidIanaTimeZone,
} from './logic.js';
import {
  LOGIN_FAIL_THRESHOLD,
  LOGIN_LOCK_BASE_MINUTES,
  LOGIN_LOCK_MAX_MINUTES,
  LOGIN_FAIL_WINDOW_MINUTES,
  MAX_TOKEN_LENGTH,
} from './config.js';
import { checkAdminToken, createSessionCookieValue, sessionSetCookieHeader, sessionClearCookieHeader, hasCsrfHeader } from './auth.js';
import {
  sendGuestConfirmationEmails, notifyBars,
  sendGuestRescheduleEmail, notifyBarsReschedule,
  sendGuestCancellationEmail, notifyBarsCancellation,
} from './webhook.js';
import { verifyTurnstile } from './turnstile.js';
import { runHealthCheck } from './healthcheck.js';

// ---------------------------------------------------------------------------
// Admin mutation audit trail (owner audit item #8, migrations/0007). Called
// AFTER a mutation succeeds — a failed/rejected request (400/404/403) never
// reaches here, since it never actually changed anything. Never throws: a
// logging failure must not turn a successful mutation into a 500 for the
// owner. `detail` is a small plain object, JSON-stringified for storage.
// ---------------------------------------------------------------------------

async function audit(env, request, action, entity_type, entity_id, detail) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    await db.insertAdminAudit(env.DB, {
      ip, action, entity_type,
      entity_id: entity_id == null ? null : String(entity_id),
      detail: detail ? JSON.stringify(detail) : null,
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
  const cookieValue = await createSessionCookieValue(env.ADMIN_SESSION_SECRET);
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
