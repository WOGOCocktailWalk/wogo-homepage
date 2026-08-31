# WOGO Migration Playbook — Wix → new site, same domain, no booking drop

**Written 31 Aug 2026 from a live audit of both sites.** Old = Wix at `www.wogococktailwalk.com` (Wix Bookings, Wix Payments, Wix email, Wix-Meta app). New = static site in this repo on GitHub Pages behind free Cloudflare + the self-built booking engine (Cloudflare Worker + D1 + Stripe Checkout + Brevo) in `backend/`.

**Success = a guest can find the site → navigate → understand the offer → start a booking → pay → get the confirmation email, and WOGO can measure that booking.** Everything below is ordered by that, not by SEO.

Owners used throughout: **Owner** = Maroussia (dashboards, money, accounts). **Dev** = whoever executes in this repo/Cloudflare/Stripe. **Both** = owner clicks, dev verifies.

---

## 0. Executive summary — what the audit found (read this first)

The new site is far along (booking engine deployed, 284 tests, emails designed, legal pages, consent banner) but **it is not launch-safe today**. Eleven blockers were found by actually inspecting the repo, the live Wix site and the ad account:

| # | Finding (verified 31 Aug 2026) | Why it drops bookings | Fix in |
|---|---|---|---|
| 1 | **`/booking-confirmed/` does not exist.** `backend/src/stripe.js` sends every paying guest to `${SITE_URL}/booking-confirmed/?session_id=…` — today that's a 404 *right after payment*. | Guests think payment failed → double-pay, chargebacks, support flood. | §2, §14 |
| 2 | **Zero tracking on the new pages.** No GA4, no Meta Pixel, no GTM in any customer page (only inside `CONSENT-SNIPPET.html` as a reference). | Ads keep spending with no conversion signal; Meta's optimization collapses; you can't tell if launch worked. | §4 |
| 3 | **Meta CAPI is an unconfigured stub** (`backend/src/meta.js` no-ops without `META_ACCESS_TOKEN`) **and points at pixel `652971109400692`** (the old browser pixel "…692"). Live ads optimise on the pixel ending **…94** via the Wix-Meta app, which dies with Wix. | Purchase/InitiateCheckout events vanish → learning phase reset → CPA spikes for 1–2 weeks. | §4, §6 |
| 4 | **Delft ad set is ACTIVE, the new site has no `/delft/` page** (route exists in D1/config, no page, not in sitemap). | Delft ad clicks → 404 the moment DNS flips. | §6 |
| 5 | **No Dutch mirror.** Wix serves a live `/nl` site (hreflang `nl-nl`); ads run Dutch-only; new site is EN-only with 0 hreflang tags. | Dutch searchers/ad clickers land on English pages → lower conversion + lost NL rankings. | §5 |
| 6 | **Every customer page still carries `<meta name="robots" content="noindex">`** and `index.html` canonicals to the Wix homepage. | Forget one and the whole site drops out of Google. | §5, §14 |
| 7 | **Stripe is in test mode** (`STRIPE_SECRET_KEY` = test) and **`EMAIL_TEST_REDIRECT`** still routes all guest/bar mail to `maroussiastyles@gmail.com`. | Real guests can't pay / bars never get reservations. | §2, §8 |
| 8 | **Redirect map has 3 lines**; the old site has **226 URLs** (28 pages, 12 service pages, 6 live booking calendars, 34 blog posts, a store, 138 member profiles) plus a `/nl` twin. | Every unmapped URL in Google, ads, WhatsApp, GBP, GetYourGuide → 404. | §5, §6 |
| 9 | **Future Wix bookings and unredeemed Wix gift cards are not carried over.** Nothing imports them into D1 or Stripe promo codes. | Double-booked bars on already-sold dates; gift-card holders can't redeem (legal + reputational). | §2 |
| 10 | **No UTM tags on any of the ~15 active Meta ads**, and only 1 of 31 ad links is API-readable — the destination inventory must be done by hand in Ads Manager. | You can't separate "ads stopped converting" from "site converts worse". | §6, §10 |
| 11 | **Sending domain has no SPF/DKIM/DMARC for Brevo** (listed in OWNER-SECURITY-TODO §6, not done). | Confirmation emails land in spam → "I paid and got nothing". | §2, §8 |

**Bottom line:** don't schedule a launch date until §14 (red flags) is all green. Realistic sequence: ~2 weeks of build/QA work (this document), a Tuesday-morning cutover, Wix kept alive (paid) for 30 days as the rollback.

---

## 1. Risk assessment — everything that can drop bookings

Legend: **Likelihood / Severity** as HIGH · MEDIUM · LOW. "Test" = how to prove it before launch. "If it happens" = live remedy.

### A. Website / technical

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| DNS flip misconfigured (wrong CNAME/A for GitHub Pages, www vs apex mismatch) → site unreachable | MEDIUM | HIGH | Add both `www` CNAME → `wogococktailwalk.github.io` and apex A records (185.199.108–111.153); set TTL 60s; enable "Enforce HTTPS" in repo settings only after cert issued | On staging: `dig www.wogococktailwalk.com`, `curl -I` both hosts, both → 200 | Revert DNS to Wix records (kept in `CLOUDFLARE-SETUP.md`, see §12) |
| HTTPS certificate not yet issued after flip (GitHub takes 5–60 min) → browser warning | HIGH | HIGH | Add custom domain in GitHub Pages settings **before** DNS flip; wait for "Certificate active" | Repo → Settings → Pages shows green check | Cloudflare SSL mode "Full" + wait; if >1 h, rollback DNS |
| Cloudflare proxy (orange cloud) + GitHub Pages cert conflict ("too many redirects") | MEDIUM | HIGH | SSL/TLS mode = **Full** (not Flexible); no redirect loops | Load site in incognito, mobile data, desktop | Toggle to Full; if loop persists set records DNS-only |
| Shared nav/footer/consent blocks not byte-identical across pages (hand-copied) → broken links on some pages | MEDIUM | MEDIUM | `grep` diff of fenced blocks across pages (script in §9) | Link crawler (§9) | Patch + push (Pages deploys in ~1 min) |
| Relative-path bugs on deeper folders (`/rotterdam/x/book/` uses `../../../`) | MEDIUM | MEDIUM | Crawl every page for 404 assets | Crawler + browser console | Patch |
| GitHub Pages outage (rare) | LOW | HIGH | Cloudflare "Always Online" (free) serves cached copy | — | Wait; booking engine is separate (Worker) so /book/ pages cached still work |
| Worker (`wogo-booking-backend`) on `workers.dev` URL, not custom domain → third-party-cookie/CSP oddities, harder Access setup | MEDIUM | MEDIUM | Add `api.wogococktailwalk.com` custom domain at cutover; update `WOGO_API`, Stripe webhook URL, UptimeRobot | Booking test after switch | Keep workers.dev as fallback URL in widget config |
| Bot Fight Mode blocks Stripe webhook (server-to-server call) | MEDIUM | HIGH | WAF skip rule for `/webhooks/*` and `/api/*` (OWNER-SECURITY-TODO §2) | Real booking immediately after toggling | Disable Bot Fight Mode |
| Wix media (`static.wixstatic.com`) still referenced anywhere → images vanish when Wix is cancelled | MEDIUM | MEDIUM | `grep -r wixstatic` = 0 hits | Same | Re-host, or keep Wix paid |

### B. Booking system (see §2 for the full funnel)

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| Success page 404 (`/booking-confirmed/` missing) | **CERTAIN today** | HIGH | Build page; reads `session_id`, shows "you're booked", noindex | Real booking | Rollback tier 1 (§12) |
| Stripe still in test keys / webhook secret mismatch live | HIGH | HIGH | Go-live checklist §8; `wrangler secret put` live keys; new live webhook endpoint | Real €29,95 booking, refunded | Tier 1 rollback |
| Webhook fails silently → paid but no D1 row, no emails | MEDIUM | HIGH | `error_log` + crash alerts already built; Stripe dashboard "webhook attempts" | Stripe CLI resend + real booking | Manual booking in admin + email; replay webhook from Stripe |
| Emails to spam (no SPF/DKIM/DMARC for Brevo) | HIGH | HIGH | Authenticate `wogoamsterdam.com` in Brevo, add DNS records | mail-tester.com score ≥ 9; test to Gmail/Outlook/iCloud | Resend from Gmail manually; fix DNS |
| `EMAIL_TEST_REDIRECT` left set → bars and guests get nothing | HIGH | HIGH | Delete secret at go-live (`wrangler secret delete EMAIL_TEST_REDIRECT`) | Real booking → guest inbox + bar inbox | Delete secret, resend from admin |
| Capacity wrong: Wix bookings for future dates not imported → overbooking | HIGH | HIGH | Export Wix Bookings → manual bookings in admin (blocks seats, no emails) | Admin week grid shows Wix bookings | Manual outreach to bars/guests |
| Gift cards sold on Wix not redeemable | HIGH | HIGH | Export Wix gift-card balances → Stripe promo codes (same code, same amount, one-use) | Redeem one test code | Honour by hand: manual booking + refund/discount |
| iDEAL/Klarna/Apple Pay not enabled in live Stripe | MEDIUM | HIGH | Enable in Stripe → Payment methods before launch | Checkout shows iDEAL first on NL IP | Enable; no rollback needed |
| Hold expiry (15 min) too short on slow mobile → "seat gone" errors | LOW | MEDIUM | Keep 15; monitor `holds_expired` vs completions | Slow-3G test | Raise to 20 |
| Guest closes Stripe tab, returns → hold gone, confusing message | MEDIUM | LOW | Clear "start again" message in widget | Test | Copy fix |
| Duplicate submissions (double-click) | LOW | MEDIUM | Idempotent hold + Stripe session dedupe (built) | Double-click test | Refund duplicate |

