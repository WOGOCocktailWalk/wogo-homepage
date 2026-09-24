-- migrations/0019_gift_card_redemptions.sql
-- Audit trail of every deduction against a gift card's balance (0018), plus
-- the two columns on `bookings` that record a redemption's effect on THAT
-- booking — deliberately SEPARATE from the pre-existing discount_code /
-- discount_cents columns (migrations/0004), which are for marketing promo
-- codes only (Stripe `allow_promotion_codes`). A gift card is applied via a
-- one-time Stripe coupon instead (src/stripe.js) — the two discount
-- mechanisms never mix on one Checkout Session.
--
-- UNIQUE(booking_id): the load-bearing double-spend/idempotency guard
-- (src/db.js:redeemGiftCard) — a booking can be redeemed against at most
-- ONCE, structurally enforced even if the atomic guarded UPDATE's own
-- `NOT EXISTS` check ever raced (belt AND suspenders, same philosophy as
-- webhook_events' PK-per-event-id dedupe).
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

CREATE TABLE gift_card_redemptions (
  id              TEXT PRIMARY KEY,         -- 'gcr_<uuid>'
  gift_card_code  TEXT NOT NULL REFERENCES gift_cards(code),
  booking_id      TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  amount_cents    INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_gift_card_redemptions_code ON gift_card_redemptions (gift_card_code);

-- bookings: what a booking redeemed, if anything. Both NULL/0 for every
-- booking made before this migration and for every booking that never used
-- a gift card — the existing booking flow is untouched (src/db.js's
-- CREATE_HOLD_SQL is NOT modified by this migration; these are filled in by
-- a separate UPDATE after the hold is created, mirroring how
-- discount_code/discount_cents are filled in after the fact from the
-- Stripe webhook — see src/db.js:attachGiftCardToBooking).
ALTER TABLE bookings ADD COLUMN gift_code          TEXT;
ALTER TABLE bookings ADD COLUMN gift_applied_cents INTEGER NOT NULL DEFAULT 0;
