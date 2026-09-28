-- migrations/0020_route_names.sql
-- Audit item 5: routes.name must be the guest-facing display name only —
-- never a marketing label. "Rotterdam Route 2 · Hidden Gems (best seller)"
-- (migrations/0002_seed_routes.sql's original seed) leaked the "(best
-- seller)" marketing tag into every place routes.name is rendered verbatim:
-- Stripe Checkout's line-item product name (src/stripe.js), the guest
-- confirmation/owner/bar emails (src/emails.js), and the admin dashboard.
-- A paying guest's Stripe receipt/bank statement should show the route name,
-- not WOGO's own internal sales copy.
--
-- Every other route name was checked against this same pattern (trailing
-- "(...)" marketing/status labels — "(new)", "(premium)", etc.) at the time
-- this migration was written (2026-09-28, live remote DB) and none of the
-- other six carry one: "Rotterdam Route 3 · Premium" is the route's actual
-- product name (the Premium Gin Walk), not an appended label, so it is left
-- untouched.

UPDATE routes
   SET name = 'Rotterdam Route 2 · Hidden Gems'
 WHERE id = 'rotterdam-hidden-gems';
