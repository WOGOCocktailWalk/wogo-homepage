// src/errors.js — €0 Sentry-equivalent. Called from index.js's top-level
// catch blocks (fetch() and scheduled()) on any unhandled exception.
// Production hardening, 2026-07 (owner audit item #5).

import * as db from './db.js';
import { alertOwnerThrottled } from './alerts.js';
import { escapeHtml } from './emails.js';
import { ERROR_ALERT_THROTTLE_MINUTES } from './config.js';

/**
 * Records the exception to error_log (migrations/0006) and — throttled —
 * emails the owner. Never throws (a logging failure must never mask or
 * replace the original error response the caller is already returning).
 *
 * `meta` is a SMALL plain object (e.g. { url, method } or { cron }) — never
 * pass the raw request body here; this table is meant to stay free of guest
 * PII, unlike (necessarily) failed_email.
 */
export async function captureError(env, err, meta = {}) {
  const message = String(err && err.message ? err.message : err);
  const stack = err && err.stack ? String(err.stack) : null;

  try {
    await db.insertErrorLog(env.DB, {
      message,
      stack,
      url: meta.url || null,
      method: meta.method || null,
      context: safeStringify(meta),
    });
  } catch (e) {
    console.error('error_log_write_failed', e);
  }

  const subject = `WOGO backend error: ${message.slice(0, 120)}`;
  const html =
    `<pre style="white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Menlo,monospace;">` +
    `${escapeHtml(message)}\n\n${escapeHtml(stack || '(no stack trace)')}\n\n${escapeHtml(safeStringify(meta))}` +
    `</pre>`;

  await alertOwnerThrottled(env, 'crash', ERROR_ALERT_THROTTLE_MINUTES, subject, html);
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj || {});
  } catch {
    return '{}';
  }
}
