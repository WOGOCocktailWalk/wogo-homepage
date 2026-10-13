// src/abandoned.js — abandoned-booking reminder emails (migrations/0031).
//
// A booking row reaches 'hold' before Stripe even runs (src/db.js:createHold)
// and flips to 'expired' once HOLD_MINUTES passes without a webhook
// confirming it (the */5 sweep, or the real-time guard in getSlotsWithSeats
// Left — see SPEC.md §6.5). Either status, with a real email and never
// confirmed, is an abandoned checkout. Two sends per GUEST (never per row —
// a guest who retried checkout a few times gets ONE nudge, not one per
// attempt): a ~1h "still free" email, and — only if they still haven't
// booked — a ~24h follow-up. Both go through the SAME atomic
// claim-before-send idiom as src/reviews.js:sendReviewRequestForBooking, and
// both are called from the existing */5 cron (src/index.js) — no new cron
// trigger (the task explicitly allows reusing the 5-minute sweep, and the
// Workers free plan is already at 3 triggers).

import * as db from './db.js';
import { sendTransactional } from './brevo.js';
import { sendWithRetry } from './email_retry.js';
import { renderAbandonedBooking, renderAbandonedFollowup } from './emails.js';
import { buildReminderUnsubscribeUrl } from './reminder_optout.js';
import { workerBaseUrl } from './config.js';

/**
 * Read-only check: is this (route, date, slot) still genuinely bookable
 * right now? Reuses the EXACT seats_left computation the guest calendar
 * itself uses (db.js:getSlotsWithSeatsLeft) — which already zeroes
 * seats_left for a slot past its route's booking cutoff (migrations/0029),
 * so "the walk date is still in the future and still bookable" falls out of
 * this one check for free, no separate date comparison needed. Returns the
 * route row on success (the caller needs it to render the mail), or `null`
 * if the route is gone/inactive, the slot no longer exists for that date
 * (a closed override, a removed slot), or there simply isn't a seat left.
 */
async function checkStillBookable(env, database, booking) {
  const route = await database.getRoute(env.DB, booking.route_id);
  if (!route || !route.active) return null;
  const overridesForDate = await database.listOverridesForDate(env.DB, booking.route_id, booking.date);
  const slots = await database.getSlotsWithSeatsLeft(env.DB, route, overridesForDate, booking.date);
  const slot = slots.find((s) => s.slot === booking.slot);
  if (!slot || slot.seats_left <= 0) return null;
  return route;
}

/**
 * Keeps only the NEWEST row per email from a list ordered newest-first —
 * several 'hold'/'expired' rows from the same guest (retried checkout)
 * collapse to the one most worth emailing about. Pure, no DB access, so it's
 * independently testable.
 */
export function dedupeByEmailNewestFirst(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = String(row.email || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function processCandidate(env, booking, variant, deps) {
  const database = deps.database || db;
  const brevoSend = deps.sendTransactional || sendTransactional;

  if (await database.isReminderOptedOut(env.DB, booking.email)) {
    return { sent: false, reason: 'opted_out' };
  }
  if (await database.hasBlockingConfirmedBooking(env.DB, booking.email, booking.route_id, booking.date, booking.slot, booking.created_at)) {
    return { sent: false, reason: 'already_booked' };
  }
  const route = await checkStillBookable(env, database, booking);
  if (!route) return { sent: false, reason: 'not_bookable' };

  const claim = variant === 'first' ? database.claimAbandonedFirstSent : database.claimAbandonedFollowupSent;
  const claimed = await claim(env.DB, booking.id);
  if (!claimed) return { sent: false, reason: 'lost_claim' };

  // Best-effort suppression for any OTHER hold/expired row from this same
  // guest, so a later sweep tick never independently rediscovers a sibling
  // and sends a second mail for the same abandoned attempt.
  const stampSiblings = variant === 'first' ? database.stampAbandonedFirstSentForSiblings : database.stampAbandonedFollowupSentForSiblings;
  await stampSiblings(env.DB, booking.email, booking.id);

  try {
    const unsubscribeUrl = await buildReminderUnsubscribeUrl(env, workerBaseUrl(env), booking.email);
    const render = variant === 'first' ? renderAbandonedBooking : renderAbandonedFollowup;
    const mail = render(booking, route, { unsubscribeUrl });
    await sendWithRetry(
      env,
      { to: booking.email, subject: mail.subject, htmlContent: mail.html },
      { database, sendTransactional: brevoSend, kind: variant === 'first' ? 'abandoned_booking' : 'abandoned_followup' }
    );
    return { sent: true };
  } catch (err) {
    // The claim already landed — by design this row is never retried by a
    // later tick. Logged, not thrown (same posture as reviews.js).
    console.error('abandoned_send_failed', variant, booking.id, err);
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * The 5-minute cron entry point (src/index.js's runScheduled, every tick — the
 * task explicitly allows this cadence; correctness doesn't depend on exact
 * timing, same reasoning as the existing hold-expiry sweep, SPEC.md §7.2).
 * Never throws — every candidate is handled independently so one bad row
 * can't block the rest.
 */
export async function sendAbandonedSweep(env, deps = {}) {
  const database = deps.database || db;

  const firstCandidates = dedupeByEmailNewestFirst(await database.listAbandonedFirstCandidates(env.DB));
  let firstSent = 0, firstSkipped = 0;
  // Tracks every row claimed in THIS pass — a hold old enough to already
  // satisfy the ~24h follow-up window (e.g. the cron was down for a day and
  // is just catching up) must not ALSO get the follow-up in the same tick:
  // the follow-up query below runs against the DB's post-claim state, where
  // that row now has abandoned_sent_at set and already qualifies. Excluding
  // it here forces the follow-up to wait for a later tick, so a guest never
  // gets both mails back-to-back in one cron run.
  const claimedThisTick = new Set();
  for (const booking of firstCandidates) {
    const result = await processCandidate(env, booking, 'first', deps);
    if (result.sent) { firstSent++; claimedThisTick.add(booking.id); } else firstSkipped++;
  }

  const followupCandidatesRaw = await database.listAbandonedFollowupCandidates(env.DB);
  const followupCandidates = dedupeByEmailNewestFirst(followupCandidatesRaw.filter((b) => !claimedThisTick.has(b.id)));
  let followupSent = 0, followupSkipped = 0;
  for (const booking of followupCandidates) {
    const result = await processCandidate(env, booking, 'followup', deps);
    if (result.sent) followupSent++; else followupSkipped++;
  }

  return {
    first: { candidates: firstCandidates.length, sent: firstSent, skipped: firstSkipped },
    followup: { candidates: followupCandidates.length, sent: followupSent, skipped: followupSkipped },
  };
}
