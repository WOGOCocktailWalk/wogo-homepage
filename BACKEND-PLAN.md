# WOGO backend plan — from Wix to your own €0 setup

*Written for Maroussia, 2026-07-06. Plain language. Every technical word gets a one-line explanation the first time it shows up.*

This is the plan for what happens **behind** your new website — where a booking goes after someone clicks "pay," where their name and phone number get stored, and how we keep that safe once Wix is gone. Nothing here costs a monthly fee.

---

## 1. How Wix works today — and exactly what dies when you cancel it

Right now Wix is doing **four separate jobs** for you, all bundled into the one subscription you're paying for:

1. **The booking calendar** — "Wix Bookings." It shows the time slots for each route, knows that a Rotterdam Route 2 slot holds **10 seats** and one booking can be up to **6 people**, and stops selling a slot when it's full.
2. **Taking the money** — "Wix Payments" (their built-in card/iDEAL processor, with PayPal as a backup). This is the piece that charges per-booking fees *plus* skims a platform cut. This is the fee you're escaping.
3. **Storing the customer** — "Wix CRM" (CRM = just a contact database). Every name, email, phone, route, date, party size and payment lives inside Wix's servers.
4. **Sending the emails** — the automatic "your booking is confirmed" email to the guest, and the notification to you/the bar.

**The important, slightly uncomfortable truth:** all of that data sits inside Wix's system, which is a black box — you can't see into it, and you can only get your data out using **Wix's own export button**. Your entire customer history is currently trapped there.

### What literally stops working the day you cancel

| The moment Wix is cancelled… | …this breaks |
|---|---|
| The booking calendar | Gone. No more slot-picking, no more capacity limits. |
| Wix Payments | Gone. No way to charge anyone. |
| Your customer database (CRM) | **Gone — and if you didn't export it first, it's lost forever.** |
| The automatic confirmation emails | Gone. |
| **All your images and videos** | Gone. Wix hosts every photo on *their* servers (`wixstatic.com`). If they're not saved onto the new site first, the new site shows broken images. |
| The Meta Pixel Purchase tracking (ID `652971109400692`) | Stops firing. Your Facebook/Instagram ads lose their "this ad made a sale" signal — the thing that makes them profitable. The new setup must re-create this. |

**➜ Two must-dos BEFORE you press cancel:** (1) export your Contacts + Bookings history from Wix, and (2) download all your photos/videos. I'll handle both and confirm with you before anything gets cancelled.

---

## 2. The recommended new backend — in plain terms

Think of it as three cheap, replaceable parts instead of one expensive bundle. Here's the whole journey of a single booking:

**A guest picks a route and time on your new site → clicks a Stripe payment button → pays → Stripe quietly tells a little free Google robot "someone just paid" → the robot writes the booking into a Google Sheet, emails the guest, and emails the right bar → done.**

Now the pieces:

