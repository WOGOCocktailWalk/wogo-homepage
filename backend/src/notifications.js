// src/notifications.js — orchestrates the in-dashboard notification feed and
// its Web Push fan-out (migrations/0032). Every call site elsewhere in this
// codebase (webhook.js, admin_api.js, guest_api.js, alerts.js) imports ONLY
// `notifyAdmins` and calls it directly, unwrapped — it NEVER throws, same
// "report, don't throw" contract src/email_retry.js:sendWithRetry already
// gives every email send, so a notification/push hiccup can never turn a
// successful booking/webhook/inquiry into a 500 or a Stripe retry storm.

import * as db from './db.js';
import { sendPushTickle } from './push.js';
import {
  NOTIFICATION_KIND_PREFERENCE_GROUP,
  NOTIFICATION_DEFAULT_PREFERENCES,
  NOTIFICATION_READ_RETENTION_MINUTES,
  NOTIFICATION_RETENTION_MINUTES,
} from './config.js';
import { sqliteMinutesAgo } from './logic.js';

const PREFS_SETTING_PREFIX = 'push_prefs:';

/** Per-user kind toggles (Settings card). Missing/unparsable -> every kind
 * defaults ON — a brand new teammate (or the owner, who's never touched
 * this screen) gets every notification until they explicitly turn one off. */
export async function getNotificationPreferences(env, userId, deps = {}) {
  const database = deps.database || db;
  if (!userId) return { ...NOTIFICATION_DEFAULT_PREFERENCES };
  const raw = await database.getSetting(env.DB, `${PREFS_SETTING_PREFIX}${userId}`);
  if (!raw) return { ...NOTIFICATION_DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(raw);
    return { ...NOTIFICATION_DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return { ...NOTIFICATION_DEFAULT_PREFERENCES };
  }
}

export async function setNotificationPreferences(env, userId, patch, deps = {}) {
  const database = deps.database || db;
  const current = await getNotificationPreferences(env, userId, deps);
  const merged = { ...current };
  for (const key of Object.keys(NOTIFICATION_DEFAULT_PREFERENCES)) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) merged[key] = !!patch[key];
  }
  await database.setSetting(env.DB, `${PREFS_SETTING_PREFIX}${userId}`, JSON.stringify(merged));
  return merged;
}

/**
 * Pushes a tickle to every subscription eligible for `notification` —
 * broadcast rows (`user_id` falsy) go to every registered device; a
 * user-targeted row (the "send me a test notification" button) goes only
 * to that user's own devices. Each kind is filtered by its OWNING device's
 * user preference — `test` has no preference group (see config.js), so it
 * always goes through regardless of what's toggled off.
 *
 * NEVER throws: every subscription's send is independently try/caught, so
 * one dead device (or a transient push-service error) can't block the rest
 * of the fan-out, exactly like notifyBars isolates one bad bar address.
 * A 404/410 ("this subscription is gone, for good, says the push service
 * itself") auto-deletes the row — any OTHER failure just gets recorded.
 */
export async function fanOutPush(env, notification, deps = {}) {
  const database = deps.database || db;
  const group = NOTIFICATION_KIND_PREFERENCE_GROUP[notification.kind];

  let subs;
  try {
    subs = notification.user_id
      ? await database.listPushSubscriptionsForUser(env.DB, notification.user_id)
      : await database.listAllPushSubscriptions(env.DB);
  } catch (err) {
    console.error('push_fanout_list_failed', err);
    return;
  }

  for (const sub of subs) {
    try {
      if (group) {
        const prefs = await getNotificationPreferences(env, sub.user_id, deps);
        if (prefs[group] === false) continue;
      }
      const result = await sendPushTickle(env, sub, deps);
      if (result.gone) {
        await database.deletePushSubscriptionByEndpoint(env.DB, sub.endpoint);
      } else if (result.ok) {
        await database.markPushSubscriptionSuccess(env.DB, sub.endpoint);
      } else if (!result.skipped) {
        await database.markPushSubscriptionFailure(env.DB, sub.endpoint, `http_${result.status}`);
      }
    } catch (err) {
      console.error('push_send_failed', sub.endpoint, String(err && err.message ? err.message : err));
      try {
        await database.markPushSubscriptionFailure(env.DB, sub.endpoint, String(err && err.message ? err.message : err));
      } catch (err2) {
        console.error('push_failure_record_failed', err2);
      }
    }
  }
}

/**
 * The one function every trigger site calls: writes the notification row,
 * then best-effort fans it out as a push tickle. Returns `{ ok, id }` —
 * callers don't need to inspect this (nothing today does), it's there so a
 * test can assert on it without reaching into the DB. Deliberately not
 * exported as two separate "create" + "push" steps for call sites — keeping
 * it one call means a future trigger site can't accidentally create a
 * notification row and forget to push it (or vice versa).
 */
export async function notifyAdmins(env, { id, kind, title, body, url, booking_id, user_id } = {}, deps = {}) {
  const database = deps.database || db;
  try {
    const notifId = id || `notif_${crypto.randomUUID()}`;
    await database.createNotification(env.DB, {
      id: notifId, kind, title, body,
      url: url ?? null,
      booking_id: booking_id ?? null,
      user_id: user_id ?? null,
    });
    await fanOutPush(env, { id: notifId, kind, user_id: user_id ?? null }, deps);
    return { ok: true, id: notifId };
  } catch (err) {
    console.error('notify_admins_failed', kind, String(err && err.message ? err.message : err));
    return { ok: false };
  }
}

/** Daily-cron housekeeping (src/index.js) — the two-tier retention rule from
 * config.js. Never throws, mirroring every other prune* function index.js
 * calls directly inside its cron try/catch. */
export async function pruneOldNotifications(env, deps = {}) {
  const database = deps.database || db;
  try {
    return await database.pruneNotifications(env.DB, {
      readBeforeStr: sqliteMinutesAgo(NOTIFICATION_READ_RETENTION_MINUTES),
      anyBeforeStr: sqliteMinutesAgo(NOTIFICATION_RETENTION_MINUTES),
    });
  } catch (err) {
    console.error('prune_notifications_failed', err);
    return 0;
  }
}
