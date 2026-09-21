-- migrations/0013_seed_city_maps.sql
-- SEED DATA ONLY (no schema): points the two cities whose map PDFs are ready
-- at their real hosted files, so the per-language map link (migrations/0012)
-- works the moment this is applied.
--
-- The PDFs live in the site repo at /maps/ and deploy with the site (GitHub
-- Pages behind www.wogococktailwalk.com):
--   maps/utrecht-en.pdf     maps/utrecht-nl.pdf
--   maps/groningen-en.pdf   maps/groningen-nl.pdf
--
-- Idempotent: plain UPDATEs keyed on the route ids seeded by
-- migrations/0002 — re-running them lands the same values; routes that don't
-- exist are simply not matched (0 rows). Other routes (amsterdam,
-- rotterdam-*) are untouched until their PDFs exist; their confirmation
-- emails keep omitting the map section, as before.
--
-- Future cities: set both URLs from the admin dashboard's Route manager
-- instead of a new migration (see ADD-A-CITY.md) — this file exists only
-- because these two cities' maps predate the dashboard fields.

UPDATE routes SET
  map_url    = 'https://www.wogococktailwalk.com/maps/utrecht-en.pdf',
  map_url_nl = 'https://www.wogococktailwalk.com/maps/utrecht-nl.pdf'
WHERE id = 'utrecht';

UPDATE routes SET
  map_url    = 'https://www.wogococktailwalk.com/maps/groningen-en.pdf',
  map_url_nl = 'https://www.wogococktailwalk.com/maps/groningen-nl.pdf'
WHERE id = 'groningen';
