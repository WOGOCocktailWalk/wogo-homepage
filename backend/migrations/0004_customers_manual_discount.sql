-- migrations/0004_customers_manual_discount.sql
-- Dashboard v2 (owner requirements, 2026-07-23):
--   * a Customers tab (CRM) that aggregates every customer across their bookings
--   * manual "phone booking" entry by the owner
--   * promo-code / discount visibility per booking, captured from Stripe
--
-- All four additions are columns on `bookings`. There is deliberately NO
-- separate `customers` table: a customer is DERIVED from their bookings, keyed
-- by email (see src/logic.js:aggregateCustomers). Editing a customer rewrites
-- their booking rows (src/db.js:updateCustomer) so the two never drift. This
-- keeps the schema minimal and means "add a customer" is simply "take their
-- first (manual) booking" — the simplest correct model for a booking CRM.
--
-- Every column has a default, so existing rows keep their exact meaning:
--   source          = 'web'  (all historical bookings came through the widget)
--   payment_status  = NULL   (web bookings are Stripe-paid; only manual bookings
--                             carry an explicit paid_invoice/free/comp status)
--   discount_code   = NULL   (no promo applied)
--   discount_cents  = 0      (nothing saved)

ALTER TABLE bookings ADD COLUMN source          TEXT    NOT NULL DEFAULT 'web';   -- 'web' | 'manual'
ALTER TABLE bookings ADD COLUMN payment_status  TEXT;                             -- manual only: 'paid_invoice' | 'free' | 'comp'
ALTER TABLE bookings ADD COLUMN discount_code   TEXT;                             -- promo code applied at Stripe checkout, NULL if none
ALTER TABLE bookings ADD COLUMN discount_cents  INTEGER NOT NULL DEFAULT 0;       -- amount saved, in eurocents

-- Customer-list lookups group/scan by email; this index keeps that fast as the
-- table grows past a few thousand rows.
CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings (email);
