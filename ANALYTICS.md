# WOGO analytics — what's tracked, where, and how to change it

Plain-language guide to the measurement setup on this site. Everything here is
€0/month: Google Analytics 4 and the Meta Pixel are both free, and there is no
tag manager, no subscription and no third-party library.

Two rules the whole setup is built on:

1. **Nothing fires before the visitor says yes.** No request to Google or Meta
   is made until the cookie banner gets a "Accept all" or a category tick.
2. **Pages never call Google or Meta directly.** They call one helper,
   `window.wogoTrack(name, params)`. It decides what is allowed to go out.

---

## 1. Where the code lives

| Thing | File | Notes |
|---|---|---|
| The analytics block | pasted on **every** `.html` page, directly after the cookie-consent block | Canonical copy: `ANALYTICS-SNIPPET.html` at the repo root |
| Cookie consent block | pasted on every page, just above it | Canonical copy: `CONSENT-SNIPPET.html` |
| Per-page product identity | a one-line `<script>window.WOGO_PAGE = {...}</script>` just above the analytics block, on route / booking / hub pages | Marked `PAGE-EDIT` |
| Newsletter sign-up (footer) | inside the shared `WOGO SHARED FOOTER v4` block | Fires `sign_up` |
| Booking widget | `backend/widget/wogo-calendar.js` | Fires `begin_checkout` |
| Booking confirmation | `booking-confirmed/index.html` (foot script) | Fires `purchase` + the Meta `Purchase` |

**Order matters.** The analytics block must come *after* the consent block,
because it uses `window.wogoOnConsent` which that block defines. If you ever move
it, keep it after.

**A name clash to know about.** Every page's own foot script already declares a
*local* `function wogoTrack(action, label)` — the old postMessage tracker that
talked to the Wix host page. Inside those scripts the local one wins. So always
write `window.wogoTrack(...)`, never a bare `wogoTrack(...)`, or the event
silently turns into a postMessage and nothing reaches GA4. There is no error when
you get this wrong, which is exactly why it is worth remembering.

---

## 2. Consent rules

The banner has three optional categories: **analytics**, **functional**,
**marketing**. The analytics block maps them onto Google Consent Mode v2:

| Visitor grants | What happens |
|---|---|
| nothing | Nothing loads. Events are held in memory (max 20) and sent only if consent arrives later on the same page. |
| analytics | GA4 (`gtag.js`) loads. `analytics_storage: granted`. No Meta Pixel. |
| marketing | Meta Pixel loads. GA4 also loads with `ad_storage` / `ad_user_data` / `ad_personalization` granted. |
| functional | `functionality_storage` / `personalization_storage` granted. Loads nothing by itself. |

Sequence inside the loader, in this order: `consent default` (everything denied)
→ `consent update` (what the visitor granted) → `js` → `config` per property →
only then is the `gtag.js` `<script>` injected. That means the very first request
to Google already carries the correct consent state.

GA4 anonymises IP addresses by default — there is no setting to turn on.
`send_page_view: true` is set explicitly, so one `page_view` is sent when GA4
loads. The loader is guarded by a `gaLoaded` flag, so re-granting consent or
changing a category never sends a second `page_view`.

Changing cookie preferences later (footer → "Cookie settings") sends a fresh
`consent update`; it does not reload anything.

---

## 3. Events

### Funnel

| Step | GA4 event | Meta event | Where it fires |
|---|---|---|---|
| Saw a route | `view_item` | `ViewContent` | Route pages and `/book/` pages, from `window.WOGO_PAGE` |
| Saw a list of routes | `view_item_list` | — | Homepage, `/rotterdam/`, `/london/` |
| Clicked "Continue to secure payment" | `begin_checkout` | `InitiateCheckout` | Booking widget |
| Paid | `purchase` | `Purchase` (fired separately, see below) | `/booking-confirmed/` |

`view_item` carries `currency`, `value`, and one item with `item_id` (the backend
route id, e.g. `rotterdam-hidden-gems`), `item_name`, `item_category` (the city)
and `price`.

`begin_checkout` carries `value = price × party` and the same item with
`quantity = party`.

`purchase` carries `transaction_id` (the booking id), `value`
(`amount_cents / 100`, already net of any gift card) and the item.

### Other conversions

| Action | GA4 event | Meta event |
|---|---|---|
| Newsletter sign-up succeeded (footer form) | `sign_up` (`method: 'newsletter'`) | `CompleteRegistration` |
| Contact form sent | `generate_lead` (`kind: 'contact'`) | `Lead` |
| Group enquiry sent | `generate_lead` (`kind: 'group'`) | `Lead` |
| Gift-card order started | `begin_checkout` (item `gift_card`) | `InitiateCheckout` |
| Gift card paid | `gift_card_purchase` (custom, **no value**) | — |

