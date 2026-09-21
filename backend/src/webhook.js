// src/webhook.js — POST /webhooks/stripe (SPEC.md §8.3).

import { verifyStripeSignature } from './stripe.js';
import { sendTransactional } from './brevo.js';
import { sendPurchaseEvent } from './meta.js';
import { computeBarArrivals, extractDiscount } from './logic.js';
import {
  renderGuestConfirmation,
  renderOwnerNotification,
  renderBarNotification,
  renderOwnerConflict,
  renderGuestReschedule,
  renderBarReschedule,
  renderGuestCancellation,
  renderBarCancellation,
} from './emails.js';
import * as db from './db.js';
import { OWNER_NOTIFY_EMAIL, OWNER_ALERT_EMAIL, WEBHOOK_TOLERANCE_SECONDS } from './config.js';
import { sendWithRetry } from './email_retry.js';

function json(data, status) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Full webhook handler. `deps` lets tests inject fakes for db/stripe/brevo/meta
 * without touching real network/D1 — production call site (index.js) passes
 * the real modules.
 */
export async function handleWebhook(request, env, deps = {}) {
  const database = deps.db || db;
  const stripeVerify = deps.verifyStripeSignature || verifyStripeSignature;
  const brevoSend = deps.sendTransactional || sendTransactional;
  const metaSend = deps.sendPurchaseEvent || sendPurchaseEvent;
  const computeBars = deps.computeBarArrivals || computeBarArrivals;

  // Cheapest-possible rejection of non-Stripe traffic: no signature header
  // (or no configured secret) → 400 before the body is even read, before any
  // crypto, before any DB touch.
  const sig = request.headers.get('stripe-signature');
  if (!sig || !env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'invalid_signature' }, 400);
  }

  const rawBody = await request.text();

  try {
    await stripeVerify(rawBody, sig, env.STRIPE_WEBHOOK_SECRET, WEBHOOK_TOLERANCE_SECONDS);
  } catch (err) {
    // Deliberately no detail in the response (why it failed is logged, not
    // leaked — a prober shouldn't learn which check tripped).
    console.warn('stripe_signature_rejected', String(err && err.message ? err.message : err));
    return json({ error: 'invalid_signature' }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'bad_request', message: 'invalid JSON' }, 400);
  }

  // Claim/finish ordering (owner audit item #7, migrations/0009): an event is
  // marked 'processing' the instant it's claimed, but only flipped to 'done'
  // AFTER the booking write below completes without throwing. If anything
  // between here and the finish call throws, this function's exception
  // propagates all the way out (nothing here catches it) — the Worker
  // returns 500, Stripe redelivers, and beginWebhookProcessing sees status
  // still 'processing' next time → returns 'retry' → we correctly try again
  // instead of the old bug where a single successful INSERT (marking it
  // "handled") happened BEFORE the write even ran, silently swallowing a
  // guest's payment on any transient failure. 'retry' is safe to re-run
  // because confirmBooking/cancelIfHold are themselves idempotent (guarded
  // by `WHERE status = 'hold'`/`'expired'` — see db.js).
  const claim = await database.beginWebhookProcessing(env.DB, event.id, event.type);
  if (claim === 'duplicate') {
    return json({ received: true, duplicate: true }, 200);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.client_reference_id;
    const result = await database.confirmBooking(env.DB, bookingId, session.id, session.payment_intent || null);

    if (result.status === 'confirmed' || result.status === 'confirmed_conflict') {
      const booking = result.booking;

      // Capture any promo code + amount saved from the Stripe session, persist
      // it, and reflect it on the in-memory booking so the emails show it.
      const discount = extractDiscount(session);
      if (discount.discount_cents > 0 || discount.discount_code) {
        await safe(() => database.setBookingDiscount(env.DB, booking.id, discount.discount_code, discount.discount_cents));
        booking.discount_code = discount.discount_code;
        booking.discount_cents = discount.discount_cents;
      }

      const route = await database.getRoute(env.DB, booking.route_id);

      if (route) {
        // Each send now goes through sendWithRetry (owner audit item #12):
        // it never throws (same contract `safe()` gave every call site here),
        // and on failure queues to failed_email instead of just logging+
        // dropping it, so a Brevo blip gets a few automatic retries before
        // anyone needs to notice.
        await sendGuestConfirmationEmails(env, booking, route, { database, sendTransactional: brevoSend });

        const arrivals = await notifyBars(env, booking, route, { database, computeBarArrivals: computeBars, sendTransactional: brevoSend });

        if (result.status === 'confirmed') {
          // Owner/internal "new booking" copy (Dashboard v2 §8.4).
          const mail = renderOwnerNotification(booking, route, { arrivals });
          await sendWithRetry(env, { to: OWNER_NOTIFY_EMAIL, subject: mail.subject, htmlContent: mail.html }, { database, sendTransactional: brevoSend, kind: 'owner_notification' });
        }

        if (result.status === 'confirmed_conflict') {
          const mail = renderOwnerConflict(booking, route);
          await sendWithRetry(env, { to: OWNER_ALERT_EMAIL, subject: mail.subject, htmlContent: mail.html }, { database, sendTransactional: brevoSend, kind: 'owner_conflict' });
        }

        await safe(() => metaSend(env, booking, route));
      }
    }
  } else if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const bookingId = session.client_reference_id;
    if (bookingId) await database.cancelIfHold(env.DB, bookingId);
  }
  // anything else: ignore, still ack 200 (Stripe expects 2xx for any event type)

  // Only reached once every write above completed without throwing — see the
  // ordering comment at the claim call above.
  await database.finishWebhookProcessing(env.DB, event.id);

  return json({ received: true }, 200);
}

