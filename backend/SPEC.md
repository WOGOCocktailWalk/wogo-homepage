# WOGO Booking Backend — Build Spec (v1)

Status: **definitive spec, ready to build against.** Written so multiple builders can implement different files in parallel without needing to ask clarifying questions. Every route, every SQL statement, every external API call is written out in full below — not "roughly like this," but the actual contract.

> **Dashboard v2 (2026-07-23):** a Customers/CRM tab, owner manual (phone) booking, promo-code capture, and owned branded HTML emails were added on top of this v1 spec — see **[`DASHBOARD-V2-SPEC.md`](./DASHBOARD-V2-SPEC.md)** for that layer's full contract. It changes/extends: `migrations/0004`, `src/logic.js`, `src/db.js`, `src/emails.js` (new), `src/webhook.js`, `src/admin_api.js`, `src/index.js`, `preview/emails.html` (new). This v1 doc is left as-is below except for the file-layout table (§1) and the "what's still open" summary at the bottom, which are updated to the current file set.

Owner: Maroussia (WOGO Amsterdam B.V.). Replaces Wix Bookings entirely. Supersedes the Google-Sheets/Apps-Script robot design in `BACKEND-PLAN.md` and the third-party booking platforms in `BOOKING-SYSTEM-OPTIONS.md` — this is a fully self-owned system on her own Cloudflare account. Those two docs are still useful background (bar-timing rules, email requirements, GDPR posture) but wherever they conflict with this spec, **this spec wins.**

---

## 0. One-paragraph architecture

One Cloudflare Worker (`backend/src/index.js`, a plain JS `fetch`/`scheduled` handler, zero npm dependencies) is the entire backend. It talks to one Cloudflare D1 database (SQLite) for all state, calls the Stripe REST API directly over `fetch` to create Checkout Sessions and to verify webhook signatures, calls the Brevo REST API directly over `fetch` to send transactional email, and serves the `/admin` dashboard itself (HTML/CSS/JS returned as strings from the Worker — no separate hosting). A Workers Cron Trigger sweeps expired holds every 5 minutes. The public site (GitHub Pages, unchanged) embeds a small vanilla-JS widget that talks to the Worker's public JSON API. Everything is free at her volume: Workers free tier (100k requests/day), D1 free tier (5GB, 5M reads/day), Brevo free tier (300 emails/day). The only money that moves is Stripe's per-transaction fee.

```
Guest browser                          Cloudflare (her account)                    Third parties
──────────────                         ──────────────────────                      ─────────────
route page                             ┌─────────────────────────┐
 └─ wogo-calendar.js  ──fetch JSON──▶  │  Worker  (src/index.js)  │
                                        │   /api/*     guest API   │──fetch──▶ Stripe API (Checkout Sessions)
                                        │   /admin*    dashboard   │◀─webhook─ Stripe (Stripe-Signature header)
Admin browser                          │   /webhooks/stripe        │──fetch──▶ Brevo API (transactional email)
 └─ /admin (served by Worker) ──────▶  │   scheduled()  (cron)     │──fetch──▶ Meta CAPI (stub)
                                        │            │              │
                                        │            ▼              │
                                        │   D1 database (SQLite)    │
                                        └─────────────────────────┘
```

---

## 1. File layout (what gets built where)

```
backend/
  SPEC.md                    ← this file (v1 contract)
  DASHBOARD-V2-SPEC.md        ← Customers/CRM, manual booking, discount capture, owned HTML emails
  PORTABILITY.md             ← how to move off Cloudflare later
  wrangler.toml               ← Cloudflare config (D1 binding, cron, no secrets)
  package.json                ← "type":"module"; scripts: test, build:admin, build:emails-preview
  migrations/
    0001_init.sql              ← CREATE TABLE + indexes
    0002_seed_routes.sql        ← the 6 real WOGO routes + placeholder bars
    0003_slot_capacity.sql       ← routes.slot_capacity column, for per-timeslot capacity (§7.6)
    0004_customers_manual_discount.sql ← bookings.source/payment_status/discount_code/discount_cents (Dashboard v2)
    0005_security.sql            ← bookings.ip, rate_events, auth_events (seat-hold abuse + admin brute-force protection, §15)
  src/
    index.js                    ← entry point: export default { fetch, scheduled }
    router.js                    ← ~30-line manual method+path router, zero-dep
    config.js                     ← non-secret constants (CORS allowlist, Brevo template IDs, Pixel ID, defaults)
    db.js                          ← ALL D1 SQL lives here, as named functions. Only file that touches env.DB.
    logic.js                        ← PURE functions, no platform calls. Runs under plain `node`. See §9.
    emails.js                        ← owned branded HTML email renderers (Dashboard v2 — see its spec §8)
    emails_preview.mjs                ← Node script: renders every emails.js template → preview/emails.html
    stripe.js                        ← createCheckoutSession(), verifyStripeSignature()
    brevo.js                          ← sendTransactional()
    meta.js                            ← sendPurchaseEvent() (CAPI stub)
    auth.js                             ← admin login check, session cookie sign/verify
    guest_api.js                         ← handlers for /api/*
    admin_api.js                          ← handlers for /admin/api/* (incl. Dashboard v2's customers + manual booking)
    webhook.js                              ← handler for /webhooks/stripe
    admin/
      admin.html, admin.css, admin.js         ← hand-edited dashboard source (SPA shell + views)
      mock.js                                  ← fixture data for the preview build
      build.mjs                                 ← Node script: admin.* → src/admin/assets.js + preview/admin.html
      assets.js                                  ← AUTO-GENERATED (do not hand-edit) — imported by index.js
  test/
    sqlite-d1-adapter.js         ← wraps Node's built-in node:sqlite as a D1-shaped stub (see §9.4)
    logic.test.js                 ← pure-function tests
    db.test.js                     ← atomic hold / no-overbooking / expiry tests against the adapter
    webhook.test.js                 ← signature verify (fake sig) + dedupe tests
  widget/
    wogo-calendar.js                 ← guest calendar, ONE constant (WOGO_API), vanilla JS
    wogo-calendar.css                 ← WOGO brand styling
  preview/
    guest.html                         ← opens directly in a browser, mock data, no Worker needed
    admin.html                          ← AUTO-GENERATED by src/admin/build.mjs — opens directly in a browser
    emails.html                          ← AUTO-GENERATED by src/emails_preview.mjs — every email template, mock data
```

Note: `admin_html.js` (named in the original build order below) was superseded during the v1 build by the `src/admin/` folder above (hand-edited `admin.html`/`.css`/`.js` + a small Node build step) — functionally the same "admin dashboard HTML/CSS/JS as strings, served by the Worker" contract, just split into editable source files instead of one hand-written template-string file.

Build order for parallel builders (dependency-safe grouping):

