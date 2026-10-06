-- migrations/0026_review_requests.sql
-- "How was your walk?" review-request email (BUILD §20): sent once per
-- booking, the day after the walk, via a daily cron (src/reviews.js).
--
-- review_sent_at: NULL until sent. Set via ONE atomic guarded UPDATE
-- (src/db.js:markReviewRequestSent — `WHERE status='confirmed' AND
-- review_sent_at IS NULL`) BEFORE the email actually goes out — same
-- "mark atomically before the side effect" idiom as every other
-- once-only send in this codebase (redeemGiftCard, consumeLoginLink) — so a
-- cron overlap, or the manual POST .../send-review trigger racing the cron,
-- can never double-send. NULL forever for a booking that never qualifies
-- (a hold that never confirmed, a cancelled booking) — there is no "N/A"
-- sentinel, only "sent" (a timestamp) or "not yet" (NULL).
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

ALTER TABLE bookings ADD COLUMN review_sent_at TEXT;
