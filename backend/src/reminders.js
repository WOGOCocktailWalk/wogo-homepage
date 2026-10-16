// src/reminders.js — "your walk is in 2 days" email (migrations/0031).
// Sent once per CONFIRMED booking, exactly WALK_REMINDER_DAYS_BEFORE
// (config.js, 2) days before the walk date in Europe/Amsterdam — DST-safe,
// same todayInTimezone/addDaysToDateStr helpers src/reviews.js already uses.
// Deliberately piggybacks on the existing daily review-request cron
// (`0 9 * * *`, src/index.js) rather than adding a 4th cron trigger — a
// guest-friendly late-morning Amsterdam send hour either way, and the
// Workers free plan is already at 3 triggers.

import * as db from './db.js';
import { sendTransactional } from './brevo.js';
import { sendWithRetry } from './email_retry.js';
import { renderWalkReminder } from './emails.js';
import { computeBarArrivals, todayInTimezone, addDaysToDateStr, DEFAULT_TIMEZONE } from './logic.js';
import { buildReminderUnsubscribeUrl } from './reminder_optout.js';
import { workerBaseUrl, WALK_REMINDER_DAYS_BEFORE } from './config.js';

/**
 * Claims + sends ONE booking's walk reminder. Never throws — same
 * "report, don't throw" contract as reviews.js:sendReviewRequestForBooking,
 * so the daily loop treats every booking independently. `booking` must be
 * the joined shape db.js:listBookingsNeedingWalkReminder returns (route_id/
 * route_name/city plus the route's map/currency columns), OR a plain
 * booking row — this function re-fetches the full route row itself (it
 * needs fields beyond what the join selects, e.g. map_url_by_weekday,
 * poster_url, booking_cutoff_minutes), so either shape works.
 */
export async function sendWalkReminderForBooking(env, booking, deps = {}) {
  const database = deps.database || db;
  const brevoSend = deps.sendTransactional || sendTransactional;

  if (await database.isReminderOptedOut(env.DB, booking.email)) {
    return { sent: false, reason: 'opted_out' };
  }

  const claimed = await database.claimReminderSent(env.DB, booking.id);
  if (!claimed) return { sent: false, reason: 'already_sent_or_not_confirmed' };

  try {
    const route = await database.getRoute(env.DB, booking.route_id);
    if (!route) return { sent: false, reason: 'route_not_found' };

    const bars = await database.listBarsForDate(env.DB, booking.route_id, booking.date);
    const overridesForDate = await database.listOverridesForDate(env.DB, booking.route_id, booking.date);
    const arrivals = computeBarArrivals(route, bars, overridesForDate, booking);
    const firstBarName = arrivals.length > 0 ? arrivals[0].bar_name : null;

    const unsubscribeUrl = await buildReminderUnsubscribeUrl(env, workerBaseUrl(env), booking.email);
    // migrations/0033: the 2-day reminder lists what the guest ordered too —
    // [] (no add-ons) for the overwhelming majority of bookings.
    const addons = await database.getAddonsForBooking(env.DB, booking.id);
    const mail = renderWalkReminder(booking, route, { firstBarName, unsubscribeUrl, addons });
    await sendWithRetry(
      env,
      { to: booking.email, subject: mail.subject, htmlContent: mail.html },
      { database, sendTransactional: brevoSend, kind: 'walk_reminder' }
    );
    return { sent: true };
  } catch (err) {
    console.error('walk_reminder_send_failed', booking.id, err);
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * The daily entry point: every CONFIRMED web/manual booking whose walk is
 * exactly WALK_REMINDER_DAYS_BEFORE days from today (Europe/Amsterdam),
 * not yet sent.
 */
export async function sendDailyWalkReminders(env, deps = {}) {
  const database = deps.database || db;
  const timeZone = deps.timeZone || DEFAULT_TIMEZONE;
  const targetDate = addDaysToDateStr(todayInTimezone(timeZone), WALK_REMINDER_DAYS_BEFORE);

  const candidates = await database.listBookingsNeedingWalkReminder(env.DB, targetDate);
  let sent = 0;
  let skipped = 0;
  for (const booking of candidates) {
    const result = await sendWalkReminderForBooking(env, booking, deps);
    if (result.sent) sent++; else skipped++;
  }
  return { date: targetDate, candidates: candidates.length, sent, skipped };
}
