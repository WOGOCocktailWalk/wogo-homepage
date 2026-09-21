# WOGO Booking Backend — Dashboard v2 (owner requirements, 2026-07-23)

Status: **complete — backend and admin UI both built and tested.** See §11 for the exact, current pass/fail. This doc extends [`SPEC.md`](./SPEC.md) — read that first for the base architecture (D1, the atomic hold pattern, the admin dashboard's build step). Nothing here changes v1's guest-facing booking flow or its overbooking guarantee; this is additive.

Three owner requirements drove this layer:

1. **A Customers tab (CRM)** — "who has booked with me, how many times, how much have they spent."
2. **Manual (phone) booking** — Maroussia takes a booking over the phone and needs to enter it herself, still protected by the same seat-capacity guarantee as the widget.
3. **Promo-code visibility** — when a guest uses a Stripe promotion code, she needs to see which code and how much it saved, per booking and per customer.

A fourth change rides along because it was needed to make owner requirement #2 useful: transactional emails moved from **Brevo-dashboard templates** (numeric `BREVO_TPL_*` IDs, edited in Brevo's UI) to **owned, branded HTML rendered in code** (`src/emails.js`) — so a manual phone booking gets a real confirmation email without Maroussia ever opening Brevo's template editor, and so the templates are version-controlled and previewable (`preview/emails.html`) without any Brevo dependency at all.

---

## 1. Schema (`migrations/0004_customers_manual_discount.sql`)

Four new columns on `bookings`, no new table:

| column | type | meaning |
|---|---|---|
| `source` | `TEXT NOT NULL DEFAULT 'web'` | `'web'` (widget/Stripe) or `'manual'` (owner phone booking) |
| `payment_status` | `TEXT` | manual-only: `'paid_invoice'` \| `'free'` \| `'comp'`. `NULL` for web bookings (they're Stripe-paid — the `stripe_session`/`stripe_payment_intent` columns are the payment record). |
| `discount_code` | `TEXT` | promo code applied at Stripe checkout, `NULL` if none. Also settable by hand on a manual booking. |
| `discount_cents` | `INTEGER NOT NULL DEFAULT 0` | amount saved, in eurocents |

Plus `idx_bookings_email` — the Customers tab's aggregation scans every booking by email; this keeps that fast past a few thousand rows.

**Why no `customers` table:** a customer is *derived* from their bookings, not stored independently. This means "add a customer" is just "take their first (manual) booking," and editing a customer's name/phone/email rewrites their existing booking rows (`db.js:updateCustomer`) instead of maintaining a second source of truth that could drift from the bookings it's summarizing. Trade-off: listing customers re-aggregates every booking row on every call — fine at WOGO's volume (a few thousand bookings/year), and means there is never a stale cache to invalidate.

---

## 2. `logic.js` — pure additions

### 2.1 `aggregateCustomers(rows, q?)`

Input: booking rows already JOINed with their route's `price_cents` (that JOIN happens in `db.js:listCustomerBookingRows`, not here — this function is pure DB-agnostic math, unit-tested without touching SQL).

Groups by **lower-cased, trimmed email**. For each customer, returns:

```js
{
  email, name, phone,                  // name/phone: from the MOST RECENTLY CREATED row (freshest typed values win)
  bookings_count,                       // every row on file, any status — a lead who never paid still shows up
  guests,                                // sum of party, but ONLY for confirmed/confirmed_conflict rows
  total_spent_cents,                     // sum of (price_cents*party - discount_cents) for confirmed rows; comp/free manual rows count as €0
  discount_total_cents,                   // sum of discount_cents across all bookings (lifetime savings given)
  last_booking, first_booking,             // date strings
}
```

Sorted by `last_booking` descending. The optional `q` does a case-insensitive substring match across name/email/phone, so the same function backs both `GET /admin/api/customers` (list) and its search box.

Rows with no email are skipped (defensive — every real booking has one; this just stops a data glitch from crashing the tab).

### 2.2 `extractDiscount(session)`

Reads a Stripe Checkout Session (the `checkout.session.completed` webhook payload's `data.object`) and returns `{ discount_code, discount_cents }`, **never throwing**. Stripe's `total_details.amount_discount` is always present on a completed session (a computed field, no `expand` needed) and is the amount-saved source of truth. The human-readable code is looked up in this order, since Stripe can send `discounts[].promotion_code` in different shapes depending on whether the request expanded it:

1. `discounts[0].promotion_code` as an **expanded object** → `.code`
2. `discounts[0].promotion_code` as a **bare id string** (`"promo_1Nx..."`) → stored as-is
3. `discounts[0].coupon.name` / `.id` (a coupon with no promotion code attached)
4. `session.metadata.discount_code` (manual fallback, e.g. if a checkout session was created with a metadata tag instead of an actual Stripe discount)
5. else `null`

Called from `webhook.js` on every `checkout.session.completed`, unconditionally — it's a cheap pure read, and it degrades gracefully to `{null, 0}` on a session with no discount.

### 2.3 `formatEuros(cents)`

`2995 → '€29,95'` — the one money-formatting helper, used by both `emails.js` and (once built) the admin UI, so a price never gets formatted two different ways.

---

## 3. `db.js` — new DB operations

### 3.1 `createManualBooking(db, params)` — the phone-booking write path

Same shape as `createHold`'s atomic guard (SPEC.md §6.2): **one SQL `INSERT ... SELECT ... WHERE <capacity guard>`**, so a manual booking can never oversell a bar's physical seats — it competes for the exact same effective-capacity pool (SPEC.md §7.6's four-level precedence) as web holds and confirmed bookings. It lands straight as `status='confirmed', source='manual'` — no Stripe hold/checkout step, because the owner is confirming it by hand right now.

It **deliberately does not enforce**: `max_party`, `open_days`, or `closed`/`remove_slot` date overrides. Those are guest-facing guardrails; the owner arranging a booking by hand with the bar has already made that judgment call herself. The only thing kept hard is the real constraint — *does the bar physically have a free seat* — because that one can't be waived by anyone.

Returns `{ created: true, booking }` or `{ created: false, seats_left: N }` so the caller (admin form) can say "only 2 seats left" without a second round-trip guess.

### 3.2 `setBookingDiscount(db, id, code, cents)`

Called from the webhook right after a Stripe-paid confirm, with whatever `extractDiscount` returned. No-op (returns `false`, no write) when there's nothing to save.

### 3.3 `listCustomerBookingRows(db)` / `updateCustomer(db, oldEmail, patch)`

`listCustomerBookingRows` — every booking JOINed with its route's `price_cents`/`name`/`city`, across **all** statuses (so a lead who only ever held never surfaces as "gone"). Handed to `logic.js:aggregateCustomers`.

`updateCustomer` — **the owner-requirement "fix a typo once, it's fixed everywhere."** One `UPDATE bookings SET ... WHERE LOWER(email) = LOWER(:old_email)`, so editing a customer's name/phone/email rewrites *every* one of their booking rows in a single statement. Changing the email itself re-points every row to the new address — the derived customer keeps its whole history under the new key. Returns `{ updated: N }` (0 if that email had no bookings).

---

## 4. `src/emails.js` — owned branded HTML (replaces Brevo-dashboard templates)

Every render function is **pure**: `render*(booking, route, opts) -> { subject, html }`. No `env`, no `fetch`, no Node/Workers APIs — string-building only, so the exact same functions run in the Worker (via `src/brevo.js:sendTransactional`, which now takes `{ to, subject, htmlContent }` instead of `{ to, templateId, params }`) and in `src/emails_preview.mjs` under plain Node. **What Maroussia previews is byte-for-byte what Brevo sends** — there's no separate "preview version" to drift out of sync.

Four templates (was five — the separate `renderRouteMap` guest email was **merged into the confirmation on 2026-07-23**), table-based/inline-styled (email-client safe), sharing one `layout()` wrapper with the site's real brand tokens (espresso/blush/salmon):

| function | fires when | to |
|---|---|---|
| `renderGuestConfirmation` | every confirmed booking (web or manual), EN/NL — the ONE guest email; includes the route-map section (prominent "Open your route map" button + save-this-email note) whenever the route has `map_url` set, omitted with a console warning when it doesn't | guest |
| `renderOwnerNotification` | web bookings only, `status === 'confirmed'` | owner (`OWNER_NOTIFY_EMAIL`) |
| `renderBarNotification` | every bar on the route, web or manual — each bar gets ONLY its own staggered arrival time, plus the guest's name and a "Guest contact" row (email · phone when present) so the bar can reach the group that evening | each bar |
| `renderOwnerConflict` | the rare `confirmed_conflict` double-booking case (SPEC.md §6.4) | owner (`OWNER_ALERT_EMAIL`) |

The guest confirmation shows a struck-through original price next to the discounted total when `discount_cents > 0` (`priceLine()`). The owner notification adds a "Discount" row (code + amount) under the same condition, a "Source" row (`Website` / `Manual (phone booking)`), a "Payment" row for manual bookings' `payment_status`, and — when arrivals were computed — a full "Bar arrival times" panel so she sees the whole staggered schedule for that booking at a glance, not just her own inbox's one line.

**Note for a later cleanup pass:** `src/config.js`'s `BREVO_TPL_CONFIRMATION`/`BREVO_TPL_MAP`/`BREVO_TPL_BAR`/`BREVO_TPL_OWNER_ALERT` constants are now dead — nothing reads them since sends carry `htmlContent` directly. Left in place (harmless) rather than removed as part of this pass, since removing them is a pure tidy-up with no behavior change.

---

## 5. `src/webhook.js` — wiring

On `checkout.session.completed`, after `confirmBooking` returns `confirmed`/`confirmed_conflict`:

1. **Discount capture** — `extractDiscount(session)`, persisted via `setBookingDiscount` if non-empty, and reflected onto the in-memory `booking` object so the emails below see it immediately (no extra read-back).
2. **Guest confirmation (incl. route map)** — `sendGuestConfirmationEmails()` sends exactly ONE guest email: the confirmation, which carries the route-map section inside it when `map_url` is set (merged 2026-07-23 — no separate route-map send anymore).
3. **Bar notifications** — factored into `notifyBars(env, booking, route, deps)`, a new exported helper shared with the manual-booking endpoint (§6.2 below), since both paths land a real confirmed booking a bar needs to know about.
4. **Owner notification** — only for `status === 'confirmed'` (not `confirmed_conflict`, which gets the conflict alert instead), includes the bar arrivals computed in step 3.
5. **Owner conflict alert** — only for `status === 'confirmed_conflict'`, unchanged from v1's contract.

Every send is independently `try/catch`-wrapped (`safe()`) exactly as in v1 — one failing address never blocks the others or fails the webhook's 200 ack to Stripe.

---

## 6. `src/admin_api.js` + `src/index.js` — new endpoints

All under the existing session-guard + CSRF-header rules (SPEC.md §12.1) — nothing new to auth here, they're just more `/admin/api/*` routes.

### 6.1 Customers (CRM)

- **`GET /admin/api/customers?q=`** — `db.listCustomerBookingRows` → `aggregateCustomers(rows, q)`. Returns `{ customers: [...] }`.
- **`GET /admin/api/customers/:email`** — same aggregation filtered to one email, plus their raw booking rows (newest-created first) for a detail-drawer timeline. 404 if that email has no bookings.
- **`PUT /admin/api/customers/:email`** — body `{ name?, phone?, email? }`. Validates a new `email` against the same `EMAIL_RE` the guest widget uses. Calls `db.updateCustomer`, which propagates to every one of that customer's bookings (§3.3). 404 if the old email had nothing to update.

### 6.2 Manual (phone) booking

- **`POST /admin/api/bookings/manual`** — body: `{ route_id, date, slot, party, name, email, phone?, locale?, marketing_opt_in?, payment_status?, discount_code?, discount_cents? }`. Validates the same shape as the guest widget's `POST /api/book` (date/slot/party/name/email), requires the route to *exist* (any active state — a manual entry is the owner's own override, per §3.1), then calls `db.createManualBooking`. On the atomic capacity guard rejecting it, returns `409 sold_out` with `seats_left` in the message. On success, sends the guest confirmation + bar notifications (via `notifyBars`, §5) — **no owner-notification email**, since she's the one who just typed it in — and returns the created booking (`201`).

---

## 7. `preview/emails.html` (`src/emails_preview.mjs`)

A Node script (`npm run build:emails-preview`) that renders all four templates in §4 against realistic mock data matching the **real** Amsterdam seed (`migrations/0002_seed_routes.sql`: 3 bars staggered **0 / 75 / 150 minutes**, not a round 60/120 — the actual seeded stagger is what's demonstrated), including one booking with a promo code applied (discount line visible in both the guest and owner emails) and one manual/comp booking (owner-notification's "Manual (phone booking)" + "Comp" rows). Each template renders inside its own `srcdoc` `<iframe>` — the same isolation a real inbox gives each message, since every template is itself a full standalone HTML document — with a sidebar to switch between all 8 rendered examples (4 templates × the EN/NL or per-bar variants that exercise every field, incl. the merged confirmation's route-map button in both languages and the bar email's "Guest contact" row). Throwaway preview tooling, same convention as `src/admin/build.mjs` — not served by the Worker.

---

## 8. Test coverage

- **`test/logic.test.js`** — `extractDiscount` (every payload shape Stripe can send, malformed input, negative-amount guard), `aggregateCustomers` (grouping, spend-net-of-discount, comp-counts-as-€0, freshest-name-wins, search, sort), `formatEuros`, and a `computeBarArrivals` case pinned to the real seed's 0/75/150-minute stagger.
- **`test/db.test.js`** — `createManualBooking` (confirmed+source=manual on success, atomic rejection at exactly zero seats left, **shares the same capacity pool as an active web hold**, does NOT enforce `max_party`, persists discount/payment_status), `listCustomerBookingRows` + `aggregateCustomers` round-tripped through a real SQLite DB (mixed web/manual/comp bookings folding into one customer), `updateCustomer` (propagates to every row sharing an email, re-points on an email change, no-op for an unknown email).
- **`test/webhook.test.js`** — updated for the owned-HTML `{to, subject, htmlContent}` send shape (no more Brevo `templateId`) and, since the 2026-07-23 merge, for the single guest email: a confirmed flow with 2 bars sends **4 emails** (1 guest confirmation incl. route-map link + 1 owner notification + 2 bars); asserts the map link lands inside the confirmation HTML and the guest's email + phone land inside each bar email.

All 95 tests green as of this pass (`npm test`). `node --check` clean across every file in `src/`, `src/admin/`, and `test/`, plus the inline `<script>` blocks in `preview/admin.html`, `preview/guest.html`, and `preview/emails.html`.

---

## 9. What changed vs. v1's contract (so nothing here surprises a reader of SPEC.md)

- `src/brevo.js:sendTransactional` now takes `{ to, subject, htmlContent }` instead of `{ to, templateId, params }` — SPEC.md §8.4 described the Brevo-template version; this supersedes it.
- `src/config.js`'s `BREVO_TPL_*` constants are dead code (§4's cleanup note) — not removed, just unused.
- `src/webhook.js` gained `notifyBars()` as a new named export (factored out of the inline bar-loop) — the manual-booking endpoint imports it too, so the "email every bar its staggered arrival time" logic has exactly one implementation.
- `GET /admin/api/bookings` and `GET /admin/api/bookings.csv` already return the new `source`/`payment_status`/`discount_code`/`discount_cents` columns with no changes needed — `db.js:listBookings` selects `b.*`, and `admin_api.js`'s CSV column list was extended to include them.

---

## 10. Deployment notes

**No new secrets.** Dashboard v2 introduces zero new external services — same Stripe/Brevo/D1 as v1. `migrations/0004_customers_manual_discount.sql` needs applying alongside 0001–0003 (`npx wrangler d1 migrations apply wogo-bookings --remote`) before any of this works against the real database; every new column has a default, so existing rows keep their exact v1 meaning (`source='web'`) with no backfill needed.

---

## 11. Current status (owner-facing — what she can and can't do today)

**Built, tested, and reachable via the API today (once deployed):**
- Every booking captures its promo code + discount amount automatically; visible via `GET /admin/api/bookings`, the CSV export, and both customer endpoints.
- `POST /admin/api/bookings/manual` takes a phone booking, atomically protected against overselling, sends the guest a real confirmation email (route map included when set) and each bar its arrival-time notice.
- `GET/PUT /admin/api/customers*` — list/search/view/edit a customer, with edits propagating to their whole booking history.
- Every transactional email (guest, owner, bar, conflict alert) renders as owned branded HTML — previewable in a browser with zero setup via `preview/emails.html`.

**Admin UI — built (this pass), in `src/admin/admin.html`/`.css`/`.js`, previewable offline via `preview/admin.html`:**
1. ✅ **Customers tab** — searchable table over `GET /admin/api/customers` (name, email, phone, bookings count, guests, total spent, a **Discount** column showing code(s) used + lifetime amount saved, last booking), plus stat tiles (customers / repeat / lifetime revenue net of discounts / discounts given). Row click opens a detail drawer wired to `GET /admin/api/customers/:email` (summary + booking-history timeline) with an **Edit details** form wired to `PUT` — one save propagates across every booking row. Codes per customer come from a one-time `GET /admin/api/bookings` fetch (the aggregate endpoint returns amount saved but not the code strings).
2. ✅ **"New manual booking" form** — "+ Manual booking" on the Customers tab: route/date/slot/party/name/email/phone + payment-status picker (Paid on invoice / Free / Comp) and optional discount code/amount, wired to `POST /admin/api/bookings/manual`. A `409 sold_out` surfaces **inline** with the seats-left message and what to do about it; success opens the created booking's drawer.
3. ✅ **Discount + source rendering** on the existing Bookings view — table status cell stacks a `Manual` tag and a `CODE −€x,xx` tag; the booking drawer gained Discount (code · amount · net paid), Source (Website / Manual (phone booking)) and Payment rows. The revenue stat is now net of discounts and counts free/comp manual bookings as €0 (matching `logic.js` spend math).
4. ✅ **Week time-grid calendar** (the v1 SPEC.md §12.2 month/week toggle, finished here) — Bookings now has a **List / Week / Month** toggle. Week = Mon–Sun columns × hour rows (~14:00–23:00, stretched if a departure falls outside), one block per departure coloured by route (route name + booked/capacity pill + city; green open / amber ≥70% / full), empty scheduled departures faded. Click a block → that departure's guest list in the drawer (guests click through to the full booking). Sidebar: mini month picker (jump to any week), route filter with colour-key checkboxes + select-all, and an "Upcoming departures" panel. Capacity per block honours the full §7.6 precedence (date+slot > date-wide > route per-slot > route default) via the same client helpers the Per-hour view uses; off-schedule manual bookings still appear. Month = the pre-existing bookings calendar, unchanged.

None of the above touches the guest-facing widget, the Stripe/webhook flow, or anything already live — it is purely additive screen(s) inside `/admin`. `preview/admin.html`'s mock layer was extended to match (customers endpoints, manual-booking endpoint with the real capacity guard + 409 shape, WELCOME10/€3,00 + manual-booking seed data, a guaranteed full 10/10 and amber 8/10 departure on today's date). Verified this pass: `node --check` clean, `node src/admin/build.mjs` regenerated `assets.js` + `preview/admin.html`, all 95 `npm test` tests green, and a headless-Chrome walkthrough of every view (old and new) with zero console errors.
