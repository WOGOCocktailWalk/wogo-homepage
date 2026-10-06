// src/guest_api.js — handlers for /api/* (SPEC.md §5), the widget's contract.

import {
  isAllowedOrigin,
  HOLD_MINUTES,
  BOOKING_HORIZON_DAYS,
  MAX_ACTIVE_HOLDS_PER_EMAIL,
  MAX_ACTIVE_HOLDS_PER_IP,
  HOLD_ATTEMPTS_PER_WINDOW,
  HOLD_ATTEMPT_WINDOW_MINUTES,
  SAME_DAY_CUTOFF_MINUTES,
  posterUrlFor,
  GIFT_CARD_TIERS_CENTS,
  GIFT_CARD_CUSTOM_MIN_CENTS,
  GIFT_CARD_CUSTOM_MAX_CENTS,
  OWNER_NOTIFY_EMAIL,
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_MESSAGE_MAX_LENGTH,
  CONTACT_CITY_MAX_LENGTH,
  CONTACT_DATE_MAX_LENGTH,
  CONTACT_PARTY_SIZE_MAX,
  SUBSCRIBE_SOURCES,
  SUBSCRIBE_NAME_MAX_LENGTH,
  SUBSCRIBE_CITY_MAX_LENGTH,
  CONFIRM_TOKEN_EXPIRY_HOURS,
  SITE_URL,
} from './config.js';
import {
  computeHoldExpiry,
  buildMonthAvailability,
  buildSlotsForDate,
  isDateBookable,
  isValidDateStr,
  isSlotPastCutoff,
  validateNotes,
  validateUtmFields,
  isoWeekday,
  addDaysToDateStr,
  sqliteMinutesAgo,
  nowSqlite,
  todayInTimezone,
  computeRateLimitRetryAfterSeconds,
  isConfirmTokenExpired,
} from './logic.js';
import * as db from './db.js';
import { createCheckoutSession, createGiftCardCheckoutSession } from './stripe.js';
import { sendTransactional } from './brevo.js';
import { sendWithRetry } from './email_retry.js';
import { renderInquiryOwnerNotification, renderInquiryAutoAck, renderSubscribeConfirm, renderSubscribeWelcome } from './emails.js';
import { generateToken, syncConfirmedSubscriber, syncUnsubscribe } from './subscribers.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const SLOT_RE = /^\d{2}:\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 'WOGO-XXXX-XXXX' shape (src/logic.js:generateGiftCardCode) — loose enough
// that a legacy/manually-issued code still passes this shape check; the real
// validation is the DB lookup that follows.
const GIFT_CODE_RE = /^[A-Za-z0-9-]{4,40}$/;

export function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

function errorJson(code, message, status, request) {
  return json({ error: code, message: message || code }, status, request);
}

/**
 * A 429 with the shape a well-behaved client can actually act on: a machine
 * code, a human message, AND how long to back off — both in the JSON body
 * (`retry_after_seconds`) and the standard `Retry-After` header (audit item
 * 3). Used by the sliding-window booking-attempt rate limit; the separate
 * active-hold-cap check keeps its own existing 'too_many_requests' shape.
 */
function rateLimitedJson(retryAfterSeconds, message, request) {
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      message: message || 'too many booking attempts — please try again in a few minutes',
      retry_after_seconds: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
        ...corsHeaders(request),
      },
    }
  );
}

export function handleOptions(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

// ---------------------------------------------------------------------------
// GET /api/geo
// ---------------------------------------------------------------------------
// The visitor's ISO-3166 alpha-2 country code (UPPERCASE), read PURELY from
// the current request's Cloudflare edge geo — request.cf.country, falling back
// to the CF-IPCountry header. Nothing is stored, cookied, or logged, so this
// is privacy-friendly and needs no consent (SPEC: reads only the current
// request). Returns {"country":null} when unknown. Cloudflare uses the
// sentinels 'XX' (couldn't geolocate) and 'T1' (Tor) — both map to null so the
// caller sees a clean "unknown" rather than a fake country. CORS is the same
// allowlist as the other guest endpoints (corsHeaders → isAllowedOrigin), and
// the OPTIONS preflight is already handled for every /api/* path in index.js.

export function handleGeo(request) {
  let country = (request.cf && request.cf.country) || request.headers.get('CF-IPCountry') || null;
  if (typeof country === 'string') {
    country = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || country === 'XX' || country === 'T1') {
      country = null;
    }
  } else {
    country = null;
  }
  return json({ country }, 200, request);
}

// ---------------------------------------------------------------------------
// GET /api/routes
// ---------------------------------------------------------------------------

