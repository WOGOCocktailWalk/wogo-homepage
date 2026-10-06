// src/brevo_sync.js — drains `brevo_sync_queue` (migrations/0024, BUILD item
// #7). Mirrors src/email_retry.js's shape exactly, for the Brevo CONTACTS API
// instead of transactional email: a few attempts with escalating backoff,
// then give up and alert the owner once (not once per row).

import * as db from './db.js';
import { alertOwnerThrottled } from './alerts.js';
import { escapeHtml } from './emails.js';
import { nowSqlite, sqliteMinutesFromNow } from './logic.js';
import { BREVO_SYNC_MAX_ATTEMPTS, BREVO_SYNC_RETRY_BACKOFF_MINUTES, BREVO_SYNC_ALERT_THROTTLE_MINUTES } from './config.js';
import { replaySyncItem } from './subscribers.js';

/** Cron entry point (consolidated into the Worker's trigger set — src/index.js). */
export async function retryBrevoSyncQueue(env, deps = {}) {
  const database = deps.database || db;
  const replay = deps.replaySyncItem || replaySyncItem;

  const now = nowSqlite();
  const due = await database.listDueBrevoSyncItems(env.DB, now, 50);

  let done = 0;
  let rescheduled = 0;
  let permanentlyFailed = 0;
  const failedRows = [];

  for (const row of due) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    try {
      await replay(env, row.kind, payload, { database });
      await database.markBrevoSyncDone(env.DB, row.id);
      done++;
    } catch (err) {
      const lastError = String(err && err.message ? err.message : err);
      const attempts = row.attempts + 1;
      if (attempts >= BREVO_SYNC_MAX_ATTEMPTS) {
        await database.markBrevoSyncPermanent(env.DB, row.id, lastError);
        permanentlyFailed++;
        failedRows.push(row);
      } else {
        const backoffIdx = Math.min(attempts - 1, BREVO_SYNC_RETRY_BACKOFF_MINUTES.length - 1);
        await database.markBrevoSyncRetry(
          env.DB, row.id, attempts, sqliteMinutesFromNow(BREVO_SYNC_RETRY_BACKOFF_MINUTES[backoffIdx]), lastError
        );
        rescheduled++;
      }
    }
  }

  if (permanentlyFailed > 0) {
    await alertOwnerThrottled(
      env, 'brevo_sync_failure', BREVO_SYNC_ALERT_THROTTLE_MINUTES,
      `WOGO: ${permanentlyFailed} Brevo sync item(s) permanently failed`,
      `<pre style="white-space:pre-wrap;font:13px ui-monospace,monospace;">` +
        `${permanentlyFailed} queued Brevo contact sync item(s) gave up after ${BREVO_SYNC_MAX_ATTEMPTS} attempts.\n` +
        `Check GET /admin/api/subscribers/sync-queue for details.\n\n` +
        `${escapeHtml(failedRows.map((r) => `#${r.id} -> ${r.kind}`).join('\n'))}` +
        `</pre>`,
      { database }
    );
  }

  return { checked: due.length, done, rescheduled, permanentlyFailed };
}
