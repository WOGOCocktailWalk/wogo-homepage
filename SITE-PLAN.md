# WOGO Website — Master Build Plan

*Synthesized from the conversion, frontend, backend and SEO proposals — one answer per topic.*
*Date: 2026-07-06 · Repo: `~/Projects/wogo-homepage` · Hosting: GitHub Pages, €0/month, plain HTML/CSS/JS, no build tools.*

**The one-paragraph version:** The site stays a folder of plain HTML pages on GitHub Pages (free forever). Every route gets its own page, every city gets a landing page for ads and Google. Booking happens through Stripe Payment Links — payment pages Stripe hosts for us, created by clicking around in the Stripe dashboard, no code, no monthly fee, only ~€0.29–€0.70 per booking. One small free Google script receives Stripe's "payment succeeded" signal and does what Wix does today: logs the booking in a Google Sheet, emails the guest their route, emails the bar the reservation, and tells Meta about the sale so ad tracking doesn't break. Groups stay a human inquiry form; gift cards are self-serve. We put free Cloudflare in front of the domain so every old Wix link redirects properly and Google rankings survive the move.

---

## 1. SITEMAP & NAV

### The full page list

English is the default (no prefix). Dutch mirrors live under `/nl/` with Dutch slugs (words Dutch people actually search, not literal translations). Every EN/NL pair points at each other with hreflang tags — small invisible labels that tell Google "this is the Dutch twin of that English page."

**Core funnel (money pages)**

| URL | NL twin | Job | Exists for |
|---|---|---|---|
| `/` | `/nl/` | Brand overview, routes all traffic. Already built. | Direct, social bio, brand searches |
| `/rotterdam/` | `/nl/rotterdam/` | City landing page — where Rotterdam Meta ads land | **Ads** + SEO ("cocktail walk rotterdam") |
| `/utrecht/` | `/nl/utrecht/` | Same, for Utrecht ads | **Ads** + SEO |
| `/amsterdam/` | `/nl/amsterdam/` | City page (organic; ads paused there) | SEO |
| `/groningen/` | `/nl/groningen/` | City page, can stay thin | SEO |
| `/rotterdam/city-centre/`* | `/nl/rotterdam/…` | Route 1 product page → Book button | Funnel |
| `/rotterdam/hidden-gems/`* | `/nl/rotterdam/verborgen-parels/` | Route 2 (best-seller) product page | Funnel |
| `/rotterdam/premium-gin-walk/`* | `/nl/rotterdam/…` | Premium Bobby's Gin Walk (€34,95) | Funnel |
| `/utrecht/city-centre/`* | `/nl/utrecht/…` | Utrecht route page | Funnel |
| `/amsterdam/noord-city-centre/`* | `/nl/amsterdam/…` | Amsterdam route page | Funnel |
| `/groningen/gin-walk/`* | `/nl/groningen/…` | Groningen route page | Funnel |
| `/groups/` | `/nl/groepen/` | 7–30 people → inquiry form (no instant payment) | Funnel + SEO ("vrijgezellenfeest") |
| `/gift-cards/` | `/nl/cadeaubonnen/` | Self-serve gift card purchase | Funnel + SEO |
| `/booking-confirmed/` | `/nl/…` | Thank-you page after payment; "check your email for your route" | Funnel (hidden from Google) |

