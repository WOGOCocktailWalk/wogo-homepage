-- migrations/0018_gift_cards.sql
-- Balance-tracked gift cards (owner-owned, €0/month): Stripe cannot hold a
-- balance across multiple future purchases, so the balance lives HERE in D1;
-- Stripe only ever processes the leftover payment at booking time (a one-time
-- coupon built from balance_cents — see src/stripe.js). Buying a gift card
-- and redeeming it at booking are two SEPARATE Stripe Checkout Sessions;
-- this table is the single source of truth for what's left on a card.
--
-- code: human-friendly, e.g. "WOGO-7F3K-9QRT" (src/logic.js:generateGiftCardCode,
--   Crockford-ish alphabet — no 0/O/1/I/L — so it's easy to read aloud/retype).
-- initial_cents / balance_cents: whole-cents integers, same convention as
--   routes.price_cents / bookings elsewhere in this schema.
-- status: 'active' (has balance, usable) | 'depleted' (balance hit 0 via
--   redemption) | 'void' (owner cancelled it by hand, e.g. a refunded purchase).
-- stripe_session: the PURCHASE Checkout Session id (cs_...) — distinct from
--   any booking's own stripe_session; used for webhook idempotency (a
--   redelivered purchase event must not mint a second card).
-- locale: 'en' | 'nl' — which language the recipient/buyer emails render in;
--   captured from the purchase form, defaults 'en'.
--
-- TODO (v2): no expiry logic yet — cards are valid indefinitely until fully
-- redeemed or voided. Add an `expires_at` column + a redemption-time check
-- when the owner wants Dutch-law-compliant voucher expiry (see gift-cards
-- page's existing TODO on statutory minimums).
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

CREATE TABLE gift_cards (
  id                TEXT PRIMARY KEY,               -- 'gc_<uuid>'
  code              TEXT NOT NULL UNIQUE,            -- 'WOGO-XXXX-XXXX'
  initial_cents     INTEGER NOT NULL,
  balance_cents     INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'EUR',
  buyer_email       TEXT NOT NULL,
  buyer_name        TEXT NOT NULL,
  recipient_name    TEXT NOT NULL,
  recipient_email   TEXT NOT NULL,
  message           TEXT,
  status            TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'depleted' | 'void'
  stripe_session    TEXT,                            -- the PURCHASE session id
  locale            TEXT NOT NULL DEFAULT 'en',       -- 'en' | 'nl'
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_gift_cards_code ON gift_cards (code);