### C. UX / conversion

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| Extra step vs Wix (route page → /book/ page → Stripe) lowers completion | MEDIUM | HIGH | Sticky "Book" bar; keep ≤3 clicks to payment; pre-select route | Click-count audit (§3) | Embed calendar on route page |
| Dutch visitors get English (no /nl/) | HIGH | HIGH | Build /nl/ for the 5 ad cities + home + how-it-works + faq before cutover | Ad click from Dutch IP | Temporary NL banner + language toggle |
| Price/trust numbers missing in first screen on some pages | LOW | MEDIUM | Conversion rules in SITE-PLAN | Screenshot review per page, mobile | Copy fix |
| Cookie banner blocks the Book button on small screens | MEDIUM | HIGH | Banner ≤ 30% viewport, never covers sticky CTA | iPhone SE + Android small | CSS fix |
| Cold-traffic pages open with hard "Book now" instead of "View dates" | LOW | LOW | SITE-PLAN CTA honesty rule | Review | Copy |
| Reviews/social proof fewer than Wix page | MEDIUM | MEDIUM | Port the same Google/Trustpilot quotes + counts | Side-by-side | Add |

### D. SEO / organic

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| `noindex` left on any page | HIGH | HIGH | Scripted removal + grep = 0 (§5) | `curl` each sitemap URL, grep robots meta | Remove, push, GSC "request indexing" |
| Canonical still → Wix homepage | HIGH | HIGH | Self-referencing canonicals | Same | Fix |
| Redirect map incomplete (226 old URLs) | HIGH | HIGH | Full map in §5.4 loaded into Cloudflare Bulk Redirects | Script hits every old URL, expects 301 → 200 | Add missing rows (5 min) |
| `/nl` rankings lost | HIGH | MEDIUM | /nl/ mirror + hreflang; else 301 /nl/* → EN equivalents (temporary) | Ahrefs/GSC NL landing pages | Build /nl/ |
| Blog: 34 posts → 8 rebuilt, 26 redirected to /blog/ | MEDIUM | LOW–MEDIUM | Check GA4 landing-page traffic per post; rebuild the top-traffic ones | GA4 baseline (§10) | Rebuild post, 301 to it |
| Schema regressions (Wix had FAQPage + Product with price) | MEDIUM | MEDIUM | Port Product/Offer + FAQPage JSON-LD | Rich Results Test on 4 city pages + FAQ | Add |
| llms.txt lost (Wix auto-file, hand-edited) | HIGH | LOW | Copy to `/llms.txt` in repo | curl | Add |
| Two GA4 properties on Wix — the wrong one gets migrated | MEDIUM | MEDIUM | Identify the real one (§4.1) | GA4 realtime | Add both temporarily |

### E. Paid traffic

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| Ad destination URLs still point at Wix paths → redirect (fine) or 404 (Delft/NL) | HIGH | HIGH | Update all ~15 active ads to new URLs with UTMs on launch day (§6) | Click each ad preview | Fix in Ads Manager |
| Optimization event (Initiate Checkout via Wix CAPI) disappears → learning reset | CERTAIN | HIGH | Fire IC + Purchase from new stack (browser + CAPI, deduped) *before* cutover; switch ad-set optimisation event same day | Events Manager "Test events" | Expect 3–7 days of weaker CPA; don't touch budgets/creatives |
| Wrong pixel ID in CAPI (…692 vs …94) | HIGH | HIGH | Confirm in Events Manager which pixel the ad sets use; set `META_PIXEL_ID` accordingly | Test event appears under the right pixel | Change config, redeploy |
| Domain verification for pixel/aggregated events on Meta tied to Wix | MEDIUM | MEDIUM | Verify `wogococktailwalk.com` via DNS TXT in Business Settings (works regardless of host) | Business Settings → Domains green | Re-verify via meta-tag |

### F. Analytics & tracking — see §4. Headline: today nothing on the new site sends any event anywhere.

### G. Marketing integrations

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| 25k Wix contacts + automations (welcome, post-walk, review request) lost | HIGH | HIGH | Export CSV (subscribed only) → Brevo; rebuild automations | Test signup → welcome email w/ WELCOME10 | Re-import |
| Newsletter signup form on new site not wired to Brevo | MEDIUM | MEDIUM | Brevo form/API; consent checkbox | Submit test | Wire |
| GetYourGuide/Viator/Tripadvisor links → old URLs | HIGH | LOW (301) | Update supplier dashboards after launch | Click | — |
| WhatsApp bridge / customer agent link to old URLs in playbook | MEDIUM | LOW | Update `~/Projects/wogo/customer-service/playbook.md` | grep | Update |
| Group form → Telegram/Sheet not tested live | MEDIUM | MEDIUM | Submit test | Same | Fix |

### H. Performance — see §8. Risks: hero video autoplay on mobile, unoptimised posters, Poppins/Inter font blocking, widget JS blocking paint.

### I. Mobile

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| ~70–80% of WOGO traffic is mobile; calendar widget unusable on small screens (tap targets, date picker) | MEDIUM | HIGH | 44px targets; test iPhone SE, iPhone 15, Pixel, Samsung Internet | Real devices + BrowserStack free trial | Hotfix CSS |
| Apple Pay absent on Safari (domain not registered in Stripe) | MEDIUM | MEDIUM | Stripe → Apple Pay → add `wogococktailwalk.com` + host `.well-known` file (Stripe-hosted Checkout handles this automatically — verify) | Safari on iPhone shows Apple Pay | Cards still work |
| Sticky CTA overlaps iOS Safari bottom bar | MEDIUM | MEDIUM | `env(safe-area-inset-bottom)` | iPhone | CSS |

### J. Content / trust

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| Trust numbers inconsistent (80,000+ walks, 4.4★, Trustpilot 4.5) | LOW | MEDIUM | Single source in shared block | grep | Fix |
| Policy text contradicts T&C (free cancellation wording) | LOW | HIGH | Never say free cancellation; 48h reschedule only | Read every CTA/FAQ | Fix |
| Old Wix reviews widget gone → fewer visible reviews | MEDIUM | MEDIUM | Static quotes + link to Google/Trustpilot | Visual | Add |

### K. External links & customer journeys — see §7.

### L. Legal / privacy / consent

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| Pixel/GA4 fire before consent | MEDIUM | MEDIUM (fine + Meta data quality) | Load only when `wogoConsent.marketing/analytics === true`; Consent Mode v2 defaults denied | Reject → no `facebook.com/tr`, no `collect` requests | Fix loader |
| Privacy policy lacks Stripe/Brevo/Cloudflare/Meta processors | HIGH | LOW | Edit `/privacy/` | Read | Edit |
| Gift-card and booking T&C links dead in Stripe Checkout (terms URL) | MEDIUM | LOW | Set Stripe → Checkout settings → terms URL to new `/terms/` | Look | Fix |

### M. Operational

| Risk | Likelihood | Severity | Prevent | Test | If it happens |
|---|---|---|---|---|---|
| Gmail filters that forward Wix confirmations to bars keep running on old-format mail; new engine emails bars directly → bars get nothing or duplicates during overlap | HIGH | HIGH | Bars receive from Brevo only; keep Gmail filters for Wix bookings already made; document who gets what for 30 days | Booking test both paths | Manual forward |
| Nobody watching Stripe/admin on launch evening | MEDIUM | HIGH | Named person + phone for first 72h (§13) | — | — |
| Wix cancelled too early (contacts/media/gift cards gone) | LOW | CATASTROPHIC | Rule: Wix cancelled only after 30 clean days + exports verified | Checklist | Nothing — this is irreversible |
| Domain registered through Wix; cancelling Wix drops the domain | MEDIUM | CATASTROPHIC | Check registrar now (Wix → Domains); transfer to Cloudflare Registrar (at-cost) before cancelling | WHOIS | Nothing |

---

## 2. Booking system — the full funnel, every break point, how to test

### 2.1 The funnel, old vs new

| Step | Old (Wix) | New | Break points |
|---|---|---|---|
| Landing | `/`, `/utrecht`, `/rotterdam-cocktail-walk-route1`, `/nl/*` | `/`, `/{city}/`, `/{city}/{route}/` | 404 if unmapped; EN-only for NL visitors |
| Info page | same page + `/service-page/*` | route page | price/time/what's-included must be present |
| CTA | "Book now" → `/booking-calendar/{service}` | "Book your walk" → `/{city}/{route}/book/` | relative href errors; sticky bar |
| Booking interface | Wix calendar (10 seats/departure, ≤6/booking) | `backend/widget/wogo-calendar.js` on the /book/ page, reading the Worker | `WOGO_API` unreachable; CORS; widget dormant guard |
| Availability | Wix live seats | Worker `/api/routes/:slug/availability` from D1 (`capacity`, `routes_bars`, date overrides) | missing Wix bookings; wrong per-hour caps; closed days (ULU Mondays) not set |
| Selection | date + time + party | date → time → party (1–6) | hold (15 min) creation fails → "seat gone" |
| Customer details | Wix form (`/booking-form`) | widget form (name, email, phone, allergies, language) | validation; honeypot; rate limits (5 per 10 min per IP — beware shared corporate/NAT IPs on group bookings) |
| Payment | Wix Payments (iDEAL 2.5%+€0.30) | Stripe Checkout (iDEAL, cards, Apple/Google Pay, Klarna; promo-code field) | test keys; methods not enabled; currency; promo field hidden |
| Confirmation page | Wix thank-you page | `/booking-confirmed/?session_id=` | **page missing**; must poll Worker for status, not assume success |
| Webhook | Wix internal | Stripe → `/webhooks/stripe` (signature-verified) → D1 booking → Brevo emails → Meta CAPI + GA4 MP | wrong secret; Bot Fight Mode; Brevo key; CAPI token |
| Emails | Wix: confirmation + separate map email; Gmail filter forwards to bars (start time only) | Brevo: ONE guest email (EN/NL, map button) + owner copy + per-bar staggered-time emails | spam; test-redirect; wrong map URL for city; poster missing |
| Post-booking | `/cancel-reservation` (already 404 on Wix!) | reschedule/cancel = email to info@; admin move/cancel endpoints **not yet built** | guests can't self-serve → support load (same as today) |

### 2.2 Break-point checklist (each must be tested by hand AND scripted)

- **Booking buttons:** every `href="book/"`, `../x/book/`, nav "Book your walk", sticky bar, footer routes — crawler asserts 200 and that the target page contains `wogo-calendar`.
- **Widget:** loads on every `/book/` page; `data-route` slug matches a D1 route (`rotterdam-witte-de-with`, `rotterdam-hidden-gems`, `rotterdam-premium-gin`, `utrecht…`, `amsterdam…`, `groningen…`, `delft…`, `london-soho` placeholder must stay hidden/noindex).
- **Deep links:** `/{city}/{route}/book/?date=YYYY-MM-DD` — decide whether to support; old `/booking-calendar/*` links 301 to the matching `/book/` page.
- **Availability API:** `curl $WOGO_API/api/routes/<slug>/availability?from=…` returns open slots for the next 60 days for each route; closed weekdays and date overrides match the Wix calendar exactly (print both side by side for 4 weeks).
- **Calendar integrations:** none (Apple Calendar embed is personal). Bar `.ics` feed = later.
- **Payment processing:** live keys; iDEAL first for NL; Klarna enabled; 3DS card test; declined-card test (Stripe test card 4000 0000 0000 0002 in test mode; in live mode use a real card with insufficient funds or a prepaid €1 card).
- **Payment confirmation:** Worker marks booking `paid` only from the webhook, never from the success URL.
- **Confirmation page:** shows route, date, time, party, reference; "check your inbox (and spam)"; no purchase-event double-fire on refresh (use `sessionStorage` flag or Worker `tracked` flag).
- **Confirmation emails:** EN and NL versions; map button opens correct city PDF; from-address `info@wogoamsterdam.com` authenticated; reply-to works; renders in Gmail app, iOS Mail, Outlook web.
- **Bar emails:** each bar gets its own email with its own arrival time (+0/+60/+120); correct bar inbox per route (control in admin Route manager); guest contact + allergies present.
- **Mobile & desktop:** full purchase on iPhone Safari, Android Chrome, desktop Chrome, desktop Safari.
- **Error messages:** slot gone, hold expired, payment cancelled (Stripe `cancel_url` → route page — make it say "your seats were released, pick again"), API down (widget shows phone/email fallback, not a blank).
- **Failed payments:** hold released after expiry; guest can retry; no ghost bookings in D1.
- **Abandoned bookings:** holds table cleaned by cron; count them (baseline for abandonment rate).
- **Tracking completed bookings:** Purchase (Meta CAPI + browser pixel deduped by `event_id`), GA4 `purchase` with `transaction_id` = booking reference, value, currency.
- **Tracking abandoned bookings:** GA4 `begin_checkout` (slot chosen) and `add_payment_info` (redirected to Stripe); Meta `InitiateCheckout` at slot chosen.
- **Booking reference numbers:** unique, human-readable (e.g. `WOGO-2026-000123`), present in guest email, bar email, admin, Stripe metadata.
- **Customer emails in D1:** normalised lowercase; GDPR retention cron live.
- **CRM:** Brevo contact created/updated on booking with attributes (city, date, language) + opt-in flag only if ticked.
- **Webhooks/API:** Stripe webhook endpoint = live URL; signing secret matches; Stripe "webhook attempts" 100% 2xx over the test window.
- **Third-party booking providers:** GetYourGuide/Viator bookings are NOT in D1 → they must be added as manual bookings (already the case today via Wix? confirm — if GYG bookings were entered in Wix, keep that habit in admin).
- **Product-specific links:** gift cards (`/gift-cards/` → Stripe Payment Link or Checkout in `payment` mode; webhook creates promo code, emails buyer); groups (`/groups/` form → Sheet/Telegram; price €32,95 shown).

### 2.3 Data that must move before cutover

| Data | Export from Wix | Import to |
|---|---|---|
| Bookings with dates ≥ cutover day | Wix Dashboard → Bookings → export CSV (all upcoming) | Admin → Customers → manual booking per row (party, route, date, time, email, phone, "source: wix", **no emails**) |
| Unredeemed gift cards | Wix → Gift cards → export (code, balance, expiry) | Stripe → Coupons: amount-off coupon per balance + promotion code = same Wix code; expiry = same |
| Contacts (subscribed only) | Contacts → Export | Brevo list "WOGO guests" + import date attribute |
| Discount codes in use (influencer/partner codes) | Wix → Marketing → Coupons | Stripe promotion codes, same string |
| Media | Media Manager → download all | `assets/` in repo |
| Blog posts (34) | copy text/images | rebuild top ones; rest 301 → `/blog/` |
| Reviews text used on pages | copy | static |

### 2.4 Exact pre-launch booking test plan (run on `wogococktailwalk.github.io` with LIVE Stripe keys, 3 days before cutover)

1. `wrangler secret put STRIPE_SECRET_KEY` (live) · create live webhook in Stripe → put `STRIPE_WEBHOOK_SECRET` · **delete** `EMAIL_TEST_REDIRECT` · set `META_ACCESS_TOKEN` (System User, scope `ads_management`/`business_management` for CAPI — the babysitter token has only `ads_read`, it will NOT work) · set `GA4_API_SECRET`.
2. Owner makes a real €29,95 booking for Utrecht by iDEAL from her phone. Expect within 60 s: Stripe payment succeeded → admin shows booking `paid` → guest email in her inbox (not spam) → bar test inbox gets email with +0 time → owner copy → Meta Events Manager shows Purchase (CAPI, `event_id` matches browser) → GA4 realtime shows `purchase` with value 29.95.
3. Repeat with a card (3DS), then cancel one checkout at Stripe → confirm hold releases in ≤15 min and the slot is bookable again.
4. Book the LAST seat of a capped slot with two browsers simultaneously → exactly one succeeds.
5. Apply a test promo code (100% off test coupon) → €0 checkout completes → booking created, `discount` recorded.
6. Refund the real bookings in Stripe by hand; note that refunds do **not** cancel the D1 booking (no cancel endpoint yet) → delete via admin or leave flagged. **Decide before launch** who does this.
7. Group form and gift-card purchase once each.
8. Record the timings and screenshots in `backend/LAUNCH-TEST-LOG.md`.

---

## 3. Conversion rate — why bookings fall even when traffic doesn't

A redesign changes the *sequence of small decisions* a visitor makes. Each of these can shave 5–20% off completion without any traffic change:

| Element | What to check on the new site | Preserve from Wix |
|---|---|---|
| CTA placement | Book CTA visible without scrolling on mobile on every city/route page; sticky bar appears after 1 screen | Wix had "Book now" at top of route pages → keep |
| CTA visibility | Salmon button on cream: contrast ≥ 4.5:1; not below the fold behind a video | — |
| Clicks to book | Wix: page → calendar → form → pay = 3. New: page → /book/ → widget (date, time, party, details) → Stripe = 3–4. **Do not exceed 4.** Consider embedding the widget on the route page itself later | — |
| Navigation | Routes ▾ lists all routes incl. Delft; Groups/Gift cards visible; About/FAQ in footer only (fine) | Wix nav had Blog & Delft top-level — keep Delft reachable in 1 click |
| Mobile UX | 44px targets, no horizontal scroll, date picker native or large | — |
| Layout | City name in H1, price + trust badge in first screen, "how it works" before hard CTA | Wix city pages already did this → keep |
| Trust signals | ★4.4 Google · Trustpilot 4.5 · 80,000+ walks · Gemeente Rotterdam partner on every city page | Keep exact numbers |
| Reviews/testimonials | Same quotes as Wix, named, with city | Preserve the same 6–8 quotes |
| Pricing visibility | €29,95 / €34,95 premium / €32,95 groups printed, not hidden | Wix showed prices in booking calendar → now show earlier |
| Availability info | Real next-available dates on the route page (pull from API) — no fake scarcity | Wix calendar showed real slots → match |
| Images | Real guests, real bars; posters as secondary | Reuse the same hero images that ran during the best-converting months |
| Copy | Same promise ("3 bars, 3 cocktails, self-guided, 3–4 h") | Keep the FAQ answers verbatim where they answer objections (18+, mocktails, groups, language) |
| Social proof | Press logos, "80,000+" | Keep press strip |
| Friction | No account, no basket, no forced newsletter | Same as Wix |
| Speed | See §8 | — |
| Popups | None on first visit; consent banner only | Wix may have had a newsletter popup — do not port it |
| Cookie banner | Reject as easy as Accept; ≤ 30% of screen; never covers CTA | — |
| Forms | Widget form 5 fields max; phone optional?; language auto-detected | — |
| Checkout | Stripe: iDEAL at top for NL, Apple Pay on iPhone; promo field present; terms link works | Wix had discount-code field → keep visible |
| Broken links | 0 (§9) | — |
| Journey change | Dutch ad → Dutch page (needs /nl/) | Wix /nl/ existed → rebuild |

**Preserve list (things that may be silently carrying conversion today):** the Dutch pages; the city H1 + price pattern; the exact review quotes; the "how it works" 3-step strip; the discount-code field at checkout; the FAQ answers; the hero photos on Rotterdam/Utrecht; the confirmation email's map delivery promise ("route in your inbox in seconds"); the phone number +31 20 210 1168 in header/footer; WhatsApp contact if present on Wix.

---

## 4. Tracking migration — complete plan

### 4.1 What exists on Wix today (measured 31 Aug)

- GA4: **G-QLXFFEK69D** and **G-45QEXJY544** (two properties — find which one has history: GA4 Admin → Property → check user counts; migrate the real one, keep both live for 30 days).
- Google Ads: **AW-11372694111** (campaigns off since 27 Jul; keep tag for remarketing lists only if you'll use them).
- Meta: browser pixel **652971109400692** (…692, old) via Wix code; **pixel …94 server-side via Wix-Meta app CAPI** — this is what the ad sets optimise on. Confirm the full …94 ID in Events Manager.
- TikTok pixel (via Wix app) — decide keep/drop (drop unless running TikTok ads).
- hreflang EN/NL, Wix consent banner, Wix Analytics (bookings/revenue reports).

### 4.2 Target stack on the new site (all €0)

| Layer | Implementation |
|---|---|
| Consent | Existing `wogoConsent` banner; **Google Consent Mode v2** defaults `denied` before any tag; update on choice |
| Tag management | **GTM (free)** — one container, loaded on every page from the shared snippet; all tags below live in GTM so the developer never touches HTML again for tracking |
| GA4 | Real property; events: `page_view`, `view_item` (route page), `select_date`, `begin_checkout` (slot+party chosen), `add_payment_info` (redirect to Stripe), `purchase` (confirmation page **and** server-side via Measurement Protocol from the webhook with the same `transaction_id` — GA4 dedupes on transaction_id), `generate_lead` (group form), `gift_card_purchase`, `click_phone`, `click_email`, `click_whatsapp`, `outbound_click`, `newsletter_signup` |
| Meta | Browser pixel (…94) via GTM after marketing consent: `PageView`, `ViewContent` (route), `InitiateCheckout` (slot chosen) with `event_id`; CAPI from Worker: `InitiateCheckout` (on hold creation) + `Purchase` (on webhook) with **the same `event_id`** for dedupe; `fbp/fbc` passed from widget to Worker |
| Google Ads | AW tag via GTM only if remarketing needed; conversion action `purchase` imported from GA4 |
| UTMs | Every ad, email, QR, partner link carries `utm_source/medium/campaign/content`; widget stores first-touch UTMs + `fbclid/gclid` in `sessionStorage` and sends them to the Worker as booking metadata → D1 column `attribution` → you can report bookings per source *without* GA4 |
| Cloudflare Web Analytics | cookie-free, no consent needed — the always-on backstop for "is traffic normal" |
| Phone/email/WhatsApp clicks | GTM click triggers on `tel:`, `mailto:`, `wa.me` |
| Thank-you page | `/booking-confirmed/` fires `purchase` once per `session_id` (guard), value from Worker lookup `/api/bookings/status?session_id=` |

### 4.3 How tracking breaks silently in a migration (all applicable here)

1. Tags exist on the homepage template but not on deeper hand-copied pages (`/book/` pages use different relative paths).
2. Consent banner stores "accepted" but the loader never fires because the event name changed.
3. Conversion fires on the success URL, but Stripe redirects to a URL variant (`www` vs apex, trailing slash) that GTM's trigger doesn't match.
4. Purchase counted twice (browser + server) because `event_id` differs.
5. Purchase never counted because the guest closes the tab before the confirmation page loads and there's no server-side event.
6. Meta events land on the wrong pixel (…692 vs …94) — Ads Manager shows zero, Events Manager shows activity elsewhere.
7. Ad set optimisation event still named "Initiate Checkout (Wix CAPI)"; the new event is a *different* source → ad set gets no signal.
8. GA4 property ID copied from the *unused* property.
9. UTMs stripped by a redirect (Cloudflare Bulk Redirects: enable "preserve query string").
10. Cross-domain: Stripe Checkout is on `checkout.stripe.com`; GA4 session breaks unless referral exclusion includes `stripe.com` and the confirmation page carries the client ID (simplest: rely on server-side purchase with `client_id` passed through Stripe metadata).
11. CSP header (from Cloudflare Transform Rules) blocks `googletagmanager.com` / `connect.facebook.net` → tags never load, no console error visible to non-devs.
12. Ad-blockers: 20–30% of browser events missing — that's why the server-side events are the source of truth.

### 4.4 Before vs after validation checklist

| Check | Before (Wix, record now) | After (new site, must match) |
|---|---|---|
| GA4 property receiving hits | ID + daily users last 28 days | Same ID, realtime shows you |
| GA4 `purchase` events/day | from GA4 Monetization report | equal to Stripe payments/day |
| Meta pixel ID receiving PageView | Events Manager | same pixel, new domain |
| Meta `InitiateCheckout`/day, `Purchase`/day | Events Manager, last 28 days | ≥ 80% of old ratio to bookings |
| Event deduplication | n/a | Events Manager → "Event dedup" shows browser+server matched |
| Event Match Quality (Purchase) | today's score | ≥ 6/10 (email hash + fbp/fbc + IP/UA) |
| Ad-set optimisation event | "Initiate Checkout" (Wix CAPI) | new IC event selected in every ad set |
| Meta domain verification | wogococktailwalk.com verified? | verified |
| Google Ads conversion (if kept) | AW-11372694111 action list | imported GA4 purchase |
| Consent: Reject → 0 network calls to google-analytics/facebook | test | test |
| Consent Mode v2 ping present (`gcs=`) | n/a | yes |
| UTMs survive redirects | n/a | `curl -I old-url?utm_source=x` → Location keeps `?utm_source=x` |
| Attribution stored per booking | Wix report by source | D1 `attribution` column populated |
| Phone/email clicks | GA4 events exist? | events exist |
| Thank-you page fires once | n/a | reload page → no 2nd purchase |
| Server purchase without browser | n/a | block JS, book → purchase still in GA4/Meta |

---

## 5. SEO — preserve first, improve later

### 5.1 Assets that must NOT change at launch

- Domain + `www` host (keep `www` as canonical, as Wix does).
- URL slugs of the money pages where possible — but the new structure is already decided; so **every old slug gets a 301** (below).
- Page titles and meta descriptions of the 4 city pages and homepage: copy Wix's current ones verbatim (they rank), improve after 30 days.
- H1 text on city pages ("Cocktail Walk Utrecht" etc.).
- FAQ questions/answers (FAQPage schema is live on Wix).
- Product/Offer schema with price 29.95 on city pages.
- Image file names/alt text where images are reused.
- llms.txt content (hand-edited version).
- `/nl` mirror (rebuild or redirect — don't just drop).
- Internal link targets from blog posts to city pages.

### 5.2 Things to fix in the same push (safe)

Remove all `noindex`; self-referencing canonicals; `sitemap.xml` (already final); `robots.txt` (already final); hreflang pairs once `/nl/` exists; London pages stay `noindex` until real.

### 5.3 Scripted checks (dev runs, outputs go in the launch log)

```bash
# 1. no noindex on indexable pages
grep -rl 'name="robots" content="noindex"' --include=index.html . | grep -v -e london -e booking-confirmed -e CONSENT
# 2. canonical = own URL
for f in $(find . -name index.html -not -path './backend/*'); do echo "$f $(grep -o 'rel="canonical" href="[^"]*"' $f)"; done
# 3. every sitemap URL is 200 after launch
for u in $(grep -o '<loc>[^<]*' sitemap.xml | sed 's/<loc>//'); do printf "%s %s\n" "$(curl -s -o /dev/null -w '%{http_code}' $u)" "$u"; done
# 4. every OLD url 301s to a 200
while read old new; do code=$(curl -s -o /dev/null -w '%{http_code}' -L "https://www.wogococktailwalk.com$old"); loc=$(curl -s -o /dev/null -w '%{redirect_url}' "https://www.wogococktailwalk.com$old"); echo "$code $old -> $loc"; done < redirects.txt
```

### 5.4 Redirect map (load into Cloudflare → Bulk Redirects, 301, preserve query string, subpath matching OFF except where noted)

**Owner decisions needed before loading:** Schiedam route (still sold? else → `/rotterdam/`); Amsterdam Route 2 Premium (still sold? else → `/amsterdam/`); Barcelona (never operated → `/`); Amsterdam Cocktail Week walks (seasonal → `/amsterdam/`).

| Old (Wix) | New |
|---|---|
| `/` | `/` |
| `/nl` and `/nl/*` | `/nl/` mirror (build) — fallback `/nl/{slug}` → EN twin |
| `/utrecht` | `/utrecht/` |
| `/rotterdam-cocktail-walk-route1` | `/rotterdam/witte-de-with/` |
| `/rotterdam-cocktail-walk-route-2` | `/rotterdam/hidden-gems/` |
| `/rotterdam-premium-cocktail-walk` | `/rotterdam/premium-gin-walk/` |
| `/amsterdam-cocktailwalk-route1` | `/amsterdam/` |
| `/amsterdam-cocktailwalk-route2-premium` | `/amsterdam/` (decision) |
| `/groningen-cocktail-walk` | `/groningen/` |
| `/delft` | `/delft/` (**build**) |
| `/schiedam-cocktail-walk` | `/rotterdam/` (decision) |
| `/barcelona-cocktailwalk` | `/` (410 acceptable) |
| `/amsterdam-cocktail-week-luxury-cocktail-walk`, `/amsterdam-cocktail-week-discovery-cocktail-walk` | `/amsterdam/` |
| `/groupbookings` | `/groups/` |
| `/gift-cards` | `/gift-cards/` |
| `/how-it-works` | `/how-it-works/` |
| `/faq` | `/faq/` |
| `/about` | `/about/` |
| `/workwithus` | `/about/` (or `/contact/`) |
| `/blog` | `/blog/` |
| `/experiences`, `/experience-details`, `/book-online`, `/reservations`, `/bars`, `/plans-pricing`, `/search`, `/copy-of-home` | `/` |
| `/booking-form` | `/` |
| `/booking-calendar/utrecht-cocktail-walk` | `/utrecht/book/` |
| `/booking-calendar/wogo-rotterdam-cocktail-walk`, `/booking-calendar/wogo-cocktail-walk-route-1` | `/rotterdam/witte-de-with/book/` |
| `/booking-calendar/rotterdam-cocktail-walk-route-2` | `/rotterdam/hidden-gems/book/` |
| `/booking-calendar/rotterdam-premium-cocktail-walk` | `/rotterdam/premium-gin-walk/book/` |
| `/booking-calendar/groningen-cocktail-walk` | `/groningen/book/` |
| `/booking-calendar/*` (any other) | `/` |
| `/service-page/wogo-rotterdam-cocktail-walk-route1`, `/service-page/wogo-cocktail-walk-route-1` | `/rotterdam/witte-de-with/` |
| `/service-page/rotterdam-cocktail-walk-route-2` | `/rotterdam/hidden-gems/` |
| `/service-page/rotterdam-premium-cocktail-walk`, `/service-page/wogo-cocktail-walk-route-2-premium` | `/rotterdam/premium-gin-walk/` |
| `/service-page/utrecht-cocktail-walk` | `/utrecht/` |
| `/service-page/groningen-cocktail-walk` | `/groningen/` |
| `/service-page/delft-cocktail-walk` | `/delft/` |
| `/service-page/schiedam-cocktail-walk` | `/rotterdam/` |
| `/service-page/acw-luxury-cocktail-walk`, `/service-page/acw-discovery-cocktail-walk` | `/amsterdam/` |
| `/service-page/special-group-cocktail-walk` | `/groups/` |
| `/cancel-reservation` (already 404 on Wix, but in old emails) | `/contact/` |
| `/post/amsterdam-cocktail-week-bars` | `/blog/amsterdam-cocktail-week-bars/` |
| `/post/best-cocktail-bars-in-rotterdam` | `/blog/best-cocktail-bars-in-rotterdam/` |
| `/post/summer-cocktail-recipes` | `/blog/summer-cocktail-recipes/` |
| `/post/new-bars-in-rotterdam-to-add-to-your-night-out` | `/blog/new-bars-rotterdam-night-out/` |
| `/post/discover-rotterdam-s-new-premium-cocktail-walk-in-rotterdam-with-bobby-s-gin` | `/blog/rotterdam-premium-gin-walk-launch/` |
| `/post/top-7-bars-in-utrecht-to-visit-for-a-great-night-out` | `/blog/top-7-bars-utrecht/` |
| `/post/discover-an-ultimate-night-out-in-utrecht-one-cocktail-at-a-time` | `/blog/utrecht-night-out-cocktails/` |
| `/post/top-5-cocktail-bars-in-rotterdam-on-the-wogo-cocktail-walk` | `/blog/best-cocktail-bars-in-rotterdam/` |
| `/post/discover-the-route-1-of-wogo-cocktail-walk-in-amsterdam` | `/amsterdam/` |
| `/post/bobbys-cocktail-walk-groningen`, `/post/best-bars-in-groningen` | `/groningen/` |
| `/post/top-7-bars-in-amsterdam`, `/post/best-bars-in-amsterdam`, `/post/5-best-cocktail-bars-to-visit-in-amsterdam-this-summer`, `/post/amsterdam-cocktail-week` | `/amsterdam/` (or rebuilt post) |
| `/post/*` (remaining 18 recipe/education posts) | `/blog/` — rebuild any with >50 sessions/month in the GA4 baseline |
| `/blog/categories/*`, `/blog/tags/*` | `/blog/` |
| `/product-page/*`, `/category/*` (store) | `/gift-cards/` |
| `/*/profile` (138 member pages) | 410 Gone (Cloudflare rule: path ends with `/profile` → 410) |
| `/sitemap.xml`, `/robots.txt`, `/llms.txt` | served by new site |
| **`wogo.city`** (old domain, still live) | 301 whole domain → `https://www.wogococktailwalk.com/` |
| `static.wixstatic.com/...` | not redirectable — self-host |