async function safe(fn) {
  try {
    await fn();
  } catch (err) {
    console.error('webhook_side_effect_failed', err);
  }
}

/**
 * Emails every bar on the route its staggered arrival-time notice
 * (SPEC.md §9.2 computeBarArrivals + emails.js:renderBarNotification), one
 * independently try/caught send per bar so a single bad bar address never
 * blocks the others. Factored out so the Stripe webhook's confirm flow and
 * the admin dashboard's manual (phone) booking endpoint — both of which land
 * a real CONFIRMED booking a bar needs to know about — share one
 * implementation. Returns the computed arrivals (used by
 * renderOwnerNotification's "who's arriving when" summary).
 */
export async function notifyBars(env, booking, route, deps = {}) {
  const database = deps.database || deps.db || db;
  const computeBars = deps.computeBarArrivals || computeBarArrivals;
  const brevoSend = deps.sendTransactional || sendTransactional;

  const bars = await database.listBarsForDate(env.DB, booking.route_id, booking.date);
  const overridesForDate = await database.listOverridesForDate(env.DB, booking.route_id, booking.date);
  const arrivals = computeBars(route, bars, overridesForDate, booking);

  for (const bar of arrivals) {
    const mail = renderBarNotification(bar, booking, route);
    await sendWithRetry(env, { to: bar.bar_email, subject: mail.subject, htmlContent: mail.html }, { database, sendTransactional: brevoSend, kind: 'bar_notification' });
  }
  return arrivals;
}

/**
 * Sends the guest their ONE confirmation email — owned branded HTML
 * (src/emails.js) in the guest's locale, which includes the route-map section
 * (prominent map button + save note) whenever the route has a map for that
 * language — map_url_nl for NL bookings (falling back to map_url), map_url
 * otherwise (migrations/0012).
 * The former separate route-map email was merged into the confirmation
 * (2026-07-23), so a confirmed booking sends exactly one guest email.
 * Factored out so both the webhook's normal confirm flow and the admin
 * dashboard's "Resend confirmation" action (admin_api.js) share one
 * implementation instead of drifting apart.
 */
export async function sendGuestConfirmationEmails(env, booking, route, deps = {}) {
  const database = deps.database || deps.db || db;
  const brevoSend = deps.sendTransactional || sendTransactional;
  const locale = booking.locale === 'nl' ? 'nl' : 'en';

  if (!route.map_url && !route.map_url_nl) {
    console.warn(`route ${route.id} has no map_url/map_url_nl set — confirmation goes out without a route-map section`);
  }

  const mail = renderGuestConfirmation(booking, route, { locale });
  await sendWithRetry(env, { to: booking.email, subject: mail.subject, htmlContent: mail.html }, { database, sendTransactional: brevoSend, kind: 'guest_confirmation' });
}

// ---------------------------------------------------------------------------
// Owner "Move" / "Cancel" drawer actions (admin_api.js) — reuse the exact same
// sendWithRetry/deps-injection contract as the two senders above.
// ---------------------------------------------------------------------------

/**
 * Emails each bar on the route that a reservation MOVED: the NEW arrival
 * time to hold, and — when this same bar had an earlier arrival time —
 * "release the old table" wording via renderBarReschedule's opts.previous.
 * `booking` is the booking's NEW (already-updated) state; `deps.previous =
 * { date, slot }` is its pre-move date/slot, used to recompute what each
 * bar's OLD arrival time would have been (matched to the new arrivals by
 * bar_email — the stable identity a bar row carries).
 */
