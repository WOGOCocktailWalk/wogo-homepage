-- migrations/0034_addon_extra_stop.sql
-- "Extra stop" add-ons (owner request, 20 Nov 2026): a guest can add a 4th
-- bar to the end of their walk at checkout (Rotterdam Route 2 + Patio Bar,
-- Delft + Sevenhills). Built ON TOP of the 0033 add-on system — the extra
-- stop is simply an add-on row with a few more fields:
--
--   extra_stop_name/email/locale   the bar that is ONLY emailed when a booking
--                                  bought this add-on. Stored on the add-on
--                                  row, deliberately NOT as a routes_bars row:
--                                  routes_bars is bulk-replaced (delete +
--                                  re-insert) by the dashboard's "Save bars",
--                                  and a weekday-specific bar set replaces the
--                                  whole day's line-up — both would break an
--                                  optional bar living there.
--   extra_stop_offset_minutes      minutes after the booked start time the
--                                  group arrives at the extra stop (180 = the
--                                  4th bar on a 3-bar, 1-hour-per-bar walk).
--                                  Also the arrival used by the hours rule.
--   hours                          JSON {"5":["18:00","23:00"], ...}: ISO
--                                  weekday (Mon=1..Sun=7) -> [open, close] of
--                                  the bar that fulfils the add-on. NULL = no
--                                  time rule. A weekday missing from the
--                                  object = not offered that day. A close
--                                  time <= open time means "past midnight".
--   min_minutes_before_close       the group must ARRIVE at least this many
--                                  minutes before closing (owner: 1.5 h).
--   available_from/available_until  optional 'YYYY-MM-DD' walk-date window
--                                  (inclusive). E.g. Patio on Rotterdam
--                                  Route 1/2 only until 2026-12-31. NULL = no
--                                  limit on that side.
--   map_url_en/map_url_nl           a different route map (the 4-bar map) for
--                                  guests who bought this add-on — replaces
--                                  the route's own map in their emails.
--
-- unit gains a third value, 'whole_group': a yes/no for the whole party —
-- quantity is always exactly the party size (enforced server-side).
--
-- Every column is nullable/defaulted, so existing add-ons (Utrecht) behave
-- exactly as before. Applied by hand:
--   wrangler d1 migrations apply wogo-bookings --remote

ALTER TABLE addons ADD COLUMN extra_stop_name TEXT;
ALTER TABLE addons ADD COLUMN extra_stop_email TEXT;
ALTER TABLE addons ADD COLUMN extra_stop_locale TEXT;
ALTER TABLE addons ADD COLUMN extra_stop_offset_minutes INTEGER;
ALTER TABLE addons ADD COLUMN hours TEXT;
ALTER TABLE addons ADD COLUMN min_minutes_before_close INTEGER NOT NULL DEFAULT 90;
ALTER TABLE addons ADD COLUMN map_url_en TEXT;
ALTER TABLE addons ADD COLUMN map_url_nl TEXT;
ALTER TABLE addons ADD COLUMN available_from TEXT;
ALTER TABLE addons ADD COLUMN available_until TEXT;