### Two deliberate gaps

- **The Meta `Purchase` is fired by `booking-confirmed/index.html` itself**, not
  by `wogoTrack` — because it needs `eventID = booking.id` so the server-side
  Conversions API copy (`backend/src/meta.js`) can be deduplicated against it.
  `purchase` is therefore mapped to *no* Meta event in the shared block; adding
  one would double-count every booking.
- **`gift_card_purchase` has no revenue.** `/gift-confirmed/` is a static page
  with no `session_id` lookup, so the amount simply isn't available there. A
  `purchase` without a value would be worse than an honest custom event. To
  upgrade: add `GET /api/giftcard?session_id=…` on the Worker and mirror what
  `booking-confirmed/` does.

### Item ids line up across the funnel

`GET /api/booking` returns `route_name` but not `route_id`. So at
`begin_checkout` the widget stashes the route id in `sessionStorage`
(`wogo_last_route`); the confirmation page reads it back after the same-tab round
trip through Stripe. If that is missing (a different browser, or the guest
reopening the confirmation link from their email) it falls back to a slug of the
route name, so the `item_id` can occasionally differ from the `view_item` one.
Fix properly by adding `route_id` to the `GET /api/booking` response.

---

## 4. UTMs

Landing-page UTMs reach GA4 on their own — they are in the URL when `page_view`
fires, and GA4 reads them from there. Nothing to wire.

Pages also carry a small `__wogoCarry` script that copies `utm_*` / `fbclid` /
`gclid` onto internal links, so the parameters survive navigation.

**Known gap:** the booking widget does **not** send UTMs to the backend. There
are no UTM fields in the `POST /api/book` payload and `__wogoCarry` is never read
by the widget, so the booking rows in D1 carry no campaign attribution. Adding it
means a change in `backend/src/` (payload validation + a column), which is out of
scope for this front-end pass.

---

## 5. How to switch GA4 property

Events currently go to **both** GA4 properties that came over from the Wix era:

```js
var GA_IDS = ["G-QLXFFEK69D", "G-45QEXJY544"];
```

One line, one place — in the analytics block. When the owner picks one property,
delete the other id from that array and re-paste the block onto every page (or
re-run the patch script). Nothing else changes: `gtag('event', …)` fans out to
every configured property automatically, so events are never sent twice by hand.

Because the block is pasted identically on all pages, verify after any edit that
all pages still carry the *same* copy:

```sh
cd ~/Projects/wogo-homepage
python3 - <<'EOF'
import glob, hashlib
S = "▼▼▼  WOGO ANALYTICS v1"; E = "▲▲▲  WOGO ANALYTICS v1"
h = {}
for p in sorted(glob.glob("**/*.html", recursive=True)):
    if p.startswith(("backend/", "email/")) or p.endswith("-SNIPPET.html"): continue
    t = open(p, encoding="utf-8").read()
    i, j = t.find(S), t.find(E)
    k = hashlib.md5(t[i:j].encode()).hexdigest()[:8] if i >= 0 and j >= 0 else "MISSING"
    h.setdefault(k, []).append(p)
for k, v in h.items(): print(k, len(v), v[:2])
EOF
```

One hash = good.

---

## 6. How to see the funnel in GA4

1. **Reports → Monetization → Ecommerce purchases** — revenue, items sold.
2. **Reports → Realtime** — use this straight after a test booking to confirm
   events are arriving at all.
3. **Explore → Funnel exploration** — build the real funnel:
   - Step 1: event `view_item`
   - Step 2: event `begin_checkout`
   - Step 3: event `purchase`
   - Breakdown: `Item name` or `Item category` (= city), so Utrecht and Rotterdam
     can be compared side by side.
4. **Admin → DebugView** — with the GA Debugger Chrome extension on, watch events
   arrive live, including which property received them. This is the way to prove
   one event reached *both* measurement ids.

Expect roughly: `view_item` ≫ `begin_checkout` > `purchase`. The ratio
`begin_checkout ÷ view_item` is the number worth watching week to week; it says
how convincing the route pages are.

## 7. Meta Events Manager check

1. **Events Manager → Data sources → the WOGO Pixel (`652971109400692`) →
   Overview** — `PageView`, `ViewContent`, `InitiateCheckout`, `Purchase`,
   `Lead`, `CompleteRegistration` should all appear with recent activity.
2. **Test events** tab — paste the site URL, accept cookies with "Accept all",
   and watch the events land as you click through a route page and into the
   widget.
3. **Purchase → Deduplication** — confirm browser and server Purchase events are
   being merged on `eventID`. Two separate counts means the `eventID` wiring
   broke.
4. If nothing appears at all: the Pixel only loads with **marketing** consent.
   Clear site data, reload, click "Accept all", and check again.
