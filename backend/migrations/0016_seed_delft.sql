-- migrations/0016_seed_delft.sql
-- WOGO Delft — the next city (Café de V → De Botanie → Wijnhaven, 7 days/week,
-- €29,95). Uses the per-weekday slots shape (migration: polymorphic routes.slots):
-- Mon–Fri 16:00–21:00 hourly; Sat–Sun open earlier, 13:00–21:00 hourly.
-- Bars stagger +0 / +60 / +120 (one hour between stops). Reservation emails are
-- the venues' real inboxes. Idempotent-ish: safe to run once on a fresh remote.

INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, map_url, map_url_nl, active)
VALUES (
  'delft',
  'WOGO Cocktail Walk Delft',
  'Delft',
  2995,
  10,
  6,
  '[1,2,3,4,5,6,7]',
  '{"1":["16:00","17:00","18:00","19:00","20:00","21:00"],"2":["16:00","17:00","18:00","19:00","20:00","21:00"],"3":["16:00","17:00","18:00","19:00","20:00","21:00"],"4":["16:00","17:00","18:00","19:00","20:00","21:00"],"5":["16:00","17:00","18:00","19:00","20:00","21:00"],"6":["13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00"],"7":["13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00"]}',
  'https://www.wogococktailwalk.com/maps/delft-en.pdf',
  'https://www.wogococktailwalk.com/maps/delft-nl.pdf',
  1
);

INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset) VALUES
  ('delft', 1, 'Café de V',  'info@cafe-de-v.nl',  0),
  ('delft', 2, 'De Botanie', 'info@debotanie.nl',  60),
  ('delft', 3, 'Wijnhaven',  'mail@wijnhaven.nl',  120);
