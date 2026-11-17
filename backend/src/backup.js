// src/backup.js — daily D1 -> R2 export (owner audit item #4, CRITICAL).
//
// D1's built-in Time Travel already gives point-in-time restore for ~30 days
// (see DR.md for the exact restore command) — that covers "I fat-fingered a
// delete 10 minutes ago". This cron adds the OTHER half: an OFFSITE,
// longer-retention, human-readable copy of every table that holds business
// data, in Cloudflare R2 (free tier: 10GB; this file is well under 1 MB per
// day today), for "D1 itself is gone/corrupted" or "I need last month's
// numbers back".
//
// Inert until `env.BACKUP_BUCKET` is bound (wrangler.toml [[r2_buckets]]).
//
// WHICH TABLES (decided table by table, audit 2026-11; test/backup.test.js
// fails if a future migration adds a table that is in neither list):
//
//   BACKED UP (money, customers, content, access):
//     routes, routes_bars, date_overrides   what is for sale and when
//     bookings, booking_addons, addons      who booked / paid / bought extras
//     gift_cards, gift_card_redemptions     prepaid money we owe guests
//     subscribers, reminder_optouts         newsletter list + opt-outs (consent)
//     inquiries                             contact/group leads
//     admin_users                           who may log in (and their role)
//     blog_posts, blog_assets               the blog's source of truth
//     settings                              k/v config (cache entries, schedules, prefs)
//     admin_audit                           who changed what (small; evidence)
//     webhook_events                        payment-event ids (dedupe after a restore)
//
//   LEFT OUT ON PURPOSE:
//     rate_events, auth_events   pure rate-limit / login-attempt noise, pruned within days
//     error_log                  diagnostics only
//     notifications              in-app feed, pruned within days
//     push_subscriptions         phone tokens; devices simply re-subscribe
//     admin_login_links          single-use login tokens (hashes) — must NOT sit in a backup
//     failed_email               transient retry queue (re-created by the app)
//     brevo_sync_queue           transient queue, derived from subscribers
//
// WORKER LIMITS: one SELECT per table (17 queries, sequential), whole snapshot
// held in memory as one JSON string (a few MB at most for this business; the
// Worker has 128 MB). Each table is read in its own try/catch so one bad
// table cannot lose the other sixteen; the failure is recorded in the file
// (`table_errors`) and the owner is alerted (throttled).

import { nowSqlite } from './logic.js';
import { BACKUP_RETENTION_DAYS } from './config.js';
import { alertOwnerThrottled } from './alerts.js';

const PREFIX = 'daily/';
export const BACKUP_FORMAT_VERSION = 2;

export const BACKUP_TABLES = [
  'routes', 'routes_bars', 'date_overrides', 'bookings', 'booking_addons', 'addons',
  'gift_cards', 'gift_card_redemptions', 'subscribers', 'reminder_optouts', 'inquiries',
  'admin_users', 'blog_posts', 'blog_assets', 'settings', 'admin_audit', 'webhook_events',
];

export const BACKUP_EXCLUDED_TABLES = [
  'rate_events', 'auth_events', 'error_log', 'notifications', 'push_subscriptions',
  'admin_login_links', 'failed_email', 'brevo_sync_queue',
];

async function readTable(d1, table) {
  // `table` only ever comes from the constant list above — never from input.
  const res = await d1.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return res.results || [];
}

export async function exportBackupToR2(env, deps = {}) {
  const bucket = env.BACKUP_BUCKET;
  if (!bucket) {
    return { skipped: true, reason: 'no_r2_binding' };
  }

  const tables = {};
  const counts = {};
  const tableErrors = {};
  for (const table of BACKUP_TABLES) {
    try {
      tables[table] = await readTable(env.DB, table);
      counts[table] = tables[table].length;
    } catch (err) {
      tableErrors[table] = String(err && err.message ? err.message : err).slice(0, 200);
    }
  }

  const exportedAt = nowSqlite();
  const dateKey = exportedAt.slice(0, 10); // 'YYYY-MM-DD'
  const payload = JSON.stringify({
    format_version: BACKUP_FORMAT_VERSION,
    exported_at: exportedAt,
    counts,
    ...(Object.keys(tableErrors).length ? { table_errors: tableErrors } : {}),
    tables,
  });

  await bucket.put(`${PREFIX}${dateKey}.json`, payload, {
    httpMetadata: { contentType: 'application/json' },
  });

  const failed = Object.keys(tableErrors);
  if (failed.length > 0) {
    await alertOwnerThrottled(
      env, 'backup_incomplete', 1440,
      'WOGO nightly backup is incomplete',
      `<p>These tables could not be read for the nightly backup: <b>${failed.join(', ')}</b>.</p>` +
      `<p>Everything else was saved. Details are inside the backup file under table_errors.</p>`,
      deps
    );
  }

  const pruned = await pruneOldBackups(bucket, dateKey);

  return { ok: failed.length === 0, date: dateKey, rows: counts, ...(failed.length ? { failed_tables: failed } : {}), pruned };
}

/** Deletes daily snapshots older than BACKUP_RETENTION_DAYS, by comparing the
 * 'YYYY-MM-DD' embedded in each object's key (string comparison is correct
 * for ISO dates) rather than relying on R2 object metadata timestamps. */
async function pruneOldBackups(bucket, todayDateKey) {
  const cutoff = new Date(`${todayDateKey}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - BACKUP_RETENTION_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  const toDelete = [];
  let cursor;
  do {
    const listing = await bucket.list({ prefix: PREFIX, cursor });
    for (const obj of listing.objects) {
      const m = /^daily\/(\d{4}-\d{2}-\d{2})\.json$/.exec(obj.key);
      if (m && m[1] < cutoffKey) toDelete.push(obj.key);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  if (toDelete.length > 0) await bucket.delete(toDelete);
  return toDelete.length;
}