export async function notifyBarsReschedule(env, booking, route, deps = {}) {
  const database = deps.database || deps.db || db;
  const computeBars = deps.computeBarArrivals || computeBarArrivals;
  const brevoSend = deps.sendTransactional || sendTransactional;
  const previous = deps.previous || {};

  const newBars = await database.listBarsForDate(env.DB, booking.route_id, booking.date);
  const overridesForNewDate = await database.listOverridesForDate(env.DB, booking.route_id, booking.date);
  const newArrivals = computeBars(route, newBars, overridesForNewDate, booking);

  let oldArrivalByEmail = new Map();
  if (previous.date && previous.slot) {
    // The OLD date can be a different weekday than the new one (e.g. a
    // Thursday->Friday reschedule), which can carry an entirely different
    // per-weekday bar set (migrations/0015) — so this must resolve bars for
    // the PREVIOUS date, not reuse newBars.
    const oldBars = await database.listBarsForDate(env.DB, booking.route_id, previous.date);
    const overridesForOldDate = await database.listOverridesForDate(env.DB, booking.route_id, previous.date);
    // Booking-shaped object at the OLD date/slot, purely so computeBarArrivals
    // can derive what each bar's arrival time used to be.
    const oldBooking = { ...booking, date: previous.date, slot: previous.slot };
    const oldArrivals = computeBars(route, oldBars, overridesForOldDate, oldBooking);
    oldArrivalByEmail = new Map(oldArrivals.map((a) => [a.bar_email, a]));
  }

  for (const bar of newArrivals) {
    const oldBar = oldArrivalByEmail.get(bar.bar_email);
    const mail = renderBarReschedule(bar, booking, route, {
      previous: { date: previous.date, arrival_time: oldBar ? oldBar.arrival_time : undefined },
    });
    await sendWithRetry(env, { to: bar.bar_email, subject: mail.subject, htmlContent: mail.html }, { database, sendTransactional: brevoSend, kind: 'bar_reschedule' });
  }
  return newArrivals;
}

/** Emails each bar on the route that a reservation was CANCELLED, so staff
 * know which table to release. Uses the booking's (cancelled) date/slot,
 * same as notifyBars's normal-confirmation path. */
export async function notifyBarsCancellation(env, booking, route, deps = {}) {
  const database = deps.database || deps.db || db;
  const computeBars = deps.computeBarArrivals || computeBarArrivals;
  const brevoSend = deps.sendTransactional || sendTransactional;

  const bars = await database.listBarsForDate(env.DB, booking.route_id, booking.date);
  const overridesForDate = await database.listOverridesForDate(env.DB, booking.route_id, booking.date);
  const arrivals = computeBars(route, bars, overridesForDate, booking);

  for (const bar of arrivals) {
    const mail = renderBarCancellation(bar, booking, route);
    await sendWithRetry(env, { to: bar.bar_email, subject: mail.subject, htmlContent: mail.html }, { database, sendTransactional: brevoSend, kind: 'bar_cancellation' });
  }
  return arrivals;
}

/** Sends the guest their "your booking moved" email. `opts.previous =
 * { date, slot }` is the OLD date/slot, shown struck-through. */
export async function sendGuestRescheduleEmail(env, booking, route, opts = {}, deps = {}) {
  const database = deps.database || deps.db || db;
  const brevoSend = deps.sendTransactional || sendTransactional;
  const locale = booking.locale === 'nl' ? 'nl' : 'en';
  const mail = renderGuestReschedule(booking, route, { locale, previous: opts.previous });
  await sendWithRetry(env, { to: booking.email, subject: mail.subject, htmlContent: mail.html }, { database, sendTransactional: brevoSend, kind: 'guest_reschedule' });
}

/** Sends the guest their "your booking was cancelled" email. `opts.message`
 * is the owner's optional free-text note (e.g. refund wording) — never
 * assumed, passed straight through to renderGuestCancellation. */
export async function sendGuestCancellationEmail(env, booking, route, opts = {}, deps = {}) {
  const database = deps.database || deps.db || db;
  const brevoSend = deps.sendTransactional || sendTransactional;
  const locale = booking.locale === 'nl' ? 'nl' : 'en';
  const mail = renderGuestCancellation(booking, route, { locale, message: opts.message });
  await sendWithRetry(env, { to: booking.email, subject: mail.subject, htmlContent: mail.html }, { database, sendTransactional: brevoSend, kind: 'guest_cancellation' });
}
