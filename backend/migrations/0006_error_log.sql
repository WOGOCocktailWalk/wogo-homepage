-- migrations/0006_error_log.sql
-- Production-readiness hardening (2026-07): €0 Sentry-equivalent. The Worker's
-- top-level fetch()/scheduled() catch blocks (src/index.js, src/errors.js)
-- write every unhandled exception here, then send a THROTTLED Brevo alert
-- (src/alerts.js) so a crash loop can't spam the owner's inbox.
--
-- `context` is a small JSON blob (url/method/cron-name at most) — deliberately
-- NOT the full request body, so this table never becomes a second place guest
-- PII leaks into. Rows are pruned by the existing 5-minute cron sweep after
-- ERROR_LOG_RETENTION_MINUTES (src/config.js).

CREATE TABLE error_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  message    TEXT NOT NULL,
  stack      TEXT,                     -- may be NULL (some thrown values aren't Error instances)
  url        TEXT,                     -- request pathname, when the error happened inside fetch()
  method     TEXT,                     -- request method, ditto
  context    TEXT                      -- small JSON blob, e.g. {"cron":"0 3 * * *"} for scheduled() failures
);

CREATE INDEX idx_error_log_created ON error_log (created_at);
