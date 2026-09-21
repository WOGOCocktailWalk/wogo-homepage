# WOGO Lean Redesign — Build Spec (route / groups / gift-cards / about)

Owner brief, in one line: **kill the wall of text, lead with the booking, one story block, real photos, official route names.**
This spec is copy-paste-buildable. It only *adds/removes sections and swaps copy* — it does **not** touch the fenced `WOGO SHARED NAV v4` / `WOGO SHARED FOOTER v4` blocks or the `BASE` / `WOGO_ROUTES` foot script (those stay byte-identical across pages except the `BASE` line).

Reference bar for "lean": the live Wix route page (`/rotterdam-cocktail-walk-route-2`) is ~250–300 words total — headline, ~2 short paras, a 4-bullet "how it works", one group line. **Match that density.** If a section doesn't help the customer book, understand, trust, or feel excited, cut it.

---

## 0. Global rules (all four pages)

- Keep on every page, unchanged: EN default + complete NL `data-i18n` dictionary, `<meta name="robots" content="noindex">` with the `REMOVE at cutover` comment, `<link rel="canonical">`, the anti-flicker script, shared NAV/FOOTER blocks, foot script.
- **Relative links only** (`../`, `../../`) — never `href="/…"`. Route pages are two folders deep (`../../`), content pages one deep (`../`).
- Palette only: espresso `#5C2A14`, near-black `#1a1410`, cream `#FAF6F2`, peach `#F5C9A8`, salmon/orange CTA `#E2641E` (hover `#C8551A`). **No reds.**
- Book buttons keep their **existing** `wogococktailwalk.com/booking-calendar/…` URLs with `target="_top"`. Never invent a URL. Folder slugs don't change.
- Trust numbers allowed, verbatim: `★ 4.4 Google · Trustpilot 4.5 · 80,000+ walks booked · Partner of Gemeente Rotterdam`. Gemeente line is **Rotterdam-only**.
- Cancellation ceiling everywhere: *"Plans change? Get in touch — we'll see what's possible."* Never "free cancellation", never fake scarcity.
- Photos: reuse the self-hosted route heroes already on disk; new photos must be **real WOGO** pulled from the live Wix/CDN into the page's own folder. Never stock.
- After each edit: tag balance, i18n key sync (`node brace-check`), JSON-LD parses, inline JS `node --check`.

---

## 1. ROUTE PAGE TEMPLATE (the big one)

### 1a. New section list — this is the whole page, in order

| # | Section | Keep? | Max copy |
|---|---------|-------|----------|
| 1 | **Hero** — breadcrumbs, eyebrow (city · theme), H1 (official name), 1-sentence descriptor, price line, Book CTA→`#book`, trust row | ✅ keep | descriptor ≤ 22 words |
| 2 | **Quick facts strip** (`.w-facts`) — 📅 days · 🕐 start + duration · 📍 location · 🍸 3 bars/3 cocktails | ✅ keep | 4 chips, ≤ 6 words each |
| 3 | **The night** — the ONE explanation block: 1 intro sentence + 3 compact stop cards + "What's included" checklist + a tiny 3-icon how-it-works row | ✅ **merged** | intro ≤ 30 words; each stop ≤ 25 words; 5 checklist items ≤ 14 words each |
| 4 | **`#book`** conversion block — price big, one Book button, one fine-print line | ✅ keep | fine print ≤ 30 words |
| 5 | **More {City} routes** — sibling `.w-citycard` scroller + "See all" link | ✅ keep | heading + 1 subline |
| — | Sticky mobile CTA → `#book` | ✅ keep | — |

### 1b. DELETE from every route page (this is the leanness win)

