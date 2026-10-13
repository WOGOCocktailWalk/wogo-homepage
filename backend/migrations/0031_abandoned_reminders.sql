-- migrations/0031_abandoned_reminders.sql
-- Three new automated guest-email flows (BUILD: abandoned booking, walk
-- reminder, post-review thank-you) + the reminder opt-out these flows honour.
--
-- bookings.abandoned_sent_at / abandoned_followup_sent_at — the atomic
--   claim-before-send markers for the 1h "still free" email and the ~24h
--   follow-up (src/abandoned.js:claimAbandonedFirst/claimAbandonedFollowup,
--   same "mark atomically first" idiom as redeemGiftCard/markReviewRequestSent
--   elsewhere in this schema). NULL means "not sent yet" for both.
-- bookings.reminder_sent_at — the 2-days-before walk reminder
--   (src/reminders.js), same atomic-claim idiom, one send per booking.
-- bookings.review_thanked_at — idempotency marker for the dashboard's
--   "thank you for the review" button (POST /admin/api/bookings/:id/
--   thank-review) — there is no review webhook, so this is staff-triggered,
--   not cron-triggered, but still needs a one-send guard.
--
-- idx_bookings_abandoned_sweep: the */5 cron sweep's hot query is
-- `status IN ('hold','expired') AND created_at BETWEEN ? AND ?` — this index
-- lets SQLite narrow by status first (two cheap range scans, one per IN
-- value) instead of scanning every booking row ever created. At WOGO's
-- volume this is a belt-and-suspenders cost (the table is small), but it's
-- the right habit as booking volume grows.
ALTER TABLE bookings ADD COLUMN abandoned_sent_at TEXT;
ALTER TABLE bookings ADD COLUMN abandoned_followup_sent_at TEXT;
ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT;
ALTER TABLE bookings ADD COLUMN review_thanked_at TEXT;

CREATE INDEX idx_bookings_abandoned_sweep ON bookings (status, created_at);

-- reminder_optouts — a ONE-CLICK out for the reminder-adjacent mails
-- (abandoned x2 + the 2-day walk reminder) ONLY. Deliberately a separate
-- table from `subscribers` (migrations/0024): `subscribers` is marketing
-- consent state (one row per email, pending/confirmed/unsubscribed, synced
-- to Brevo's list) — these three mails are NOT marketing, they're
-- transactional-adjacent reminders about a specific booking, so opting out
-- of them must never touch, create, or imply anything about the guest's
-- newsletter subscription. A booking's CONFIRMATION/reschedule/cancellation/
-- bar mails are NEVER affected by a row here (src/abandoned.js,
-- src/reminders.js only — nothing else reads this table).
-- email_lower is the PK (not a separate `id`): the only operation this table
-- ever needs is "has this email opted out?" and "record that it has" — no
-- update, no list view, no reason for a surrogate key.
CREATE TABLE reminder_optouts (
  email_lower TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
