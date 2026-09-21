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

/**
 * Sends one owner alert email, at most once per `throttleMinutes` per `key`.
 * Never throws — an alerting failure must never become a second incident.
 * Returns { sent: true } | { sent: false, throttled: true } | { sent: false, error: true }.
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
    // Record the throttle timestamp BEFORE sending: if the send itself hangs
    // or fails, we still don't want the very next invocation (seconds later,
    // e.g. the next request's crash) to fire a second email for the same
    // incident — one alert per throttle window is the point, not "one
    // successful alert".
    await database.setSetting(env.DB, settingKey, now);
    await brevoSend(env, { to: OWNER_ALERT_EMAIL, subject, htmlContent: html });
    return { sent: true };
  } catch (err) {
    console.error('alert_owner_failed', key, String(err && err.message ? err.message : err));
    return { sent: false, error: true };
  }
}