1. **Group A (no dependencies on each other):** `migrations/*.sql`, `src/logic.js` + `test/logic.test.js`, `src/config.js`.
2. **Group B (depends on A's schema):** `src/db.js`, `test/sqlite-d1-adapter.js` + `test/db.test.js`.
3. **Group C (depends on A/B):** `src/stripe.js`, `src/brevo.js`, `src/meta.js`, `src/auth.js` — all independent of each other.
4. **Group D (depends on B+C):** `src/guest_api.js`, `src/admin_api.js`, `src/webhook.js`, `test/webhook.test.js`.
5. **Group E:** `src/admin_html.js`, `widget/*`, `preview/*` — can start any time once §5/§6/§8 contracts below are frozen (they are, as of this spec).
6. **Group F (last):** `src/router.js`, `src/index.js` wire everything together; `wrangler.toml`.

---

## 2. D1 schema (`migrations/0001_init.sql`)

```sql
-- migrations/0001_init.sql
-- WOGO booking backend — initial schema. SQLite dialect (Cloudflare D1).

CREATE TABLE routes (
  id          TEXT PRIMARY KEY,              -- slug, e.g. 'amsterdam', 'rotterdam-hidden-gems'
  name        TEXT NOT NULL,                 -- display name, e.g. "Rotterdam Route 2 · Hidden Gems"
  city        TEXT NOT NULL,                 -- 'Amsterdam' | 'Rotterdam' | 'Utrecht' | 'Groningen' | ...
  price_cents INTEGER NOT NULL,              -- price PER PERSON, in eurocents
  capacity    INTEGER NOT NULL DEFAULT 10,   -- route-wide default seats per departure (owner default: 10);
                                              -- see also slot_capacity, added by migrations/0003 (§7.6),
                                              -- for per-timeslot capacity defaults
  max_party   INTEGER NOT NULL DEFAULT 6,    -- max guests in one single booking (owner default: 6)
  open_days   TEXT NOT NULL,                 -- JSON array of ISO weekday ints, Mon=1..Sun=7, e.g. "[4,5,6]"
  slots       TEXT NOT NULL,                 -- JSON array of "HH:MM" 24h strings, e.g. "[\"17:30\",\"18:00\"]"
  map_url     TEXT,                          -- EN/default route-map link/button shown inside the guest confirmation email; NULL until owner fills it in.
                                              -- See also map_url_nl, added by migrations/0012: the separate DUTCH map,
                                              -- linked instead for bookings with locale='nl' (falls back to map_url when NULL)
  active      INTEGER NOT NULL DEFAULT 1,    -- 1 = bookable, 0 = hidden everywhere (guest + admin still see history)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bookings (
  id                    TEXT PRIMARY KEY,           -- crypto.randomUUID(), generated by the Worker
  route_id              TEXT NOT NULL REFERENCES routes(id),
  date                  TEXT NOT NULL,              -- 'YYYY-MM-DD'
  slot                  TEXT NOT NULL,               -- 'HH:MM' 24h
  party                 INTEGER NOT NULL,             -- 1..route.max_party
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT,
  locale                TEXT NOT NULL DEFAULT 'en',     -- 'en' | 'nl'
  marketing_opt_in      INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'hold',     -- see status machine below
  stripe_session         TEXT,                             -- Checkout Session id (cs_...)
  stripe_payment_intent   TEXT,                              -- filled on confirm; used for refunds/CAPI
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  hold_expires             TEXT                               -- ISO datetime; NULL once confirmed/cancelled
);

-- status machine: hold -> confirmed | expired | cancelled
--                 hold -> confirmed_conflict  (rare edge case, see §5.5)
-- 'hold' is the ONLY status that ever counts toward capacity together with 'confirmed'.

CREATE INDEX idx_bookings_avail   ON bookings (route_id, date, slot, status, hold_expires);
CREATE INDEX idx_bookings_session ON bookings (stripe_session);
CREATE INDEX idx_bookings_expiry  ON bookings (status, hold_expires);
CREATE INDEX idx_bookings_date    ON bookings (date);

CREATE TABLE routes_bars (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id       TEXT NOT NULL REFERENCES routes(id),
  ord            INTEGER NOT NULL,           -- stop order: 1, 2, 3...
  bar_name       TEXT NOT NULL,
  bar_email      TEXT NOT NULL,
  minutes_offset INTEGER NOT NULL DEFAULT 0  -- minutes after the booked slot time this bar expects guests
);

CREATE INDEX idx_routes_bars_route ON routes_bars (route_id, ord);

CREATE TABLE date_overrides (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id  TEXT NOT NULL REFERENCES routes(id),
  date      TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  action    TEXT NOT NULL,                    -- 'closed' | 'alternate_bars' | 'extra_slot' | 'remove_slot' | 'capacity_override'
  payload   TEXT,                             -- JSON, meaning depends on action (see §7.4)
  UNIQUE(route_id, date, action)
);

CREATE INDEX idx_overrides_lookup ON date_overrides (route_id, date);

CREATE TABLE settings (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- Addition beyond the owner's 5 named tables, required for correctness (owner requirement #4:
-- "dedupes retries"). Kept minimal — one row per Stripe event ID ever processed.
CREATE TABLE webhook_events (
  id           TEXT PRIMARY KEY,      -- Stripe event id, e.g. 'evt_1Nx...'
  type         TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Seed migration `migrations/0002_seed_routes.sql` — real WOGO data pulled from the live route pages in this repo (`amsterdam/`, `utrecht/`, `groningen/`, `rotterdam/*/`). Fields marked **PLACEHOLDER** below are not publicly stated on the site and must be confirmed/edited by Maroussia in the admin Route Manager before go-live — the migration seeds *something sane* so the system is immediately testable, it does not need a redeploy to fix.

```sql
-- migrations/0002_seed_routes.sql

INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, map_url, active) VALUES
  ('amsterdam',                'WOGO Cocktail Walk Amsterdam',                 'Amsterdam', 2995, 10, 6, '[4,5,6]',       '["17:30","18:00","18:30","19:00","19:30","20:00"]', NULL, 1),
  ('utrecht',                  'WOGO Cocktail Walk Utrecht',                   'Utrecht',   2995, 10, 6, '[1,2,3,4,5,6,7]', '["17:30"]',                                         NULL, 1),
  ('groningen',                'WOGO Cocktail Walk Groningen',                 'Groningen', 2995, 10, 6, '[3,4,5,6]',       '["17:00","17:30","18:00","18:30","19:00","19:30","20:00"]', NULL, 1),
  ('rotterdam-witte-de-with',  'Rotterdam Route 1 · Witte de With',            'Rotterdam', 2995, 10, 6, '[4,5,6]',       '["17:00"]',                                         NULL, 1),
  ('rotterdam-hidden-gems',    'Rotterdam Route 2 · Hidden Gems (best seller)','Rotterdam', 2995, 10, 6, '[4,5,6]',       '["18:00","18:30","19:00","19:30","20:00","20:30"]', NULL, 1),
  ('rotterdam-premium-gin',    'Rotterdam Premium · High-end Bars',            'Rotterdam', 3495, 10, 6, '[2,3,4,5,6]',   '["17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:30"]', NULL, 1);

-- PLACEHOLDER bar rows — real bar names/emails are intentionally not published on the site
-- ("a surprise until you book"), so they cannot be pulled from public pages. Default 75-min
-- stagger per BACKEND-PLAN.md §7. Maroussia MUST replace bar_name/bar_email via
-- Admin → Route manager → Bars before real bookings go out, or the arrival emails go nowhere useful.
INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset)
SELECT r.id, b.ord, b.bar_name, 'bookings@wogoamsterdam.com', b.minutes_offset
FROM routes r
JOIN (
  SELECT 1 AS ord, 'Bar 1 (TBD — set real name/email)' AS bar_name, 0   AS minutes_offset UNION ALL
  SELECT 2,        'Bar 2 (TBD — set real name/email)',              75 UNION ALL
  SELECT 3,        'Bar 3 (TBD — set real name/email)',             150
) b;

-- Amsterdam's known first bar (from the live page's schema.org itinerary) is the one real
-- name available publicly — seed it, leave bars 2/3 as the surprise they're marketed as.
UPDATE routes_bars SET bar_name = 'Van de Werf (NDSM wharf)'
WHERE route_id = 'amsterdam' AND ord = 1;
```

---

## 3. Secrets (never in the repo)

Set with `npx wrangler secret put <NAME>` from her Mac, one time each. They live encrypted in her Cloudflare account, injected into `env` at runtime — never written to any file, never visible in `wrangler.toml`, never sent to the browser.

| Secret | Used by | Where to get it |
|---|---|---|
| `STRIPE_SECRET_KEY` | `stripe.js` → create Checkout Sessions | Stripe Dashboard → Developers → API keys (use the **live** key only once tested with a **test** key) |
| `STRIPE_WEBHOOK_SECRET` | `webhook.js` → verify `Stripe-Signature` | Stripe Dashboard → Developers → Webhooks → the endpoint's "Signing secret" (`whsec_...`) |
| `BREVO_API_KEY` | `brevo.js` → send transactional email | Brevo → Settings → SMTP & API → API Keys |
| `ADMIN_TOKEN` | `auth.js` → login password check | Generate once: `openssl rand -base64 32`. This IS her admin password — store it in a password manager, not in chat. |
| `ADMIN_SESSION_SECRET` | `auth.js` → HMAC-sign session cookies | Generate once: `openssl rand -base64 32`. Separate from `ADMIN_TOKEN` on purpose (rotating one doesn't invalidate the other's logic). |
| `CRON_SECRET` | `webhook.js`/`index.js` → guards the manual `/internal/cron/expire-holds` HTTP fallback (§10, §11) | Generate once: `openssl rand -base64 32`. |
| `META_ACCESS_TOKEN` | `meta.js` → Conversions API (stub) | **Not yet issued.** Leave unset; `meta.js` no-ops safely until it exists. TODO for Maroussia: Meta Events Manager → Pixel `652971109400692` → Settings → Conversions API → generate token. |

Non-secret config (Pixel ID, Brevo template IDs, CORS allowlist, default capacity/max-party) lives in `src/config.js` as plain constants — nothing in that file is sensitive, so it's fine in the repo and editable without touching secrets.

---

## 4. `wrangler.toml`

```toml
name = "wogo-booking-backend"
main = "src/index.js"
compatibility_date = "2026-07-01"
# No compatibility_flags needed — the Worker uses only Web-standard APIs
# (fetch, Web Crypto, URL, Response) and D1's native binding. No Node-only
# APIs anywhere in src/, so no nodejs_compat flag required. This keeps the
# code portable (see PORTABILITY.md).

[[d1_databases]]
binding = "DB"
database_name = "wogo-bookings"
database_id = "REPLACE_AFTER_RUNNING_wrangler_d1_create"

[triggers]
crons = ["*/5 * * * *"]   # sweeps expired holds; correctness does NOT depend on this (see §7.2)

[vars]
ENVIRONMENT = "production"
```

Local dev uses `npx wrangler dev` which runs a local D1 (SQLite file under `.wrangler/`) — apply migrations with `--local` first. Secrets for local dev go in a gitignored `.dev.vars` file (`wrangler` reads it automatically); add `.dev.vars` to `.gitignore`.

---

## 5. Guest API (`/api/*`) — the widget's contract

All responses `Content-Type: application/json`. All error responses share one shape: `{ "error": "<machine_code>", "message": "<human string>" }`. CORS: `Access-Control-Allow-Origin` echoed only if the request `Origin` is in `config.ALLOWED_ORIGINS` (`https://www.wogococktailwalk.com`, `https://wogococktailwalk.com`, `https://wogococktailwalk.github.io`, plus `http://localhost:*` in dev); `OPTIONS` preflight handled for all `/api/*` routes.

### 5.1 `GET /api/routes`

Lists bookable routes for the widget's route picker (only needed if a page embeds a multi-route picker; a single-route page just hardcodes its `route_id` in the widget's HTML attribute).

- **Params:** none.
- **Response `200`:**
```json
{
  "routes": [
    { "id": "amsterdam", "name": "WOGO Cocktail Walk Amsterdam", "city": "Amsterdam",
      "price_cents": 2995, "max_party": 6, "map_url": null }
  ]
}
```
Only `active = 1` routes are returned.

### 5.2 `GET /api/availability`

Drives the **month grid** — which days get an "open" dot vs "closed"/"sold out" styling. One call per month view.

- **Params (query string):** `route` (required, route id) · `month` (required, `YYYY-MM`).
- **Response `200`:**
```json
{
  "route_id": "amsterdam",
  "month": "2026-08",
  "days": {
    "2026-08-06": "open",
    "2026-08-07": "closed",
    "2026-08-08": "soldout"
  }
}
```
  Only dates that are calendar-valid AND within `[today, today+90 days]` are included; dates before today or beyond the booking horizon are simply absent (widget treats absent = not selectable). A day is `"closed"` if its weekday isn't in `open_days`, or a `date_overrides` row with `action='closed'` exists for it. Otherwise `"soldout"` if every valid slot that date has `seats_left = 0`, else `"open"`.
- **Errors:** `400 {error:"bad_request"}` missing/invalid params · `404 {error:"route_not_found"}`.

### 5.3 `GET /api/slots`

Drives the **timeslot list** after a day is tapped.

- **Params:** `route` (required) · `date` (required, `YYYY-MM-DD`).
- **Response `200`:**
```json
{
  "route_id": "amsterdam",
  "date": "2026-08-06",
  "closed": false,
  "slots": [
    { "slot": "17:30", "capacity": 10, "seats_left": 10 },
    { "slot": "18:00", "capacity": 10, "seats_left": 3 },
    { "slot": "18:30", "capacity": 10, "seats_left": 0 }
  ]
}
```
  `slots` = route's normal `slots` for that weekday, **minus** any `remove_slot` override, **plus** any `extra_slot` override for that date, sorted chronologically. `capacity` is resolved per-timeslot via the four-level precedence in **§7.6** (route default → route's per-slot default → date-wide override → date+slot override), not just the flat route capacity. `seats_left = capacity − Σparty` over bookings with `status='confirmed'` OR (`status='hold'` AND `hold_expires > now`). If `closed:true`, `slots` is `[]`. Nothing about this response shape changed for §7.6 — the widget already reads `capacity`/`seats_left` per slot, so per-timeslot capacity "just works" for the guest calendar with zero widget changes (verified: `widget/wogo-calendar.js` never reads `route.capacity` directly, only each slot's own `capacity`/`seats_left`).
- **Errors:** `400`, `404 route_not_found`.

### 5.4 `POST /api/book`

The one write call the widget makes. Internally does hold-creation *and* Stripe Checkout Session creation as one call so the widget only needs one round trip before redirecting the guest to Stripe.

- **Body (JSON):**
```json
{
  "route_id": "amsterdam", "date": "2026-08-06", "slot": "18:00", "party": 3,
  "name": "Anna de Vries", "email": "anna@example.com", "phone": "+31612345678",
  "notes": "Nut allergy, celebrating a birthday",
  "locale": "en", "marketing_opt_in": true
}
```
  `notes` (migrations/0010) is OPTIONAL free text — the widget's "Allergies or notes" textarea. Validated by `logic.js:validateNotes` (trimmed; max 500 chars; control characters rejected; blank ⇒ stored as `NULL`) and treated as untrusted on every output: `src/emails.js` HTML-escapes it into the guest echo, the owner notification, and the bar email's prominent "⚠️ Allergies / notes" block; the admin dashboard renders it via `textContent`. The GDPR retention sweep wipes it together with name/email/phone.
- **Response `200`:**
```json
{ "booking_id": "b_9f2c...", "checkout_url": "https://checkout.stripe.com/c/pay/cs_test_..." }
```
  Widget does `window.location.href = checkout_url`.
- **Errors:**
  - `400 {error:"bad_request", message:"..."}` — missing field, `party` not an integer 1..max_party, date not `YYYY-MM-DD`, invalid email shape.
  - `404 {error:"route_not_found"}`.
  - `409 {error:"sold_out", seats_left:N}` — the atomic capacity guard rejected the hold (see §6). Widget re-fetches `/api/slots` to refresh the displayed numbers and shows "sorry, only N left" or "sold out."
  - `409 {error:"route_closed"}` — date has a `closed` override or falls outside `open_days`.
  - `502 {error:"payment_setup_failed"}` — the D1 hold was created but the Stripe API call failed. The hold still exists and will silently expire in 15 minutes freeing the seat; widget shows a generic "something went wrong, try again" and the guest can retry (a fresh hold attempt).

### 5.5 Internal server-side sequencing of `POST /api/book`

1. Validate input shape (reject fast, no DB hit).
2. `db.createHold(...)` — the single atomic `INSERT ... SELECT ... WHERE` statement from §6. If `meta.changes !== 1`, run `db.diagnoseHoldFailure(...)` (read-only) to pick the right error code (`sold_out` vs `route_closed` vs `party_too_large`) and return it.
3. On success, call `stripe.createCheckoutSession(env, booking)` (§8.1).
4. On Stripe success: `db.attachStripeSession(bookingId, sessionId)` (simple `UPDATE ... WHERE id=? AND status='hold'`), return `{booking_id, checkout_url}`.
5. On Stripe failure: leave the hold as-is (do **not** delete it — deleting would need another write; the 15-min expiry is the cleanup), return `502`.

---

## 6. The atomic hold pattern — how overbooking is made impossible

This is the load-bearing part of the whole system (owner requirement #2). The guarantee: **under any number of simultaneous requests for the last seat, at most `capacity` seats are ever held for a given `(route_id, date, slot)`.**

### 6.1 Why a single SQL statement, not "read-then-write"

D1 (like all SQLite) serializes writes to a given database — only one write transaction commits at a time. The classic bug is doing the capacity check as a **separate** read, then a **separate** write: two requests can both read "2 seats left, party of 2, OK" before either has written, and both insert — now it's oversold. The fix is to make the check part of *the same statement* as the write, so there's no gap for another request to land in. `db.js` implements this as one `INSERT ... SELECT ... WHERE <guard>` — SQLite guarantees a single statement's read and write happen as one atomic unit; nothing can interleave inside it.

### 6.2 The exact statement (`db.js: createHold`)

```sql
INSERT INTO bookings
  (id, route_id, date, slot, party, name, email, phone, locale, marketing_opt_in, status, created_at, hold_expires)
SELECT
  :id, :route_id, :date, :slot, :party, :name, :email, :phone, :locale, :marketing_opt_in,
  'hold', datetime('now'), :hold_expires
WHERE
  -- 1. party size fits the route's per-booking cap
  :party <= (SELECT max_party FROM routes WHERE id = :route_id AND active = 1)

  -- 2. the date isn't closed via override
  AND NOT EXISTS (
    SELECT 1 FROM date_overrides
    WHERE route_id = :route_id AND date = :date AND action = 'closed'
  )

  -- 3. the slot isn't hidden for this date via a remove_slot override
  AND NOT EXISTS (
    SELECT 1 FROM date_overrides
    WHERE route_id = :route_id AND date = :date AND action = 'remove_slot'
      AND json_extract(payload, '$.slot') = :slot
  )

  -- 4. capacity check: existing confirmed + still-live holds + this new party
  --    must not exceed the (possibly overridden) capacity for this date
  AND (
    (SELECT COALESCE(SUM(party), 0) FROM bookings
      WHERE route_id = :route_id AND date = :date AND slot = :slot
        AND (status = 'confirmed' OR (status = 'hold' AND hold_expires > datetime('now')))
    ) + :party
  ) <= COALESCE(
    (SELECT CAST(json_extract(payload, '$.capacity') AS INTEGER) FROM date_overrides
      WHERE route_id = :route_id AND date = :date AND action = 'capacity_override'),
    (SELECT capacity FROM routes WHERE id = :route_id)
  );
```

`db.js` runs this via `env.DB.prepare(SQL).bind(...).run()` and checks `result.meta.changes`. `changes === 1` → hold created, return the booking row. `changes === 0` → nothing was written (the whole point); `db.js` then runs three cheap read-only queries to figure out *which* guard clause failed, purely to return a helpful error code — this diagnostic path only runs on the rare "someone just took the last seat" case, so it costs nothing on the hot path.

`hold_expires` is computed by the caller as `new Date(Date.now() + 15*60*1000).toISOString()` (15 minutes — owner requirement #7) and passed in as a bound parameter; `db.js` itself has no clock logic, keeping it trivially testable.

### 6.3 Confirming a hold (`db.js: confirmBooking`, called from the webhook)

The capacity was already reserved when the hold was created — confirming just flips status, it never re-runs the capacity guard **except** in the one edge case below.

```sql
-- normal path: booking is still an unexpired hold
UPDATE bookings
SET status = 'confirmed', stripe_session = :session_id, stripe_payment_intent = :pi_id, hold_expires = NULL
WHERE id = :id AND status = 'hold';
```
If `changes === 1`, done. If `changes === 0`, the booking wasn't in `status='hold'` anymore — either it's already `confirmed` (duplicate webhook, handled by the `webhook_events` dedupe before this ever runs), or it's `expired` (see §6.4).

### 6.4 The Stripe-minimum-vs-15-minute-hold edge case (name it, don't hide it)

Stripe requires a Checkout Session's `expires_at` to be **at least 30 minutes** in the future — it cannot be set to match our 15-minute internal hold. So there is an honest ~15-minute window where a guest's Stripe payment page is still technically payable after their D1 hold has expired and the seat may have been resold. `db.js` handles it explicitly:

```sql
-- conflict path: the hold already expired (or was swept by cron) — try to re-reserve
-- atomically, exactly like createHold's guard, but as an UPDATE on the existing row.
UPDATE bookings
SET status = 'confirmed', stripe_session = :session_id, stripe_payment_intent = :pi_id, hold_expires = NULL
WHERE id = :id AND status = 'expired'
  AND (
    (SELECT COALESCE(SUM(party), 0) FROM bookings
      WHERE route_id = (SELECT route_id FROM bookings WHERE id = :id)
        AND date = (SELECT date FROM bookings WHERE id = :id)
        AND slot = (SELECT slot FROM bookings WHERE id = :id)
        AND id != :id
        AND (status = 'confirmed' OR (status = 'hold' AND hold_expires > datetime('now')))
    ) + (SELECT party FROM bookings WHERE id = :id)
  ) <= (SELECT capacity FROM routes WHERE id = (SELECT route_id FROM bookings WHERE id = :id));
```
If this also returns `changes === 0`, the seat truly is gone: `webhook.js` sets `status = 'confirmed_conflict'` (guest paid, seat unavailable), still sends the guest their confirmation email (they paid — don't leave them hanging), and sends an **owner alert email** via Brevo ("double-booked: booking `b_...`, refund or find an alternate slot") for Maroussia to resolve by hand (offer another slot or refund via the Stripe dashboard). This path is rare by design (it needs a fully-sold-out slot to be re-emptied-and-refilled inside a 15-minute gap) but must exist and must be tested (`test/db.test.js` includes it explicitly).

**Mitigation to shrink the window:** `stripe.js` sets `expires_at` to exactly Stripe's minimum (`now + 30 min`), not longer — the smallest gap Stripe allows.

### 6.5 Freeing seats — `expireHolds` (used by both cron and the manual fallback)

```sql
UPDATE bookings SET status = 'expired'
WHERE status = 'hold' AND hold_expires <= datetime('now');
```
Note this is **housekeeping, not a correctness dependency** — §6.2's guard already excludes `hold` rows whose `hold_expires <= now` from the capacity sum in real time, so a new booking can use a freed seat even if the cron hasn't run yet. The sweep exists so the admin dashboard doesn't show stale "hold" rows forever and so CSV exports / participants-per-hour aren't cluttered with abandoned carts.

---

## 7. Admin data operations

### 7.1 Filtered bookings list (`db.js: listBookings`)

```sql
SELECT b.*, r.name AS route_name, r.city
FROM bookings b JOIN routes r ON r.id = b.route_id
WHERE 1=1
  [AND b.route_id = :route]
  [AND r.city = :city]
  [AND b.date >= :date_from]
  [AND b.date <= :date_to]
  [AND b.status = :status]
  [AND (b.name LIKE '%'||:q||'%' OR b.email LIKE '%'||:q||'%')]
ORDER BY b.date DESC, b.slot DESC
LIMIT :limit OFFSET :offset;
```
Bracketed clauses are appended only when that filter param is present (built in `db.js`, still fully parameterized — no string-interpolated user values, ever).

### 7.2 Participants-per-hour (`db.js: participantsPerHour`)

```sql
SELECT b.route_id, r.name AS route_name, b.slot, SUM(b.party) AS guests, COUNT(*) AS bookings
FROM bookings b JOIN routes r ON r.id = b.route_id
WHERE b.date = :date
  AND (b.status = 'confirmed' OR (b.status = 'hold' AND b.hold_expires > datetime('now')))
  [AND b.route_id = :route]
GROUP BY b.route_id, b.slot
ORDER BY b.slot;
```
`logic.js` exposes a pure `buildHourBars(rows)` that turns this result set into `{ slot, route_name, guests, pct }[]` (pct = guests / max(guests) across the set, for bar-chart width) — kept in `logic.js` so it's unit-testable without a DB.

### 7.3 Route manager operations

- **Add a new tour:** `POST /admin/api/routes` → `INSERT INTO routes (...)`. Body validated: `id` must be a unique lowercase-kebab slug, `open_days` a JSON array of ints 1-7, `slots` a JSON array of `HH:MM` strings, optional `slot_capacity` (see §7.6).
- **Edit days/slots/capacity/max-party/price/map_url/map_url_nl/slot_capacity:** `PUT /admin/api/routes/:id` → partial `UPDATE routes SET <only provided columns> WHERE id = :id`. (`map_url` = English/default route map, `map_url_nl` = Dutch route map, migrations/0012 — both live side by side on the add/edit-route form.)
- **Open/close a specific date:** `POST /admin/api/date-overrides` body `{route_id, date, action:'closed'}` → `INSERT OR REPLACE INTO date_overrides (route_id, date, action, payload) VALUES (?, ?, 'closed', NULL)`. Reopen: `DELETE FROM date_overrides WHERE id = :id` (id returned by the list endpoint) or `DELETE ... WHERE route_id=? AND date=? AND action='closed'`.
- **Bars per route:** `GET/POST/PUT/DELETE /admin/api/routes/:id/bars` → straight CRUD on `routes_bars`, ordered by `ord`.
- **Day-specific alternate bars:** same `date_overrides` mechanism, `action='alternate_bars'`, `payload = JSON.stringify([{bar_name, bar_email, minutes_offset}, ...])` — checked first by `logic.js: computeBarArrivals` (§9.2) before falling back to the route's default `routes_bars` rows.

### 7.4 `date_overrides.payload` shapes by action

| action | payload JSON | effect |
|---|---|---|
| `closed` | `null` | date unbookable, no slots shown |
| `remove_slot` | `{"slot":"18:00"}` | that one slot hidden for that date only |
| `extra_slot` | `{"slot":"21:00","capacity":10}` | one-off extra departure added for that date (`capacity` optional, defaults to route capacity) |
| `capacity_override` | `{"capacity":6}` | overrides seats-per-departure for ALL slots that date (e.g. a bar has limited seats one night) |
| `slot_capacity_override` | `{"20:00":4,"19:00":6}` | **NEW, §7.6.** overrides seats for ONLY the named slot(s) that date — everything else that date keeps whatever `capacity_override`/`route.slot_capacity`/`route.capacity` would otherwise give it. `0` shows that slot as "0 seats left" (soldout) without hiding it — use `remove_slot` instead to hide it entirely. **Replaces the whole map** for `(route_id, date)` on every write — same `INSERT OR REPLACE` semantics as every other action here — so a caller adding a second slot's override must resubmit the full map (existing entries + the new one), exactly like the "Save bars" bulk-replace pattern. |
| `alternate_bars` | `[{"bar_name":"...","bar_email":"...","minutes_offset":0}, ...]` | replaces the default `routes_bars` list for that date only |

### 7.5 CSV export

`GET /admin/api/bookings.csv?<same filters as §7.1>` — `admin_api.js` runs the same `listBookings` query with a high `LIMIT` (e.g. 10000), builds a CSV string (`logic.js: toCsv(rows, columns)` — pure function, testable), returns `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="wogo-bookings-<today>.csv"`. Columns: `id, route_name, city, date, slot, party, name, email, phone, status, stripe_session, created_at`.

### 7.6 Per-timeslot capacity (`migrations/0003_slot_capacity.sql`)

**Owner requirement:** capacity must be editable **per timeslot**, not just per route — e.g. Rotterdam Route 2 defaults to 10 seats/departure, but its 20:00 slot only ever has 6 (a bar is busy at that hour); and a specific date's 20:00 departure might need to drop to 4, or close, without touching any other slot or any other date.

**Schema decision (routes.slots JSON vs. a new column):** `routes.slots` stays exactly what it's always been — a flat JSON array of `"HH:MM"` strings, so the day-of-week open/slots UI and every existing consumer of that column are untouched. Per-slot *capacity* is a separate concern from *which times exist*, so it gets its own new column rather than mutating `slots`' shape into `[{slot, capacity}, ...]` (which would have forced every reader — the widget's request-shape assumptions, the seed migration, the admin route-details form — to change). One `ALTER TABLE`:

```sql
-- migrations/0003_slot_capacity.sql
ALTER TABLE routes ADD COLUMN slot_capacity TEXT NOT NULL DEFAULT '{}';
```

`slot_capacity` is a JSON object `{ "HH:MM": capacity, ... }` — this route's per-slot capacity *default*, independent of date. A slot absent from the map falls back to `routes.capacity`. Default `'{}'` means every existing route behaves byte-for-byte as before the migration.

Date-level per-slot overrides need **no schema change at all** — they're the new `date_overrides.action = 'slot_capacity_override'` row documented in §7.4, using the table's existing free-text `action` column and JSON `payload` column exactly like every other action.

**Precedence — four levels, highest to lowest specificity** (implemented once in `logic.js: buildSlotsForDate` §9.3, and mirrored in `db.js`'s atomic `createHold` guard via the shared `effectiveCapacitySql()` SQL-fragment builder — both must agree, or the guest-facing `seats_left` number and the no-overbook guarantee could disagree):

1. **date+slot override** — `date_overrides` row `(route, date, 'slot_capacity_override')`, only the slot(s) named in its payload.
2. **date-wide override** — `date_overrides` row `(route, date, 'capacity_override')`, existing/unchanged, every slot that date.
3. **route's per-slot default** — `routes.slot_capacity[slot]`, every date.
4. **route-wide default** — `routes.capacity`, existing/unchanged.

Each level only fills in what the level(s) above it didn't already decide — e.g. a date-wide override of 6 seats plus a date+slot override of 4 for `20:00` means `20:00` gets 4 and every other slot that date gets 6, even if `routes.slot_capacity` said `20:00` should default to 8 on every other date.

**Atomicity:** `db.js`'s `CREATE_HOLD_SQL` resolves this same four-level `COALESCE` chain **inside** the single atomic `INSERT ... SELECT ... WHERE` statement (§6.2) — the no-overbooking guarantee holds against whichever capacity number is *lowest* in the chain for that exact `(route, date, slot)`, not just against `routes.capacity`. The §6.4 conflict-recovery `UPDATE` uses the identical SQL fragment (via subqueries on the booking's own `route_id`/`date`/`slot`) so a stale Stripe payment can never re-confirm past a capacity that's since been tightened.

**Admin surface — no new endpoints, existing ones extended:**
- Route-level per-slot defaults: `PUT /admin/api/routes/:id` body may now include `slot_capacity` (a JSON-object string, validated: HH:MM keys, non-negative integer values) — same endpoint used for capacity/max_party/etc. Admin UI: each time-chip in the route's "Start times" editor has an inline seats input; blank = no override.
- Date+slot overrides: `POST /admin/api/date-overrides` with `action: 'slot_capacity_override'` — same endpoint used for `closed`/`capacity_override`/etc., validated with the same HH:MM/non-negative-integer rule. Admin UI, two ways in: (a) the Route manager "Date overrides" panel has a "Cap one slot" option taking `slot=seats` pairs (e.g. `20:00=4, 19:00=6`); (b) the **Participants-per-hour** view (single route selected) lets her tap any departure on a given date and set/close/reset its seats directly — the visual, date-first path (§12.2). Both submit the same whole-map payload; the tap-to-edit path merges into the existing map so she never has to retype the other slots.

**Guest-facing surface — unverified assumption checked, confirmed correct:** `GET /api/slots` and `GET /api/availability` already compute `capacity`/`seats_left` per slot by calling `db.getSlotsWithSeatsLeft` → `logic.js: buildSlotsForDate`, which is the one function this feature extends — so both endpoints automatically return the effective (possibly overridden) capacity with **zero changes to `guest_api.js`**. `widget/wogo-calendar.js` was checked line-by-line for any hardcoded reliance on `route.capacity`: it has none — every seats-left/soldout/capacity decision in the widget reads the per-slot `capacity`/`seats_left` fields from the API response. The guest calendar reflects per-timeslot capacity automatically.

---

## 8. External services

### 8.1 Stripe Checkout (`src/stripe.js`)

No SDK — Workers-safe raw `fetch` against Stripe's REST API (form-encoded body, exactly how `stripe-node` does it under the hood; avoiding the SDK keeps the project zero-dependency and Node-API-free).

```js
export async function createCheckoutSession(env, booking, route) {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('client_reference_id', booking.id);
  body.set('customer_email', booking.email);
  body.set('success_url', `${SITE_URL}/booking-confirmed/?session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url', `${SITE_URL}${routePathFor(route)}`);
  body.set('allow_promotion_codes', 'true');
  body.set('expires_at', String(Math.floor(Date.now() / 1000) + 30 * 60)); // Stripe minimum = 30 min
  body.set('metadata[booking_id]', booking.id);
  body.set('payment_intent_data[metadata][booking_id]', booking.id);
  ['card', 'ideal', 'klarna'].forEach((t, i) => body.set(`payment_method_types[${i}]`, t));
  body.set('line_items[0][quantity]', String(booking.party));
  body.set('line_items[0][price_data][currency]', 'eur');
  body.set('line_items[0][price_data][unit_amount]', String(route.price_cents));
  body.set('line_items[0][price_data][product_data][name]', `${route.name} — ${booking.date} ${booking.slot}`);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`stripe_checkout_failed: ${res.status}`);
  return res.json(); // { id: 'cs_...', url: 'https://checkout.stripe.com/...' }
}
```
Apple Pay/Google Pay auto-enable on the `card` payment method once the domain is verified in the Stripe dashboard (Settings → Payment methods → Apple Pay → add domain `www.wogococktailwalk.com`) — a one-time dashboard step, no code.

### 8.2 Webhook signature verification (`src/stripe.js: verifyStripeSignature`)

Workers **can** verify Stripe signatures — this must use the async Web Crypto pattern (no `stripe-node`, which needs Node's `crypto` module):

```js
export async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  const timestamp = Number(parts.t);
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) throw new Error('malformed_signature');

  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > toleranceSeconds) throw new Error('signature_too_old');

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signedPayload = `${timestamp}.${rawBody}`;
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computedSig = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');

  if (!timingSafeEqualHex(computedSig, expectedSig)) throw new Error('signature_mismatch');
  return true;
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```
`webhook.js` must read the request body as **raw text first** (`await request.text()`) — never `request.json()` before verifying — since the signature is computed over the exact raw bytes.

### 8.3 `POST /webhooks/stripe` — full handler flow

1. `rawBody = await request.text()`; `sig = request.headers.get('stripe-signature')`.
2. `await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET)` → on failure, return `400` (do **not** touch the DB).
3. `event = JSON.parse(rawBody)`.
4. Dedupe: `INSERT INTO webhook_events (id, type) VALUES (:id, :type)` wrapped so a duplicate primary key is caught and treated as "already handled" → return `200` immediately without re-running side effects. (SQLite `INSERT` on an existing PK throws — `db.js` catches the constraint error specifically and returns a `duplicate` flag rather than throwing.)
5. Switch on `event.type`:
   - `checkout.session.completed` → `bookingId = event.data.object.client_reference_id`; run §6.3/§6.4 confirm logic; on success, **fire side effects** (§8.4 emails + §8.5 Meta CAPI) — wrapped in `try/catch` per side effect so one failing send doesn't block the others or fail the webhook ack (log failures to `console.error`; a future iteration could add a `notifications_sent` column and a retry sweep, noted as a v2 improvement, not required now).
   - `checkout.session.expired` → mark the booking `cancelled` if still `hold` (best-effort early release; the 15-min hold_expires would catch it anyway).
   - anything else → ignore, still return `200` (Stripe expects 2xx for any event type it sends, known or not).
6. Always return `200` once the event is durably recorded in `webhook_events`, even if a downstream email failed — Stripe should not retry an event we've already processed.

### 8.4 Brevo transactional email (`src/brevo.js`)

```js
export async function sendTransactional(env, { to, templateId, params }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: [{ email: to }], templateId, params }),
  });
  if (!res.ok) throw new Error(`brevo_send_failed: ${res.status} ${await res.text()}`);
}
```
> **Updated (Dashboard v2 + 2026-07-23 merge):** emails are no longer Brevo-dashboard templates — they're owned branded HTML rendered by `src/emails.js` and passed to Brevo as `htmlContent` (see DASHBOARD-V2-SPEC.md §4). And the guest's separate route-map email was **merged into the confirmation** (2026-07-23), so the current per-confirmed-booking send set is exactly:

1. **Guest confirmation (incl. route map)** — ONE email to the guest, EN/NL by `booking.locale`: booking details, the what's-included block, and a prominent "Open your route map" button + save-this-email note inside the same email. **The map link is language-matched (migrations/0012):** an NL booking gets `route.map_url_nl` (falling back to `map_url` when the Dutch map isn't set); every other locale gets `map_url` (the EN/default map). When neither URL is set the map section is simply omitted (console warning; no separate email either way).
2. **Owner "new booking" notification** — to `OWNER_NOTIFY_EMAIL`, `status === 'confirmed'` web bookings only (DASHBOARD-V2-SPEC.md §5).
3. **Per-bar arrival email** — one send per bar returned by `logic.js: computeBarArrivals(route, routesBars, dateOverrides, booking)` (§9.2), `to: bar_email`. Each carries ONLY that bar's own staggered arrival time (never the full itinerary) plus the guest's name and a clearly-labelled **"Guest contact"** row (email · phone when present) so the bar can reach the group directly that evening.
4. **Owner conflict alert** (only in the §6.4 conflict path) — to `OWNER_ALERT_EMAIL` (`info@wogoamsterdam.com`).

So a confirmed booking on a 3-bar route sends **5 emails total: 1 guest + 1 owner + 3 bars** (previously 6, when the route map was a separate guest email).

### 8.5 Meta Pixel CAPI (`src/meta.js`) — stub, clear TODO

```js
export async function sendPurchaseEvent(env, booking, route) {
  if (!env.META_ACCESS_TOKEN) {
    console.warn('META_ACCESS_TOKEN not set — skipping CAPI Purchase event. See SPEC.md §3.');
    return;
  }
  const emailHash = await sha256Hex(booking.email.trim().toLowerCase());
  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: `${SITE_URL}${routePathFor(route)}`,
      user_data: { em: [emailHash] },
      custom_data: { currency: 'EUR', value: (route.price_cents * booking.party) / 100 },
    }],
  };
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${config.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  if (!res.ok) console.error('meta_capi_failed', res.status, await res.text());
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
```
`config.META_PIXEL_ID = '652971109400692'` (already public — it's in the site's client-side pixel snippet).

---

## 9. `logic.js` — pure functions (no `env`, no `fetch`, no D1; runs under plain `node`)

This file is the one both a Node test suite and the Worker import identically — no platform calls of any kind. Exports:

### 9.1 `isDateBookable(route, dateOverrides, dateStr)` → `boolean`
Weekday of `dateStr` (`YYYY-MM-DD`) must be in `route.open_days` (JSON-parsed), AND no `date_overrides` row for that date with `action === 'closed'`.

### 9.2 `computeBarArrivals(route, routesBars, dateOverridesForDate, booking)` → `{bar_name, bar_email, arrival_time}[]`
If a `date_overrides` row with `action === 'alternate_bars'` exists for `booking.date`, use its `payload` array **instead of** `routesBars` (owner requirement #9: overrides checked first). Otherwise use `routesBars` sorted by `ord`. For each bar, `arrival_time = addMinutes(booking.slot, bar.minutes_offset)` (`"18:00"` + `75` → `"19:15"`, wrapping correctly past midnight if ever needed).

### 9.3 `buildSlotsForDate(route, dateOverridesForDate, date)` → `{slot, capacity}[]`
Starts from `route.slots`; removes any slot matching a `remove_slot` override; adds any `extra_slot` override. Each slot's `capacity` is resolved through the four-level precedence from §7.6 (`route.slot_capacity[slot]` as the per-slot default, overridden by a date-wide `capacity_override`, overridden by a date+slot `slot_capacity_override` — see §7.6 for the full chain and worked examples); sorted chronologically. (`db.js` then annotates each with `seats_left` from a live query — that part isn't pure, stays in `db.js`.)

### 9.4 `buildMonthAvailability(route, dateOverridesInMonth, slotSeatsLeftByDate, monthStr, today)` → `{ [date]: 'open'|'closed'|'soldout' }`
Pure aggregation given precomputed per-date seat data (the DB call happens in `db.js`; this function just turns raw numbers into the three-state map), bounded to `[today, today+90d]`.

### 9.5 `buildHourBars(participantsPerHourRows)` → normalized rows with a `pct` field for the admin bar chart (§7.2).

### 9.6 `toCsv(rows, columns)` → CSV string with correct quoting/escaping (commas, quotes, newlines inside fields).

### 9.7 `isHoldExpired(hold, nowIso)` → `boolean` — trivial, but pulled out as a pure predicate so `db.test.js` can assert the exact SQL's semantics match this function's semantics (both must agree: `hold_expires <= now`).

### 9.8 Test coverage required in `test/logic.test.js` (Node's built-in `node:test` + `node:assert`)
- `computeBarArrivals` — default order, minutes offsets, midnight wraparound, `alternate_bars` override takes priority.
- `buildSlotsForDate` — remove_slot, extra_slot, capacity_override, combinations of two at once; plus the full §7.6 per-timeslot precedence stack (`route.slot_capacity` default, date-wide override, date+slot override, and all four levels combined in one date).
- `buildMonthAvailability` — open/closed/soldout classification, horizon boundary (day 91 excluded, day 90 included), past dates excluded.
- `toCsv` — a field containing a comma, a quote, and a newline round-trips correctly.
- `isHoldExpired` — boundary at exactly `hold_expires === now`.

---

## 10. `db.js` — the only file that touches `env.DB`

Exports one function per operation named in §5–§7 (`createHold`, `confirmBooking`, `attachStripeSession`, `diagnoseHoldFailure`, `getAvailabilityMonth`, `getSlotsForDate`, `listBookings`, `participantsPerHour`, `expireHolds`, `recordWebhookEvent` (returns `{duplicate: bool}`), route/bar/override CRUD). Every function takes `db` (the `env.DB` binding, or the test adapter — see §11) as its first argument and returns plain JS objects/arrays, never a raw D1 result object, so callers never need to know they're talking to D1 specifically (this is also the seam PORTABILITY.md points to).

`expireHolds(db)` (§6.5) is called from **two** places with identical effect:
1. The Worker's `scheduled()` export (native Cloudflare Cron).
2. `POST /internal/cron/expire-holds`, guarded by header `X-Cron-Secret: <CRON_SECRET>` — an authenticated HTTP fallback that lets an external pinger (cron-job.org, a GitHub Actions scheduled workflow, anything) trigger the exact same sweep on a host without native cron. Not needed while on Cloudflare; exists for PORTABILITY.

---

## 11. Test suite (`test/`) — run with `node --test test/`, must be green

`test/sqlite-d1-adapter.js` wraps Node's built-in `node:sqlite` (`DatabaseSync`, available unflagged on Node ≥ 22 — confirmed working on this machine's Node v24) behind a **D1-shaped interface** with **strict D1 positional-binding semantics**:

```js
import { DatabaseSync } from 'node:sqlite';

export function makeTestDb(schemaSql) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(schemaSql); // the literal contents of migrations/0001_init.sql
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        _values: [],
        // STRICT: positional variadic only, exactly like real D1. Any value
        // that isn't null/Number/String/Boolean/ArrayBuffer — most importantly
        // an OBJECT of named params — throws the same D1_TYPE_ERROR
        // production raises.
        bind(...values) { this._values = values.map(validateD1Value); return this; },
        run() {
          const info = stmt.run(...this._values);
          return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        },
        all() { return { results: stmt.all(...this._values) }; },
        first() { return stmt.get(...this._values) ?? null; },
      };
    },
    batch(stmts) { return stmts.map(s => s.run()); },
  };
}
```

**Why strict (2026-07 production incident):** real D1 supports **only positional parameters** (`?` / `?N`) bound variadically — `.bind({ named: 'object' })` throws `D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'` in production. Node's `node:sqlite` happily accepts a named-params object, so a permissive adapter let every parameterized query pass 141 tests while failing on the very first live request. The adapter now **rejects object binding** with the identical `D1_TYPE_ERROR`, making that whole bug class impossible to ship again.

`src/db.js` keeps its readable named `:token` SQL and translates once, in its private `run`/`all`/`first` helpers, via the exported `toPositional(sql, paramsObj)`: each `:name` becomes `?N` (one index per distinct name — a name used several times in one statement binds once), `':'` inside string literals / quoted identifiers / `--` comments is never touched (e.g. the `'$."18:00"'` JSON paths), and any missing binding, unused binding, or `undefined` value **throws** rather than silently mismatching. The adapter (and production D1) only ever sees the translated positional form. `toPositional` has its own unit tests in `db.test.js`, plus tests asserting the adapter rejects object binds.

Because this runs against **real SQLite** (not a hand-rolled fake), the atomicity/concurrency tests in `db.test.js` are high-fidelity — they exercise the actual guard-clause SQL from §6.2, not a re-implementation of its intent — and because the adapter enforces real D1 binding semantics, the same `db.js` file runs unmodified against the adapter in tests and against `env.DB` in production.

Required scenarios:

- **`db.test.js`**
  - `createHold` succeeds up to exactly `capacity`, the `capacity+1`-th concurrent call fails with `changes === 0`. Simulated concurrency: since `node:sqlite` is synchronous, fire `capacity + 5` calls to `createHold` in a tight loop (no `await` between them) for the same `(route,date,slot)` and assert exactly `capacity` succeeded, by-seat-count (parties summing to exactly `capacity`, not by-call-count, since party size varies) and the rest returned `sold_out`.
  - A party size that alone exceeds `max_party` is rejected even with seats free.
  - A `closed` date_override blocks `createHold` even with seats free.
  - A `remove_slot` override blocks that one slot only.
  - A `capacity_override` is honored over the route's default capacity.
  - §7.6 per-timeslot precedence: a `route.slot_capacity` entry caps one slot below the route default while sibling slots are unaffected; a `slot_capacity_override` beats both `route.slot_capacity` and a same-date `capacity_override` for its named slot only; `slot_capacity_override` of `0` rejects any party on that slot/date (diagnosed as `sold_out`, `seats_left: 0`) while leaving other slots bookable; and — the load-bearing property — `createHold` never oversells past the *lowest* capacity number anywhere in the four-level chain, exercised with the same concurrent-call-loop technique as the plain `capacity` test above.
  - `expireHolds` flips only holds past `hold_expires`, leaves confirmed/future holds untouched.
  - `confirmBooking` normal path (§6.3) and the conflict path (§6.4): manually expire a hold, fill the seat with a second confirmed booking, then attempt to confirm the first (now-expired) one — assert it lands in `confirmed_conflict`, not `confirmed`.
  - `recordWebhookEvent` — first call for an id returns `{duplicate:false}`, second call same id returns `{duplicate:true}`, no side-effect functions invoked on the second.

- **`webhook.test.js`**
  - `verifyStripeSignature` accepts a correctly-computed fake signature (construct one with the same HMAC recipe using a test secret) and rejects: wrong secret, tampered body, timestamp older than tolerance, malformed header.
  - Full `handleWebhook` flow (with `db` = test adapter, `stripe`/`brevo`/`meta` calls mocked) — duplicate `event.id` short-circuits before any side effect runs.

- **`logic.test.js`** — see §9.8.

`package.json`:
```json
{
  "name": "wogo-booking-backend",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/" }
}
```
No dependencies, no devDependencies. `npm test` (or `node --test test/`) must exit 0 before this is considered done.

---

## 12. Admin dashboard (`/admin`, served by the Worker)

### 12.1 Auth (`src/auth.js`)

- `POST /admin/login` (public) — body `{token}` — constant-time compare against `env.ADMIN_TOKEN`. On match: issue cookie `wogo_admin=<payload_b64>.<sig_b64>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`, where `payload = {exp: nowSeconds + 43200}` and `sig = HMAC-SHA256(env.ADMIN_SESSION_SECRET, payload_b64)` (Web Crypto, same pattern as §8.2). On mismatch: `401 {error:"invalid_token"}` — no attempt-counting/lockout in v1 (the token is a 32-byte random secret, not a guessable password; Cloudflare Access is the documented upgrade if she ever wants a second layer, see §12.4).
- `POST /admin/logout` — clears the cookie.
- Every other `/admin*` and `/admin/api/*` route: `auth.requireSession(request, env)` reads the cookie, recomputes the HMAC, checks `exp > now`; on failure, `/admin/api/*` returns `401 {error:"unauthenticated"}`, plain `/admin*` page routes redirect (`302`) to `/admin/login`.
- State-changing admin API calls (`POST`/`PUT`/`DELETE`) additionally require header `X-Requested-With: wogo-admin` (cheap CSRF mitigation — the login page's own JS sets it; a cross-site form post can't).

### 12.2 Views (all client-side JS in `admin_html.js`, calling `/admin/api/*`; zero external CDNs, no charting library — bars are styled `<div>`s)

1. **Bookings** — table + a month/week calendar toggle, filters: route, city, date range, status, free-text search (name/email). Backed by §7.1. Row click → detail drawer (all booking fields, "resend confirmation email" action).
2. **Participants per hour** — date picker, route filter. With **all routes** selected: a horizontal bar per timeslot (bar length = guest count), stacked by route. With a **single route** selected: every departure that date is listed with its *effective* seats (the §7.6 four-level capacity), a guests/seats fill meter, "seats left", and an override badge (`Override` = a date+slot cap, `Date cap` = a date-wide cap, `Route default N` = the route's own per-slot default). Tapping a departure opens an inline editor to set that **date+slot's** seats, close just that departure (0 seats), or reset it to the route default — writing/clearing a `slot_capacity_override` (§7.4) via the existing `POST`/`DELETE /admin/api/date-overrides` endpoints (merging into the whole-map payload, deleting the row when its last entry is removed). Backed by §7.2/§9.5 plus a client-side read of `GET /admin/api/date-overrides` for the effective-capacity computation.
3. **Route manager** — list of all routes (active + inactive), "Add tour" form (§7.3), edit panel per route (days as day-of-week checkboxes, slots as an editable time-chip list, capacity, max_party, price, map_url, active toggle), a "Bars" sub-panel per route (ordered list, drag-to-reorder sets `ord`, add/remove/edit name+email+minutes_offset), a "Date overrides" sub-panel (calendar picker → choose action → fill payload form matching §7.4's shape).
4. **Export** — filter form identical to Bookings, "Download CSV" button hitting §7.5.

### 12.3 `preview/admin.html` and `preview/guest.html`

Static files with the exact same HTML/CSS/JS as `admin_html.js`/the widget, but with `fetch` calls intercepted by a small mock layer returning realistic fixture data (a handful of routes, a spread of bookings across today ± a few days, one soldout slot, one closed date, one date with an `alternate_bars` override) — so Maroussia can open the file directly in a browser (`file://`) and judge the look/feel with zero setup, before any Worker is deployed. These are throwaway preview shells, not code the Worker ever serves.

### 12.4 Optional hardening (documented, not built in v1)

Cloudflare Access (free for up to 50 users on her account) can be layered in front of `/admin/*` at the Cloudflare dashboard level — zero code change, adds a second login (Google/email OTP) before a request even reaches the Worker. Left as a documented option, not required, since the token+HMAC-cookie scheme is already "safe for one owner."

---

## 13. Guest widget (`widget/wogo-calendar.js` + `.css`)

- **The one constant:** `const WOGO_API = "";` at the top of `wogo-calendar.js`. Empty string ⇒ the widget's init function returns immediately without touching the DOM — **the route page's existing Wix "Book Now" button is left completely untouched**, so dropping this file onto a live page today changes nothing. Setting it to the deployed Worker URL (e.g. `https://api.wogococktailwalk.com`) is the one-line switch that activates it (§14 deployment last step).
- **Markup contract:** the widget looks for `<div class="wogo-calendar" data-route="amsterdam"></div>` wherever a page wants it, and renders itself inside. Language: reads `document.documentElement.lang` (already set per-page) or a `data-lang` attribute, falls back to `en`; ships its own `STRINGS = {en:{...}, nl:{...}}` dictionary matching the existing `data-i18n` phrasing style used across the site.
- **States:** `loading` (skeleton month grid), `open` (normal), `soldout` (day/slot shown struck-through, disabled, localized "sold out" label), `error` (network/5xx — localized "couldn't load availability, try again" with a retry button). All state text lives in an `aria-live="polite"` region so screen readers announce transitions.
- **Flow:** month grid (real `<button>` per open day, `aria-label="Thursday, 6 August — available"`) → tap day → slot list (`<button>` per slot showing seats-left, disabled at 0) → party-size stepper (1..`max_party`, clamped) → name/email/phone form (client-side validation mirrors §5.4's server checks so errors surface before a network round trip) → "Book" → `POST /api/book` → redirect to `checkout_url`.
- **Accessibility:** every interactive element is a native `button`/`input`/`label` (no div-with-onclick); visible `:focus-visible` ring in brand salmon (`#ffaa81`); `Escape` closes the slot/form panel and returns focus to the day button that opened it; all CSS transitions wrapped in `@media (prefers-reduced-motion: no-preference)` so `reduce` gets instant state changes, no motion.
- **Styling:** `wogo-calendar.css` hardcodes the site's existing palette — espresso `#3f2b21` / `#1a1410`, blush `#ffe5d9` / `#fffaf6`, salmon accent `#ffaa81` / `#f2905c` — matching the exact hex values already used on `amsterdam/index.html` (verified against the live page during spec-writing). Mobile-first: single-column month grid ≤ 480px widening to a 7-col grid above that, no JS-computed layout, pure CSS grid/flex. No external fonts loaded — inherits the page's existing font stack (`inherit` from the host page, same as the rest of the site's component CSS).

---

## 14. Deployment model

**Phase 1 — from her Mac, once:**
```bash
cd backend
npx wrangler login                              # authorizes against HER Cloudflare account (same account as the DNS in CLOUDFLARE-SETUP.md)
npx wrangler d1 create wogo-bookings            # prints a database_id — paste it into wrangler.toml
npx wrangler d1 migrations apply wogo-bookings --local    # for local dev
npx wrangler d1 migrations apply wogo-bookings --remote   # applies 0001_init.sql + 0002_seed_routes.sql to the real, remote D1
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ADMIN_SESSION_SECRET
npx wrangler secret put CRON_SECRET
npx wrangler deploy                             # publishes to wogo-booking-backend.<her-subdomain>.workers.dev
```
Then, in the Stripe dashboard: add a webhook endpoint pointing at `https://<the-deployed-url>/webhooks/stripe`, subscribed to `checkout.session.completed` and `checkout.session.expired`, copy its signing secret into `STRIPE_WEBHOOK_SECRET` (the one command above).

Optional custom domain (a few clicks, since her zone is already on Cloudflare per `CLOUDFLARE-SETUP.md`): Cloudflare dashboard → Workers & Pages → `wogo-booking-backend` → Settings → Triggers → Custom Domains → add `api.wogococktailwalk.com`. Auto-provisions TLS, no code change.

Last step — flip the widget on: set `WOGO_API` in `widget/wogo-calendar.js` to the deployed URL, commit, push. GitHub Pages redeploys the static site (unchanged process); the calendar activates on whichever route pages have the `<div class="wogo-calendar">` embed added (embedding it onto the six live route pages is a **separate follow-up task**, intentionally out of scope here so this spec doesn't touch live pages).

**Phase 2 — runs independently forever after:** Cloudflare's infrastructure executes the Worker on every request, runs D1, and fires the Cron Trigger every 5 minutes — none of this depends on her Mac being on, on Claude, or on this chat session existing. `wrangler dev`/`wrangler deploy` are only ever used again when *she* (or a future builder) wants to ship a code change. Production traffic never touches her machine.

**Cost at her volume:** Workers free tier = 100,000 requests/day; D1 free tier = 5GB storage, 5M row reads/day, 100k row writes/day; Brevo free tier = 300 emails/day. All comfortably above her current volume. The only recurring cost is Stripe's standard per-transaction fee — same as the BACKEND-PLAN.md cost model, just paid to Stripe instead of Wix.

---

## 15. Security hardening (2026-07, `migrations/0005_security.sql`)

Two confirmed gaps closed, plus an engine-wide pass. Everything here is D1-backed on purpose: Cloudflare Workers run as many parallel isolates with **no shared memory**, so an in-process rate limiter or counter would be silently bypassed by the very next request landing on a different isolate. All counters/locks live in D1 instead.

### 15.1 Seat-hold abuse (denial of bookings)

**The gap:** `POST /api/book` had no limits — a scripted attacker could fire endless requests, each creating a free 15-minute hold, and lock every seat on a route without ever paying. Real guests would see "sold out" on a route that's actually empty.

**Layered protection (`src/guest_api.js: handleBook`, `src/db.js`, `migrations/0005`):**

1. **Per-identity active-hold caps** — `MAX_ACTIVE_HOLDS_PER_EMAIL = 2` and `MAX_ACTIVE_HOLDS_PER_IP = 2` (`src/config.js`). Before creating a hold, `db.countActiveHoldsByEmail`/`countActiveHoldsByIp` count that identity's *currently live* (unexpired) holds; at the cap, the request is rejected before it ever reaches the atomic capacity guard. `bookings.ip` (new column) is recorded on the hold and **cleared the instant it resolves** — confirmed, cancelled, or swept expired — so no guest IP is retained on a finished booking (data minimization). IP comes from `CF-Connecting-IP`, which Cloudflare sets itself and a client cannot spoof.
2. **Per-IP attempt rate limit, sliding window** — `HOLD_ATTEMPTS_PER_WINDOW = 5` per `HOLD_ATTEMPT_WINDOW_MINUTES = 10` (`src/config.js`). Every `POST /api/book` call writes one row to the new `rate_events` table (`kind='book'`) before anything else happens, then counts that identity's rows in the trailing window; over the limit → `429`. This is a genuine sliding window (not fixed buckets), computed with `logic.js:sqliteMinutesAgo`. `rate_events` rows are pruned after 24h by the cron sweep (`RATE_EVENTS_RETENTION_MINUTES`) — the table never grows unbounded.
3. **Global sanity cap per route+date+slot** — already enforced, verified: the atomic `INSERT ... SELECT ... WHERE` guard in `db.js`'s `CREATE_HOLD_SQL` (§6.2) sums live holds + confirmed bookings against the effective capacity as one indivisible SQL statement, so holds mathematically cannot exceed remaining seats no matter how many requests race for the last one. Confirmed still correct with the new `ip` column added — it doesn't touch the guard clause.
4. **Server-side booking-shape validation**, closing holes an attacker could otherwise exploit even under the caps above: `date` is checked as a real calendar date (`logic.js:isValidDateStr` — `2026-02-30` now rejected, not just regex-shape), bounded to the same `[today, today+90d]` horizon the guest calendar shows; `slot` must match `HH:MM` AND actually exist for that route/date (via `buildSlotsForDate`, catching remove_slot/extra_slot correctly) — a crafted request can no longer hold a nonexistent departure; `party` is capped at a sane upper bound (99) before the route's real `max_party` check runs; `name`/`email`/`phone` get length caps so a giant payload can't be used to pad row size or abuse downstream email sends.
5. **Origin check as defense-in-depth beyond CORS** — CORS only stops a browser from *reading* a cross-origin response, it does not stop the request from being sent and taking effect. `handleBook` now also rejects (`403`) any request that *does* present a browser `Origin` header not on the allowlist. Requests with no `Origin` (scripts, curl, server-to-server) can't be filtered this way — the rate limits above are the layer that catches those.

**Cheap, honest failure responses:** every rejection from this layer returns `429 {error:"too_many_requests", message:"too many booking attempts — please try again in a few minutes"}` — the same generic message regardless of *which* layer tripped, so a prober learns nothing about which specific limit they hit. The existing widget error state already renders this correctly (§13, `error` state with retry).

**Documented outer layer (not built here — a dashboard click, not code):** Cloudflare's free-tier WAF includes one free rate-limiting rule. Configure it as a second, edge-level layer in front of everything above — see `SETUP.md`'s new "Cloudflare WAF rate-limiting rule" section for the exact rule to create. It stops abusive traffic before it even reaches the Worker (saving request-count budget too), while the D1-backed limits above remain the authoritative, portable guarantee if the site ever moves off Cloudflare.

### 15.2 Admin login brute force

**The gap:** `src/auth.js`'s token check had no throttling — an attacker who found the `/admin/login` endpoint could try unlimited tokens against it with no lockout, no logging, and (before this pass) a non-constant-time comparison that could in principle leak timing information about how many leading characters matched.

**Protection (`src/auth.js`, `src/admin_api.js`, `src/logic.js`, `migrations/0005`):**

1. **Constant-time comparison, properly constant this time** — `logic.js:constantTimeEqual` replaces the previous length-mismatch-returns-early check (which technically leaked length via timing) with a loop that always runs the full length of the *longer* string, folding in the length difference as part of the accumulator rather than short-circuiting on it. Used for the admin token check, the session-cookie HMAC check (`auth.js:requireSession`), and the cron-secret check (`index.js`'s `/internal/cron/expire-holds`).
2. **D1-backed per-IP lockout with escalation** — every login attempt is recorded to the new `auth_events` table (`ip`, `ok`, `created_at`). Before checking the token, `handleLogin` reads this IP's failures since its last success (`db.listRecentLoginFailures` — a success resets the count, so a few mistypes followed by the right password never leaves a stale lockout armed) and runs them through `logic.js:computeLoginLockout`: below `LOGIN_FAIL_THRESHOLD` (5) fails, never locked; at 5, locked for `LOGIN_LOCK_BASE_MINUTES` (15) from the most recent failure; each further failure **while already unlocked** doubles the lock length, capped at `LOGIN_LOCK_MAX_MINUTES` (240 = 4h) — `15 → 30 → 60 → 120 → 240` minutes. While locked, the submitted token is never even compared (no DB write either — hammering during a lockout can't extend it), and the response is `429 {error:"too_many_attempts"}` with a `Retry-After` header, not `401` — so a script can't distinguish "wrong password" from "locked out" by content alone without checking the status code, but the honest `Retry-After` value is there for a legitimate user's browser/UI to use.
3. **Audit log + visible count** — every failed attempt is queryable: `GET /admin/api/security/login-attempts` (session-guarded, i.e. Maroussia must already be logged in to view it) returns `{failed_24h, failed_7d, recent_failures: [{ip, created_at}, ...]}`. `auth_events` rows are pruned after `AUTH_EVENTS_RETENTION_MINUTES` (30 days) by the cron sweep — long enough to be a useful audit trail, bounded so the table never grows unbounded.
4. **Session cookie flags — verified, unchanged (already correct):** `src/auth.js:sessionSetCookieHeader` sets `HttpOnly` (JS can't read it, blocking XSS-based theft), `Secure` (never sent over plain HTTP — skipped only when `ENVIRONMENT==='development'` for local `wrangler dev`), `SameSite=Strict` (never sent on a cross-site request, the strongest CSRF-relevant setting), `Path=/`, and `Max-Age=43200` (12h — a reasonable session length for a single-owner admin panel, not indefinite). No change needed here; confirmed correct against the spec in §12.1.
5. **Login token itself unchanged by design** — `ADMIN_TOKEN` is still a 32-byte random secret (`openssl rand -base64 32`), not a guessable password, so throttling is defense-in-depth on top of an already-strong secret, not a substitute for one.

### 15.3 Engine-wide pass — what was checked and what changed

- **Input validation on public endpoints** — `handleAvailability`/`handleSlots` already validated `route`/`month`/`date` shape; `handleBook` is the one hardened above (§15.1 point 4) since it's the only state-changing guest endpoint. Route existence was already checked everywhere (`404 route_not_found`); date format is now checked for *calendar validity*, not just regex shape, everywhere `isValidDateStr` was worth adding.
- **CORS/origin checks on state-changing endpoints** — `isAllowedOrigin` (`src/config.js`) was already applied to every `/api/*` response's CORS headers; `handleBook` now additionally hard-rejects a disallowed browser `Origin` outright (§15.1 point 5) rather than only omitting the CORS header (which still lets the write happen, just hides the response from `fetch()` — a same-origin form POST wouldn't have been stopped by CORS headers alone). Admin state-changing routes already required both a valid session cookie AND the `X-Requested-With: wogo-admin` CSRF header (`index.js`, unchanged, verified still wired to every `POST`/`PUT`/`DELETE` under `/admin/api/*`).
- **No information leaks in error messages** — the Stripe webhook handler (`src/webhook.js`) now logs the specific signature-verification failure reason to `console.error`/`console.warn` (visible to Maroussia in Cloudflare's dashboard logs) but returns only `{error:"invalid_signature"}` to the caller, with no detail about *which* check failed (timestamp vs. mismatch vs. malformed) — previously it echoed `err.message` straight into the HTTP response, which is a minor oracle for an attacker iterating on a forged signature. All other error responses were already generic machine codes (`bad_request`, `sold_out`, `route_closed`, etc.) with no stack traces or internal detail — verified unchanged.
- **Webhook endpoint rejects non-Stripe traffic cheaply** — `handleWebhook` now checks for a `stripe-signature` header (and a configured `STRIPE_WEBHOOK_SECRET`) and returns `400` **before** reading the request body or doing any signature math — the cheapest possible rejection for the large volume of non-Stripe traffic (scanners, stray bots) any public webhook URL attracts.
- **Internal cron fallback** — `POST /internal/cron/expire-holds`'s `X-Cron-Secret` check now uses `constantTimeEqual` and is closed-by-default if `CRON_SECRET` is ever unset (previously a strict `!==`, functionally fine but inconsistent with the constant-time standard applied everywhere else touching a secret).
- **Retention/cleanup** — the existing 5-minute cron (`scheduled()` in `index.js`) now also prunes `rate_events` (24h) and `auth_events` (30 days) alongside its existing expired-hold sweep, so neither new table grows without bound. All three are independent `await`s inside one `ctx.waitUntil`, so a failure in one doesn't block the others (mirroring the webhook's existing per-side-effect isolation pattern from §8.3).

### 15.4 Test coverage (`test/security.test.js`, `test/logic.test.js`)

- **Pure functions** (`logic.test.js`): `constantTimeEqual` (equal, unequal-same-length, unequal-different-length, non-string inputs, first-char-vs-last-char-differs structural check), `computeLoginLockout` (below threshold, exactly at threshold, unlocked after base window elapses, escalation math across multiple fails including the cap, unordered input, empty input), `isValidDateStr` (real dates, `2026-02-30`/`2026-13-01` rejected, malformed strings, non-strings), `sqliteMinutesAgo` (basic offset, day-boundary crossing).
- **D1-backed counters** (`security.test.js`, real SQLite via the same adapter as `db.test.js`): `countActiveHoldsByEmail`/`countActiveHoldsByIp` (counts unexpired only, case-insensitive email, per-identity isolation, `ip` cleared on cancel/expire), `rate_events` sliding window (in-window vs. stale rows, per-identity isolation, pruning), `auth_events` (fails-after-last-success semantics, per-IP isolation, audit-count/list, pruning).
- **Full-stack handler tests**: `POST /api/book` — hold cap per email rejects the 3rd concurrent hold, hold cap per IP rejects across different emails, a different IP is unaffected; rate limit rejects the 6th attempt in the window even across different emails/slots, and ignores attempts outside the window; Origin check rejects a disallowed browser Origin but allows no-Origin requests; validation hardening rejects a fake calendar date, an out-of-horizon date, a nonexistent slot, and an absurd party size. `POST /admin/login` — wrong token is a plain 401, the 6th attempt from one IP after 5 fails is 429 with `Retry-After`, a different IP is unaffected, a success resets the fail counter, a correct login still sets the `HttpOnly`/`Secure`/`SameSite=Strict` cookie, an oversized token is rejected pre-comparison. `GET /admin/api/security/login-attempts` returns the expected counts.
- All added to the existing Node suite (`node --test test/*.test.js`) — **141 tests, 141 passing, 0 failing** as of this pass (up from the prior 95).

---

## PORTABILITY.md (to be created verbatim as its own file)

```markdown
# Portability — moving off Cloudflare later

This backend is deliberately built from three portable layers, so a future
move away from Cloudflare (if ever needed) touches only a small, named
surface — not a rewrite.

## What's portable as-is
- `src/logic.js` — pure JS, zero platform calls. Runs anywhere JS runs.
- `src/index.js`'s shape — `export default { fetch(request, env, ctx), scheduled(event, env, ctx) }`
  is the WinterCG/Web-standard handler signature also used by Deno Deploy,
  Vercel Edge Functions, Bun, and Val Town. The routing and handler logic in
  `guest_api.js`/`admin_api.js`/`webhook.js` uses only `Request`/`Response`/
  `URL`/`crypto.subtle`/`fetch` — all Web-standard, none Cloudflare-specific.
- `src/stripe.js`, `src/brevo.js`, `src/meta.js` — plain `fetch` calls to
  public REST APIs. Zero Cloudflare dependency.

## What's Cloudflare-specific, and the swap for each
| Cloudflare piece | Where it's used | Swap for another host |
|---|---|---|
| D1 binding (`env.DB`) | Only inside `src/db.js` | D1 is SQLite. `db.js`'s functions are written against the `prepare/bind/run/all/first` shape (same shape the test adapter in `test/sqlite-d1-adapter.js` already implements over `node:sqlite`). Point that exact adapter — or a managed SQLite host like Turso/libSQL, which speaks the same dialect — at `db.js` in production and nothing else changes. A Postgres move would need `db.js` rewritten (different placeholder syntax, no `json_extract` by that name) but the SQL *shape* (single-statement atomic guard clauses) carries over conceptually. |
| Workers Cron Trigger | `wrangler.toml` `[triggers]`, and `scheduled()` in `index.js` | `db.js: expireHolds(db)` is also exposed as `POST /internal/cron/expire-holds` (guarded by `CRON_SECRET`). Any external scheduler (cron-job.org, a GitHub Actions scheduled workflow, another host's native cron) hitting that URL every few minutes reproduces the exact same effect. |
| `wrangler.toml` / `wrangler secret` | Deployment config + secret storage | Config becomes that host's equivalent (e.g. `vercel.json` + Vercel env vars, or a `.env` + host secret manager). No application code references `wrangler.toml` at runtime — it's build/deploy tooling only. |
| Admin dashboard hosting | Served by the Worker itself, as strings in `admin_html.js` | Already framework-agnostic — any host that can run a `fetch` handler and return an HTML `Response` serves it identically. This is why v1 deliberately does NOT use Cloudflare's Static Assets binding (which would be Cloudflare-only) in favor of inline template strings. |

## What would NOT move
Nothing is Cloudflare-only at the business-logic level. The entire "can this
booking be made without overbooking" guarantee lives in portable SQL
(§6 of SPEC.md) and portable JS (`logic.js`) — the platform only supplies
the HTTP entrypoint, the SQLite engine, and the clock that fires the sweep.
```

---

## Summary of what's still open (owner action items, not builder blockers)

1. **Real bar names + emails** per route, to replace the seeded `Bar 1/2/3 (TBD)` placeholders — via Admin → Route manager → Bars once deployed. Bar emails will silently go to `bookings@wogoamsterdam.com` until then (not to nowhere — safe default, just needs the real list).
2. **`map_url` + `map_url_nl` per route** — the owner makes a separate English and Dutch "mail version" map PDF per route, hosted in the site repo's `/maps/` folder (public at `https://www.wogococktailwalk.com/maps/<city>-en.pdf` / `<city>-nl.pdf`); the confirmation email links the one matching `booking.locale` (migrations/0012; merged into the confirmation 2026-07-23 — no separate map email). Utrecht and Groningen are seeded by migrations/0013; remaining routes (amsterdam, rotterdam-*) still `NULL` until their PDFs exist — set both URLs via Admin → Route manager (see ADD-A-CITY.md).
3. **Slot times** in the `0002_seed_routes.sql` seed are derived from the *stated start windows* on the live pages (e.g. "start between 5.30 and 8pm" → 30-min increments) — not pulled from Wix's actual configured departure times, since that data isn't visible on the public pages. Confirm/adjust against the live Wix calendar before go-live; editable in Admin, no redeploy needed.
4. ~~**Brevo template IDs** (`config.BREVO_TPL_*`)~~ — **no longer needed.** Dashboard v2 moved all templates to owned HTML in `src/emails.js` (sent as `htmlContent`); nothing has to be built in the Brevo dashboard. The `BREVO_TPL_*` constants in `src/config.js` are dead and await a cleanup pass.
5. **`META_ACCESS_TOKEN`** — not yet issued; CAPI silently no-ops until she generates one in Meta Events Manager.
6. **Embedding the widget onto the six live route pages** (adding the `<div class="wogo-calendar" data-route="...">` markup and the `<script>`/`<link>` tags) is intentionally a separate follow-up task, not done by this spec, so today's live pages are guaranteed untouched.
7. **Dashboard v2's Admin UI is not yet built** (backend is done and tested — see DASHBOARD-V2-SPEC.md §11 for the exact current status). The Customers tab, the manual/phone-booking form, the discount column on the bookings table, and the bookings month/week calendar toggle from §12.2 above all still need building in `src/admin/admin.*` before Maroussia can use any of Dashboard v2's features from the browser. Everything they'd call already works and is tested (`/admin/api/customers*`, `POST /admin/api/bookings/manual`).
