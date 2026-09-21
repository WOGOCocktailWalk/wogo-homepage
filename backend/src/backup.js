// src/backup.js — daily D1 -> R2 export (owner audit item #4, CRITICAL).
//
// D1's built-in Time Travel already gives point-in-time restore for ~30 days
// (see SETUP.md "Disaster recovery" section for the exact restore command) —
// that covers "I fat-fingered a delete 10 minutes ago". This cron adds the
// OTHER half: an OFFSITE, longer-retention, human-readable copy of the
// business-critical tables in Cloudflare R2 (free tier: 10GB storage, way
// more than WOGO's volume needs), for the "D1 itself is gone/corrupted" or
// "I need last month's numbers back" case Time Travel's 30-day window
// doesn't reach.
//
// Config-gated and INERT until the owner both (a) creates the R2 bucket
// (`wrangler r2 bucket create wogo-backups`) and (b) uncomments the
// `[[r2_buckets]]` block in wrangler.toml — see SETUP.md. Until then
// `env.BACKUP_BUCKET` is undefined and this is a no-op, so it ships live with
// zero risk to the current deploy.
//
// Only the tables whose loss would be catastrophic and can't be trivially
// re-entered by hand are exported: routes, routes_bars, date_overrides,
// bookings. Operational/security-log tables (rate_events, auth_events,
// error_log, admin_audit, webhook_events, failed_email) are NOT included —
// Time Travel already covers them for the cases that matter, and duplicating
// high-churn logs into R2 daily would just burn storage for no real DR value.

import * as db from './db.js';
import { nowSqlite } from './logic.js';
import { BACKUP_RETENTION_DAYS } from './config.js';

const PREFIX = 'daily/';

export async function exportBackupToR2(env, deps = {}) {
  const bucket = env.BACKUP_BUCKET;
  if (!bucket) {
    return { skipped: true, reason: 'no_r2_binding' };
  }
  const database = deps.database || db;

  const [routes, bars, dateOverrides, bookings] = await Promise.all([
    database.listAllRoutesForBackup(env.DB),
    database.listAllBarsForBackup(env.DB),
    database.listAllDateOverridesForBackup(env.DB),
    database.listAllBookingsForBackup(env.DB),
  ]);

  const exportedAt = nowSqlite();
  const dateKey = exportedAt.slice(0, 10); // 'YYYY-MM-DD'
  const payload = JSON.stringify({
    exported_at: exportedAt,
    tables: { routes, routes_bars: bars, date_overrides: dateOverrides, bookings },
  });

  await bucket.put(`${PREFIX}${dateKey}.json`, payload, {
    httpMetadata: { contentType: 'application/json' },
  });

  const pruned = await pruneOldBackups(bucket, dateKey);

  return { ok: true, date: dateKey, rows: { routes: routes.length, bars: bars.length, date_overrides: dateOverrides.length, bookings: bookings.length }, pruned };
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
