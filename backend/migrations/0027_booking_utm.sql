-- migrations/0027_booking_utm.sql
-- UTM capture on bookings (BUILD §19's Marketing/Highlights pass): lets
-- "Sales by source" on the dashboard be answered from D1 alone (web
-- sessions -> a booking row), without depending on GA4 being connected at
-- all. There is still no GA4-to-D1 join (a GA4 purchase event carries no
-- booking id) — this is a SEPARATE, D1-native source-tracking column set
-- captured at booking time, not a join key.
--
-- All six columns are NULL for every booking that predates this migration,
-- and NULL for any booking (web or manual) with no UTM/referrer info at
-- hand — db.js/admin_api.js group a NULL utm_source under
-- 'Direct / unknown' rather than treating it as an error. Capped at 100
-- characters each by guest_api.js before they ever reach a bound SQL
-- parameter (src/config.js:UTM_FIELD_MAX_LENGTH) — these are attacker-
-- controlled strings (echoed into admin dashboard tables), not computed
-- values, so the length cap is a deliberate input-validation boundary, not
-- just a column-width nicety.
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

ALTER TABLE bookings ADD COLUMN utm_source   TEXT;
ALTER TABLE bookings ADD COLUMN utm_medium   TEXT;
ALTER TABLE bookings ADD COLUMN utm_campaign TEXT;
ALTER TABLE bookings ADD COLUMN utm_content  TEXT;
ALTER TABLE bookings ADD COLUMN referrer     TEXT;
ALTER TABLE bookings ADD COLUMN landing_path TEXT;