### The payment: Stripe
**Stripe** = a payment company (the same kind of thing Wix Payments was, but you own the account and pay *only* per-transaction — no monthly fee). You'll use **Stripe Payment Links / Checkout**, which is a ready-made, Stripe-hosted payment page. You don't build it; Stripe hosts it. Card details never touch your site or your Google Sheet — they only ever touch Stripe, which is bank-grade secure (they're certified at the highest security level in the industry, "PCI DSS Level 1" — the same standard the card networks hold banks to).

### Where the booking lives: a Google Sheet (your daily workbench) + Stripe (your unforgeable backup)
This is the "data store" — the place a booking is safely written down. We use **two copies on purpose**, and both are free:

- **The Google Sheet is your everyday view.** It's just a spreadsheet — you and Valeriia already live in Sheets and Gmail. Open it and instantly see "tonight's bookings, which bar to email." It's the friendliest possible tool for this, and it's €0.
- **Stripe is your safety copy.** Because Stripe is already handling the money, it *automatically* keeps a permanent, tamper-proof record of every real booking — name, email, phone, amount, date/time (we capture those as fields on the checkout page). So if the Sheet ever gets deleted, messed up, or your Google account is compromised, **Stripe's dashboard is a second, higher-security copy of every genuine paid booking** — at no extra cost, because you're paying Stripe for payments anyway.

This "belt and braces" (two independent copies) closes the one real weakness of a spreadsheet-only setup: a spreadsheet has no backup. Now it does, for free, with nothing new to learn or secure.

*(I looked hard at fancier databases — Airtable, Supabase, Cloudflare. None is worth it for you right now: they'd mean a brand-new account to secure for no real safety gain, and some hit limits or need actual code. If you ever triple in volume, or an investor demands proof that data physically sits in the EU, there's a clean, still-€0 upgrade to a "Supabase Frankfurt" database — but that's a later problem, not a now problem.)*

### The free glue: a Google Apps Script webhook
**Apps Script** = free mini-programs that run inside your Google account. A **webhook** = just an automatic phone call between two apps ("hey, a payment happened"). This little robot is what listens for Stripe's "someone paid" message, then: writes the row into the Sheet, emails the guest their confirmation, emails the correct bar its reservation, and re-fires the **Meta Pixel Purchase event** so your ads keep their sales tracking. €0.

### The honest security posture: "there's no server to break into"
Here's the genuinely reassuring part. A classic website gets hacked because there's a **server** — a computer of yours, running your code, sitting on the internet 24/7 for attackers to poke at. **Your new setup has none of that.** Your site is just flat files on GitHub Pages (free static hosting). The payment page is Stripe's problem, not yours. The database is Google's problem. The email-sending robot only wakes up when Stripe pokes it and has no public login page.

So the "attack surface" (the number of doors an attacker could try to open) is tiny — you've *removed* the thing that normally gets hacked. What's left to protect isn't a server; it's your **accounts** (Google, Stripe, GitHub). That's covered next.

---

## 3. Is it safe? Can it be hacked?

Short version: **yes it's safe, and it's meaningfully harder to hack than a normal website** — because, as above, there's no server. But "safe" is never "magic," so here's the honest, plain-language threat model — the realistic ways someone could cause trouble, and the specific thing that stops each one.

| The realistic worry | How real is it | What actually stops it |
|---|---|---|
| A hacker "breaks into your website's server" | **Not possible — there is no server.** Your pages are static files. | The architecture itself. Nothing to break into. |
| Someone steals credit card numbers from your database | **Not possible — you never store cards.** They only ever touch Stripe. | Stripe holds the cards, at bank-grade security. Your Sheet has none. |
| A prankster sends **fake "someone paid" messages** to your robot to create bogus bookings or spam emails | This is the one genuinely worth engineering against. | **Two locks.** (1) A long secret password hidden inside the webhook's web address, so random internet bots can't even reach it. (2) The robot **doesn't trust the message** — it turns around and asks Stripe directly "did this payment *really* happen?" using your secret Stripe key, before writing anything or sending any email. A faker can't forge a real Stripe payment. *(Technical footnote for whoever builds it: Google Apps Script can't read the `Stripe-Signature` header, so the standard copy-paste Stripe signature check silently won't work here — we verify by calling Stripe's API to confirm the event instead. This is a known Apps Script limitation and the fix is built in.)* |
| Someone **guesses/phishes your Google or Stripe password** and gets into the data | This is now your **main** risk — it moved from "Wix's servers" to "your accounts." | **MFA on every account** (explained in §4). With MFA on, a stolen password alone is useless. |
| Stripe re-sends the same "paid" message twice and you double-book | Stripe genuinely does retry messages. | The robot remembers every booking it's already handled and ignores repeats ("deduplication"). Built in. |
| Your secret Stripe key leaks | Would be bad. | The key is stored **server-side inside Apps Script**, never written into any website page a visitor's browser can see. Not exposed. |

**Bottom line:** the dangerous, classic "website got hacked" scenarios are designed out. The residual risk is ordinary account security — the same thing that protects your email — and MFA handles it.

---

## 4. Your data responsibilities (light, but real)

Because you now clearly "own" the customer data instead of renting Wix's compliance, three simple habits keep you on the right side of privacy law (GDPR = the EU rule that says people can see and delete the data you hold on them). None of this is heavy.

- **MFA on your accounts.** MFA ("multi-factor authentication" = a second code from your phone on top of your password) on **Google, Stripe, and GitHub.** This is the single most important thing you do. Ten minutes, once. I'll walk you through it.
- **Retention — don't keep data forever for no reason.** Sensible default: keep booking rows for **24 months**, then archive/delete the personal bits (name/email/phone). Two exceptions you *can't* delete: Stripe keeps payment records for **~7 years** because Dutch tax law requires it (that's legal and correct — your privacy policy just needs to say so, which yours can).
- **If a customer asks "show me / delete my data"** (their legal right): their data is in exactly two findable places — the Google Sheet and Stripe. You search their email, export or delete the Sheet row, and note that Stripe's copy is legally retained for tax. Simple and honest. I can give you a two-line canned reply for this.

---

## 5. What you need to add or decide — the "I'll add whatever's missing" list

Each item has a **recommended default** so you don't have to weigh options — just say "yes, go with the default" or tweak.

| # | Thing to decide/add | Recommended default (just say yes) |
|---|---|---|
| 1 | **Per-bar reservation emails** — the robot needs to know which email address to notify for each route/city. | Give me one contact email per bar/route. Default: the bar's existing reservations inbox you already use. Until you send them, notifications come to **you**. |
| 2 | **A Stripe account** | Open one free Stripe account in the WOGO company name (KvK 92237347). I'll list exactly what to click. One-time. |
| 3 | **MFA on Google + Stripe + GitHub** | Turn on all three (§4). Non-negotiable, but painless. Do it the same day we go live. |
| 4 | **Availability / capacity policy** — a static site can't do a live calendar as cleverly as Wix did. | Keep Wix's real numbers: **10 seats per departure, up to 6 per booking.** Simplest €0 approach: sell fixed departure slots and cap them; I set the caps. If two routes truly need live "sold out" logic we can add it later. |
| 5 | **Groups = enquiry only** (no instant payment) | A simple form that emails you the enquiry; you quote and send a Stripe link by hand. Keeps it €0 and personal. Default: yes. |
| 6 | **Meta Pixel** — keep your ads' sales tracking alive | Re-use your existing Pixel `652971109400692`; the robot fires the Purchase event on real payments. Default: yes, keep it. |
| 7 | **Export Wix data + download all media BEFORE cancelling** | I do both, show you the files, *then* you cancel Wix. Default: yes. |
| 8 | **Confirmation email wording** (guest + bar) | I draft both in your brand voice; you approve once. |
| 9 | **Cancellation/refund wording** | Per your standing decision: **no free cancellation** (bars hold tables). I'll state it plainly and add a Stripe refund process for genuine exceptions you approve. |

---

## 6. Cost

**€0 per month. Confirmed.** You're leaving Wix's subscription and not signing up for a new one.

| Piece | Monthly | Per-transaction |
|---|---|---|
| Website hosting (GitHub Pages) | €0 | — |
| Booking database (Google Sheet) | €0 | — |
| The email/logging robot (Apps Script) | €0 | — |
| Backup copy (Stripe dashboard) | €0 | — |
| Meta Pixel tracking | €0 | — |
| **Stripe payments** | **€0** | **only the standard per-payment fee** (a small % + a few cents per booking — the fee you already accept, and it *replaces* Wix's fee, it doesn't add to it) |

The **only** money that ever moves is Stripe's cut on an actual sale. No sale, no cost. That's the whole point: you pay when you earn, never a flat monthly rent again.

---

*Next step whenever you're ready: I set up the Stripe account and the robot on a test route, run one €0.50 test booking end-to-end so you can watch a real row land in the Sheet and both emails arrive — then we do the Wix export and go live.*

---

## 7. Owner-corrected current system + the pieces the plan above missed (2026-07-20)

Maroussia corrected the exact behaviour of the live Wix system. The full current flow, and how each piece is replaced/improved:

**Current Wix flow (accurate):**
1. Book on Wix calendar → pay.
2. On payment, guest gets **TWO** emails: a **confirmation** and a **separate route-map email**.
3. The confirmation is forwarded to the route's bars via a **Gmail filter**.
4. **Flaw:** bars only receive the route **start time**, even though the 2nd/3rd bar gets guests +1h / +2h later.
5. **Email marketing** via Wix to the customer list.
6. A full **analytics** page.
7. **All contacts stored** in Wix.
8. **Gift cards** auto-issue a code on purchase; the **discount/gift-code field is also on the booking checkout** for redemption.

**How the new backend covers ALL of it:**

| Current Wix job | New €0 replacement |
|---|---|
| Two guest emails (confirmation + route map) | The Apps Script robot sends **both** — confirmation email + a separate route-map email (map can be a hosted PDF/link per route). |
| Bar notification via Gmail filter | The robot emails **each bar directly** — and here it's **BETTER than Wix**: see below. |
| **Bar timing flaw** | **FIXED.** Each route has an ordered bar list with per-stop time offsets (e.g. bar 1 = start, bar 2 = +75 min, bar 3 = +150 min). The robot computes **each bar's own expected arrival time** from the booked start time and emails that bar *its* time, not the route start. Needs from owner: per route, the bar order + minutes per stop (default ~75 min/bar). |
| Email marketing (Wix) | **Brevo** (already researched — free at her ~25k list, charges by emails sent not contacts). Robot can auto-add each new booker to the Brevo list (consent-respecting). |
| Analytics page | **GA4** (behind cookie consent) + **Cloudflare Web Analytics** (cookie-free, no consent needed). |
| Contact storage | Google Sheet (bookings) + Brevo (marketing contacts) + Stripe (paid-booking backup). |
| **Gift cards: auto-issue a code** | On a gift-card purchase, the robot **auto-creates a Stripe promotion code** for the gift amount and emails it to the buyer. |
| **Redeem gift/discount code at booking** | **Stripe Checkout has a built-in promo-code field** — guests enter their gift/discount code there; Stripe applies it. No custom code-ledger to build. |

**New owner to-do items surfaced here:** (a) per-route bar order + minutes-per-stop (for the timing fix), (b) the route-map file/link per route (to send as the 2nd email), (c) confirm Brevo for marketing + whether the robot auto-adds bookers to it.

---

## 8. Two more requirements (2026-07-20)

### A. New email signups get an automatic 10% discount
- Signup form on the site → contact lands in **Brevo** → Brevo's **welcome automation** emails a **10% code**.
- The code is a **Stripe promotion code** redeemed via the same Checkout promo-code field as gift cards. Restrict it: **once per customer, ~30-day expiry, first booking only** so it can't be farmed.
- **Default:** one shared code (e.g. `WELCOME10`) with those restrictions. **Upgrade path if abused:** robot generates a **unique one-time code per signup** via the Stripe API.

### B. Bar notifications WITHOUT Gmail filters — a control sheet instead
The Gmail-filter setup is rigid: route→bar mapping is hard-coded and can't handle a day when a route uses different bars. Replace it with an owner-editable **"Routes & Bars" control sheet** (a tab in the same Google Sheet):
- Row per bar: **Route · order · bar name · bar email · minutes-into-walk** (arrival offset).
- The robot **reads it live** on each booking → computes each bar's own arrival time → emails the right bars. Changing a route's bars = **edit a row** (no filters, no code).
- **Day-specific overrides** (the real pain point): a small override table — **Route · Date · use-these-bars-instead** — the robot checks FIRST before the default mapping. One line swaps a bar for a specific date.
- This control sheet is the single operational panel (and the same data can feed the Level-2 bar calendar feeds/pages). Owner runs everything from the spreadsheet; the robot obeys it.

### How bars receive reservations — Levels (owner asked "can bars couple to their own system?")
- **Level 1 (default, universal, €0):** robot emails each bar its own arrival time. Works with every bar regardless of their software.
- **Level 2 (recommended upgrade, still €0):** each bar gets a **subscribe-once calendar feed (.ics)** or a **private per-bar web page** of just their WOGO reservations (name, party size, correct time), auto-fed from the control sheet. Feels like a system, no integration with their software.
- **Level 3 (avoid for now):** push directly INTO each bar's own reservation system (Formitable/Zenchef, Guestplan, TheFork…). Per-bar, per-platform integrations, mostly gated APIs, real maintenance, breaks €0/no-server, doesn't scale to London. Only if a major partner demands it.
