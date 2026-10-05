-- migrations/0023_route_names_simple.sql
-- Rotterdam route display names, simplified to the owner's final naming
-- (2026-10): the three Rotterdam routes drop their sub-neighbourhood/
-- marketing suffixes ("· Witte de With", "· Hidden Gems", "Premium ·
-- High-end Bars") in favour of a plain "Rotterdam Route N[, Premium]" —
-- consistent with how every other city's routes are already named
-- ("WOGO Cocktail Walk Utrecht", etc.) and with migrations/0020's same
-- goal (routes.name is the guest-facing display name only).
--
-- routes.name is printed VERBATIM wherever a route is named — Stripe
-- Checkout's line-item product name (src/stripe.js), the guest/owner/bar
-- emails (src/emails.js), the booking-confirmation page (reads
-- GET /api/booking's route_name field, src/guest_api.js), and the admin
-- dashboard. No code path parses or derives a city/label from routes.name
-- (every call site already uses route.city for the city, and route.id for
-- routing) — confirmed by a full repo search before writing this migration
-- — so this rename has zero effect beyond the printed string.
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

UPDATE routes SET name = 'Rotterdam Route 1'         WHERE id = 'rotterdam-witte-de-with';
UPDATE routes SET name = 'Rotterdam Route 2'         WHERE id = 'rotterdam-hidden-gems';
UPDATE routes SET name = 'Rotterdam Route 3 Premium' WHERE id = 'rotterdam-premium-gin';
