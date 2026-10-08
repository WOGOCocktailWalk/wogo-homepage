-- migrations/0029_route_booking_cutoff.sql
-- Per-route booking cutoff (owner requirement, 2026-10): SAME_DAY_CUTOFF_MINUTES
-- (src/config.js, default 60) used to be one global number for every route.
-- Real bar policy isn't uniform — the Rotterdam Premium walk needs a full
-- 24h notice (the gin bar pre-arranges tasting flights), Delft's venues want
-- 10h, and every other route keeps the original 1h. This column makes the
-- cutoff a per-route setting; the global constant becomes only the fallback
-- for a route that has never set one.
--
-- routes.booking_cutoff_minutes  NOT NULL DEFAULT 60 — mirrors
--   SAME_DAY_CUTOFF_MINUTES's own default exactly, so every pre-existing
--   route (and any INSERT written before this column existed) keeps today's
--   1h behaviour with zero data migration needed beyond the backfill below.
--   Read everywhere as `route.booking_cutoff_minutes ?? SAME_DAY_CUTOFF_MINUTES`
--   (src/db.js:getSlotsWithSeatsLeft, src/guest_api.js:handleBook) — the `??`
--   only matters for a route object built by hand in a test fixture that
--   omits the column entirely; a real DB row is never NULL here.
--
-- NOTE: the underlying cutoff check (logic.js:isSlotPastCutoff) was ALREADY a
-- real "slot start < now + cutoffMinutes" instant comparison, not a
-- same-calendar-day shortcut — it already generalizes correctly to a cutoff
-- longer than a day (e.g. 1440 for the 24h Premium route now reaches into
-- TOMORROW's slots too, zeroing seats_left / rejecting POST /api/book for
-- them exactly as it already did for "today"). Nothing about the predicate
-- itself needed to change; only the number fed into it is now per-route.
--
-- Backfill mirrors the live Wix policies at cutover: Rotterdam Route 3
-- Premium 24h, Delft 10h, every other route keeps the 1h default untouched.
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

ALTER TABLE routes ADD COLUMN booking_cutoff_minutes INTEGER NOT NULL DEFAULT 60;

UPDATE routes SET booking_cutoff_minutes = 1440 WHERE id = 'rotterdam-premium-gin';
UPDATE routes SET booking_cutoff_minutes = 600 WHERE id = 'delft';