export async function handleListRoutes(request, env) {
  const routes = await db.listActiveRoutes(env.DB);
  return json(
    {
      routes: routes.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city,
        price_cents: r.price_cents,
        // migrations/0011: per-route currency (ISO, default 'EUR') + timezone
        // (IANA, default 'Europe/Amsterdam') — single source of truth for the
        // widget/booking pages to format price + times correctly per city.
        currency: r.currency,
        timezone: r.timezone,
        max_party: r.max_party,
        map_url: r.map_url,
      })),
    },
    200,
    request
  );
}

// ---------------------------------------------------------------------------
// GET /api/availability?route=&month=
// ---------------------------------------------------------------------------

export async function handleAvailability(request, env) {
  const url = new URL(request.url);
  const routeId = url.searchParams.get('route');
  const month = url.searchParams.get('month');

  if (!routeId || !month || !MONTH_RE.test(month)) {
    return errorJson('bad_request', 'route and month (YYYY-MM) are required', 400, request);
  }

  const route = await db.getRoute(env.DB, routeId);
  if (!route || !route.active) return errorJson('route_not_found', null, 404, request);

  // migrations/0011: "today" is judged in the ROUTE's own timezone, not the
  // server's UTC clock — a London/NYC guest's calendar day boundary is not
  // the same instant as Amsterdam's. Defaults to Europe/Amsterdam, so every
  // existing NL route sees exactly the same "today" as before.
  const today = todayInTimezone(route.timezone);
  const [y, m] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEndDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${month}-${String(monthEndDay).padStart(2, '0')}`;

  const overridesInMonth = await db.listOverrides(env.DB, routeId, monthStart, monthEnd);
  const openDays = JSON.parse(route.open_days);

  // Only compute live seat data for weekday-open, non-closed dates within the
  // horizon — cheap enough at this scale, and buildMonthAvailability only
  // needs slot data for dates it might mark 'soldout'.
  const closedDates = new Set(overridesInMonth.filter((o) => o.action === 'closed').map((o) => o.date));
  const horizonEnd = addDaysToDateStr(today, BOOKING_HORIZON_DAYS);
  const seatsByDate = {};

  for (let day = 1; day <= monthEndDay; day++) {
    const dateStr = `${month}-${String(day).padStart(2, '0')}`;
    if (dateStr < today || dateStr > horizonEnd) continue;
    const weekday = isoWeekday(dateStr);
    if (!openDays.includes(weekday) || closedDates.has(dateStr)) continue;
    const overridesForDate = overridesInMonth.filter((o) => o.date === dateStr);
    seatsByDate[dateStr] = await db.getSlotsWithSeatsLeft(env.DB, route, overridesForDate, dateStr);
  }

  const days = buildMonthAvailability(route, overridesInMonth, seatsByDate, month, today);

  return json(
    { route_id: route.id, month, currency: route.currency, timezone: route.timezone, days },
    200,
    request
  );
}

// ---------------------------------------------------------------------------
// GET /api/slots?route=&date=
// ---------------------------------------------------------------------------

export async function handleSlots(request, env) {
  const url = new URL(request.url);
  const routeId = url.searchParams.get('route');
  const date = url.searchParams.get('date');

  if (!routeId || !date || !DATE_RE.test(date)) {
    return errorJson('bad_request', 'route and date (YYYY-MM-DD) are required', 400, request);
  }

  const route = await db.getRoute(env.DB, routeId);
  if (!route || !route.active) return errorJson('route_not_found', null, 404, request);

  const overridesForDate = await db.listOverridesForDate(env.DB, routeId, date);
  const bookable = isDateBookable(route, overridesForDate, date);

  if (!bookable) {
    return json(
      { route_id: route.id, date, currency: route.currency, timezone: route.timezone, closed: true, slots: [] },
      200,
      request
    );
  }

  const slots = await db.getSlotsWithSeatsLeft(env.DB, route, overridesForDate, date);
  return json(
    { route_id: route.id, date, currency: route.currency, timezone: route.timezone, closed: false, slots },
    200,
    request
  );
}

// ---------------------------------------------------------------------------
// GET /api/booking?session_id=cs_...
// ---------------------------------------------------------------------------
// Powers the post-payment "you're booked" page (booking-confirmed/). The guest
// arrives from Stripe with their Checkout Session id in the URL — an
// unguessable token they alone hold — so we look the booking up by it and
// return ONLY the few non-sensitive fields the page shows. Status is reported
// as 'confirmed' once the webhook has processed the payment, or 'pending' in
// the brief window before that (Stripe only redirects here on success, so the
// page can safely show a confirmation either way).
export async function handleBookingLookup(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 200) {
    return errorJson('bad_request', 'session_id is required', 400, request);
  }

  const booking = await db.getBookingBySession(env.DB, sessionId);
  if (!booking) return errorJson('not_found', null, 404, request);
  const route = await db.getRoute(env.DB, booking.route_id);
  if (!route) return errorJson('not_found', null, 404, request);

  const amountCents = Math.max(
    0,
    (route.price_cents || 0) * (booking.party || 0) - (booking.discount_cents || 0) - (booking.gift_applied_cents || 0)
  );
  const firstName = booking.name ? String(booking.name).trim().split(/\s+/)[0] : '';
  const confirmed = booking.status === 'confirmed' || booking.status === 'confirmed_conflict';

  return json(
    {
      id: booking.id,
      status: confirmed ? 'confirmed' : 'pending',
      route_name: route.name,
      city: route.city,
      date: booking.date,
      slot: booking.slot,
      party: booking.party,
      currency: route.currency || 'EUR',
      amount_cents: amountCents,
      first_name: firstName,
      locale: booking.locale === 'nl' ? 'nl' : 'en',
      poster_url: posterUrlFor(route),
      gift_code: booking.gift_code || null,
      gift_applied_cents: booking.gift_applied_cents || 0,
    },
    200,
    request
  );
}

// ---------------------------------------------------------------------------
// POST /api/book
// ---------------------------------------------------------------------------

export async function handleBook(request, env) {
  // Defense in depth beyond CORS: CORS only stops a cross-site page READING
  // the response — the state change would still happen. A browser request
  // whose Origin is known and not on the allowlist is rejected outright.
  // Requests with no Origin header (curl, scripts) can't be origin-filtered;
  // the rate limits below are the layer that handles those.
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin)) {
    return errorJson('forbidden', null, 403, request);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON body', 400, request);
  }

  const { route_id, date, slot, party, name, email, phone, notes, locale, marketing_opt_in, gift_code } = body || {};

  // UTM / source capture (migrations/0027, BUILD §19 Marketing pass) — every
  // field optional, validated independently of the rest of the booking so a
  // malformed tracking param never blocks a genuine guest; see
  // logic.js:validateUtmFields for the exact shape/length rules.
  const utmCheck = validateUtmFields(body);
  if (!utmCheck.ok) {
    return errorJson('bad_request', utmCheck.message, 400, request);
  }

  if (!route_id || typeof route_id !== 'string' || route_id.length > 100) {
    return errorJson('bad_request', 'route_id is required', 400, request);
  }
  if (!date || typeof date !== 'string' || !isValidDateStr(date)) {
    return errorJson('bad_request', 'date must be YYYY-MM-DD', 400, request);
  }
  if (!slot || typeof slot !== 'string' || !SLOT_RE.test(slot)) {
    return errorJson('bad_request', 'slot must be HH:MM', 400, request);
  }
  if (!Number.isInteger(party) || party < 1 || party > 99) {
    return errorJson('bad_request', 'party must be a positive integer', 400, request);
  }
  if (!name || typeof name !== 'string' || name.length > 200) {
    return errorJson('bad_request', 'name is required', 400, request);
  }
  if (!email || typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
    return errorJson('bad_request', 'a valid email is required', 400, request);
  }
  if (phone !== undefined && phone !== null && phone !== '' && (typeof phone !== 'string' || phone.length > 50)) {
    return errorJson('bad_request', 'invalid phone', 400, request);
  }
  // Optional allergies/notes free text (migrations/0010): trimmed, length-
  // capped, control-chars rejected — and STILL treated as untrusted on every
  // output (emails.js HTML-escapes it; the dashboard renders via textContent).
  const notesCheck = validateNotes(notes);
  if (!notesCheck.ok) {
    return errorJson('bad_request', notesCheck.message, 400, request);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const route = await db.getRoute(env.DB, route_id);
  if (!route || !route.active) return errorJson('route_not_found', null, 404, request);

  // Booking horizon: same [today, today + 90d] window the availability grid
  // exposes, judged in the ROUTE's own timezone (migrations/0011) — a
  // London/NYC guest's "today" is not necessarily the server's UTC "today" —
  // a hand-crafted request can't hold seats in the past or years out.
  const today = todayInTimezone(route.timezone);
  if (date < today || date > addDaysToDateStr(today, BOOKING_HORIZON_DAYS)) {
    return errorJson('route_closed', 'this date is not bookable', 409, request);
  }

  if (party > route.max_party) {
    return errorJson('bad_request', `party must be between 1 and ${route.max_party}`, 400, request);
  }

  // Server-side sanity the atomic guard's SQL doesn't cover: the weekday must
  // be open, the date not closed, and the slot must actually exist for that
  // date (route slots ± remove_slot/extra_slot overrides) — otherwise a
  // crafted request could hold seats on departures that don't exist.
  const overridesForDate = await db.listOverridesForDate(env.DB, route_id, date);
  if (!isDateBookable(route, overridesForDate, date)) {
    return errorJson('route_closed', 'this date is not bookable', 409, request);
  }
  if (!buildSlotsForDate(route, overridesForDate, date).some((s) => s.slot === slot)) {
    return errorJson('route_closed', 'this date is not bookable', 409, request);
  }

  // Same-day cutoff (audit item 1, SAME_DAY_CUTOFF_MINUTES): a slot that has
  // already started, or starts too soon to realistically book, is rejected
  // outright — judged against the ROUTE's own timezone, same as the horizon
  // check above. isSlotPastCutoff is false for every future date, so this is
  // a no-op for anything but "today".
  if (isSlotPastCutoff(date, slot, route.timezone, SAME_DAY_CUTOFF_MINUTES)) {
    return errorJson('slot_passed', 'this time slot has already started or is starting too soon to book', 409, request);
  }

  // Layer 1 — per-IP attempt rate limit (SPEC.md §15.1, sliding window,
  // D1-backed). Recorded AFTER every validation check above (basic field
  // shape, route existence, horizon, party size, weekday/slot legitimacy,
  // same-day cutoff) — a request that was always going to be rejected as
  // malformed or out-of-bounds no longer burns part of the genuine guest's
  // attempt budget (audit item 3). Record first, then count: the current
  // attempt is included, so `> limit` means "this is at least attempt
  // limit+1 inside the window".
  await db.recordRateEvent(env.DB, 'book', ip);
  const since = sqliteMinutesAgo(HOLD_ATTEMPT_WINDOW_MINUTES);
  const attempts = await db.countRateEventsSince(env.DB, 'book', ip, since);
  if (attempts > HOLD_ATTEMPTS_PER_WINDOW) {
    const oldest = await db.oldestRateEventSince(env.DB, 'book', ip, since);
    const retryAfterSeconds = computeRateLimitRetryAfterSeconds(oldest, HOLD_ATTEMPT_WINDOW_MINUTES, nowSqlite());
    return rateLimitedJson(retryAfterSeconds, 'too many booking attempts — please try again in a few minutes', request);
  }

  // Layer 2 — active-hold caps per email AND per IP (SPEC.md §15.1): even
  // inside the rate limit, nobody accumulates more than a couple of live
  // 15-minute holds at once, so scripted hold-hoarding can't lock a slot.
  const holdsForEmail = await db.countActiveHoldsByEmail(env.DB, email);
  const holdsForIp = await db.countActiveHoldsByIp(env.DB, ip);
  if (holdsForEmail >= MAX_ACTIVE_HOLDS_PER_EMAIL || holdsForIp >= MAX_ACTIVE_HOLDS_PER_IP) {
    return errorJson('too_many_requests', 'too many booking attempts — please try again in a few minutes', 429, request);
  }

  // Optional gift-card redemption (migrations/0018/0019) — deliberately
  // SEPARATE from any marketing promo code (Stripe's allow_promotion_codes):
  // validated up front, BEFORE a hold is created, so an invalid/typo'd code
  // never burns a seat hold on a booking that's about to be rejected anyway.
  let giftCard = null;
  let giftApplied = 0;
  if (gift_code !== undefined && gift_code !== null && gift_code !== '') {
    if (typeof gift_code !== 'string' || !GIFT_CODE_RE.test(gift_code)) {
      return errorJson('bad_request', 'invalid gift card code', 400, request);
    }
    giftCard = await db.getGiftCardByCode(env.DB, gift_code);
    if (!giftCard || giftCard.status !== 'active' || giftCard.balance_cents <= 0) {
      return errorJson('invalid_gift_card', 'that gift card code was not found or has no balance left', 400, request);
    }
    if ((giftCard.currency || 'EUR') !== (route.currency || 'EUR')) {
      return errorJson('gift_card_currency_mismatch', 'this gift card is not valid for this route’s currency', 400, request);
    }
    const bookingTotalCents = (route.price_cents || 0) * party;
    giftApplied = Math.min(giftCard.balance_cents, bookingTotalCents);
  }

  const bookingId = `b_${crypto.randomUUID()}`;
  const holdExpires = computeHoldExpiry(HOLD_MINUTES);

  const holdResult = await db.createHold(env.DB, {
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
    hold_expires: holdExpires,
    ip,
    ...utmCheck.utm,
  });

  if (!holdResult.created) {
    const diag = await db.diagnoseHoldFailure(env.DB, { route_id, date, slot, party });
    if (diag.code === 'sold_out') {
      return errorJson('sold_out', 'not enough seats left', 409, request);
    }
    if (diag.code === 'party_too_large') {
      return errorJson('bad_request', `party must be between 1 and ${route.max_party}`, 400, request);
    }
    if (diag.code === 'route_not_found') {
      return errorJson('route_not_found', null, 404, request);
    }
    return errorJson('route_closed', 'this date is not bookable', 409, request);
  }

  if (giftCard && giftApplied > 0) {
    await db.attachGiftCardToBooking(env.DB, bookingId, giftCard.code, giftApplied);
    // Reflect it on the in-memory booking so createCheckoutSession (below)
    // sees the applied amount without a re-read — same pattern the webhook
    // uses for discount_code/discount_cents after setBookingDiscount.
    holdResult.booking.gift_code = giftCard.code;
    holdResult.booking.gift_applied_cents = giftApplied;
  }

  let session;
  try {
    session = await createCheckoutSession(env, holdResult.booking, route);
  } catch (err) {
    console.error('stripe_checkout_failed', err);
    // Hold stays as-is; it will silently expire in HOLD_MINUTES and free the seat.
    return errorJson('payment_setup_failed', 'something went wrong, please try again', 502, request);
  }

  await db.attachStripeSession(env.DB, bookingId, session.id);

  return json({ booking_id: bookingId, checkout_url: session.url }, 200, request);
}

// ---------------------------------------------------------------------------
// POST /api/giftcard/checkout — buying a gift card (migrations/0018/0019).
// A completely separate flow from /api/book: no route, no date, no seat hold
// — just a Checkout Session for the chosen amount. The card itself is minted
// by the webhook once payment completes (src/webhook.js), never here.
// ---------------------------------------------------------------------------

const GIFT_CARD_TIER_SET = new Set(GIFT_CARD_TIERS_CENTS);

function isValidGiftAmount(cents) {
  if (!Number.isInteger(cents)) return false;
  if (GIFT_CARD_TIER_SET.has(cents)) return true;
  return cents >= GIFT_CARD_CUSTOM_MIN_CENTS && cents <= GIFT_CARD_CUSTOM_MAX_CENTS;
}

export async function handleGiftCardCheckout(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin)) {
    return errorJson('forbidden', null, 403, request);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON body', 400, request);
  }

  const { amount_cents, buyer_name, buyer_email, recipient_name, recipient_email, message, locale } = body || {};

  if (!isValidGiftAmount(amount_cents)) {
    return errorJson(
      'bad_request',
      `amount_cents must be one of ${GIFT_CARD_TIERS_CENTS.join(', ')}, or between ${GIFT_CARD_CUSTOM_MIN_CENTS} and ${GIFT_CARD_CUSTOM_MAX_CENTS}`,
      400,
      request
    );
  }
  if (!buyer_name || typeof buyer_name !== 'string' || buyer_name.length > 200) {
    return errorJson('bad_request', 'buyer_name is required', 400, request);
  }
  if (!buyer_email || typeof buyer_email !== 'string' || buyer_email.length > 254 || !EMAIL_RE.test(buyer_email)) {
    return errorJson('bad_request', 'a valid buyer email is required', 400, request);
  }
  if (!recipient_name || typeof recipient_name !== 'string' || recipient_name.length > 200) {
    return errorJson('bad_request', 'recipient_name is required', 400, request);
  }
  if (!recipient_email || typeof recipient_email !== 'string' || recipient_email.length > 254 || !EMAIL_RE.test(recipient_email)) {
    return errorJson('bad_request', 'a valid recipient email is required', 400, request);
  }
  if (message !== undefined && message !== null && (typeof message !== 'string' || message.length > 500)) {
    return errorJson('bad_request', 'message must be 500 characters or fewer', 400, request);
  }

  // Own rate-limit bucket ('giftcard', not 'book') — a burst of gift-card
  // purchases must never eat into the booking widget's abuse budget, and
  // vice versa (SPEC.md §15.1-style layered, D1-backed, per-IP).
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  await db.recordRateEvent(env.DB, 'giftcard', ip);
  const attempts = await db.countRateEventsSince(env.DB, 'giftcard', ip, sqliteMinutesAgo(HOLD_ATTEMPT_WINDOW_MINUTES));
  if (attempts > HOLD_ATTEMPTS_PER_WINDOW) {
    return errorJson('too_many_requests', 'too many attempts — please try again in a few minutes', 429, request);
  }

  let session;
  try {
    session = await createGiftCardCheckoutSession(env, {
      amount_cents,
      buyer_name,
      buyer_email,
      recipient_name,
      recipient_email,
      message: message || '',
      locale: locale === 'nl' ? 'nl' : 'en',
    });
  } catch (err) {
    console.error('giftcard_checkout_failed', err);
    return errorJson('payment_setup_failed', 'something went wrong, please try again', 502, request);
  }

  return json({ url: session.url }, 200, request);
}

// ---------------------------------------------------------------------------
// POST /api/contact — contact form + group booking request (migrations/0021,
// audit item 9). A lead inbox, not a booking flow: no route, no date/slot
// validation against a real calendar, no seat hold. Validates, rate-limits
// (own 'contact' bucket — a burst of contact-form spam must never eat into
// the booking widget's abuse budget, same reasoning as the gift-card
// checkout's own bucket above), stores one `inquiries` row, emails the owner
// with reply-to set to the guest, and sends the guest a short
// auto-acknowledgement in their own locale. See SETUP.md for the full
// request/response contract the frontend integrates against.
// ---------------------------------------------------------------------------

const CONTACT_KINDS = new Set(['contact', 'group']);

/** SHA-256 hex of the submitter's IP — never the raw IP (migrations/0021's
 * doc comment / migrations/0005's IP-minimization posture). Web Crypto only
 * (Workers-safe, no Node `crypto` — PORTABILITY.md), same primitive
 * src/meta.js already uses for Meta CAPI's hashed email. */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleContact(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin)) {
    return errorJson('forbidden', null, 403, request);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON body', 400, request);
  }

  const { kind, name, email, phone, city, date, party_size, message, locale, website } = body || {};

  // Honeypot: a real visitor never sees or fills this field (hidden by CSS on
  // the form). A filled one is a bot — absorb it silently with a normal-
  // looking 200 so the bot has no signal to react to, but do nothing: no row,
  // no email, no rate-limit event spent.
  if (website !== undefined && website !== null && String(website).trim() !== '') {
    return json({ ok: true }, 200, request);
  }

  if (!kind || !CONTACT_KINDS.has(kind)) {
    return errorJson('bad_request', "kind must be 'contact' or 'group'", 400, request);
  }
  if (!name || typeof name !== 'string' || name.trim() === '' || name.length > CONTACT_NAME_MAX_LENGTH) {
    return errorJson('bad_request', 'name is required', 400, request);
  }
  if (!email || typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
    return errorJson('bad_request', 'a valid email is required', 400, request);
  }
  if (phone !== undefined && phone !== null && phone !== '' && (typeof phone !== 'string' || phone.length > 50)) {
    return errorJson('bad_request', 'invalid phone', 400, request);
  }
  if (city !== undefined && city !== null && city !== '' && (typeof city !== 'string' || city.length > CONTACT_CITY_MAX_LENGTH)) {
    return errorJson('bad_request', 'invalid city', 400, request);
  }
  // `date` is deliberately free text ("mid November", "flexible") — a group
  // request doesn't always have a fixed date yet — so this is a length cap
  // only, not a calendar-format check (unlike POST /api/book's `date`).
  if (date !== undefined && date !== null && date !== '' && (typeof date !== 'string' || date.length > CONTACT_DATE_MAX_LENGTH)) {
    return errorJson('bad_request', 'invalid date', 400, request);
  }
  let partySize = null;
  if (party_size !== undefined && party_size !== null && party_size !== '') {
    if (!Number.isInteger(party_size) || party_size < 1 || party_size > CONTACT_PARTY_SIZE_MAX) {
      return errorJson('bad_request', `party_size must be a positive integer up to ${CONTACT_PARTY_SIZE_MAX}`, 400, request);
    }
    partySize = party_size;
  }
  if (!message || typeof message !== 'string' || message.trim() === '' || message.length > CONTACT_MESSAGE_MAX_LENGTH) {
    return errorJson('bad_request', `message is required (max ${CONTACT_MESSAGE_MAX_LENGTH} characters)`, 400, request);
  }

  // Rate limit AFTER validation, same reasoning as the /api/book fix (audit
  // item 3): a request that was always going to be rejected as malformed
  // never burns part of the genuine guest's attempt budget. Own bucket
  // ('contact', not 'book' or 'giftcard') so this form can't be starved by,
  // or starve, the other two.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  await db.recordRateEvent(env.DB, 'contact', ip);
  const since = sqliteMinutesAgo(HOLD_ATTEMPT_WINDOW_MINUTES);
  const attempts = await db.countRateEventsSince(env.DB, 'contact', ip, since);
  if (attempts > HOLD_ATTEMPTS_PER_WINDOW) {
    const oldest = await db.oldestRateEventSince(env.DB, 'contact', ip, since);
    const retryAfterSeconds = computeRateLimitRetryAfterSeconds(oldest, HOLD_ATTEMPT_WINDOW_MINUTES, nowSqlite());
    return rateLimitedJson(retryAfterSeconds, 'too many attempts — please try again in a few minutes', request);
  }

  const inquiry = await db.createInquiry(env.DB, {
    id: `inq_${crypto.randomUUID()}`,
    kind,
    name: name.trim(),
    email,
    phone: phone || null,
    city: city || null,
    date: date || null,
    party_size: partySize,
    message: message.trim(),
    locale: locale === 'nl' ? 'nl' : 'en',
    ip_hash: ip === 'unknown' ? null : await sha256Hex(ip),
  });

  // Owner notification (reply-to the guest, so replying in the inbox goes
  // straight to them) and the guest's own auto-acknowledgement. Both go
  // through sendTransactional, so both respect EMAIL_TEST_REDIRECT
  // automatically like every other mail in this codebase. A mail failure
  // must not turn a successfully-stored inquiry into a 500 for the guest —
  // the row is already saved either way.
  try {
    const ownerMail = renderInquiryOwnerNotification(inquiry);
    await sendTransactional(env, {
      to: OWNER_NOTIFY_EMAIL,
      subject: ownerMail.subject,
      htmlContent: ownerMail.html,
      replyTo: { email: inquiry.email, name: inquiry.name },
    });
  } catch (err) {
    console.error('inquiry_owner_email_failed', err);
  }
  try {
    const ackMail = renderInquiryAutoAck(inquiry);
    await sendTransactional(env, { to: inquiry.email, subject: ackMail.subject, htmlContent: ackMail.html });
  } catch (err) {
    console.error('inquiry_ack_email_failed', err);
  }

  return json({ ok: true, id: inquiry.id }, 200, request);
}

// ---------------------------------------------------------------------------
// Newsletter subscribers (migrations/0024, BUILD §17) — the site-footer
// signup form's backend. GDPR DOUBLE OPT-IN: POST /api/subscribe only ever
// stores a 'pending' row and sends a confirmation link; a subscriber is never
// added to Brevo (and never emailed the WELCOME10 code) until they click it
// (GET /api/subscribe/confirm). Own rate-limit bucket ('subscribe'), same
// honeypot pattern as /api/contact. See SETUP.md for the full site-form
// contract (request/response/error codes, the /subscribed/ page's states).
// ---------------------------------------------------------------------------

const SUBSCRIBE_SOURCE_SET = new Set(SUBSCRIBE_SOURCES);

/**
 * POST /api/subscribe — body { email, first_name?, locale, city?, source,
 * website }. The double-opt-in state machine (src/db.js has the storage half
 * of each branch):
 *   * no existing row            -> create 'pending' + send confirm email
 *   * existing row, 'pending'    -> re-issue a fresh token (resets the
 *                                    CONFIRM_TOKEN_EXPIRY_HOURS clock) + resend
 *   * existing row, 'unsubscribed' -> re-arm as 'pending' (a fresh opt-in
 *                                    round, same as a brand-new signup) + resend
 *   * existing row, 'confirmed'  -> 200 {ok:true, already:true}, NO email —
 *                                    re-submitting the form for an already-
 *                                    confirmed address must not be a way to
 *                                    re-trigger the welcome code or spam them.
 */
export async function handleSubscribe(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin)) {
    return errorJson('forbidden', null, 403, request);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('bad_request', 'invalid JSON body', 400, request);
  }

  const { email, first_name, locale, city, source, website } = body || {};

  // Honeypot — identical silent-absorb pattern to /api/contact: a real
  // visitor never sees/fills this field, so a filled one is a bot. Absorbed
  // with a normal-looking 200 so the bot has no signal to react to, but
  // nothing is stored and no rate-limit event is spent.
  if (website !== undefined && website !== null && String(website).trim() !== '') {
    return json({ ok: true }, 200, request);
  }

  if (!email || typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
    return errorJson('bad_request', 'a valid email is required', 400, request);
  }
  if (first_name !== undefined && first_name !== null && first_name !== '' && (typeof first_name !== 'string' || first_name.length > SUBSCRIBE_NAME_MAX_LENGTH)) {
    return errorJson('bad_request', 'invalid first_name', 400, request);
  }
  if (city !== undefined && city !== null && city !== '' && (typeof city !== 'string' || city.length > SUBSCRIBE_CITY_MAX_LENGTH)) {
    return errorJson('bad_request', 'invalid city', 400, request);
  }
  if (!source || !SUBSCRIBE_SOURCE_SET.has(source)) {
    return errorJson('bad_request', `source must be one of ${[...SUBSCRIBE_SOURCE_SET].join(', ')}`, 400, request);
  }

  // Rate limit AFTER validation (same reasoning as /api/book and /api/contact
  // — a malformed request never burns a genuine guest's attempt budget). Own
  // bucket ('subscribe') so a burst of newsletter signups can't be starved
  // by, or starve, booking/gift-card/contact traffic.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  await db.recordRateEvent(env.DB, 'subscribe', ip);
  const since = sqliteMinutesAgo(HOLD_ATTEMPT_WINDOW_MINUTES);
  const attempts = await db.countRateEventsSince(env.DB, 'subscribe', ip, since);
  if (attempts > HOLD_ATTEMPTS_PER_WINDOW) {
    const oldest = await db.oldestRateEventSince(env.DB, 'subscribe', ip, since);
    const retryAfterSeconds = computeRateLimitRetryAfterSeconds(oldest, HOLD_ATTEMPT_WINDOW_MINUTES, nowSqlite());
    return rateLimitedJson(retryAfterSeconds, 'too many attempts — please try again in a few minutes', request);
  }

  const normalizedLocale = locale === 'nl' ? 'nl' : 'en';
  const existing = await db.getSubscriberByEmail(env.DB, email);

  if (existing && existing.status === 'confirmed') {
    return json({ ok: true, already: true }, 200, request);
  }

  let subscriber;
  if (existing) {
    subscriber = await db.reissueSubscriberToken(env.DB, existing.id, {
      confirm_token: generateToken(),
      locale: normalizedLocale,
      city: city || null,
      source,
      first_name: first_name || null,
    });
  } else {
    subscriber = await db.createSubscriber(env.DB, {
      id: `sub_${crypto.randomUUID()}`,
      email,
      first_name: first_name || null,
      locale: normalizedLocale,
      city: city || null,
      source,
      confirm_token: generateToken(),
      unsubscribe_token: generateToken(),
      ip_hash: ip === 'unknown' ? null : await sha256Hex(ip),
    });
  }

  const baseUrl = new URL(request.url).origin;
  const confirmUrl = `${baseUrl}/api/subscribe/confirm?token=${subscriber.confirm_token}`;
  const mail = renderSubscribeConfirm(subscriber, confirmUrl);
  await sendWithRetry(
    env,
    { to: subscriber.email, subject: mail.subject, htmlContent: mail.html },
    { database: db, sendTransactional, kind: 'subscribe_confirm' }
  );

  return json({ ok: true }, 200, request);
}

/**
 * GET /api/subscribe/confirm?token=... — the double opt-in click. Always a
 * 302 redirect to the site's /subscribed/ page (this is a link clicked
 * straight out of an email, never a fetch() call — no JSON response, no CORS
 * concern). Invalid/expired/unsubscribed token -> ?state=invalid; success ->
 * ?lang=en|nl so the thank-you page can show the welcome code in the right
 * language (the code itself is sent in the WELCOME email, never embedded in
 * this redirect URL). An already-'confirmed' token (a double-click, or an
 * email client that pre-fetches links) redirects to the SAME success page
 * without re-sending the welcome email — this handler is idempotent.
 */
export async function handleSubscribeConfirm(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token || typeof token !== 'string') {
    return Response.redirect(`${SITE_URL}/subscribed/?state=invalid`, 302);
  }

  const subscriber = await db.getSubscriberByConfirmToken(env.DB, token);
  if (!subscriber || subscriber.status === 'unsubscribed') {
    return Response.redirect(`${SITE_URL}/subscribed/?state=invalid`, 302);
  }

  if (subscriber.status === 'confirmed') {
    return Response.redirect(`${SITE_URL}/subscribed/?state=confirmed&lang=${subscriber.locale}`, 302);
  }

  // status === 'pending' from here.
  if (isConfirmTokenExpired(subscriber.created_at, CONFIRM_TOKEN_EXPIRY_HOURS)) {
    return Response.redirect(`${SITE_URL}/subscribed/?state=invalid`, 302);
  }

  let confirmed = await db.confirmSubscriberByToken(env.DB, token);
  if (!confirmed) {
    // Lost a race to a near-simultaneous confirm of the same token (e.g. an
    // email client that opens the link twice) — re-read; it's confirmed
    // either way, so this is still a success, just without re-sending mail.
    const recheck = await db.getSubscriberByConfirmToken(env.DB, token);
    if (!recheck || recheck.status !== 'confirmed') {
      return Response.redirect(`${SITE_URL}/subscribed/?state=invalid`, 302);
    }
    return Response.redirect(`${SITE_URL}/subscribed/?state=confirmed&lang=${recheck.locale}`, 302);
  }

  await syncConfirmedSubscriber(env, confirmed);

  const unsubscribeUrl = `${url.origin}/api/unsubscribe?token=${confirmed.unsubscribe_token}`;
  const mail = renderSubscribeWelcome(confirmed, { unsubscribeUrl });
  await sendWithRetry(
    env,
    { to: confirmed.email, subject: mail.subject, htmlContent: mail.html },
    { database: db, sendTransactional, kind: 'subscribe_welcome' }
  );

  return Response.redirect(`${SITE_URL}/subscribed/?state=confirmed&lang=${confirmed.locale}`, 302);
}

/**
 * GET /api/unsubscribe?token=... — the welcome email's footer link (and any
 * future marketing send). Always a 302 redirect, same reasoning as the
 * confirm handler above. An invalid token, or a token for a row already
 * unsubscribed, both redirect to the SAME success state — unsubscribing is
 * idempotent from the guest's point of view, and a stale/already-used link
 * must never look like an error.
 */
export async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token || typeof token !== 'string') {
    return Response.redirect(`${SITE_URL}/subscribed/?state=invalid`, 302);
  }

  const result = await db.unsubscribeByToken(env.DB, token);
  if (!result) {
    return Response.redirect(`${SITE_URL}/subscribed/?state=invalid`, 302);
  }

  if (!result.already_unsubscribed) {
    await syncUnsubscribe(env, result.email);
  }

  return Response.redirect(`${SITE_URL}/subscribed/?state=unsubscribed`, 302);
}