\* Route slugs are my best guess from the theme copy — **Maroussia confirms real neighbourhood names before these folders are created** (Decision #2). Neighbourhood names beat theme words in local search.

**Support & trust pages**

| URL | Job | Exists for |
|---|---|---|
| `/how-it-works/` | Explains the format in depth; owns "what is a cocktail walk / self-guided bar crawl" — a category WOGO can define | SEO + funnel support |
| `/faq/` | Full FAQ (homepage keeps a short subset) | SEO + support |
| `/about/` | Founder story + how bars are hand-picked — the trust gap the site currently has. **Built** (noindex until cutover; founder-photo slot + old Wix stats left as TODOs for Maroussia). | SEO (trust) + conversion |
| `/privacy/` `/cookies/` `/terms/` | Publish the legal docs already drafted at `~/Projects/wogo/legal/` | Housekeeping |
| `/404.html` | Brand-styled "page not found" — GitHub Pages serves it automatically | Housekeeping |

**Later (Phase 7):** occasion pages — `/date-night/`, `/bachelorette-party/` (+ `/nl/vrijgezellenfeest/`), `/birthday-night-out/`, `/team-outing/`. These are just different doorways: one question — "How many of you?" — sends ≤6 into the normal route flow and 7–30 into `/groups/`. No parallel content tree.

**London later:** `/london/` + `/london/{route}/` — same pattern, no country folder needed (people search "cocktail walk london", not "cocktail walk uk").

### Navigation (keep, with two fixes)

`Logo · Routes ▾ · How it works · Groups · Gift cards · [Book your walk]` — unchanged. About + FAQ stay in the footer. Two fixes:

1. **CTA honesty:** wherever a button only scrolls to the route grid (nav CTA, sticky mobile bar), the label becomes **"View dates" / "Bekijk data"**. Buttons that open an actual checkout keep **"Book your walk"**. Cold visitors need a low-commitment first click.
2. **Routes ▾ dropdown** points at the real `/{city}/` pages once they exist (the code already has a TODO comment for exactly this), and the `WOGO_ROUTES` data object gains route-level URLs so the footer can list all 6 routes, not just 4 cities.

### Footer

Routes column (all 6 routes) · Discover column (How it works, Groups, Gift cards, FAQ, About) · Contact (mail, +31 20 210 1168, socials) · legal links. Rotterdam ↔ Utrecht cross-link on their city pages to concentrate strength on the two ad markets.

*(One specialist flagged a phone-number mismatch — checked the file: it's already +31 20 210 1168 everywhere, including the schema. No action needed.)*

---

## 2. BOOKING & CHECKOUT

### The chosen model: no basket — one direct booking flow

A cocktail walk is one reservation (route + date + head count) with real bar tables behind it — like booking a restaurant, not filling a shopping cart. Airbnb Experiences, Resy and OpenTable all skip the cart for exactly this reason. A basket would let a guest hold two conflicting dates at once — the one thing this business can't get wrong. So: **no basket, ever.** Gift cards get their own separate checkout.

### The flow, step by step

1. **Entry** — ad or Google lands on `/{city}/`; visitor picks a route card.
2. **Route page** (`/{city}/{route}/`) — photos, reviews, start times, what's included, price. One button: **Book your walk**.
3. **Stripe Payment Link** — the button opens a checkout page Stripe hosts (their servers, their security). On it the guest picks: **number of people (1–6)** via Stripe's quantity selector, **date** and **start time** via dropdown fields we configure per route with that route's real operating nights. Payment methods on the same page: **iDEAL, cards, Apple Pay, Google Pay**. Gift-card codes are entered here too (see below).
4. **Payment succeeds** → Stripe sends the guest a receipt and forwards them to `/booking-confirmed/` ("Your route is on its way to your inbox").
5. **Behind the scenes, within seconds** a free **Google Apps Script** (a tiny script that lives on Google's servers — always on, never depends on Maroussia's laptop) receives Stripe's confirmation and:
   - verifies the message genuinely came from Stripe (signature check),
   - writes a row to a **"WOGO Bookings" Google Sheet** — this Sheet *is* the booking database and the capacity dashboard,
   - **emails the guest** their route + practical info (replacing Wix's auto-confirm),
   - **emails the bar(s)** the reservation request — date, time, party size (replacing Wix's forward),
   - **fires a server-side Purchase event to Meta** (Conversions API, Pixel 94) with the real order value, **and one to Google Analytics**,
   - ignores duplicate signals so a retried message never double-emails a bar.

> ⚠️ **The one thing that silently breaks otherwise:** today Wix tells Meta about every sale. That integration dies with Wix Bookings. The Meta event in step 5 must be built and *tested* **before** cutover, or the ROAS numbers on the live €40/day Utrecht+Rotterdam campaigns go blank with no error message.

**Why Payment Links and not a custom checkout server?** Two specialists proposed different depths: a Cloudflare Worker building live-inventory checkouts, vs. dashboard-made Payment Links with no code. **Payment Links win for v1**: at 70–90 bookings/month (~2–3 per operating night) live inventory solves a problem WOGO barely has, and Payment Links mean zero code before payment — every "Book Now" link in the existing HTML is swapped 1:1 for a Stripe URL. Cloudflare Workers + a live capacity counter is the named, still-€0 upgrade if a real double-booking ever happens or volume triples. Don't build it preemptively.

### Payment processor & costs

**Stripe** (default; check for a dormant Mollie account first — Decision #1):

| Method | Fee | On a €29,95 booking |
|---|---|---|
| iDEAL (most Dutch guests) | flat ~€0.29 | €0.29 |
| EU card | ~1.5% + €0.25 | ~€0.70 |
| Non-EU card / Amex | ~2.9% + €0.25 | ~€1.12 |

At ~80 bookings/month: **roughly €25–40/month in fees total, €0 fixed** — vs. Wix's flat subscription whether or not anyone books.

**London / GBP:** when London launches, create GBP-priced Payment Links for London routes. Stripe settles GBP into the EUR account automatically (~2% currency conversion); add a UK bank account later only if London volume justifies it. No multi-currency cleverness now.

### Availability & capacity — the honest limitation vs Wix

There is **no live seat-count check before payment** in this setup. Managed with three cheap layers:

1. The date/time dropdown on each Payment Link lists **only currently open nights** — Maroussia (or Valeriia) edits the list in the Stripe dashboard, no code, to close a full night.
2. The Google Sheet shows bookings building up per date/route at a glance.
3. Stripe's built-in "limit total number of payments" acts as a hard safety valve per link.

At current volume the real double-booking risk is low, and this mirrors how bar coordination already works. **Urgency badges rule:** the site never shows fake scarcity — "Nog X plekken" style badges only appear if/when the live-capacity upgrade is built. Also: **no free-cancellation promises anywhere, ever** (bars pre-arrange tables) — the FAQ's "get in touch and we'll see what's possible" wording is the ceiling.

### Groups (7–30) — inquiry, not checkout

`/groups/` = short form (name, email, phone, city, group size, preferred date, occasion) posting to a second branch of the same Apps Script → its own Sheet tab + a ping to @WOGOCOCKTAILBOT on Telegram, where Maroussia already looks daily. She replies by hand with availability + a one-off Stripe Payment Link for the exact head count. **Show the group price on the page** (currently visitors must leave the site to learn it — Decision #7). No calendar, no instant payment: bars need human coordination at this size, so automation here would be wasted work.

### Gift cards — self-serve

`/gift-cards/`: three preset amounts **€30 / €60 / €100** with **€60 pre-highlighted "Most popular — a walk for two"** (a genuinely different tier, not a fake upsell), plus custom amount. Purchase via Stripe. On payment, the Apps Script asks Stripe to **auto-create a one-time promotion code for that exact amount** and emails it to the buyer — matching the "delivered instantly by email" promise. Redemption is Stripe's own "Add promotion code" field at any route's checkout — **no custom code ledger to build or maintain.** (Chosen over the hand-rolled code-in-a-Sheet proposal: same result, far less to break.)

### Legal footnote (don't skip at go-live)

Add Stripe, Google (Sheets/Apps Script/Gmail) and Telegram as data processors to the privacy policy drafted at `~/Projects/wogo/legal/` — a one-paragraph edit to an already-written document.

---

## 3. TEMPLATE SYSTEM

Four templates. Each page is one self-contained `index.html` in its own folder — no build tools, ever.

1. **Homepage** — exists. Stays the brand overview.
2. **City hub** (`/{city}/`) — city-name H1, hero, trust badges (★4.4 Google · ★4.5 Trustpilot · 80,000+ walks booked · Partner of Gemeente Rotterdam), the mini "How it works" 3-step strip, that city's route cards, short FAQ, links to Groups/Gift cards + the other priority city. Built once for Rotterdam, copied for the rest.
3. **Route page** (`/{city}/{route}/`) — the product page: theme, 20+ photos, reviews for that route, operating nights & start times, what's included, breadcrumbs (Home › City › Route), "Coming with 7+? → Groups", "Give it as a gift → Gift cards", and the **Book your walk** button → that route's Payment Link.
4. **Content page** — one simpler shell for How it works, Groups, Gift cards, FAQ, About, legal.

**Metadata pattern** (same shape every city, so London slots in mechanically):
- City: `Cocktail Walk {City} | Self-Guided Bar Crawl — 3 Bars, 1 Night | WOGO`
- Route: `{Route theme} Cocktail Walk — {City} | WOGO`
- NL versions written fresh in natural Dutch, never machine-translated slugs of the English.

**Structured data** (the invisible label that can earn Google's price/breadcrumb rich results): homepage keeps TouristAttraction + gains a separate Organization block; city hubs = TouristAttraction; route pages = TouristTrip + Offer (price, EUR) + BreadcrumbList; gift cards = Product + Offer; FAQ = FAQPage (full version on `/faq/`, homepage carries the short subset). Never LocalBusiness — WOGO isn't a fixed venue.

### Keeping nav/footer in sync

Nav and footer live in each file as clearly fenced copy-paste blocks:

```html
<!-- ===== WOGO SHARED NAV v3 — must be identical on every page. Edit via find-and-replace across all files. ===== -->
…
<!-- ===== /WOGO SHARED NAV ===== -->
```

A version number in the comment makes drift visible; a change = one find-and-replace across ~20 files, which Claude does in one command. Chosen over a JavaScript include because copy-paste blocks work with zero moving parts, never flicker, and are fully visible to Google.

### How Dutch works (this is a real change from today)

Today "Dutch" is a JavaScript text-swap on the same URL — Google only ever sees the English page, so Dutch searches can't find Dutch content. **Fix: every page becomes two physical files** — `/rotterdam/hidden-gems/index.html` (EN) and `/nl/rotterdam/verborgen-parels/index.html` (NL) — each with its language baked into the actual HTML, plus reciprocal hreflang tags (`en`, `nl`, `x-default`→EN). The EN/NL toggle button stays but now **navigates to the twin URL** instead of rewriting text in place. Not a rebuild: both languages' copy already exists in the current file's i18n dictionary — it's a split-and-paste job done once per template.

### Adding London later (the recipe)

1. Copy the `/rotterdam/` folder → `/london/`; copy one route folder per London route.
2. Change: city name, H1/meta/schema, photos, route details, bar list.
3. Create GBP Payment Links in Stripe; point the Book buttons at them.
4. Add London + its routes to `WOGO_ROUTES` (nav dropdown + footer pick it up).
5. Add the London bar emails to the Apps Script's route→bar table.
6. Add the new URLs to `sitemap.xml`. New language later (e.g. `/es/`) = same recipe as `/nl/`.

---

## 4. WIX MIGRATION

**Redirects — the ranking-preservation move.** GitHub Pages can't do real redirects by itself. Put **Cloudflare's free plan** in front of the domain (a DNS change — Cloudflare becomes the address book that points wogococktailwalk.com at GitHub Pages, still €0/month) and use its **Bulk Redirects** to permanently forward every old Wix URL to its new home. That "permanent" signal (a 301) is what carries Google rankings, the 5 press backlinks, GetYourGuide, and the Google Business Profile link across the move. Known old URLs to map (~15–20): `/utrecht`, `/rotterdam-cocktail-walk-route1`, `/rotterdam-cocktail-walk-route-2`, `/rotterdam-premium-cocktail-walk`, `/amsterdam-cocktailwalk-route1`, `/groningen-cocktail-walk`, `/groupbookings`, `/gift-cards`, plus 5 `/booking-calendar/*` pages. As a belt-and-braces fallback, any stragglers get a static folder with an instant meta-refresh page. **Before cutover:** pull the *complete* historical URL list from Google Search Console (Decision #4) — the homepage only shows currently-linked URLs, not old blog/legal pages that may still rank.

**Self-host all media first.** Every hero image, city-card photo and the hero video still load from Wix's servers (`static.wixstatic.com`). Download them into the repo **before cancelling Wix**, or the site's images die silently the day the subscription ends.

**Flip the launch switches.** `index.html` currently carries `noindex` (deliberately, while it's a Wix embed) and a canonical pointing at wogococktailwalk.com. At cutover: remove noindex, point canonical at itself, and rewrite every internal link from Wix paths to the new relative paths. Miss this and the new site stays invisible to Google indefinitely. `/booking-confirmed/` (and any checkout step) stays **noindex** and out of the sitemap forever — thank-you pages have no search value.

**Cutover order (the safety rule):** nothing gets cancelled until the new flow has processed **real test bookings end-to-end** — pay by iDEAL → Sheet row appears → guest email arrives → bar email arrives → Purchase event visible in Meta Events Manager.

1. Build & test booking flow on the GitHub Pages URL (Stripe test mode, then one real €29,95 booking refunded after).
2. Download all Wix media into the repo.
3. Update the privacy policy processors; publish legal pages.
4. Add sitemap.xml + robots.txt; get Google Search Console access; export the historical URL list.
5. Move DNS to Cloudflare (site still points at Wix — zero visitor impact).
6. Load the bulk redirect map; flip DNS to GitHub Pages; flip noindex/canonical.
7. Submit the sitemap in GSC + Bing; request indexing for Rotterdam & Utrecht pages first; update Meta ad destination URLs; watch GSC coverage weekly for 4–6 weeks for 404 spikes.
8. Only when a full week of bookings has flowed cleanly: cancel Wix. 🎉

---

## 5. BUILD ORDER

Each phase ships on its own. **Deliberate change from the old Amsterdam-first plan: Rotterdam + Utrecht come first** — that's where the €40/day of ads already lands, so those pages moving off Wix has the fastest effect on bookings. Amsterdam (high competition) and Groningen (deprioritized) come later and can be thinner.

**Phase 0 — Stripe account & first Payment Link** *(start immediately, no code)*
Create the Stripe account (WOGO Amsterdam B.V., KvK 92237347), enable iDEAL/cards/Apple Pay/Google Pay, build the Rotterdam Route 2 Payment Link (qty 1–6, date+time dropdowns) in test mode. Unblocks everything; Stripe's business verification takes a few days, so start it first.

**Phase 1 — Rotterdam + Utrecht pages (EN)**
`/rotterdam/` + its 3 route pages, `/utrecht/` + its route page, from the new city-hub and route-page templates. Book buttons → test-mode Payment Links. Media downloaded from Wix as part of building these pages. Nav/footer updated (View dates fix, Routes ▾ → real city pages).

**Phase 2 — The webhook script (the one real piece of engineering)**
Google Apps Script: verify Stripe signature → Sheet row → guest route email → bar reservation email → **Meta CAPI Purchase + GA4 event** → dedupe. Plus `/booking-confirmed/`. Test end-to-end in Stripe test mode. *This phase gates cutover — nothing goes live without it.*

**Phase 3 — Support pages**
`/how-it-works/`, `/groups/` (form → Apps Script → Sheet + Telegram ping, group price on the page), `/gift-cards/` (tiers + promo-code automation), `/faq/`, `/404.html`, legal pages.

**Phase 4 — Dutch mirror of everything so far**
`/nl/` twins with Dutch slugs, hreflang pairs, toggle rewired to navigate between twins. NL copy largely exists in the current i18n dictionary.

**Phase 5 — Cutover** (the ordered list in section 4). *The site is now fully live and Wix-free.*

**Phase 6 — Amsterdam + Groningen**
`/amsterdam/` + route page, `/groningen/` + route page, EN + NL. Thinner is fine.

**Phase 7 — Growth**
~~`/about/`~~ (**done early** — built from the how-it-works template; see the support-pages table above), occasion pages with the "How many of you?" split, richer route-page photo sets, then London.

---

## 6. OWNER DECISIONS NEEDED

1. **Stripe or Mollie?** → **Default: Stripe.** Ten-minute check first: any existing/dormant Mollie account? Absent one, Stripe's feature set (quantity, date dropdowns, promo codes for gift cards, GBP later) wins.
2. **Real route slugs.** Are the neighbourhood-based guesses right (`/rotterdam/hidden-gems/`, `/rotterdam/city-centre/`, `/rotterdam/premium-gin-walk/`, `/utrecht/city-centre/`, `/amsterdam/noord-city-centre/`, `/groningen/gin-walk/`)? → **Default: name each route after its actual bar-cluster neighbourhood** — real place names beat theme words in local search. Needed before Phase 1 folders are created (renaming later = redirect mess).
3. **Dutch slugs: localized or translated?** → **Default: localized** (`/nl/hoe-het-werkt/`, `/nl/cadeaubonnen/`, `/nl/rotterdam/verborgen-parels/`) — ranks better for Dutch searches; the cost is maintaining two slug sets by hand, acceptable at ~20 pages.
4. **Google Search Console access** for wogococktailwalk.com, to export the full historical URL list for the redirect map. → If no property exists, verify one while the site is still on Wix.
5. **Bar notification emails.** One reservation inbox per bar, per route — the exact list the webhook needs (Phase 2). → Copy whatever Wix currently uses.
6. **Gift card amounts & terms.** → **Default: €30 / €60 / €100 + custom, €60 highlighted**, with the standard Dutch 2-year minimum validity stated on the page.
7. **Group price on the page.** Confirm the per-person group rate (~€32,95?) so `/groups/` can finally show it. → **Default: publish it** — hiding price costs more leads than it protects.
8. **Domain/DNS access.** Where is wogococktailwalk.com registered, and can we move its DNS to free Cloudflare? (Needed for Phase 5; if the domain is registered *through* Wix it should be transferred out before cancelling — flag early, transfers take days.)
9. **Who's on booking-ops after launch?** Editing open nights in Stripe and answering `/groups/` leads becomes a small recurring task — Maroussia or Valeriia (starts Wed 2026-07-08)? → **Default: Valeriia**, with a one-page how-to.

**Resolved, no decision needed:** phone number is already consistent site-wide (+31 20 210 1168); no basket (direct booking flow); no live inventory in v1 (Cloudflare Workers named as the €0 upgrade only after a real incident); no free-cancellation copy anywhere.
