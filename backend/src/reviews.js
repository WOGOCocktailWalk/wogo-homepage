// src/reviews.js — "how was your walk?" review-request email (BUILD §20,
// migrations/0026_review_requests.sql). Sent once per booking, the day
// after the walk. Called by the daily cron (src/index.js's runScheduled)
// and by the manual admin trigger (POST /admin/api/bookings/:id/send-review,
// src/admin_api.js:handleSendReviewRequest) — both paths go through
// sendReviewRequestForBooking so there is exactly one place that claims the
// atomic guard and renders/sends the mail.

import * as db from './db.js';
import { sendTransactional } from './brevo.js';
import { sendWithRetry } from './email_retry.js';
import { renderReviewRequest } from './emails.js';
import { todayInTimezone, addDaysToDateStr, DEFAULT_TIMEZONE } from './logic.js';

/**
 * Claims + sends ONE booking's review request. Never throws — a failure
 * (already sent, not confirmed, email send error) is reported in the
 * returned `reason`, not an exception, so the daily cron's loop (and the
 * manual-trigger endpoint) can treat every booking independently.
 * `booking` must carry the joined `route_name`/`city`/`route_id` shape
 * db.js:listBookingsNeedingReviewRequest/a plain booking+route lookup both
 * provide.
 */
export async function sendReviewRequestForBooking(env, booking, deps = {}) {
  const database = deps.database || db;
  const brevoSend = deps.sendTransactional || sendTransactional;

  const claimed = await database.markReviewRequestSent(env.DB, booking.id);
  if (!claimed) return { sent: false, reason: 'already_sent_or_not_confirmed' };

  try {
    const route = { id: booking.route_id, name: booking.route_name, city: booking.city };
    const mail = renderReviewRequest(booking, route);
    await sendWithRetry(
      env,
      { to: booking.email, subject: mail.subject, htmlContent: mail.html },
      { database, sendTransactional: brevoSend, kind: 'review_request' }
    );
    return { sent: true };
  } catch (err) {
    // The CLAIM already landed (review_sent_at is set) — by design, this
    // booking will not be retried by a later cron tick. sendWithRetry
    // already queues its own retry for a transient Brevo failure (same
    // contract as every other transactional email in this codebase), so
    // only a genuinely unexpected bug reaches here; logged, not thrown.
    console.error('review_request_send_failed', booking.id, err);
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * The daily cron entry point: every CONFIRMED web/manual booking whose walk
 * was YESTERDAY in Europe/Amsterdam (DST-safe — todayInTimezone reads the
 * real local calendar date via Intl, not a fixed UTC offset), not yet sent.
 */
export async function sendDailyReviewRequests(env, deps = {}) {
  const database = deps.database || db;
  const timeZone = deps.timeZone || DEFAULT_TIMEZONE;
  const yesterday = addDaysToDateStr(todayInTimezone(timeZone), -1);

  const candidates = await database.listBookingsNeedingReviewRequest(env.DB, yesterday);
  let sent = 0;
  let skipped = 0;
  for (const booking of candidates) {
    const result = await sendReviewRequestForBooking(env, booking, deps);
    if (result.sent) sent++; else skipped++;
  }
  return { date: yesterday, candidates: candidates.length, sent, skipped };
}
