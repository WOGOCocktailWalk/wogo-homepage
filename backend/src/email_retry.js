// src/email_retry.js — email delivery reliability (owner audit item #12).
// Production hardening, 2026-07.
//
// `sendWithRetry` is a drop-in replacement for calling `sendTransactional`
// directly: on success it behaves identically; on failure it queues the
// email to `failed_email` (migrations/0008) instead of just logging+dropping
// it, and NEVER throws (same contract the existing `safe()` wrapper in
// webhook.js already relies on for every send site).
//
// `retryFailedEmails` is the cron-side drain: resend due rows a few times
// with escalating backoff, then give up and alert the owner once.

import { sendTransactional } from './brevo.js';
import * as db from './db.js';
import { alertOwnerThrottled } from './alerts.js';
import { escapeHtml } from './emails.js';
import { nowSqlite, sqliteMinutesFromNow } from './logic.js';
import {
  FAILED_EMAIL_MAX_ATTEMPTS,
  FAILED_EMAIL_RETRY_BACKOFF_MINUTES,
  FAILED_EMAIL_ALERT_THROTTLE_MINUTES,
} from './config.js';

/**
 * Sends one transactional email; on failure, records it for cron-driven
 * retry. `opts.kind` is a short label (e.g. 'guest_confirmation') stored
 * alongside the queued row purely for the dashboard's failed-email view —
 * it has no effect on sending. Never throws.
 */
export async function sendWithRetry(env, msg, opts = {}) {
  const database = opts.database || db;
  const brevoSend = opts.sendTransactional || sendTransactional;
  try {
    await brevoSend(env, msg);
    return { sent: true };
  } catch (err) {
    const lastError = String(err && err.message ? err.message : err);
    console.error('email_send_failed_queuing_retry', msg.to, lastError);
    try {
      await database.queueFailedEmail(env.DB, {
        to_email: msg.to,
        subject: msg.subject,
        html_content: msg.htmlContent,
        sender_email: (msg.sender && msg.sender.email) || null,
        sender_name: (msg.sender && msg.sender.name) || null,
        reply_to: msg.replyTo || null,
        kind: opts.kind || 'unknown',
        last_error: lastError,
        next_attempt_at: sqliteMinutesFromNow(FAILED_EMAIL_RETRY_BACKOFF_MINUTES[0]),
      });
    } catch (queueErr) {
      console.error('failed_email_queue_write_failed', queueErr);
    }
    return { sent: false };
  }
}

/**
 * Cron entry point (consolidated into the Worker's trigger set — see
 * index.js). Resends every due row; on a further failure it either
 * reschedules with backoff or, past FAILED_EMAIL_MAX_ATTEMPTS, marks the row
 * permanently failed and sends ONE throttled owner alert (not one per row —
 * a Brevo outage would otherwise be one alert per queued email).
 */
export async function retryFailedEmails(env, deps = {}) {
  const database = deps.database || db;
  const brevoSend = deps.sendTransactional || sendTransactional;

  const now = nowSqlite();
  const due = await database.listDueFailedEmails(env.DB, now, 50);

  let sent = 0;
  let rescheduled = 0;
  let permanentlyFailed = 0;

  for (const row of due) {
    const msg = {
      to: row.to_email,
      subject: row.subject,
      htmlContent: row.html_content,
      sender: row.sender_email ? { email: row.sender_email, name: row.sender_name || undefined } : undefined,
      replyTo: row.reply_to || undefined,
    };
    try {
      await brevoSend(env, msg);
      await database.markFailedEmailSent(env.DB, row.id);
      sent++;
    } catch (err) {
      const lastError = String(err && err.message ? err.message : err);
      const attempts = row.attempts + 1;
      if (attempts >= FAILED_EMAIL_MAX_ATTEMPTS) {
        await database.markFailedEmailPermanent(env.DB, row.id, lastError);
        permanentlyFailed++;
      } else {
        const backoffIdx = Math.min(attempts - 1, FAILED_EMAIL_RETRY_BACKOFF_MINUTES.length - 1);
        await database.markFailedEmailRetry(
          env.DB, row.id, attempts, sqliteMinutesFromNow(FAILED_EMAIL_RETRY_BACKOFF_MINUTES[backoffIdx]), lastError
        );
        rescheduled++;
      }
    }
  }

  if (permanentlyFailed > 0) {
    await alertOwnerThrottled(
      env, 'email_failure', FAILED_EMAIL_ALERT_THROTTLE_MINUTES,
      `WOGO: ${permanentlyFailed} email(s) permanently failed to send`,
      `<pre style="white-space:pre-wrap;font:13px ui-monospace,monospace;">` +
        `${permanentlyFailed} queued email(s) gave up after ${FAILED_EMAIL_MAX_ATTEMPTS} attempts.\n` +
        `Check GET /admin/api/failed-emails for details.\n\n` +
        `${escapeHtml(due.filter((r) => r.attempts + 1 >= FAILED_EMAIL_MAX_ATTEMPTS).map((r) => `#${r.id} -> ${r.to_email} (${r.kind})`).join('\n'))}` +
        `</pre>`,
      { database }
    );
  }

  return { checked: due.length, sent, rescheduled, permanentlyFailed };
}
