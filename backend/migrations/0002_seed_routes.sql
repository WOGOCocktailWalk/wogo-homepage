-- migrations/0002_seed_routes.sql
-- Real WOGO data pulled from the live route cards on index.html and the route pages
-- (amsterdam/, utrecht/, groningen/, rotterdam/witte-de-with/, rotterdam/hidden-gems/,
-- rotterdam/premium-gin-walk/) at build time. Fields marked PLACEHOLDER below are not
-- publicly stated on the site and must be confirmed/edited by Maroussia in the admin
-- Route Manager before go-live — this migration seeds *something sane* so the system
-- is immediately testable, it does not need a redeploy to fix.

INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, map_url, active) VALUES
  ('amsterdam',                'WOGO Cocktail Walk Amsterdam',                 'Amsterdam', 2995, 10, 6, '[4,5,6]',       '["17:30","18:00","18:30","19:00","19:30","20:00"]', NULL, 1),
  ('utrecht',                  'WOGO Cocktail Walk Utrecht',                   'Utrecht',   2995, 10, 6, '[1,2,3,4,5,6,7]', '["17:30"]',                                         NULL, 1),
  ('groningen',                'WOGO Cocktail Walk Groningen',                 'Groningen', 2995, 10, 6, '[3,4,5,6]',       '["17:00","17:30","18:00","18:30","19:00","19:30","20:00"]', NULL, 1),
  ('rotterdam-witte-de-with',  'Rotterdam Route 1 · Witte de With',            'Rotterdam', 2995, 10, 6, '[4,5,6]',       '["17:00"]',                                         NULL, 1),
  ('rotterdam-hidden-gems',    'Rotterdam Route 2 · Hidden Gems (best seller)','Rotterdam', 2995, 10, 6, '[4,5,6]',       '["18:00","18:30","19:00","19:30","20:00","20:30"]', NULL, 1),
  ('rotterdam-premium-gin',    'Rotterdam Route 3 · Premium'            ,            'Rotterdam', 3495, 10, 6, '[2,3,4,5,6]',   '["17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:30"]', NULL, 1);

-- PLACEHOLDER bar rows — real bar names/emails are intentionally not published on the site
-- ("a surprise until you book"), so they cannot be pulled from public pages. Default 75-min
-- stagger per BACKEND-PLAN.md §7. Maroussia MUST replace bar_name/bar_email via
-- Admin → Route manager → Bars before real bookings go out, or the arrival emails go nowhere useful.
INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset)
SELECT r.id, b.ord, b.bar_name, 'bookings@wogoamsterdam.com', b.minutes_offset
FROM routes r
JOIN (
  SELECT 1 AS ord, 'Bar 1 (TBD — set real name/email)' AS bar_name, 0   AS minutes_offset UNION ALL
  SELECT 2,        'Bar 2 (TBD — set real name/email)',              60 UNION ALL
  SELECT 3,        'Bar 3 (TBD — set real name/email)',             120
) b;

-- Amsterdam's known first bar (from the live page's schema.org itinerary) is the one real
-- name available publicly — seed it, leave bars 2/3 as the surprise they're marketed as.
UPDATE routes_bars SET bar_name = 'Van de Werf (NDSM wharf)'
WHERE route_id = 'amsterdam' AND ord = 1;
