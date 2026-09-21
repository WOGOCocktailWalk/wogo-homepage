-- migrations/0008_failed_email.sql
-- Production-readiness hardening (2026-07): email reliability. Every
-- transactional send already went through Brevo's HTTP API best-effort
-- (each side effect independently try/caught — SPEC.md §8.3 step 5); this
-- adds a safety net UNDER that: src/email_retry.js:sendWithRetry() records a
-- failed send here instead of just logging+dropping it, and a new cron
-- (consolidated into the existing trigger set, src/index.js) resends it a
-- few times with backoff before giving up and alerting the owner.
--
-- The full rendered HTML is stored (not just a template ref) because every
-- email in this codebase is owned/rendered HTML (src/emails.js), not a
-- Brevo-hosted template — storing the finished htmlContent is what lets the
-- retry cron resend byte-for-byte the same email without re-deriving it from
-- a booking row that may since have changed. This is real guest PII at rest
-- (name/email/booking details baked into the HTML), so resolved rows
-- ('sent' or 'failed_permanent') are pruned 30 days after their last update
-- by the same cron sweep — see FAILED_EMAIL_RESOLVED_RETENTION_MINUTES.

CREATE TABLE failed_email (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  to_email        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  html_content    TEXT NOT NULL,
  sender_email    TEXT,                -- NULL = caller's default (EMAIL_SENDER, config.js)
  sender_name     TEXT,
  reply_to        TEXT,
  kind            TEXT NOT NULL DEFAULT 'unknown',  -- 'guest_confirmation' | 'owner_notification' | 'bar_notification' | 'owner_conflict' | ...
  attempts        INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed_permanent'
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The retry cron's hot query: due, still-pending rows.
CREATE INDEX idx_failed_email_due ON failed_email (status, next_attempt_at);
