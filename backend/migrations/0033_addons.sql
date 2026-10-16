-- migrations/0033_addons.sql
-- Bar-fulfilled add-on upsells (owner requirement, 2026-10): after a guest
-- picks date/time/party size and before Stripe Checkout, the booking flow
-- can offer optional extras actually SOLD BY A BAR on the route — e.g.
-- "Bites at ULU" — which WOGO resells at a markup. The guest sees ONE price
-- (price_cents); the bar invoices WOGO its own, lower price (cost_cents);
-- WOGO keeps the difference. Both numbers are stored so margin is reportable
-- in Analytics, but cost_cents/margin are NEVER sent to the guest (emails.js,
-- the widget JSON, and the guest-facing GET /api/addons response all strip
-- it — see src/guest_api.js:ADDON_GUEST_FIELDS).
--
-- Exact products/prices are the owner's call and not yet known, so EVERY
-- field here is dashboard-editable (src/admin_api.js addon handlers,
-- ROUTE_ROLES: viewing = viewer+, editing = staff+) and nothing is seeded —
-- this migration inserts zero rows. `active` defaults to 0 (see below), so
-- even a row created by a half-finished admin edit never reaches a guest
-- until the owner explicitly flips it on. A route with zero active add-ons
-- produces a byte-for-byte identical booking flow and /api/book payload to
-- before this migration (src/guest_api.js, backend/widget/wogo-calendar.js).
--
-- addons
--   route_id              FK routes.id — which walk this can be offered on.
--   bar_id                FK routes_bars.id, NULLABLE. A specific bar means
--                          "this bar fulfills it" — ONLY that bar's email
--                          gets told about it (src/webhook.js:notifyBars).
--                          NULL means "the whole walk" — deliberately NOT
--                          fanned out to every bar on the route (no bar
--                          actually owns it, so per the owner's own framing
--                          — "bars that don't own it must not see it" — a
--                          route-wide add-on is WOGO-fulfilled and appears
--                          only in the guest confirmation/reminder, the
--                          owner notification, and the admin booking detail,
--                          never in a bar's inbox). See SPEC.md for the full
--                          writeup of this decision.
--   name_en/name_nl, description_en/description_nl, image_url — guest-facing
--                          copy, both languages (same locale convention as
--                          routes_bars.locale / booking.locale elsewhere).
--   price_cents            what the GUEST pays per unit, in `currency`.
--   cost_cents              what the BAR invoices WOGO per unit — margin is
--                          price_cents - cost_cents. Guest-facing code paths
--                          must never read this column.
--   currency               ISO code, mirrors routes.currency (migrations/0011);
--                          stored per add-on (not just inherited from the
--                          route) so a future multi-currency route can't
--                          silently charge a guest in the wrong currency for
--                          an add-on priced before the route's currency was
--                          set.
--   vat_rate                INTEGER percent, stored explicitly per add-on —
--                          NOT assumed from the ticket's own VAT treatment.
--                          Dutch food is 9% while the cocktail-walk ticket
--                          itself is treated as 21% (reference_wogo_bar_fee_
--                          vat); a merch add-on might be 21% again. The
--                          admin UI defaults a new row to 9 (food is the
--                          first use case) but never assumes it silently.
--   is_food                 BOOLEAN (INTEGER 0/1). Drives ONE piece of guest
--                          UX: the widget only shows the "allergies/dietary
--                          needs" free-text field when a FOOD add-on is in
--                          the cart (bookings.addon_notes below) — a safety
--                          requirement, not a nicety.
--   unit                    'per_person' | 'per_booking' — caps the quantity
--                          stepper at party size, or at 1, respectively
--                          (src/guest_api.js, backend/widget/wogo-calendar.js).
--   max_qty_per_booking      hard per-booking cap on top of the unit rule
--                          (e.g. "max 2 bottles of prosecco" on a per_booking
--                          item even though the party is 8).
--   capacity_per_slot        NULLABLE. NULL = unlimited (no kitchen limit).
--                          A number caps the TOTAL quantity sold across every
--                          booking for this add-on on one (date, slot) —
--                          enforced atomically by the guarded INSERT in
--                          src/db.js (CREATE_BOOKING_ADDON_SQL), the exact
--                          same "INSERT ... SELECT ... WHERE capacity allows
--                          it" idiom CREATE_HOLD_SQL already uses for seats.
--                          This capacity is SEPARATE from seat capacity —
--                          an add-on can sell out while seats remain, and
--                          vice versa.
--   cutoff_hours             DEFAULT 24. How many hours before the slot's
--                          start a kitchen needs warning; past this, the
--                          add-on silently stops being offered (GET
--                          /api/addons) and POST /api/book rejects it
--                          (error code addon_cutoff_passed). Reuses
--                          src/logic.js:isSlotPastCutoff (the exact same
--                          DST-safe, per-route-timezone instant comparison
--                          routes.booking_cutoff_minutes already uses) —
--                          cutoff_hours * 60 is simply a second, independent
--                          cutoffMinutes fed into that one function.
--   sort_order                display order within a route, same convention
--                          as routes_bars.ord.
--   active                   DEFAULT 0 — see "seed nothing live" above.
--
-- booking_addons
--   One row per (booking, add-on) line item actually purchased. Snapshots
--   EVERYTHING the price/VAT/name were at the moment of purchase
--   (unit_price_cents, unit_cost_cents, vat_rate, name_snapshot) so a later
--   edit to the `addons` row (price change, rename, even deletion) never
--   rewrites a guest's history, their email, the bar's email, or a past
--   CSV export — the exact same "snapshot, don't re-join" principle
--   bookings.notes/bookings.party etc. already follow for every other
--   guest-submitted value in this schema. `name_snapshot` stores the EN
--   string; the booking's own `locale` column decides which language to
--   show it in at render time (emails.js renders name_en/name_nl from the
--   live `addons` row when still available, falling back to name_snapshot
--   when the add-on has since been deleted — see src/emails.js doc comment
--   on addonLines()).
--   Capacity/cutoff/cancellation release needs NO extra bookkeeping: a
--   booking_addons row's capacity only counts while its PARENT booking's
--   status counts (exactly the join CREATE_BOOKING_ADDON_SQL's own capacity
--   subquery performs) — the instant a hold expires or a booking is
--   cancelled, every capacity query for that slot already excludes it, same
--   as seats. There is no addon_holds table and no separate release step.
--
-- bookings.addon_notes — the guest's optional allergy/dietary free text,
--   DELIBERATELY a separate column from the pre-existing `bookings.notes`
--   (general "anything else?" field): conflating them would mean an
--   allergy note typed before any food add-on was selected either gets
--   silently dropped or silently shown to a bar that isn't serving food.
--   Same validateNotes() length/character rules apply (src/logic.js),
--   reused as-is, not duplicated.
--
-- Indexes:
--   idx_addons_route            the admin editor's + guest API's
--                                "add-ons for this route" list query.
--   idx_booking_addons_booking   the per-booking fetch every email,
--                                the booking-detail panel, and the CSV
--                                export all do.
--   idx_booking_addons_addon     the per-slot capacity join
--                                (CREATE_BOOKING_ADDON_SQL groups by
--                                addon_id, joined to bookings for date/slot/
--                                status) — this is the hot path, checked on
--                                every POST /api/book that includes add-ons.
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

CREATE TABLE addons (
  id                   TEXT PRIMARY KEY,
  route_id             TEXT NOT NULL REFERENCES routes(id),
  -- INTEGER, not TEXT: routes_bars.id is itself a plain autoincrement
  -- INTEGER PRIMARY KEY (migrations/0001) — matching the column's real
  -- affinity matters here beyond style. A TEXT-affinity FK storing a bound
  -- JS number gets SQLite's REAL->TEXT conversion ("1" becomes the string
  -- "1.0") under the test adapter's node:sqlite driver, which would make
  -- every bar_id equality check silently fail.
  bar_id               INTEGER REFERENCES routes_bars(id),
  name_en              TEXT NOT NULL,
  name_nl              TEXT NOT NULL,
  description_en       TEXT,
  description_nl       TEXT,
  image_url            TEXT,
  price_cents          INTEGER NOT NULL,
  cost_cents           INTEGER NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'EUR',
  vat_rate             INTEGER NOT NULL DEFAULT 9,
  is_food              INTEGER NOT NULL DEFAULT 0,
  unit                 TEXT NOT NULL DEFAULT 'per_person',
  max_qty_per_booking  INTEGER NOT NULL DEFAULT 10,
  capacity_per_slot    INTEGER,
  cutoff_hours         INTEGER NOT NULL DEFAULT 24,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  active               INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_addons_route ON addons (route_id, sort_order);

CREATE TABLE booking_addons (
  id                TEXT PRIMARY KEY,
  booking_id        TEXT NOT NULL REFERENCES bookings(id),
  addon_id          TEXT NOT NULL REFERENCES addons(id),
  qty               INTEGER NOT NULL,
  unit_price_cents  INTEGER NOT NULL,
  unit_cost_cents   INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'EUR',
  vat_rate          INTEGER NOT NULL,
  name_snapshot_en  TEXT NOT NULL,
  name_snapshot_nl  TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_booking_addons_booking ON booking_addons (booking_id);
CREATE INDEX idx_booking_addons_addon ON booking_addons (addon_id);

ALTER TABLE bookings ADD COLUMN addon_notes TEXT;