### 5.5 Post-launch SEO tasks (day 0–30)

Submit sitemap in GSC + Bing; "Request indexing" for `/`, 5 city pages, Rotterdam routes; watch GSC → Pages → "Not found (404)" weekly; check "Crawled – currently not indexed" doesn't balloon; compare top 20 queries' average position at day 14 and 30 with baseline; Core Web Vitals report (field data appears after ~28 days).

---

## 6. Paid & external traffic — URL inventory

### 6.1 Where old URLs live (fill the table in `LAUNCH-URL-INVENTORY.md` — owner, 1 hour)

| Source | What to check | Action at launch |
|---|---|---|
| Meta Ads — **5 active ad sets (Delft, Utrecht, Amsterdam, Rotterdam, Groningen), ~15 active + ~16 paused ads** | Ads Manager → each ad → Website URL. Only "Amsterdam Poster" is API-readable (`/amsterdam-cocktailwalk-route1`); all others must be opened by hand | Change to new URL + UTMs (`?utm_source=meta&utm_medium=paid&utm_campaign={city}&utm_content={ad}`) — editing the URL does **not** reset learning; changing the optimisation event does |
| Meta ad-set optimisation event | "Initiate Checkout" via Wix CAPI | Switch to the new IC event (same day as DNS flip) |
| Instagram bio link / link-in-bio tool, Facebook page CTA, TikTok bio | current URL | homepage or `/nl/` |
| Google Business Profile | Website = wogococktailwalk.com; booking link? | keep; add "Book" link → `/` |
| GetYourGuide / Viator / Tripadvisor supplier pages | "website" fields, meeting-point links | update after launch (301 covers meantime) |
| Email: Brevo/Wix automations, signatures, past newsletters | links in templates | update templates; old links 301 |
| WhatsApp: saved replies, WhatsApp Business catalogue/links, customer-agent playbook | `~/Projects/wogo/customer-service/playbook.md` | update |
| QR codes on route maps, bar table cards, posters, flyers | scan each city's PDF/poster (Desktop `WOGO 2026/All Routes/*`) | keep 301s forever; regenerate on next print |
| Partnerships (Gemeente Rotterdam, Rotterdam Partners, bars' own sites, hotels, uitjes.nl, 1001activiteiten) | backlink list (Ahrefs free / GSC → Links) | email them a new URL only if the page changed meaning |
| Affiliates / influencers / gift-card resellers | any discount-code landing pages | keep codes valid in Stripe |
| Press backlinks (5) | GSC → Links → Top linking sites | 301 |
| Saved/bookmarked URLs, old confirmation emails (`/cancel-reservation`, `/booking-calendar/*`) | — | 301 |
| Direct traffic | — | homepage unchanged |
| Google Ads (off) | ads, sitelinks, final URLs — if ever resumed | update before resuming |
| Old domain `wogo.city` | still resolves | 301 |

### 6.2 Landing-page relevance rule

Cold paid traffic always lands on the city page (`/{city}/` or `/nl/{city}/`), never on `/book/`. Retargeting may land on `/book/`. Every ad's language must match the page language — Dutch ads → `/nl/` once built; until then EN pages with a Dutch hero line is the minimum.

---

## 7. Customer experience — old journeys that must keep working

| A guest who… | What must happen |
|---|---|
| Bookmarked `/utrecht` | 301 → `/utrecht/` in <300 ms, UTM-free |
| Clicks an old Google result (`/rotterdam-cocktail-walk-route1`, `/post/...`) | 301 to the route page; Google updates within 1–4 weeks |
| Has a WhatsApp message with `/booking-calendar/utrecht-cocktail-walk` | 301 → `/utrecht/book/` — calendar visible immediately |
| Clicks the Instagram bio link | updated same day; old link 301 anyway |
| Scans a QR on a bar table card | 301 forever (never delete the map) |
| Opens an old newsletter | 301 |
| Comes back after 6 months | homepage same domain; nav recognisable; Trust numbers; same phone |
| Searches "WOGO Delft" | `/delft/` exists, indexed, GBP up to date |
| Uses mobile | sticky CTA, widget tested on 4 devices |
| Has an old Wix confirmation email with a link (map, `/cancel-reservation`) | map links: Wix-hosted PDFs die with Wix → **host every map PDF in `/maps/` and keep old filenames reachable via redirect**; `/cancel-reservation` → `/contact/` |
| Booked on Wix for a date after launch | booking honoured: imported into admin; bars get an email from the new engine (send once, flagged "already confirmed via Wix") or rely on Gmail filter — pick one, no duplicates |
| Holds a Wix gift card | same code works in Stripe Checkout promo field |
| Emails info@ asking to reschedule | admin move endpoint not built — manual for now (same as today) |

---

## 8. Performance — old vs new test plan

**Why a prettier site can book less:** WOGO's buyers are on phones, often in the evening on mobile data; every extra second of load before the CTA costs ~7–10% of conversions (industry median). Autoplay hero video, four web-font files, unoptimised posters and a booking widget that blocks paint can turn a 1.5 s Wix page into a 4 s one.

| Test | Tool (free) | Old site baseline | New site target |
|---|---|---|---|
| LCP / INP / CLS lab | PageSpeed Insights (mobile + desktop) for `/`, `/utrecht`, `/rotterdam-cocktail-walk-route1`, `/booking-calendar/utrecht-cocktail-walk` | record | LCP ≤ 2.5 s mobile, CLS < 0.1, INP < 200 ms |
| Field CWV | GSC Core Web Vitals + CrUX | record | not worse |
| Load time | WebPageTest, Moto G4 / 4G profile, Amsterdam node | record | ≤ old |
| Image weight | Lighthouse "Properly size images" | — | hero ≤ 200 KB webp, posters ≤ 150 KB |
| JS | Lighthouse "Reduce unused JS" | Wix is heavy (advantage!) | widget `defer`, no other JS ≥ 50 KB |
| Third-party scripts | Lighthouse third-party summary | Wix apps | GTM + pixel only, after consent |
| Fonts | 2 families max, `display=swap`, preconnect | — | ≤ 4 files |
| Hosting/CDN | GitHub Pages + Cloudflare proxy, cache everything static, Brotli | — | TTFB < 200 ms NL |
| Server response (Worker) | `curl -w %{time_total}` on availability endpoint | — | < 300 ms |
| Caching | Cloudflare cache rule: `Cache Everything` for static, bypass for `/api/*` | — | HIT ratio > 90% |

Run all of it on the `github.io` URL before launch and once more on the real domain the day after.

---

## 9. Functionality audit — systematic, not click-around

**Automate:** put `backend/scripts/site-check.sh` (dev writes, ~1 h) into the repo:

1. **Crawl**: `wget --spider -r -l 5 -nd -np -o crawl.log https://www.wogococktailwalk.com` → list any non-200 (internal 404s, missing images).
2. **Links**: `npx linkinator https://www.wogococktailwalk.com --recurse --skip 'stripe.com|instagram|facebook'` (Node, one-off, free).
3. **Shared blocks**: hash the fenced nav/footer/consent blocks per page; fail if not identical.
4. **Widget pages**: for each `/book/` page assert the HTML contains `wogo-calendar` and `data-route` ∈ D1 route list (`curl $WOGO_API/api/routes`).
5. **Forms**: scripted POST to group form + newsletter → check Sheet/Brevo.
6. **Headers**: `curl -I` → HSTS, CSP (must allow GTM/Meta/Stripe), X-Frame-Options.
7. **Lighthouse CI** on 6 pages, mobile.
8. **Console errors**: Chrome DevTools MCP / Playwright script opens every sitemap URL and fails on console errors.

**Manual matrix (owner + one friend, 45 min, on real phones):**

| Area | Check |
|---|---|
| Navigation, menus, mobile menu | every item on iPhone + Android + desktop; Routes dropdown lists 7 routes incl. Delft |
| Search | none on site (Wix had `/search`) — fine |
| Forms | groups, contact, newsletter — submit + confirmation |
| Booking + payments | §2.4 |
| Contact | phone tap dials; mailto opens; WhatsApp link opens app |
| Emails | guest/bar/owner/group/gift-card |
| Buttons/links | all CTAs, footer legal links |
| Images/videos | hero video has poster + plays muted; falls back on Low Power Mode |
| Maps | route-map PDFs open on phone |
| Social links | IG/FB/TikTok correct handles |
| Language switch | EN↔NL toggle lands on twin page |
| Cookie banner | Reject/Accept/Customize + reopen from footer |
| Privacy settings | consent stored, re-prompt on version bump |
| Login/account | none (admin only, behind Cloudflare Access) |
| Integrations | Stripe, Brevo, Meta, GA4, Telegram ping, Sheet |
| Third-party widgets | Google reviews embed / Trustpilot widget if used — loads after consent |

---

## 10. Data baseline — record before touching anything

**Window: 90 days minimum, ideally 12 months** (WOGO is seasonal: weekends, summer, December, bachelorette season). Compare like-for-like: same weekdays, same ad spend, same weather-ish weeks. Save everything as CSV/screenshots in `~/Projects/wogo/marketing/baseline-2026-09/`.

| Metric | Source | Granularity |
|---|---|---|
| Bookings per day / week, guests per booking | Wix Bookings export + Wix Analytics | daily, 12 months |
| Revenue per day/week, AOV | Wix Payments / Analytics | daily |
| Booking conversion rate (sessions → paid) | GA4 (purchase / sessions) + Wix Analytics funnel | weekly |
| Calendar → form → payment step drop-off | GA4 page funnel (`/booking-calendar` → `/booking-form` → thank-you) | weekly |
| Sessions by channel: organic, paid social, direct, referral, email | GA4 Acquisition | daily |
| Top 30 landing pages (sessions + conversions) | GA4 Landing page report | 90 d |
| Top booking pages (which calendar) | GA4 + Wix | 90 d |
| Conversion rate by device | GA4 Tech → Device | 90 d |
| Conversion rate by source | GA4 | 90 d |
| Most important URLs (traffic × revenue) | above | list of 20 |
| Google rankings | GSC → Queries (top 100, clicks/impressions/position) export; note position of 15 money queries ("cocktail walk rotterdam/utrecht/amsterdam/groningen/delft", "cocktailtour rotterdam", "vrijgezellenfeest rotterdam idee", …) | export |
| Indexed pages | GSC → Pages → Indexed count + `site:wogococktailwalk.com` count | number |
| 404 errors | GSC → Not found | list |
| Site speed / CWV | PSI + GSC CWV | 4 pages |
| Meta: spend, CPM, CTR, IC, purchases, CPA, ROAS per ad set | Ads Manager export | daily, 90 d |
| Email list size, open/click of last 5 campaigns | Wix email | — |
| Support volume (emails/WhatsApps per week about booking problems) | Gmail count | weekly |
| Gift cards sold / redeemed per month | Wix | — |
| Group enquiries per week | Gmail/Wix form | — |

**Success/failure definition after launch (14-day window, same weekdays):**
- Bookings ≥ 90% of baseline **and** conversion rate ≥ 90% of baseline → success.
- Sessions normal, conversion rate < 75% → site/conversion problem → §12 tier 1.
- Sessions down > 25% from one channel only → that channel's URLs/tracking (§13).

---

## 11. Launch strategy — the safest sequence

**Recommended: staged by *readiness*, not by traffic — with an instant-reversible DNS flip.** Splitting live traffic between Wix and the new site on the same domain isn't practical (Wix must own the domain's DNS target, and Wix doesn't support being proxied by path), so the safe levers are: rehearse everything on the `github.io` URL with **live money**, flip DNS at the quietest hour with a 60-second TTL, keep Wix paid and reconnectable for 30 days, and keep the old booking calendar reachable as a fallback link.

| Option | Verdict |
|---|---|
| Launch everything simultaneously | Yes for DNS (one flip) — but only after the beta below |
| Soft launch / beta | Yes: 5–10 real bookings by owner + friends on the github.io URL with live Stripe (refunded), 3–5 days before |
| Internal users | Yes: owner, intern (Selin from 15 Sep), 2 bar contacts test the bar email |
| Selected customers | Optional: send the github.io link with a 100%-off test code to 3 loyal guests; ask them to book and screenshot |
| Low-booking period | Yes: **Tuesday 09:00–10:00** (bookings peak Thu–Sat evenings; never Friday) |
| Keep old site available | Yes: Wix plan stays paid ≥ 30 days; do **not** disconnect the domain in Wix, only change DNS |
| Redirects | Yes: loaded in Cloudflare *before* the flip (they only activate when the proxy is on) |
| Feature flags | Yes: `WOGO_API` URL and a `BOOKING_FALLBACK_URL` (old Wix calendar at the `wixsite.com` address) in one config file; flipping it swaps every Book button in one commit |
| Staged rollout | By **ad set**: day 0 switch Utrecht + Rotterdam ad URLs (they were built for the new pages), day 2 the rest — this staggers the Meta learning reset instead of resetting five ad sets at once |

**Launch-day runbook (Tuesday):**

| Time | Who | Step |
|---|---|---|
| T-7 d | Owner | Move DNS hosting to Cloudflare (site still on Wix — no visitor change). Verify Meta domain via TXT. Verify GSC via DNS. |
| T-3 d | Both | §2.4 live-money test on github.io. §14 all green. |
| T-1 d | Dev | Load Bulk Redirects (disabled). Import Wix future bookings + gift cards. Set `SITE_URL`, `SITE_ASSET_BASE` to `.com`. Remove noindex (commit ready, not pushed). |
| T-0 09:00 | Dev | Push noindex/canonical commit. Add custom domain in GitHub Pages. Change Cloudflare DNS to GitHub Pages (TTL 60). Enable redirects. |
| 09:10 | Both | Site loads on mobile data + desktop; HTTPS ok; `/utrecht/` etc. 200; 10 old URLs 301. |
| 09:20 | Owner | Real €29,95 booking on the real domain → all 6 signals (§2.4 step 2). |
| 09:30 | Owner | Ads Manager: Utrecht + Rotterdam ad URLs → new URLs + UTMs; optimisation event → new IC on all ad sets. |
| 09:45 | Dev | GSC: submit sitemap; request indexing for 7 pages. Bing too. |
| 10:00 | Owner | IG/FB/TikTok bio links, GBP, WhatsApp saved replies. |
| 10:30 | Both | Monitoring §13 begins. |

---

## 12. Rollback plan

### Tiers

| Tier | What | Time | When |
|---|---|---|---|
| **0 — hotfix** | Push a fix to the repo (Pages deploys in ~1 min) / `wrangler deploy` / Cloudflare rule | 5–15 min | Any single broken thing with a known cause |
| **1 — booking fallback** | Flip `BOOKING_FALLBACK_URL`: all Book buttons open the Wix calendar (site stays new). Pause new-engine widget. | 5 min | Payments/webhook/emails broken and not fixed in 30 min |
| **2 — full site rollback** | Cloudflare DNS back to Wix records; disable Bulk Redirects; (Wix domain connection untouched so it just works) | 5–15 min (TTL 60 s + Wix SSL) | Site down, mass 404s, mobile can't book, or tier 1 also fails |
| **3 — tracking-only** | Keep new site; re-point ad-set optimisation to a temporary "Landing page views" objective until events fixed | 10 min | Only tracking broken, bookings flowing |

### Trigger → Diagnosis → Decision → Procedure → Recovery

| Trigger (any) | Diagnose in ≤ 15 min | Decision | Procedure | Recovery |
|---|---|---|---|---|
| **0 paid bookings for 3 h in a window where baseline predicts ≥ 2** (evenings) or 0 by 14:00 on launch day | Stripe → Payments (attempts? failures?); admin → holds created?; UptimeRobot; Cloudflare analytics (traffic normal?) | Holds yes/payments no → Stripe config → Tier 1. Holds no/traffic yes → widget/API → Tier 0 then 1. Traffic no → DNS/redirects → Tier 2 | as tier | Re-test §2.4 before re-enabling |
| **Payment failure rate > 10%** (Stripe "failed" ÷ attempts) | Stripe logs: method, decline code, 3DS | Config → fix; unknown → Tier 1 | | |
| **Webhook 5xx or Brevo failures > 0** | Stripe webhook attempts; `error_log` | Fix ≤ 30 min else Tier 1; **meanwhile** send emails by hand from admin | | replay webhooks from Stripe |
| **Conversion rate (sessions→purchase) < 50% of baseline for 48 h with traffic normal** | Funnel by step + device (GA4/D1); check mobile specifically; compare NL vs EN | Device-specific → Tier 0; overall → Tier 1 while fixing; if unresolved by day 5 → Tier 2 | | |
| **Sessions < 60% of baseline by day 2** | Per channel: organic (redirects/index), paid (ad URLs), direct | Redirect/DNS → Tier 0; index drop → not a rollback trigger (fix + wait) | | |
| **Paid: IC events ≈ 0 for 6 h while clicks normal** | Events Manager, pixel ID, consent gate | Tier 3 + fix | | |
| **Analytics broken** | GTM preview; realtime | Tier 3; never roll back the site for tracking alone | | |
| **Important page 404** | crawler | Tier 0 (redirect/page) | | |
| **Mobile can't book** (owner reproduces on 2 phones) | console errors, Safari | Tier 1 immediately, then fix | | |
| **Major integration down (Stripe/Cloudflare outage)** | status pages | Tier 1 (Wix uses different processor) if > 1 h | | |
| **Organic traffic −30% at day 14** | GSC coverage/404, canonical, sitemap | NOT a rollback — rolling back after 14 days damages more; fix redirects/index | | |

**Hard stop rule:** if bookings are < 50% of the baseline for the equivalent window after 24 h **and** the cause isn't identified, go to Tier 2 before the Thursday–Saturday peak. Don't debug through a weekend.

Rollback prerequisites (verify at T-1): Wix subscription active; domain still "connected" in Wix; old DNS records saved in `CLOUDFLARE-SETUP.md`; Wix booking calendar reachable at the `wixsite.com` URL; Wix-Meta app still installed; someone with Cloudflare + Stripe + Meta access reachable 09:00–23:00 for 7 days.

---

## 13. Post-launch monitoring

**Business metrics first, every window.** Dashboard = Stripe Payments (bookings/€), admin week grid, Cloudflare Web Analytics (traffic), Events Manager (IC/Purchase), GA4 realtime, UptimeRobot, GSC.

| Window | Check | Normal | Problem signal |
|---|---|---|---|
| **First 6 h** | Every 30 min: site up (UptimeRobot), 1 real booking done, Stripe attempts vs successes, webhook 2xx, emails delivered (Brevo log), IC events in Events Manager, 10 old URLs 301, console errors 0, phone rings (support) | Morning = few bookings anyway | Any failed webhook; any "paid but no email"; IC=0 with clicks>0; 404 spike in Cloudflare |
| **First 24 h** | Evening peak (19:00–23:00) bookings vs same weekday last 4 weeks; Meta CPA/ad set; sessions by channel vs baseline; GSC not yet | ±30% on a single evening | 0 bookings in peak; CPA > 2× with same spend; direct traffic collapse (DNS) |
| **First 3 days** | Bookings/day vs baseline; funnel step conversion (route → book → hold → paid); device split; email deliverability (spam complaints); ad learning phase status; support emails count | Bookings ≥ 70% while Meta relearns | Conversion < 50%; mobile paid share far below baseline; support spike |
| **First 7 days** | Weekly bookings vs baseline week; CR by source; GSC coverage & 404; rankings for 15 money queries; CWV lab; Brevo bounce rate; gift-card redemptions; bar complaints (missing reservations) | ≥ 85–90%; positions ±3 | Organic sessions −30%; index count −40%; any bar "we didn't get the booking" |
| **First 30 days** | Bookings/revenue/CR vs baseline month; SEO positions; CWV field; ad ROAS back to baseline; cancel Wix **only if all green** | Full recovery | Persistent −15% CR → CRO sprint (§3), not rollback |

**Telling "traffic is down" from "site converts worse":**

| Sessions (Cloudflare/GA4) | Bookings | Reading |
|---|---|---|
| normal | down | **Conversion or booking-system problem** → funnel step drop-off tells which: route→book (UX/CTA), book→hold (widget/API/mobile), hold→paid (Stripe/methods), paid→email (webhook/Brevo) |
| down from *all* channels | down proportionally | DNS/uptime/redirect problem (technical) |
| down from organic only | down proportionally | SEO (redirects/index) — expect 1–3 weeks of noise; don't panic before day 14 |
| down from paid only | down | Ad URLs/optimisation event/pixel (tracking or paid) — check Events Manager first |
| normal | normal, but GA4/Meta show fewer | **Tracking problem** — Stripe count is the truth |
| normal | normal, bar complaints | Booking-system emails |

---

## 14. Red flags — STOP, do not launch yet

Any one of these = no DNS flip:

1. `/booking-confirmed/` not built, not tested with a real `session_id`.
2. Stripe live keys not set, live webhook not created, or webhook secret unverified with a real payment.
3. `EMAIL_TEST_REDIRECT` still exists in Worker secrets.
4. No real-money end-to-end booking on the github.io URL producing all six signals (Stripe, D1, guest email, bar email, Meta Purchase, GA4 purchase).
5. Guest email lands in spam on Gmail **or** iCloud **or** Outlook (SPF/DKIM/DMARC).
6. Any customer page still `noindex` or canonical → Wix (except London placeholders, `/booking-confirmed/`).
7. Redirect list not loaded/tested for every URL in §5.4 (script output not in launch log).
8. `/delft/` page + `/delft/book/` missing while the Delft ad set is active.
9. Dutch ads pointing to English pages with no `/nl/` — either build `/nl/` for the ad cities or accept the risk in writing.
10. GTM/GA4/Meta pixel absent on any page; consent gate not verified (Reject = zero calls).
11. Meta CAPI token missing, or `META_PIXEL_ID` not the pixel the ad sets optimise on; browser+server dedupe not shown in Events Manager.
12. Future Wix bookings not imported into admin; Wix gift cards not recreated in Stripe.
13. Wix media still referenced (`grep wixstatic` > 0) or maps not self-hosted.
14. Mobile booking not completed on at least iPhone Safari + Android Chrome by two different people.
15. PageSpeed mobile LCP > 4 s on any city page or the /book/ page.
16. Ad URL inventory (§6.1) not filled — nobody knows all 31 ad destinations.
17. Baseline (§10) not exported — you couldn't prove a problem afterwards.
18. No named person on watch for launch evening + the following Thu–Sat.
19. Wix domain registrar unknown; DNS not yet on Cloudflare 7 days prior (nameserver propagation).
20. Rollback rehearsal not done (DNS back to Wix once on staging — at least the records are written down and someone has clicked through the screen).
21. iDEAL/Apple Pay/Klarna not visible on a live Stripe Checkout from a Dutch phone.
22. Bot Fight Mode enabled without the `/webhooks/*` skip rule tested.

---

## 15. Master migration plan

Priority: **P0** = blocks launch · **P1** = must be done launch week · **P2** = within 30 days.

### PHASE 1 — Audit old website (done 31 Aug; owner to complete 3 items)

| Task | Pri | Owner | Tool | Test / DoD | Risk if skipped |
|---|---|---|---|---|---|
| Full URL inventory (226 URLs + /nl) | P0 | Dev ✅ | sitemaps → `scratchpad/old-wix-urls.txt` | list in repo as `OLD-URLS.txt` | 404s |
| Tracking inventory (GA4 ×2, AW, TikTok, pixels …692/…94) | P0 | Dev ✅ / Owner confirms …94 ID | Events Manager | IDs written in §4.1 | wrong pixel |
| Wix automations list (email, review request, reminders) | P0 | Owner | Wix → Automations | screenshot list | lost lifecycle emails |
| Wix Bookings settings (caps, closed days per route) | P0 | Owner | Wix Bookings | matched in admin | overbooking |
| Domain registrar check | P0 | Owner | Wix → Domains | written down | catastrophic |

### PHASE 2 — Inventory everything

| Task | Pri | Owner | Tool | DoD | Risk |
|---|---|---|---|---|---|
| Ad URL inventory (31 ads) | P0 | Owner | Ads Manager | `LAUNCH-URL-INVENTORY.md` filled | ad 404s |
| External link inventory (§6.1) | P1 | Owner | GSC Links, Ahrefs free | same file | — |
| Data exports (§2.3) | P0 | Owner | Wix exports | CSVs in a private folder | data loss |
| Media download | P0 | Dev | Wix Media Manager | `grep wixstatic` = 0 | images vanish |

### PHASE 3 — Baseline

| Task | Pri | Owner | Tool | DoD | Risk |
|---|---|---|---|---|---|
| Export all §10 metrics, 12 months | P0 | Owner (dev scripts what's API-able: Meta via babysitter token) | GA4, Wix, GSC, Ads Manager, PSI | folder `baseline-2026-09/` | can't prove impact |
| Verify GSC + Bing property via DNS | P0 | Owner | GSC | verified | no redirect/index data |

### PHASE 4 — Build (gaps only)

| Task | Pri | Owner | Tool | DoD | Risk |
|---|---|---|---|---|---|
| `/booking-confirmed/` page (reads session_id, polls status, fires purchase once) | P0 | Dev | repo + Worker status endpoint | real booking lands there | payment-then-404 |
| `/delft/` + `/delft/book/` | P0 | Dev | templates (ADD-A-CITY.md) | in sitemap, widget works | Delft ads 404 |
| `/nl/` for `/`, 5 cities, how-it-works, faq, groups (+ hreflang on twins) | P0 (or written waiver) | Dev | templates | toggle works both ways | NL conversion |
| GTM container + shared tracking snippet, Consent Mode v2, event layer (§4.2) | P0 | Dev | GTM, repo | Tag Assistant green on 8 pages | blind launch |
| Widget → pass `event_id`, `fbp/fbc`, UTMs/gclid/fbclid, GA client_id to Worker; D1 `attribution` column | P0 | Dev | repo | booking row shows source | can't attribute |
| Worker: CAPI IC + Purchase with dedupe; GA4 Measurement Protocol purchase; correct pixel ID; `META_ACCESS_TOKEN` (CAPI-capable System User) | P0 | Dev + Owner (token) | wrangler | Events Manager shows deduped | Meta blind |
| `BOOKING_FALLBACK_URL` config flag | P1 | Dev | repo | one-line switch tested | slow rollback |
| Brevo domain authentication + DNS (SPF/DKIM/DMARC) | P0 | Owner (DNS) + Dev | Brevo, Cloudflare | mail-tester ≥ 9 | spam |
| Wix future bookings + gift cards import | P0 | Both | admin manual booking; Stripe coupons | counts match export | overbooking, angry gift-card holders |
| Brevo list import + welcome automation + newsletter form | P1 | Both | Brevo | test signup | lost list |
| Privacy policy processors + Stripe terms URL | P1 | Dev | repo, Stripe | live | compliance |
| `llms.txt`, schema (Product/Offer, FAQPage), titles/meta copied from Wix | P1 | Dev | repo | Rich Results Test pass | SEO dip |
| Custom domain `api.wogococktailwalk.com` for Worker; update widget, Stripe webhook, UptimeRobot | P1 | Both | Cloudflare | booking works via new host | — |
| Admin move/cancel endpoints | P2 | Dev | repo | — | manual work (as today) |

### PHASE 5 — QA

| Task | Pri | Owner | Tool | DoD | Risk |
|---|---|---|---|---|---|
| `site-check.sh` (§9) green on github.io | P0 | Dev | script | log saved | broken links |
| Manual device matrix (§9) | P0 | Owner + friend | phones | checklist signed | mobile bugs |
| Performance (§8) | P0 | Dev | PSI/WebPageTest | targets met | slow site |
| Consent gate test | P0 | Dev | DevTools network | Reject = 0 calls | legal |

### PHASE 6 — SEO migration

| Task | Pri | Owner | Tool | DoD | Risk |
|---|---|---|---|---|---|
| Full redirect list from §5.4 → Cloudflare Bulk Redirects (query preserved) | P0 | Dev | Cloudflare | script: every old URL → 301 → 200 | 404s |
| `wogo.city` → 301 | P1 | Owner | its registrar/Cloudflare | curl | — |
| Remove noindex, self canonicals (scripted) | P0 | Dev | sed + grep | grep = 0 | invisible site |
| Submit sitemap GSC/Bing; request indexing | P0 | Dev | GSC | done | slow reindex |

### PHASE 7 — Tracking migration

| Task | Pri | Owner | Tool | DoD | Risk |
|---|---|---|---|---|---|
| §4.4 before column filled | P0 | Owner | GA4, Events Manager | table | — |
| §4.4 after column verified on github.io with live booking | P0 | Dev | Tag Assistant, Events Manager Test Events, GA4 DebugView | all rows pass | — |
| Meta domain verification via DNS TXT | P0 | Owner | Business Settings | green | event loss |
| Ad-set optimisation event switch plan written | P0 | Owner | Ads Manager | which event, when | learning chaos |

### PHASE 8 — Booking-system testing

§2.4 in full, logged in `backend/LAUNCH-TEST-LOG.md`. P0. Both. DoD: six signals on a real €29,95 iDEAL booking + card + cancel + race + promo.

### PHASE 9 — Launch

§11 runbook, Tuesday morning. P0. Both. DoD: real booking on the real domain within 30 min of flip; ads updated; bio links updated.

### PHASE 10 — Monitor

§13 windows. P0. Owner (business), Dev (technical). DoD: daily one-line log for 7 days, weekly for 30.

### PHASE 11 — Optimise (day 8–30)

Rebuild top blog posts by baseline traffic; CRO on the weakest funnel step; retitle pages; Reels/UTM reporting from D1 attribution; occasion pages; admin move/cancel; bar `.ics` feed; cancel Wix at day 30 if green (exports verified twice).

### PHASE 12 — Rollback if necessary

§12 tiers; rehearsed at T-1; decision rule: unidentified cause + < 50% bookings at 24 h → Tier 2 before Thursday.

---

## 16. Challenging the assumptions

1. **"Same domain, so SEO is fine."** Google ranks URLs, not domains. All 226 old URLs change (plus `/nl`). Without 301s the domain keeps its authority and loses every ranking page. Even with perfect 301s expect 10–20% organic noise for 2–6 weeks; and Wix's `/nl` pages, FAQ schema, Product schema and llms.txt don't move by themselves.
2. **"It looks better, so conversion improves."** Conversion comes from clarity, speed, trust and fewest clicks — not beauty. The new flow adds a page, is English-only for Dutch buyers, currently has no confirmation page and fewer visible reviews. "Better-looking" sites routinely convert 10–30% worse at launch until the funnel is tuned on real data.
3. **"The developer tested it, so booking is fine."** It was tested in **Stripe test mode with all emails redirected to one Gmail**. Live keys, live webhook secret, real iDEAL, real bar inboxes, real spam filters, Bot Fight Mode, Apple Pay on Safari and a paying guest on a slow phone have never been exercised. 284 unit tests don't cover DNS.
4. **"GA4 is installed, so tracking is fine."** It isn't installed on the new site at all yet; and "installed" ≠ "the purchase event fires once, with value, on the right property, after consent, on every device, with the source attached". Meta is the bigger issue: the optimisation signal your ads learn from lives in a Wix app that dies at cutover.
5. **"Same information, so SEO is preserved."** Titles, H1s, schema, hreflang, internal links, image names and crawl paths are what Google reads. The new pages have different titles and structure; the /nl pages don't exist; 26 blog posts collapse into `/blog/`.
6. **"301s solve everything."** They pass ~all link equity over weeks, not instantly; they don't fix wrong destinations (a blog post → homepage is a soft-404 to Google), don't carry UTMs unless configured, don't help ads that hard-link a 404 (Delft), and do nothing for media hosted on `wixstatic.com`, gift-card codes, future bookings or email automations.
7. **"Stable traffic → stable bookings."** Bookings = traffic × conversion. A 4-second mobile page, a cookie banner over the CTA, English for Dutch visitors, a missing iDEAL option or a spam-foldered confirmation each cut conversion with zero effect on traffic.
8. **"We'll fix problems after launch."** Some can't be: a cancelled Wix loses contacts/media/gift-card data forever; a domain registered via Wix can lapse; Meta learning resets cost real money for a week; guests who paid and got a 404 don't come back; bars that don't get reservations lose trust in WOGO. Fix-after-launch is fine for copy and titles — not for money, emails, data or DNS.

---

*Files this playbook references: `SITE-PLAN.md`, `REDIRECT-MAP.md` (now superseded by §5.4), `CLOUDFLARE-SETUP.md`, `CONSENT-SNIPPET.html`, `backend/SETUP.md`, `backend/DR.md`, `backend/OWNER-SECURITY-TODO.md`, `backend/src/{stripe,meta,config,webhook}.js`, `backend/widget/wogo-calendar.js`.*
