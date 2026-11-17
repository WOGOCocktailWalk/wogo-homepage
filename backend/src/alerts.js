// src/alerts.js — throttled owner alert emails, €0 (Brevo + the existing
// `settings` D1 table as the throttle clock — no new table, no paid
// uptime/error-tracking service). Production hardening, 2026-07.
//
// Three callers share this: src/errors.js (crash alerts), src/email_retry.js
// (a booking email that permanently failed to send), src/healthcheck.js (the
// backend looks down). Each uses its OWN `key`, so one flapping check can't
// suppress alerting about a totally different problem.

import { sendTransactional } from './brevo.js';
import * as db from './db.js';
import { nowSqlite, sqliteMinutesBetween } from './logic.js';
import { OWNER_ALERT_EMAIL } from './config.js';
import { notifyAdmins } from './notifications.js';

/**
 * Sends one owner alert on TWO independent channels — a phone push and an
 * email — at most once per `throttleMinutes` per `key`.
 *
 * The channels never depend on each other (audit finding O2): previously the
 * push was only attempted after the email send succeeded, so when the email
 * service was the problem the owner heard nothing at all. Now each channel
 * has its own try/catch and both are always attempted.
 *
 * Throttle: the timestamp is claimed BEFORE sending so a burst (many requests
 * crashing in the same second) can't each fire an alert. If NEITHER channel
 * got through, the claim is released again so the next trigger can retry —
 * nothing reached the owner, so there is nothing to throttle yet.
 *
 * Never throws — an alerting failure must never become a second incident.
 * Returns { sent: true, email, push } | { sent: false, throttled: true } |
 * { sent: false, error: true }. `sent` is true when at least one channel
 * succeeded.
 */
export async function alertOwnerThrottled(env, key, throttleMinutes, subject, html, deps = {}) {
  const database = deps.database || db;
  const brevoSend = deps.sendTransactional || sendTransactional;
  try {
    const settingKey = `alert_last_sent:${key}`;
    const last = await database.getSetting(env.DB, settingKey);
    const now = nowSqlite();
    if (last && sqliteMinutesBetween(last, now) < throttleMinutes) {
      return { sent: false, throttled: true };
    }
    await database.setSetting(env.DB, settingKey, now);

    // Channel 1: phone push (+ in-app notification row). notifyAdmins itself
    // never throws; the try/catch is belt-and-braces. Deliberately NOT routed
    // through src/errors.js:captureError — that function is what CALLS this
    // one (via the 'crash' key), so looping a failure back would recurse.
    let push = false;
    try {
      const r = await notifyAdmins(env, {
        kind: 'problem',
        title: `⚠️ ${subject}`,
        body: 'Tap to open the dashboard for details.',
      }, deps);
      push = !!(r && r.ok);
    } catch (err) {
      console.error('alert_owner_push_failed', key, String(err && err.message ? err.message : err));
    }

    // Channel 2: email via Brevo. Independent of the push above.
    let email = false;
    try {
      await brevoSend(env, { to: OWNER_ALERT_EMAIL, subject, htmlContent: html });
      email = true;
    } catch (err) {
      console.error('alert_owner_email_failed', key, String(err && err.message ? err.message : err));
    }

    if (!push && !email) {
      // Nothing got through: release the claim so the next run retries.
      try {
        if (last) await database.setSetting(env.DB, settingKey, last);
        else await database.deleteSetting(env.DB, settingKey);
      } catch (err) {
        console.error('alert_owner_release_failed', key, String(err && err.message ? err.message : err));
      }
      return { sent: false, error: true };
    }
    return { sent: true, email, push };
  } catch (err) {
    console.error('alert_owner_failed', key, String(err && err.message ? err.message : err));
    return { sent: false, error: true };
  }
}
