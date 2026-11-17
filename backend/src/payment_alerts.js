// src/payment_alerts.js — record + alert when a PAYMENT step fails in a way
// that is handled (so it never reaches the crash handler in src/errors.js).
// Audit finding O1: Stripe refusing to create a checkout, and a payment
// webhook being rejected, used to leave nothing but a console line that is
// not retained — guests saw "something went wrong" and nobody was told.
//
// Uses only existing infrastructure: the `error_log` table (shown in the
// dashboard) and alerts.js's throttled owner alert (push + email, `settings`
// table as the clock). No new tables.
//
// Burst safety: a prober or a Stripe outage can fire this hundreds of times.
// Both the error_log row and the alert are throttled per kind.
//
// PRIVACY: error_log is meant to stay free of guest data. Callers pass only
// small, non-personal `meta` (route id, HTTP status); the error text is cut
// to 300 characters. Never pass emails, names or request bodies.

import * as db from './db.js';
import { alertOwnerThrottled } from './alerts.js';
import { escapeHtml } from './emails.js';
import { nowSqlite, sqliteMinutesBetween } from './logic.js';

export const PAYMENT_PROBLEM_LOG_THROTTLE_MINUTES = 10;
export const PAYMENT_PROBLEM_ALERT_THROTTLE_MINUTES = 30;

const KIND_LABEL = {
  checkout_failed: 'Stripe refused to start a checkout',
  giftcard_checkout_failed: 'Stripe refused to start a gift-card checkout',
  webhook_rejected: 'A Stripe payment message was rejected',
};

/**
 * @param {string} kind  one of the KIND_LABEL keys (others are accepted)
 * @param {unknown} err  the error (or a short string) — only its message is kept
 * @param {object} meta  SMALL non-personal object, e.g. { route: 'x', status: 400 }
 * Never throws.
 */
export async function reportPaymentProblem(env, kind, err, meta = {}, deps = {}) {
  try {
    const database = deps.database || db;
    const label = KIND_LABEL[kind] || `Payment problem: ${kind}`;
    const detail = String(err && err.message ? err.message : err || '').slice(0, 300);

    // error_log row — throttled so a burst can't flood the table.
    const logKey = `payment_problem_logged:${kind}`;
    const lastLogged = await database.getSetting(env.DB, logKey);
    const now = nowSqlite();
    if (!lastLogged || sqliteMinutesBetween(lastLogged, now) >= PAYMENT_PROBLEM_LOG_THROTTLE_MINUTES) {
      await database.setSetting(env.DB, logKey, now);
      try {
        await database.insertErrorLog(env.DB, {
          message: `${label}${detail ? `: ${detail}` : ''}`,
          stack: null,
          url: null,
          method: null,
          context: JSON.stringify({ kind, ...meta }),
        });
      } catch (e) {
        console.error('payment_problem_log_failed', e);
      }
    }

    const html =
      `<p><b>${escapeHtml(label)}.</b></p>` +
      `<p>Guests may be unable to pay or to get a confirmation. Check Stripe (Developers, Webhooks and Logs) and the dashboard error log.</p>` +
      `<pre style="white-space:pre-wrap;font:13px ui-monospace,Menlo,monospace;">${escapeHtml(detail)}\n${escapeHtml(JSON.stringify(meta))}</pre>`;
    await alertOwnerThrottled(
      env, `payment_${kind}`, PAYMENT_PROBLEM_ALERT_THROTTLE_MINUTES,
      `WOGO payment problem: ${label}`, html, deps
    );
  } catch (e) {
    console.error('report_payment_problem_failed', kind, String(e && e.message ? e.message : e));
  }
}