- ❌ **Reviews section** entirely (owner rule 4 — route pages aren't about that). Remove the `.w-reviews` block **and** the `review` node inside the TouristTrip JSON-LD, **and** every `r1*/r2*/rev_*` i18n key.
- ❌ Standalone **How-it-works** brown strip (folded into §3 as a 3-icon row).
- ❌ **Groups strip**, ❌ **Gift-card strip**, ❌ **Final CTA** section. Cross-sell to groups/gift already lives in the footer; the sibling scroller (§5) + sticky CTA carry re-conversion. Removing these three is ~40% of the old page's height.

Net: old route page ≈ 11 body sections → new ≈ 5. That is the target.

### 1c. Naming pattern — city on its own line, theme as eyebrow, NO dash-glue

Source of truth = the homepage route cards (`c1…c7`). Pattern for the hero:

```
<div class="w-hero-brand" data-i18n="hero_brand">The Cocktail Walk</div>
<nav class="w-crumbs">Home › {City} › {H1}</nav>
<div class="w-hero-flag" …>          ← only on genuine best-seller (Route 2) or New
<div class="w-eyebrow w-hero-kicker" data-i18n="hero_kicker">{CITY} · {THEME}</div>
<h1 data-i18n="hero_h1">{OFFICIAL NAME}</h1>
<p data-i18n="hero_p">{one warm sentence}</p>
```

- **Eyebrow** carries `CITY · THEME` (uppercase). **H1** is the official name only. Never `"Hidden Gems Cocktail Walk — Rotterdam"`.
- New CSS (add once to the route `<style>`, route-extras block):
  `.w-hero-kicker { color:#F5C9A8; margin-bottom:10px; }` (reuses `.w-eyebrow` sizing; just recolors it for the dark hero).

Per-route values:

| Folder (slug — unchanged) | Eyebrow `CITY · THEME` | H1 (official) | Hero subline idea | Booking URL (keep) |
|---|---|---|---|---|
| `rotterdam/hidden-gems` | ROTTERDAM · HIDDEN GEMS | **Rotterdam Route 2** | "Three brand-new hidden-gem bars, one night of surprises." | `/booking-calendar/rotterdam-cocktail-walk-route-2` |
| `rotterdam/witte-de-with` | ROTTERDAM · LOCAL FAVOURITES | **Rotterdam Route 1** | "The bars locals keep to themselves, around the Witte de With." | `/booking-calendar/wogo-rotterdam-cocktail-walk` |
| `rotterdam/premium-gin-walk` | ROTTERDAM · HIGH-END BARS | **Rotterdam Premium** | "The Bobby's Gin Walk — three high-end bars, elevated." | `/booking-calendar/rotterdam-premium-cocktail-walk` |
| `utrecht/city-centre` | UTRECHT · HIDDEN GEMS | **Utrecht City Centre** | "Three hidden gems along the Utrecht canals, tables reserved." | `/booking-calendar/utrecht-cocktail-walk` |
| `amsterdam/ndsm-noord` | AMSTERDAM · ICONIC | **Amsterdam Route 1** | "Noord to the centre — three iconic Amsterdam bars in one night." | `/booking-calendar/wogo-cocktail-walk-route-1` |
| `groningen/gin-walk` | GRONINGEN · BEST BARS | **Groningen Gin Walk** | "The Bobby's Gin Walk — the best bars in the city, in three stops." | `/booking-calendar/groningen-cocktail-walk` |

"Premium" and "Groningen Gin Walk" keep Bobby's Gin as a **subline**, never dash-glued into the H1.

### 1d. Head updates per route (match the official name)

- `<title>`: `{Official Name} — {Theme} Cocktail Walk | WOGO` (city already leads, so it never dangles). e.g. `Rotterdam Route 2 — Hidden Gems Cocktail Walk | WOGO`.
- `og:title` / `twitter:title`: `{Official Name} · {short hook}`.
- **TouristTrip JSON-LD**: `"name":"{Official Name}"`, `"alternateName":"{Theme} Cocktail Walk"` (flip of today's values, which have theme as name). Keep `offers.url` = the existing booking calendar. **Remove the `review` node.**
- **BreadcrumbList JSON-LD**: 3rd item `name` → `{Official Name}` (e.g. "Rotterdam Route 2"), and the visible `.w-crumbs` last crumb must match it.

### 1e. §3 "The night" — exact markup pattern (reuse existing classes)

```html
<section class="w-section">
  <div class="w-head w-pad"><div class="w-eyebrow" data-i18n="story_eyebrow">The route</div>
    <h2 data-i18n="story_h2">Three brand-new bars, one night of surprises</h2></div>
  <p class="w-stops-intro w-pad" data-i18n="story_p">{≤30-word intro, keywords woven naturally}</p>

  <div class="w-stops w-pad">
    <div class="w-stop"><h3 …>1 · {Vibe}</h3><p …>{≤25 words}</p></div>
    …stop 2, stop 3…
  </div>

  <ul class="w-incl-list w-pad" style="margin-top:26px;">   <!-- what's included, folded in -->
    <li …>3 signature cocktails or mocktails — one at each bar</li>
    <li …>3 pre-reserved tables — no queues, just give your name</li>
    <li …>Digital route map in your inbox right after booking</li>
    <li …>Mocktail option at every bar — the whole walk works alcohol-free</li>
    <li …>The bars stay a surprise until after booking</li>
  </ul>

  <div class="w-howstrip" style="margin-top:26px;">        <!-- tiny how-it-works, 3 icons -->
    <div class="w-hs-item" style="color:#5C2A14;">…🗺️ Pick your route &amp; date…</div>
    …🍸 We pick your three bars… · …🚶 Walk the city, your pace…
  </div>
</section>
```

Note: `.w-hs-tx` is peach-on-dark by default; on this cream section override inline to `#5C2A14` (or wrap the strip in a `w-section peach`). Keep `hs_1/2/3` i18n text **verbatim** from the homepage.

If a route has ≥6 real photos on disk, un-comment the existing gallery block (§ already stubbed in the template). Otherwise leave it commented — no stock.

---

## 2. GROUPS PAGE — visual, simple, with an enquiry form

Owner: *too static, too much text, needs pictures, needs a form.* New order:

| # | Section | Notes |
|---|---------|-------|
| 1 | **Hero** (`.w-hero .w-hero-flat` — keep) | H1 "Cocktail Walks for Groups". Sub ≤ 18 words. CTA "Plan your group walk →" scrolls to `#enquire`. |
| 2 | **Occasion chips** (`#occasions`) | One line intro + a chip row. Reuse `.w-chip` (static, not links). Chips: Bachelorettes · Birthdays · Team outings · Corporate events · Graduations · Just because. |
| 3 | **Photo + "what a group walk contains"** | Two-column on desktop, stacked mobile. Left = real WOGO group photo; right = a `.w-incl-list` of what's included (3 cocktails/3 bars, 6–30 people, self-guided 3–4 hrs, one contact person, snacks optional). |
| 4 | **Extras strip** | Short "Make it yours" line + a second `.w-chip`/list row: custom start times · dietary & mocktail menus · groups over 30 · multiple starting groups · add snacks · custom route map. |
| 5 | **ENQUIRY FORM** (`#enquire`) — the point of the page | See 2a. |
| 6 | **One real group review** | The Klup group-of-6 Google review only (single card, `.w-review`). One review is allowed here (it's a group page, and it's real) — do not add a wall. |
| 7 | **≤6 split** (`#cities`) | "6 or fewer? Book instantly" + `.w-citycard` scroller of the routes. Keep. |

Drop the old multi-step "how group booking works", the phone-only section (fold phone into the form's fallback note), the FAQ, and the gift strip.

### 2a. The enquiry form — front-end only, mailto fallback

Fields (all in one card): **Name · Email · Phone · City** (select: Utrecht / Rotterdam / Amsterdam / Groningen) **· Group size** (number) **· Preferred date** (date) **· Occasion** (select mirroring the chips) **· Special requests** (textarea).

```html
<form class="w-form" id="wGroupForm" novalidate>
  <div class="w-form-grid">
    <label class="w-field"><span>Name</span><input name="name" required></label>
    <label class="w-field"><span>Email</span><input type="email" name="email" required></label>
    <label class="w-field"><span>Phone</span><input type="tel" name="phone"></label>
    <label class="w-field"><span>City</span>
      <select name="city"><option value="">Choose a city</option>
        <option>Utrecht</option><option>Rotterdam</option><option>Amsterdam</option><option>Groningen</option></select></label>
    <label class="w-field"><span>Group size</span><input type="number" min="6" name="size" placeholder="e.g. 12"></label>
    <label class="w-field"><span>Preferred date</span><input type="date" name="date"></label>
    <label class="w-field"><span>Occasion</span>
      <select name="occasion"><option value="">Choose…</option>
        <option>Bachelorette</option><option>Birthday</option><option>Team outing</option>
        <option>Corporate event</option><option>Graduation</option><option>Other</option></select></label>
    <label class="w-field w-field-wide"><span>Special requests</span>
      <textarea name="notes" rows="3" placeholder="Dietary needs, timings, group splits…"></textarea></label>
  </div>
  <button type="submit" class="w-form-submit" data-i18n="form_submit">Send enquiry →</button>
  <p class="w-form-note" data-i18n="form_note" role="status" aria-live="polite"></p>
</form>
```

**JS (add to foot script, clearly commented "// FRONT-END ONLY — backend hookup comes later"):**
- On submit: `preventDefault()`, basic required check, then show the friendly line in `.w-form-note`:
  *"Thanks {name} — we've noted your enquiry and we'll get back to you within one working day."*
- **AND** build a `mailto:info@wogoamsterdam.com` fallback so **no lead is lost pre-backend**: prefill `subject=Group enquiry — {city} · {size} guests` and body from the fields, and either auto-open it or render a "Didn't open? Email us directly →" link in the note. This is the safety net until Formspree/Netlify Forms is wired.
- Do not fake a network call or a success that implies data was stored server-side.

### 2b. Form CSS — add these NEW classes (groups page only, in its extras block)

```css
.w-form { max-width: 640px; margin: 0 auto; background:#fff; border-radius:16px; padding:26px; box-shadow:0 8px 24px rgba(92,42,20,0.10); }
.w-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.w-field { display:flex; flex-direction:column; gap:6px; font-size:12.5px; font-weight:800; letter-spacing:0.04em; text-transform:uppercase; color:#5C2A14; }
.w-field-wide { grid-column:1 / -1; }
.w-field input, .w-field select, .w-field textarea { font:inherit; font-weight:500; text-transform:none; letter-spacing:0; color:#1a1410; background:#FAF6F2; border:1.5px solid rgba(92,42,20,0.20); border-radius:10px; padding:12px 14px; min-height:48px; }
.w-field input:focus, .w-field select:focus, .w-field textarea:focus { outline:none; border-color:#E2641E; box-shadow:0 0 0 3px rgba(226,100,30,0.18); }
.w-field textarea { min-height:88px; resize:vertical; }
.w-form-submit { display:block; width:100%; margin-top:18px; background:#E2641E; color:#fff; border:none; cursor:pointer; padding:16px; border-radius:999px; font-size:15px; font-weight:800; letter-spacing:0.04em; text-transform:uppercase; box-shadow:0 4px 14px rgba(226,100,30,0.4); transition:transform .2s, background .2s; }
.w-form-submit:hover { background:#C8551A; transform:translateY(-2px); }
.w-form-submit:active { transform:scale(0.98); }
.w-form-note { margin-top:14px; font-size:13.5px; font-weight:700; line-height:1.55; color:#5C2A14; text-align:center; min-height:1.2em; }
@media (max-width:720px){ .w-form-grid{ grid-template-columns:1fr; } .w-form{ padding:20px; } }
```

Add every visible string as an EN default + NL key. NL: natural Dutch (Naam · E-mail · Telefoon · Stad · Groepsgrootte · Voorkeursdatum · Gelegenheid · Speciale wensen · "Verzoek versturen →").

---

## 3. GIFT-CARDS PAGE — leaner

Keep the tone of the current page but strip to essentials. New order:

| # | Section | Notes |
|---|---------|-------|
| 1 | **Hero** (`.w-hero-flat`) | H1 "WOGO Gift Cards". Sub ≤ 16 words: "A night out they'll actually remember — delivered by email in seconds." |
| 2 | **Amount tiers** (`#tiers`) | Three amount cards (keep the live Wix tiers — currently €25 / €50 / €100; do **not** invent). Each card: amount + one line + "Buy this card →" → the existing gift URL `https://www.wogococktailwalk.com/gift-cards` (`target="_top"`). |
| 3 | **How gifting works** (`#how`) | 3 compact steps (choose amount → pay → they get an email code). ≤ 12 words per step. |
| 4 | **Perfect for** | Occasion `.w-chip` row (Birthdays · Anniversaries · Thank-yous · Christmas · Just because). One line, no paragraph. |
| 5 | **Mini FAQ** | 3 items only: validity, redemption (used at checkout on any route), partial value. Keep the cancellation ceiling. |
| 6 | **Final CTA** (`.w-final`) | "Give a night, not a thing" → `#tiers`. |

Delete the SEO essay block and the reviews block and the city-hub grid (footer already links routes). Result: ~6 lean sections.

---

## 4. ABOUT PAGE — leaner, better design

| # | Section | Notes |
|---|---------|-------|
| 1 | **Hero** (`.w-hero-flat`) | Keep H1 "Explore your city, one cocktail at a time". |
| 2 | **Our story** (`#story`) | **Two short paragraphs max** (born in Amsterdam during lockdown → grew to 4 cities). Trim the current copy hard. |
| 3 | **Trust numbers** (`.w-stats`, peach) | Approved set only: ★4.4 Google · 4.5 Trustpilot · 80,000+ walks · Partner of Gemeente Rotterdam. |
| 4 | **How we pick our bars** | 3 short points (or a photo + 3 points). This is the premium-curation proof — keep tight. |
| 5 | **Contact** | NAP matches the footer exactly (email · phone · hours). |
| 6 | **City cards** (`#cities`) soft CTA | The one gentle CTA. Keep. |

Delete the bar-owner testimonial and the spirits-partners strip (or keep **one** of them, not both) and the groups + gift strips. Fewer, stronger sections.

---

## 5. CSS reuse map (don't reinvent)

**Already defined — reuse as-is:** `.w-section` (+ `.alt/.peach/.brown/.dark`), `.w-pad`, `.w-head`, `.w-eyebrow`, `.w-hero` + `.w-hero-flat`, `.w-hero-price`, `.w-hero-flag`, `.w-crumbs`, `.w-facts`/`.w-fact`, `.w-stops`/`.w-stop`, `.w-stops-intro`/`.w-stops-note`, `.w-incl-list`, `.w-howstrip`/`.w-hs-item`/`.w-hs-tx`, `.w-book*`, `.w-citycard*` (sibling scroller), `.w-scroller*`/`.w-arrow*`, `.w-chip`, `.w-final*`, `.w-review` (groups: single card), `.w-sticky-cta*`.

**New classes to add (scoped to the page that needs them):**
- Route pages: `.w-hero-kicker` (recolor eyebrow for dark hero) — §1c.
- Groups page: the `.w-form*` set — §2b.
- Groups §3 two-column: reuse `.w-group-wrap` (flex, wraps to stack on mobile) with a photo on one side, `.w-incl-list` on the other. No new class needed.

---

## 6. Per-page QA checklist (run after every file)

1. **Tag balance** — `<section>`/`<div>` open == close.
2. **i18n sync** — every `data-i18n="key"` has a matching `NL.key`; deleted sections' keys removed from `NL`. Run `node brace-check` (or grep both lists and diff).
3. **JSON-LD parses** — pipe each `application/ld+json` block through `node -e "JSON.parse(require('fs')...)"`; TouristTrip `name` = official route name; **no `review` node** on route pages; BreadcrumbList last item matches the visible crumb + H1.
4. **Inline JS** — `node --check` on the foot script (esp. the new groups form handler).
5. **Links** — all internal links relative and correct for depth; all Book/gift buttons keep existing `wogococktailwalk.com` URLs with `target="_top"`.
6. **Mobile (85% of traffic)** — hero readable, form one-column, tap targets ≥ 44px, no horizontal scroll, sticky CTA present on route pages only.
7. **Copy ceilings** — spot-check §-max word counts above; if a paragraph runs longer, cut it.
8. **Guardrails** — no "free cancellation", no invented numbers, no reds, no stock photos, no dash-glued city in any H1.
