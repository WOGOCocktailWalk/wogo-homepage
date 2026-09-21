# WOGO booking system — replacing Wix Bookings

*Written for Maroussia, 2026-07-21. Plain language. Every technical word gets a one-line explanation the first time it appears.*

This is the "which booking tool do we use" decision. It's the one piece of the backend plan that a plain Stripe payment button **can't** do on its own — a real visual calendar where a guest picks a day, picks a start time, sees how many seats are left, and pays. This document picks the tool that gives you that, keeps iDEAL, syncs with GetYourGuide, and stays cheap at your volume.

---

## 1. What you have now (Wix Bookings) — and exactly what a replacement must match

Wix Bookings does two jobs you actually love, and you don't want to lose either:

**(a) The guest-facing calendar, on each route page.** A visitor lands on, say, the Rotterdam route, sees a **calendar** (a real month/day grid), taps a **day you've opened**, sees the **start times** you've set for that day, picks one, chooses party size, and pays. A slot holds **10 seats** (a "departure" = one group leaving at one start time), one booking can be up to **6 people**, and once a slot fills, Wix stops selling it. You open, close and edit those days and times yourself.

**(b) The all-routes backend overview.** One place where you (and Valeriia) see **every** booking across **all** routes and **all** cities — Amsterdam, Rotterdam, Utrecht, Groningen — in a single calendar/list. You don't hop between four separate systems.

**So the replacement is non-negotiable on five things:**

| Must-have | Why it matters for WOGO |
|---|---|
| **Real visual calendar per route** — pick day → pick timeslot → pay, with a **capacity per departure** (your 10-seat/6-per-booking model) | This is the actual product experience. A plain "buy now" button can't do slot-picking or sell-outs. |
| **iDEAL at checkout** (iDEAL = the bank-transfer button ~60% of Dutch shoppers expect) | Non-negotiable for a Dutch-first business. No iDEAL = lost sales. |
| **One all-routes / all-cities backend** where you open & close days and timeslots yourself | Your daily control panel. Must scale to Delft (~Aug) and London without adding systems. |
| **Embeds into a static site** (your new site is flat files on GitHub Pages — no server of ours) | The booking tool must drop in as a **widget** (a snippet you paste that pops open the tool's own hosted booking window). We don't run a server. |
| **GetYourGuide channel sync** (one shared availability pool so a GYG sale and a website sale draw from the same 10 seats) | You already sell on GetYourGuide. Without sync you risk **double-booking** the same departure across the two. This is the big upgrade Wix never gave you. |

Everything else — gift cards, promo codes, abandoned-cart emails — is a bonus, not a dealbreaker.

---

## 2. The shortlist (I screened 9 platforms; these are the 4 that fit)

I'll be honest up front where research **couldn't verify** something — those are the questions to ask on the demo call, not facts to trust yet.

| Platform | Cost model | iDEAL | Real calendar + all-routes backend | Embeds in static site | GetYourGuide sync | Gift cards / promo / abandoned-cart |
|---|---|---|---|---|---|---|
| **TicketingHub** ⭐ | **Flat 3% per booking, €0/month, no contract.** You plug in your **own Stripe** (payment company you own the account with), so Stripe's fees are on top (~1.5% cards, ~€0.29 flat iDEAL). | **Yes, via Stripe** (Stripe does iDEAL natively). Not stated as a TH-native feature — confirm on demo. | **Yes** — "multi-product calendar" widget; one backend for all routes/departures/capacity/channels. | **Yes** — built to be an embeddable widget. | **Yes — confirmed** GetYourGuide supplier sync + Viator/Tripadvisor. | **All three confirmed.** |
| **Checkfront** | **€99/month + 3%.** Offline/manual bookings free. You can **pass the 3% to the guest** or absorb it. | **Yes — explicitly confirmed on their pricing page** (cards, Apple/Google Pay, iDEAL, Alipay). Highest-confidence iDEAL of the four. EUR-native. | **Yes** — availability calendar per route, single backend across all cities. | **Yes** — embeddable booking widget. | **Yes — confirmed** GetYourGuide + Viator + Tripadvisor + Expedia. | Gift cards + promo **yes**; **abandoned-cart unverified** (couldn't confirm). |
| **FareHarbor** | **€0/month, no contract.** ~**6%** fee that by default the **customer** pays (you can absorb/split). Exact % not printed on their site — confirm. | **Yes — verified** (runs iDEAL via Adyen; full Dutch bank list on their checkout). **EU company in Amsterdam.** GBP for London supported. | **Yes** — full visual dashboard calendar, all locations in one place. A very close Wix-Bookings lookalike. | **Yes** — "lightframe" popup widget for any HTML page. | Connects to OTAs incl. GetYourGuide — but **live two-way GYG sync for NL is unconfirmed**; confirm on demo. | Gift cards + promo **yes**; abandoned-cart **unverified**. Klarna unverified. |
| **Regiondo** | **€59/month + an undisclosed online-booking fee** (not printed — likely ~2–3%). **1-year contract** (billed monthly). | Not explicitly named; runs on Stripe so **likely yes** — confirm. Multi-currency (GBP) supported. | **Yes** — strong: calendar views, seat-based booking, one backend for all products + channels. | **Yes** — widget/iframe. | **Yes — confirmed** GetYourGuide + Viator. | Gift cards **yes**; promo likely; **abandoned-cart likely absent.** |

**Ruled out (and why):** **Rezdy** — iDEAL *not confirmed* (the one thing you can't gamble on) + billed in US dollars. **Bókun** (Tripadvisor's tool) — you'd need its **$49/mo paid plan** just to embed a widget, and its headline "0% on Viator" perk doesn't help a GetYourGuide-first business. **Smeetz, TripWorks, Peek Pro** — either no public pricing, US-centric, or **no evidence of iDEAL at all** — wrong fit for a Dutch operator.

---

## 3. The recommendation

### ⭐ Primary: **TicketingHub**

**Why it wins for you specifically:**

- **Cheapest by a wide margin, in the €0-monthly spirit you want.** Flat **3%, no monthly fee, no contract, cancel anytime** — versus the 6% charged by FareHarbor/TripWorks/Peek. On ~€9,000/month (200 bookings × ~€45) that 3% is ~€270/month **if you absorb it** — and you can instead **pass it to the guest** as a small booking fee (~€1.35 on a €45 order), which keeps your own fixed cost essentially just Stripe's processing.
- **It reuses the exact Stripe setup we already planned.** TicketingHub is "bring your own payment company," and that company is **Stripe** — the one the backend plan already chose. So iDEAL, cards, Apple/Google Pay, Klarna and GBP-for-London all come through Stripe, which you own, and **the free email robot we already designed can hang off the very same Stripe events** (more on this in section 4). Nothing gets thrown away.
- **It ticks every must-have that's confirmed:** real multi-product calendar, one all-routes/all-cities backend, static-site widget, **confirmed GetYourGuide sync** (one seat pool, no double-booking), plus gift cards, promo codes **and** abandoned-cart emails — the only shortlisted tool where all three bonuses are confirmed.
- **Scales cleanly to Delft and London:** add a route, it's one more product in the same backend; GBP is just a Stripe currency setting.

**What to verify on the demo (don't treat as fact yet):** that iDEAL shows at checkout for Dutch guests (it will via Stripe, but see it live); that you can choose who pays the 3%; and that it exposes a **webhook** (an automatic "a booking just happened" ping) or Zapier so the email robot can catch each booking. A couple of their deep help pages were unreachable during research — treat those three as demo questions.

### Runner-up: **Checkfront**

Pick this **if you'd rather pay a flat €99/month for the reassurance of the most clearly-verified iDEAL** and a slightly more hand-holding, all-in-one setup (Checkfront can process payments itself, so there's no separate Stripe step if you don't want one). It's EUR-native, GetYourGuide sync is confirmed, and iDEAL is stated **in black and white on their pricing page** — the highest-confidence iDEAL of the four. The trade-off: €99/month is exactly the kind of subscription you're leaving Wix to escape, and if you *pass* the 3% to guests your fixed cost is still ~€99/month versus TicketingHub's ~€0. Choose it only if the extra certainty is worth ~€99/month to you.

### Honorable mention: **FareHarbor**

The one to demo **if you want a €0-monthly tool from an actual Amsterdam company with rock-solid, verified iDEAL** and a dashboard that looks almost identical to Wix Bookings. The catch is the **~6% fee (double TicketingHub's)** and that **GetYourGuide two-way sync for the Netherlands is unconfirmed** — which is one of your core requirements. Worth a call to confirm those two points; if the GYG sync is live and you're happy defaulting the 6% onto the guest, it's a strong safety pick.

---

## 4. How it fits the rest of the backend plan

Good news: **this doesn't replace the backend plan — it slots into it and makes it simpler.** Here's the division of labour.

**The booking platform takes over three of Wix's four old jobs:**
- the **guest-facing calendar** (day → timeslot → pay),
- **taking the money** (via your Stripe, or Checkfront's own processor),
- **capacity / sell-outs** (the 10-seats-per-departure logic and GetYourGuide sync).

That's actually *more* than the DIY Stripe-button plan could do — a plain payment link can't show a calendar or stop selling a full slot. So the booking platform is a clean upgrade to the plan, not a detour from it.

**The free Google Apps Script robot still has a job — the one thing no booking platform does for you:** the **per-bar staggered-time emails.** (Apps Script = free mini-programs inside your Google account. A webhook = an automatic "this just happened" ping between two apps.) Booking tools will email the guest a confirmation and can email you a copy — but **none of them compute that Bar 1 = the start time, Bar 2 = +75 min, Bar 3 = +150 min and email each bar *its own* arrival time.** That WOGO-specific logic, plus your owner-editable **"Routes & Bars" control sheet** (with day-specific bar overrides), stays exactly as designed in BACKEND-PLAN.md.

**Where the two connect — one wire:**
- With **TicketingHub or Checkfront on your Stripe:** the robot listens to the **same Stripe "payment succeeded" event** the backend plan already builds against. Booking lands → Stripe pings the robot → robot reads route/date/start-time/party-size/guest-email → reads the control sheet → emails each bar its staggered time, re-fires the Meta Pixel Purchase event, and (optionally) adds the guest to Brevo. **Zero new glue** beyond what's already planned.
- With a tool that uses its **own** payment rail (e.g. FareHarbor via Adyen): Stripe isn't in the loop, so the robot instead catches the platform's **own webhook or a Zapier trigger**. Same robot, different doorbell. **Flag: confirm on the demo that the platform offers a webhook or Zapier** — TicketingHub and Checkfront both have APIs/integrations, so this is very likely, but verify it before committing.

So the picture is: **booking platform = calendar + payment + capacity + GetYourGuide. Robot = bar-timing emails + control sheet + Pixel + Brevo.** They meet at one webhook.

---

## 5. Honest cost at 200+/month — and the trade-offs vs Wix

Assume ~200 bookings/month at ~€45 average ≈ **~€9,000/month** in revenue.

| Option | Your fixed monthly | Per-booking cost | Realistic total if you **pass fees to guests** | If you **absorb** everything |
|---|---|---|---|---|
| **TicketingHub** ⭐ | **€0** | 3% + Stripe (~1.5% card / ~€0.29 iDEAL) | **≈ Stripe processing only** (guest pays the 3%, ~€1.35 on €45) | ~€270 (3%) + Stripe ≈ **€400–450** |
| **Checkfront** | **€99** | 3% + processing | **≈ €99** | €99 + ~€270 ≈ **~€370** |
| **FareHarbor** | **€0** | ~6% (guest pays by default) | **≈ €0 to you** (guest total up ~€2.70 on €45) | ~€540 if you absorb it |
| **Regiondo** | **€59** (1-yr contract) | undisclosed fee + processing | ~€59 + unknown | €59 + unknown |

**The honest trade-off vs Wix:** you're swapping one bundled subscription for a **per-booking** model. The upside: at your volume, with fees passed to guests, your **fixed** monthly cost can sit near **€0–€99** — and you finally get things Wix never gave you (tours-native calendar, **GetYourGuide sync so you stop risking double-bookings**, your own Stripe, no lock-in except Regiondo's 1-year term). The realistic downside to name out loud: **per-booking fees grow with revenue.** A 6% tool gets pricey as you scale; a **flat-3%, no-monthly** tool (TicketingHub) is the one that stays cheapest all the way up to London. That's the core reason it's the pick.

*One caveat I won't hide: passing the fee to the guest nudges their displayed total up a little, which can dent conversion. On a €45 experience, +€1.35 (TicketingHub) is negligible; +€2.70 (FareHarbor 6%) is the one to watch. My default recommendation: pass the small 3% along — it's below the threshold anyone abandons a cart over.*

---

## 6. What you need to decide / provide to move

**Three decisions from you:**
1. **Absorb the booking fee, or pass it to the guest?** (Recommendation: pass the 3% — keeps your fixed cost near €0.)
2. **TicketingHub (cheapest, uses your Stripe) or Checkfront (€99/mo, most-verified iDEAL, all-in-one)?** My lead is TicketingHub; Checkfront if you want maximum certainty and don't mind the €99.
3. **Book the demos** — I'd line up **TicketingHub + Checkfront**, and **FareHarbor** as a €0-monthly backup. I can draft the demo emails.

**Four things to confirm *on* those demos (the unverified list):**
- iDEAL shows live at checkout for a Dutch guest.
- **Live two-way GetYourGuide sync for the Netherlands** (so a GYG sale really does close the same seat on your site).
- A **webhook or Zapier** the email robot can listen to.
- **GBP** available for London when the time comes.

**What you'd provide to set it up:**
- Your **Stripe** account (or we open one — same account the backend plan already needs).
- Your **GetYourGuide supplier login** (to connect the sync).
- The **route data** to load: each route's open days, start times, and seats per departure.
- Per-route **bar order + minutes-per-stop** (for the robot's staggered emails — already on your backend to-do list).

---

## Things research could NOT verify — read before trusting

- **TicketingHub:** iDEAL is via Stripe (reliable) but **not stated as a native TH feature**; who pays the 3% is configurable; a couple of their deep pages were unreachable. → confirm on demo.
- **Checkfront:** **abandoned-cart recovery unverified**; GBP/multi-currency for London not separately confirmed (likely via Stripe).
- **FareHarbor:** **exact fee % not printed** (assume ~6%); **live GetYourGuide two-way sync for NL unconfirmed**; Klarna and abandoned-cart unverified; **signup is sales-led** (no instant self-serve).
- **Regiondo:** **online booking fee is undisclosed**; **1-year contract**; **iDEAL not explicitly named**; abandoned-cart likely absent.
- **Rezdy (ruled out):** **iDEAL not confirmed** — the deciding gap for a Dutch business; billed in USD.
- **Bókun (ruled out):** website widget needs the **$49/mo** paid plan; iDEAL not explicitly verified.
- **Smeetz / TripWorks / Peek Pro (ruled out):** no public pricing and/or **no evidence of iDEAL/EUR** support.
