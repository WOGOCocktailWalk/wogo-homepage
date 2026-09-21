# WOGO Redesign — DESIGN V3 SPEC

**Author:** Head of Product Design / Brand Guardian
**Scope:** Homepage + 4 city hubs + 6 route pages + groups / gift-cards / about
**Goal:** Kill the "sloppy + static" heroes, make reviews dynamic (homepage only), ship a real gift-card visual + custom amount, deepen the About page, ban the "—" dash from every visible headline, and raise the motion floor sitewide — all €0, vanilla, self-contained, and CRO-evidence-led.

This spec is **implementable as written**: exact headlines (EN + NL), exact CSS, exact JS, exact per-file change lists, and a verification gate.

---

## 0. Current-state findings (what's really on screen)

| Page(s) | Hero today | Motion system | Review section | Dash in headline? |
|---|---|---|---|---|
| `index.html` (home) | video/photo hero, good | **NONE (`wg-js` absent)** | 4 hardcoded review cards in a manual scroller | `hero_p` yes |
| `rotterdam/` `utrecht/` `amsterdam/` `groningen/` (hubs) | **real photo hero** (`.w-hero` + `<img class="w-hero-video">`), but **static** (`w-hero-content`, no `wg-hero-anim`) | **NONE** | **YES — remove** (`.w-reviews` band, solo review) | **YES — remove** ("City Cocktail Walk — 3 Bars, 3 Cocktails, 1 Night") |
| `groups/` `gift-cards/` `about/` | **`.w-hero-flat`** — espresso gradient, **no photo** ← the "sloppy static" ones | present (`wg-js`, `wg-hero-anim`) | groups: **remove**; others n/a | some `hero_p` |
| route pages (`rotterdam/hidden-gems/` etc.) | photo hero | present | none (correct) | `hero_p` dashes yes |

**Design consequence:** two different hero fixes are needed — (A) **enrich** the hubs' existing photo heroes (motion + gradient + dash-free copy), and (B) **replace** the flat photo-less heroes on groups/gift-cards/about with real photo heroes. Plus a **sitewide dash sweep** and a **motion-floor top-up** on the homepage + hubs.

All real photos already exist in-repo (see `find … *.jpg/*.webp/*.png`): `rotterdam/rotterdam-hero.jpg`, `groups/group-photo.jpg`, `amsterdam/ndsm-noord/ndsm-noord-hero.jpg`, etc. No downloads required for the hero fixes; gift-card uses a **pure CSS/SVG mock** (no photo).

---

## 1. THE DASH BAN — sitewide sweep + exact replacements

**Rule:** no `—` (em dash) or `–` (en dash) in any visible `h1`, `h2`, hero subline, or card headline. Replace with a full stop + new sentence, a middot `·`, or a comma. Applies to **both** the EN markup and the NL dict string. (Dashes inside body copy / FAQ answers may stay; the ban is headlines + hero sublines + card titles + section `h2`.)

### 1a. City-hub hero headlines (h1) — restructured, SEO-safe

Keep the SEO phrase "**[City] Cocktail Walk**" as the `h1` (rankings), move the punch to a new dash-free subline. Replace the single dashed `h1` with **`h1` + `.w-hero-sub`**:

| Page | NEW `h1` (EN) | NEW `.w-hero-sub` (EN) | `h1` (NL) | sub (NL) |
|---|---|---|---|---|
| `rotterdam/` | Rotterdam Cocktail Walk | Three bars. Three cocktails. One unforgettable night. | Rotterdam Cocktail Walk | Drie bars. Drie cocktails. Eén onvergetelijke avond. |
| `utrecht/` | Utrecht Cocktail Walk | Three bars. Three cocktails. Every single night. | Utrecht Cocktail Walk | Drie bars. Drie cocktails. Elke avond van de week. |
| `amsterdam/` | Amsterdam Cocktail Walk | From the NDSM wharf to the centre. Three bars, one night. | Amsterdam Cocktail Walk | Van de NDSM-werf tot het centrum. Drie bars, één avond. |
| `groningen/` | Groningen Cocktail Walk | Three hidden bars. Three Bobby's Gin cocktails. One night. | Groningen Cocktail Walk | Drie verborgen bars. Drie Bobby's Gin-cocktails. Eén avond. |

New markup (hub hero, replaces the single `<h1>` line):
```html
<h1 data-i18n="hero_h1">Rotterdam Cocktail Walk</h1>
<p class="w-hero-sub" data-i18n="hero_sub">Three bars. Three cocktails. One unforgettable night.</p>
```
New CSS (add to each hub's `<style>`, outside fences):
```css
.w-hero-sub { font-size: clamp(15px,1.6vw,20px); font-weight: 800; letter-spacing: -0.005em; line-height: 1.25; margin: -4px 0 14px; color: #F5C9A8; text-shadow: 0 2px 14px rgba(0,0,0,0.5); max-width: 22ch; }
@media (max-width:720px){ .w-hero-sub{ font-size:14.5px; margin:-2px 0 12px; } }
```
Add `hero_sub` to each hub's NL dict.

### 1b. Hero subline (`hero_p`) dash removals — every page

Replace the em dash with a full stop. Exact edits (EN markup **and** NL dict):

| File | `hero_p` — replace `… — just show up.` / dash | with |
|---|---|---|
| `index.html` | `tables reserved — just show up.` | `tables reserved. Just show up.` |
| `rotterdam/` | `tables reserved — just show up.` | `tables reserved. Just show up.` |
| `utrecht/` | `tables reserved — just show up.` | `tables reserved. Just show up.` |
| `groningen/` | `tables reserved — just show up.` | `tables reserved. Just show up.` |
| `amsterdam/` | `Amsterdam bars — from the NDSM Wharf towards the centre — three` | `Amsterdam bars, from the NDSM wharf towards the centre, three` |
| `utrecht/city-centre/` | `runs every single night — three hidden-gem bars` | `runs every single night. Three hidden-gem bars` |
| `amsterdam/ndsm-noord/` | `cocktail bars — from an industrial-chic … NDSM wharf to the city centre.` | `cocktail bars, from an industrial-chic … NDSM wharf to the city centre.` |
| `groningen/gin-walk/` | `clubbing street — a signature Bobby's Gin` | `clubbing street. A signature Bobby's Gin` |
| `rotterdam/premium-gin-walk/` | `at each stop — and a skybar` | `at each stop, and a skybar` |
| `rotterdam/hidden-gems/` | `from playful to refined — bold cocktails` | `from playful to refined. Bold cocktails,` |

NL dict equivalents: apply the same period/comma swap to each `hero_p:` string (the Dutch strings carry the identical `—`).

### 1c. Meta/OG titles (not visible headlines, but sweep for consistency)
`og:title` "WOGO Cocktail Walk — three bars…" (index) may keep its dash (it is an OG string, not an on-page headline) **but** to be safe and consistent, change to "WOGO Cocktail Walk · three bars, three cocktails, one night". Low priority; do it in the same pass.

**Verification for section 1:** after edits run
`grep -rnE 'data-i18n="(hero_h1|hero_p|hero_sub)"' --include='*.html' . | grep -E '—|–'` → must return **zero** rows. Repeat for the NL dict lines: `grep -rnE '(hero_h1|hero_p|hero_sub):' . | grep -E '—|–'` → zero.

---

## 2. HERO REDESIGNS

### 2A. City hubs — enrich the existing photo hero (rotterdam / utrecht / amsterdam / groningen)

The photo is already there; it reads "static" because it is a frozen frame under a flat scrim with no entrance. Fixes, all transform/opacity-only and reduced-motion safe:

1. **Slow Ken-Burns drift on the hero image** (premium, 60fps-safe, GPU transform only):
```css
.w-hero-video { animation: wgHeroPan 22s ease-in-out infinite alternate; will-change: transform; }
@keyframes wgHeroPan { from { transform: scale(1.06) translate3d(0,0,0); } to { transform: scale(1.12) translate3d(-1.5%, -1.2%, 0); } }
@media (prefers-reduced-motion: reduce) { .w-hero-video { animation: none; transform: none; } }
```
(Scale starts at 1.06 so the pan never reveals an edge.)

2. **Richer overlay** — swap the flat scrim for a directional espresso gradient that anchors the text bottom-left and deepens legibility:
```css
.w-hero-overlay { background:
   linear-gradient(180deg, rgba(26,20,16,0.30) 0%, rgba(26,20,16,0.20) 40%, rgba(26,20,16,0.78) 100%),
   radial-gradient(120% 80% at 15% 90%, rgba(92,42,20,0.55) 0%, rgba(92,42,20,0) 60%); }
```

3. **Hero entrance motion** — add the `wg-hero-anim` class to the hub hero content wrapper so the overline → h1 → sub → trust → CTA drift up in sequence (the class + CSS already exist on content pages; hubs just need the class **and** the motion system added — see §6):
```html
<div class="w-hero-content wg-hero-anim">
```

4. **Dash-free headline + subline** — per §1a.

5. **CTA stays** `View dates →` / `Bekijk data →` (unchanged target `#routes`). One primary CTA per hero — keep it.

Result: same fast LCP (image still `fetchpriority="high"`, headline paints immediately — the pan is decorative, the entrance is transform-only so the h1 is never hidden), but it now feels alive and premium.

### 2B. groups / gift-cards / about — replace the flat hero with a real photo hero

These use `.w-hero-flat` (gradient only). Convert them to the **same photo-hero pattern the hubs use**, so the whole site shares one hero language.

**Photo choice (real, in-repo or one download each):**
- `groups/` → reuse `groups/group-photo.jpg` (already downloaded, real WOGO group shot). ✅ in repo.
- `about/` → reuse `amsterdam/ndsm-noord/ndsm-noord-hero.jpg` (already used in the story block) **or** download one warm bar-interior shot from the live Wix media into `about/about-hero.jpg`. Prefer a people/behind-the-scenes frame to match the "humans behind WOGO" intent.
- `gift-cards/` → **no photo**; this hero gets the **CSS gift-card mock** (see §4) sitting beside the copy, on the espresso gradient. Keep `.w-hero-flat` here but add the card visual as the hero's right-hand element (two-column hero).

**Markup pattern for groups + about** (replace the `<section class="w-hero w-hero-flat">…` opener):
```html
<section class="w-hero">
  <img class="w-hero-video" src="group-photo.jpg" alt="A group of friends toasting cocktails on a WOGO walk" fetchpriority="high" decoding="async" width="1600" height="900">
  <div class="w-hero-overlay"></div>
  <div class="w-hero-content wg-hero-anim">
    <div class="w-hero-overline" data-i18n="hero_eyebrow">For groups of 6–30</div>
    <h1 data-i18n="hero_h1">Cocktail Walks, Built for Groups</h1>
    <p class="w-hero-sub" data-i18n="hero_sub">Bachelorettes, birthdays, team outings. We handle the bars.</p>
    <div class="w-hero-price" data-i18n="hero_price">€32,95 per person · groups of 6–30 · Amsterdam &amp; Rotterdam</div>
    <p data-i18n="hero_p">Three reserved bars, three cocktails each, one unforgettable night.</p>
    <a href="#enquire" class="w-hero-cta w-scroll" data-i18n="hero_cta">Plan your group walk →</a>
  </div>
</section>
```
Add to each of these pages' `<style>` the hub hero rules they currently lack: `.w-hero-video`, `.w-hero-brand`/overline sizing already present, plus the `.w-hero-overlay` gradient + Ken-Burns block from §2A, and the `.w-hero-sub` block from §1a. **Remove** the now-unused `.w-hero-flat` rules (or leave them; harmless, but cleaner to drop).

**Dash-free headlines for these three:**
| Page | `h1` (EN) | `.w-hero-sub` (EN) | `h1` (NL) | sub (NL) |
|---|---|---|---|---|
| `groups/` | Cocktail Walks, Built for Groups | Bachelorettes, birthdays, team outings. We handle the bars. | Cocktail Walks voor groepen | Vrijgezellenfeesten, verjaardagen, teamuitjes. Wij regelen de bars. |
| `about/` | Explore your city, one cocktail at a time | Born in lockdown to back local bars. 80,000+ walks later, still hand-picked. | Ontdek je stad, één cocktail per keer | Ontstaan in lockdown om lokale bars te steunen. 80.000+ walks later, nog steeds met de hand gekozen. |
| `gift-cards/` | Give a Cocktail Walk Gift Card | A night out they'll actually remember. In their inbox in minutes. | Geef een Cocktail Walk cadeaubon | Een avond uit die ze écht bijblijft. Binnen minuten in de inbox. |

**about `hero_price` line** doesn't exist — omit that line for about. Keep the trust strip below the CTA on all three (already present on gift-cards; add the `.w-hero-trust` strip to groups + about using the shared `t_google/t_trustpilot/t_guests` keys).

---

## 3. HOMEPAGE DYNAMIC REVIEW CAROUSEL (homepage only)

**Owner intent:** a much larger pool of **real** reviews (Trustpilot + Google + GetYourGuide) that shuffles per visit + gently auto-advances, each labelled with its true source.

**CRO tension, resolved:** NN/g evidence says *single-slide auto-forwarding carousels* hide content and annoy. We honor the owner's ask **and** the evidence by building a **multi-card visible rail that is shuffled once per visit and drifts gently**, with **pause-on-hover / focus / touch**, full swipe, arrows, and reduced-motion = no auto-advance. That gives the freshness the owner wants (different reviews each visit) without the documented single-slide harm — it still reads as a scannable list.

### 3a. Data format (in-page JS array, no network)
Replace the 4 hardcoded `.w-review` cards with a data-driven pool. Add near the foot script:
```js
/* REAL reviews only. Harvested verbatim from Trustpilot / Google / GetYourGuide.
   Trim long ones with a trailing … — never reword. stars 4–5 only (curation,
   not editing). Keep the source label truthful. lang: 'en'|'nl' shown as-is
   (Dutch quotes are fine on the NL site AND EN site — real voice > translation). */
var WOGO_REVIEWS = [
  { q:"So much fun to do with friends! Great organization. They picked lovely cocktail bars for us in Amsterdam, responded quickly and were extremely friendly. Highly recommended!", name:"Wendy K.", meta:"Amsterdam", src:"Trustpilot", stars:5 },
  { q:"My sixth time on the WOGO walk — Amsterdam Centre, Belly of the Beast, Margerita bar, Arca near Central. I plan at least one walk a month. Love it!", name:"Walter Z.", meta:"Returning guest", src:"Trustpilot", stars:5 },
  { q:"Erg leuk om met vrienden te doen! Goede organisatie. Ze hebben leuke cocktailbars uitgekozen in Amsterdam. Snel en vriendelijk. Een aanrader!", name:"Wendy Kabalt", meta:"Amsterdam", src:"Trustpilot", stars:5 },
  { q:"Een hele creatieve manier van een uitje! 3 cocktails, elke bar, waarbij je de hele buurt leert kennen. Let's go!", name:"Michiel", meta:"", src:"Trustpilot", stars:5 },
  { q:"Super leuk! De cocktails bij de Kevin Bacon bar waren geweldig. Leuk ontvangen en een gratis shotje met snack.", name:"Stephanie O.", meta:"Rotterdam", src:"Trustpilot", stars:5 },
  { q:"Such a great way to make a night out more interesting and less stressful — the plan is already in place. Nice venues and an easy, fun evening.", name:"Elizabeth O.", meta:"Verified booking", src:"Trustpilot", stars:4 },
  { q:"Really a great idea — perfect for discovering hidden bars you'd never have walked into otherwise. We had a lot of fun!", name:"GetYourGuide traveller", meta:"Germany · Verified booking", src:"GetYourGuide", stars:4 }
  /* MAROUSSIA: paste more REAL 4–5★ reviews here — Trustpilot, Google, GYG.
     The more you add, the more variety each visitor sees. Verbatim only. */
];
```
**Source-of-truth rule:** every object needs a truthful `src` of exactly `"Trustpilot"`, `"Google"`, or `"GetYourGuide"`. The 3★/2★ items in the pool (Elena Müller logistics complaint, Anna-Maria 2★) are **excluded** — curating which real reviews to feature is allowed; editing their text is not.

### 3b. Source badge (per card)
Small pill, brand-tinted, top-right of each card. No third-party logos (avoids trademark/asset issues); a clean text badge:
```css
.w-review { position: relative; }
.w-review-src { position:absolute; top:14px; right:14px; font-size:9.5px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; padding:4px 9px; border-radius:999px; }
.w-review-src[data-src="Trustpilot"]  { background:#e7f6ef; color:#1b7a4b; }
.w-review-src[data-src="Google"]      { background:#eef2fb; color:#3159c4; }
.w-review-src[data-src="GetYourGuide"]{ background:#fdecef; color:#c0325a; }
@media (prefers-color-scheme: dark){ /* n/a — homepage light only */ }
```

### 3c. Render + shuffle + gentle auto-advance + swipe (foot JS)
```js
(function () {
  var rail = document.getElementById('reviewsScroller');
  if (!rail || !window.WOGO_REVIEWS) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Fisher–Yates shuffle → different order every visit (the "dynamic" win). */
  var pool = WOGO_REVIEWS.slice();
  for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(Math.random()*(i+1)); var t=pool[i]; pool[i]=pool[j]; pool[j]=t; }

  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function starRow(n){ return '★ '.repeat(n).trim() + (n<5 ? ' ☆'.repeat(5-n) : ''); }

  rail.innerHTML = pool.map(function (r) {
    var meta = r.meta ? esc(r.meta) : esc(r.src);
    return '<div class="w-review">' +
      '<span class="w-review-src" data-src="'+esc(r.src)+'">'+esc(r.src)+'</span>' +
      '<div class="w-review-stars" role="img" aria-label="Rated '+r.stars+' out of 5">'+starRow(r.stars)+'</div>' +
      '<div class="w-review-quote">“'+esc(r.q)+'”</div>' +
      '<div class="w-review-foot"><div class="w-review-name">'+esc(r.name)+'</div>' +
      '<div class="w-review-meta">'+meta+' · '+esc(r.src)+'</div></div></div>';
  }).join('');

  /* Gentle auto-advance: nudge one card-width every 5s. NOT a single-slide
     hijack — the whole rail is visible and swipeable. Pauses on any interaction
     and never runs under reduced-motion (NN/g mitigation). */
  if (reduce) return;
  var timer = null, paused = false;
  function step(){
    if (paused) return;
    var card = rail.querySelector('.w-review');
    var w = card ? card.getBoundingClientRect().width + 16 : 336;
    var atEnd = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4;
    rail.scrollTo({ left: atEnd ? 0 : rail.scrollLeft + w, behavior: 'smooth' });
  }
  function start(){ stop(); timer = setInterval(step, 5000); }
  function stop(){ if (timer) clearInterval(timer); timer = null; }
  ['pointerdown','touchstart','mouseenter','focusin'].forEach(function(e){ rail.addEventListener(e, function(){ paused = true; stop(); }, {passive:true}); });
  ['mouseleave','focusout'].forEach(function(e){ rail.addEventListener(e, function(){ paused = false; start(); }); });
  /* Pause when the section is off-screen (saves cycles / respects attention). */
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function(es){ es.forEach(function(en){ paused = !en.isIntersecting; en.isIntersecting ? start() : stop(); }); }, {threshold:0.2}).observe(rail);
  } else { start(); }
})();
```
The existing `.w-arrow` left/right buttons already target `reviewsScroller` and keep working (user-initiated scroll — the good kind). Mobile swipe already works via the native `overflow-x:auto` scroller. **Keep** the "Read all our reviews on Google →" link below.

### 3d. Markup change
In the reviews section, empty the scroller (JS fills it) but keep a no-JS fallback of 2–3 static cards inside it so the section is never blank without JS:
```html
<div class="w-scroller" id="reviewsScroller">
  <!-- No-JS fallback: 2 real cards; JS replaces the whole list with the shuffled pool. -->
  <div class="w-review"><span class="w-review-src" data-src="Trustpilot">Trustpilot</span>…</div>
  <div class="w-review"><span class="w-review-src" data-src="Trustpilot">Trustpilot</span>…</div>
</div>
```
Because the pool is language-agnostic (real Dutch + English quotes shown verbatim), the review cards are **exempt from the i18n dict** — remove the `r1q…r4m` keys from the NL dict and drop `data-i18n` from review cards. Document this in a comment so the i18n sync check doesn't flag them.

---

## 4. GIFT-CARD VISUAL MOCK + CUSTOM AMOUNT (gift-cards page)

### 4a. The card mock — pure CSS/SVG, espresso + peach, WOGO wordmark
A beautiful branded card, no image asset. Drop it into the gift-cards hero (right column) **and** reuse it at the top of the `#tiers` section.

```html
<div class="w-giftcard" role="img" aria-label="WOGO gift card">
  <div class="w-giftcard-sheen" aria-hidden="true"></div>
  <div class="w-giftcard-top">
    <span class="w-giftcard-word">WOGO</span>
    <span class="w-giftcard-chip" aria-hidden="true"></span>
  </div>
  <div class="w-giftcard-mid" data-i18n="gc_label">Gift Card</div>
  <div class="w-giftcard-foot">
    <span data-i18n="gc_sub">The Cocktail Walk</span>
    <span class="w-giftcard-cities">AMS · RTM · UTR · GRO</span>
  </div>
</div>
```
```css
.w-giftcard {
  position: relative; width: min(360px, 88vw); aspect-ratio: 1.586 / 1;   /* real card ratio */
  border-radius: 18px; overflow: hidden; padding: 22px 24px;
  display: flex; flex-direction: column; justify-content: space-between;
  color: #F5C9A8; isolation: isolate;
  background:
     radial-gradient(130% 120% at 85% 15%, #7a3a1c 0%, #5C2A14 45%, #3d1d0e 100%);
  box-shadow: 0 22px 48px rgba(26,20,16,0.40), inset 0 1px 0 rgba(245,201,168,0.18);
  border: 1px solid rgba(245,201,168,0.22);
  transform: rotate(-3deg);
  transition: transform .4s cubic-bezier(.22,.61,.36,1), box-shadow .4s ease;
}
.w-giftcard:hover { transform: rotate(-1deg) translateY(-4px); box-shadow: 0 30px 60px rgba(26,20,16,0.5); }
@media (hover:none){ .w-giftcard:hover{ transform: rotate(-3deg); } }
/* Peach diagonal sheen that sweeps once on reveal (transform only) */
.w-giftcard-sheen { position:absolute; inset:-40% -10%; z-index:-1;
  background: linear-gradient(115deg, transparent 40%, rgba(245,201,168,0.16) 50%, transparent 60%);
  transform: translateX(-60%); }
html.wg-js .w-giftcard.wg-in .w-giftcard-sheen { transition: transform 1.1s ease .2s; transform: translateX(60%); }
.w-giftcard-top { display:flex; align-items:center; justify-content:space-between; }
.w-giftcard-word { font-size: 26px; font-weight: 900; letter-spacing: 0.24em; }
/* EMV-style chip in peach */
.w-giftcard-chip { width: 40px; height: 30px; border-radius: 6px;
  background: linear-gradient(135deg, #F5C9A8, #d9a878);
  box-shadow: inset 0 0 0 1px rgba(92,42,20,0.35);
  position: relative; }
.w-giftcard-chip::before { content:""; position:absolute; inset:6px 4px;
  background-image: linear-gradient(#5C2A14 1px, transparent 1px), linear-gradient(90deg, #5C2A14 1px, transparent 1px);
  background-size: 100% 8px, 12px 100%; opacity:.5; border-radius:3px; }
.w-giftcard-mid { font-size: clamp(22px,4vw,30px); font-weight: 900; text-transform: uppercase; letter-spacing: 0.02em; color:#fff; }
.w-giftcard-foot { display:flex; align-items:flex-end; justify-content:space-between; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; opacity:.85; }
.w-giftcard-cities { font-size: 10px; opacity:.7; }
@media (prefers-reduced-motion: reduce){ .w-giftcard, .w-giftcard-sheen { transition:none; transform:rotate(-3deg); } }
```
Add `gc_label` / `gc_sub` to the NL dict (`gc_label:"Cadeaubon"`, `gc_sub:"The Cocktail Walk"`). Give the card the `wg-reveal` class so the sheen sweeps in on scroll.

**Hero layout for gift-cards** becomes two-column (copy left, card right):
```css
.w-hero-content.w-gift-hero { flex-direction: row; flex-wrap: wrap; gap: 32px; align-items: center; justify-content: center; text-align: left; max-width: 1000px; }
.w-gift-hero .w-gift-copy { flex: 1 1 320px; }
.w-gift-hero .w-giftcard { flex: 0 0 auto; }
@media (max-width: 720px){ .w-hero-content.w-gift-hero { flex-direction: column; text-align: center; } }
```

### 4b. Custom-amount option (alongside €25 / €50 / €100)
Add a **4th tile** to the `#tiers` grid — the "choose your own amount" card. For now it links to the existing Wix gift-card purchase page (where the buyer types any amount). Commented for Stripe later.

```html
<!-- CUSTOM AMOUNT tile — 4th in the grid.
     PHASE 1 (now): links to the live Wix gift-card page, where the buyer enters
     any amount at checkout. target=_top breaks out of the Wix iframe.
     PHASE 2 (Stripe): replace href with the Stripe custom-amount checkout and
     add an inline amount <input> (min 10, step 5). See commented block below. -->
<div class="w-tier w-tier-custom">
  <div class="w-tier-amt" aria-hidden="true">€ …</div>
  <div class="w-tier-sub" data-i18n="tierc_sub">Your amount</div>
  <div class="w-tier-benefit"><span aria-hidden="true">🎁</span><span data-i18n="tierc_b">Any value you like</span></div>
  <a href="https://www.wogococktailwalk.com/gift-cards" target="_top" class="w-tier-btn w-navlink" data-i18n="tierc_btn">Choose an amount →</a>
</div>
<!-- PHASE 2 (Stripe) — do not enable until Stripe gift cards are live:
<label class="w-tier-input"><span>€</span>
  <input type="number" min="10" step="5" inputmode="numeric" placeholder="50" aria-label="Custom gift amount in euros">
</label>
-->
```
Update the grid to 4 columns on desktop, 2 on tablet, 1 on mobile:
```css
.w-tiers { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 900px){ .w-tiers { grid-template-columns: 1fr 1fr; } }
@media (max-width: 720px){ .w-tiers { grid-template-columns: 1fr; } }
.w-tier-custom { border: 1.5px dashed rgba(92,42,20,0.35); background:#fff; }
.w-tier-custom .w-tier-amt { color:#8a7066; }
```
Add anchor line under the grid (WijnSpijs-style spend anchor, using **real** price):
```html
<p class="w-tiers-note" data-i18n="tiers_anchor">A walk is €29,95 per person — €50 covers one guest with a cocktail to spare, €100 makes it a night for two.</p>
```
NL dict: `tierc_sub:"Eigen bedrag"`, `tierc_b:"Elk bedrag dat je wilt"`, `tierc_btn:"Kies een bedrag →"`, `tiers_anchor:"Een walk is €29,95 per persoon — €50 dekt één gast met een cocktail over, €100 maakt er een avond voor twee van."` (dash here is body copy, allowed; if you prefer, use "…per persoon. €50 dekt…").

**Update the JSON-LD** `AggregateOffer` on gift-cards: keep `lowPrice:"25"` but since custom amounts start at €10 in Phase 2, leave as-is for Phase 1 (Wix tiers unchanged). Flag in the head comment.

---

## 5. ABOUT PAGE — personal + partner brands + work-with-us

The About page already has: story block, stats, "how we pick", partner chips, contact. V3 deepens three areas.

### 5a. Make the story PERSONAL (founder voice)
Replace the third-person story with **first-person founder voice** and add a real founder line + photo slot. The repo has no founder photo yet — leave a clearly-commented slot and use a warm placeholder frame; **Maroussia decides** whether to add her face (EEAT favors it).

New story copy (`story_p1` / `story_p2`, EN then NL):
- EN p1: "I started WOGO in Amsterdam during lockdown. Our favourite bars were empty and I wanted to send people back to them — not to a tourist trap, but to the hidden places locals actually love."
- EN p2: "Years later we've arranged 80,000+ walks across four cities, and I still personally sign off on every bar we add. If it's not somewhere I'd take my own friends, it doesn't make the route."
- NL p1: "Ik ben WOGO begonnen in Amsterdam tijdens de lockdown. Onze favoriete bars waren leeg en ik wilde mensen terugbrengen — niet naar een toeristenval, maar naar de verborgen plekken waar locals van houden."
- NL p2: "Jaren later hebben we 80.000+ walks geregeld in vier steden, en ik keur nog steeds elke bar persoonlijk goed. Als ik er mijn eigen vrienden niet mee naartoe zou nemen, komt hij niet op de route."

Add a founder attribution line under `story_p2`:
```html
<p class="w-founder-sig" data-i18n="founder_sig">— Maroussia, founder of WOGO</p>
```
```css
.w-founder-sig { margin-top: 14px; font-size: 14px; font-weight: 800; color: #5C2A14; font-style: italic; }
```
(The `—` here is a signature em dash in body text, not a headline — allowed. If you want zero dashes anywhere, use "Maroussia · founder of WOGO".)

**Founder photo slot** (commented, her call):
```html
<!-- FOUNDER PHOTO (Maroussia's call — EEAT favours a real face here).
     Drop a real photo at about/founder.jpg and uncomment:
<figure class="w-founder">
  <img src="founder.jpg" alt="Maroussia, founder of WOGO" width="120" height="120" loading="lazy">
  <figcaption data-i18n="founder_cap">Maroussia · Founder</figcaption>
</figure>  -->
```

### 5b. Partner brands — logos/names of premium spirits partners
The chips already list Bobby's Gin, Hendrick's, Bols, Patrón, Lillet, Absolut + "…and 15+ more". V3 upgrade: present them as **tasteful text wordmarks** (not clip-art), in a slightly more premium "logo wall" treatment, on the espresso band. **No fake image logos** — text wordmarks only, per the hard constraint.
```css
.w-partners-grid .w-chip { font-size: 15px; font-weight: 800; letter-spacing: 0.02em; padding: 12px 22px;
  background: rgba(245,201,168,0.06); border-color: rgba(245,201,168,0.32); }
.w-partners-grid .w-chip:hover { background: rgba(245,201,168,0.14); }
```
Keep the `wg-stagger` reveal so they fade in one by one. Only name **confirmed** partners; the closing "…and 15+ more" chip covers the rest without inventing names. If any partner requires no-logo/name usage rights, keep them out — text names of spirits brands you genuinely pour are fine.

### 5c. NEW section — "Work with WOGO" (brands + bars)
Insert **after** the partners band, **before** contact. Two-audience pitch (brands and bars) with real proof points and a single email CTA.

```html
<section class="w-section alt w-pad" id="partner-with-us">
  <div class="w-head">
    <div class="w-eyebrow" data-i18n="wwu_eyebrow">Partner with WOGO</div>
    <h2 data-i18n="wwu_h2">For brands and bars</h2>
    <p data-i18n="wwu_p">Put your spirit in thousands of glasses, or your bar on a curated route.</p>
  </div>
  <div class="w-boxes">
    <div class="w-box wg-reveal">
      <h3 data-i18n="wwu_brand_h">For brands</h3>
      <ul>
        <li data-i18n="wwu_brand1">A premium, social audience discovering cocktails in real bars</li>
        <li data-i18n="wwu_brand2">80,000+ walks booked and growing across four Dutch cities</li>
        <li data-i18n="wwu_brand3">Your spirit featured as the signature pour on a route</li>
      </ul>
    </div>
    <div class="w-box wg-reveal">
      <h3 data-i18n="wwu_bar_h">For bars</h3>
      <ul>
        <li data-i18n="wwu_bar1">Guaranteed reservations on quiet nights, no upfront cost</li>
        <li data-i18n="wwu_bar2">New guests who'd never have found you otherwise</li>
        <li data-i18n="wwu_bar3">A city partnership brand (partner of Gemeente Rotterdam)</li>
      </ul>
    </div>
  </div>
  <div style="text-align:center;margin-top:26px;">
    <a href="mailto:info@wogoamsterdam.com?subject=Partnering%20with%20WOGO" class="w-final-btn" data-i18n="wwu_cta">Talk partnerships →</a>
  </div>
</section>
```
NL dict keys: `wwu_eyebrow:"Werk samen met WOGO"`, `wwu_h2:"Voor merken en bars"`, `wwu_p:"Zet je drank in duizenden glazen, of je bar op een curated route."`, `wwu_brand_h:"Voor merken"`, `wwu_brand1:"Een premium, sociaal publiek dat cocktails ontdekt in échte bars"`, `wwu_brand2:"80.000+ walks geboekt en groeiend in vier Nederlandse steden"`, `wwu_brand3:"Jouw drank als signature pour op een route"`, `wwu_bar_h:"Voor bars"`, `wwu_bar1:"Gegarandeerde reserveringen op rustige avonden, zonder kosten vooraf"`, `wwu_bar2:"Nieuwe gasten die je anders nooit had gevonden"`, `wwu_bar3:"Partner van steden (partner van Gemeente Rotterdam)"`, `wwu_cta:"Praat over partnerships →"`.

**Proof-point guardrail:** only real numbers — 80,000+ walks (already sitewide), partner of Gemeente Rotterdam, four cities. Do **not** add invented reach/impression stats.

---

## 6. REMOVALS

### 6a. Groups page — remove the review/testimonial section entirely
Delete the whole block (`groups/index.html` ~611–621):
```html
<section class="w-section peach w-pad">
  <div class="w-head"><h2 data-i18n="rev_h2">Groups keep coming back</h2></div>
  <div class="w-review wg-reveal">…</div>
  <div class="w-rev-trust" data-i18n="rev_trust">…</div>
</section>
```
**Keep** the trust-number line only if you want it elsewhere — but per the owner, reviews live on the homepage now. Move the `★ 4.4 · Trustpilot · 80,000+ · Gemeente Rotterdam` line into the section above (e.g. under the enquiry form) as a plain trust row so the numbers survive. Then:
- Delete NL keys `rev_h2`, `rev_q`, `rev_attr` (keep `rev_trust` if you relocate the trust line, else delete).
- Delete now-unused CSS: `.w-review`, `.w-review-stars`, `.w-review blockquote`, `.w-review-attr`, `.w-rev-trust`.

### 6b. City hubs — remove the standalone review section from all four
In `rotterdam/`, `utrecht/`, `amsterdam/`, `groningen/` delete the `.w-reviews` band (the "What guests say about [City]" section + solo review + "Read all reviews" link). **Keep** the trust-number strip (`★ 4.4 · Trustpilot 4.5 · 80,000+`) that appears in the hero and near the routes — those stay everywhere. Delete the corresponding `rev_h2 / r1q / r1n / r1m / rev_tp` NL keys and the `.w-review*` CSS on each hub.

**Net rule after §6:** the only place `.w-review` cards exist is the homepage. Trust-number rows (★4.4 etc.) stay on every page.

---

## 7. THE RICHER ANIMATION SET (premium, 60fps-safe, reduced-motion + no-JS safe)

The motion system (`wg-js` gate, `wg-reveal`, `wg-stagger`, `wg-hero-anim`, `wg-routeline`, the reduced-motion safety net, and the foot IntersectionObserver) **already exists on content pages**. V3 raises the floor:

### 7a. Add the whole motion system to the homepage + 4 hubs (they lack it)
For `index.html` and the four hub pages:
1. Add `<script>document.documentElement.classList.add('wg-js');</script>` right after `<body>`.
2. Paste the motion CSS block (the `html.wg-js .wg-reveal / .wg-stagger / .wg-hero-anim / .wg-routeline` rules **and** the `@media (prefers-reduced-motion: reduce)` safety net) into the `<style>`, outside any fenced block — copy verbatim from `groups/index.html` lines ~366–410.
3. Paste the motion foot `<script>` (the `wg-hero-go` + IntersectionObserver block) verbatim from `groups/index.html` (~1134–1160), before `</body>`, outside fences.

### 7b. Apply reveal classes (both home + hubs)
- Hero content wrapper → add `wg-hero-anim` (entrance drift; transform-only so the LCP h1 is never hidden).
- Each `<section>`'s heading/intro → `wg-reveal`.
- Any grid/rail of siblings (city cards, steps, stats, partner chips, tiers, review rail's fallback) → `wg-stagger` on the container.
- Gift-card mock → `wg-reveal` (drives the sheen sweep).

### 7c. New premium micro-interactions (add to the shared CSS)
```css
/* Card hover lift already exists on city cards; unify tap-press everywhere */
.w-citycard, .w-tier, .w-box, .w-cityhub-card { transition: transform .3s cubic-bezier(.22,.61,.36,1), box-shadow .3s ease; }
.w-citycard:active, .w-tier:active, .w-cityhub-card:active { transform: scale(.99); }
/* CTA sheen on primary buttons (transform-only, once on hover) */
.w-hero-cta, .w-final-btn { position: relative; overflow: hidden; }
.w-hero-cta::after, .w-final-btn::after { content:""; position:absolute; top:0; left:-120%; width:60%; height:100%;
  background: linear-gradient(115deg, transparent, rgba(255,255,255,0.35), transparent); transform: skewX(-18deg); transition: left .6s ease; }
.w-hero-cta:hover::after, .w-final-btn:hover::after { left: 140%; }
@media (hover: none){ .w-hero-cta::after, .w-final-btn::after { display:none; } }
@media (prefers-reduced-motion: reduce){ .w-hero-cta::after, .w-final-btn::after { display:none; } }
```
**Hard rules:** transform/opacity only; never animate a property that triggers layout; never gate the h1, price, or a CTA behind opacity that JS must flip (hero entrance is transform-only for exactly this reason); everything visible if JS never runs; auto-advance and Ken-Burns both disabled under `prefers-reduced-motion`.

---

## 8. SECTION ORDER PER PAGE TYPE (CRO-evidence-led)

Reordered to the research: hero (photo + rating + price + CTA above fold) → value bullets → product/teaser → reviews (home only) → practical → CTA. One primary CTA per screen.

**Homepage:**
1. Hero (photo/video, dash-free h1, single trust line + CTA above fold)
2. How it works (3-step strip)
3. **Choose your route** (city filter + card rail) ← the money section, stays high
4. Groups teaser (one line + button)
5. **Reviews — dynamic shuffled rail** (the only reviews on the site)
6. Mid-page CTA
7. As featured in (press chips)
8. Gift cards teaser
9. FAQ
10. Final CTA

**City hub:**
1. Enriched photo hero (dash-free h1 + sub, trust line, `View dates` CTA)
2. How it works (shared 3-step)
3. **Routes in this city** (cards) ← one city, one focus
4. City-specific practical / meeting-point strip (keep)
5. ~~Reviews~~ **REMOVED**
6. Cross-city ("other cities", small)
7. Groups teaser
8. Gift teaser
9. FAQ
10. Final CTA
(Trust-number strip stays in hero + near routes.)

**Route page:** hero → key facts strip → the three stops / "what you'll do" → what's included → practical/map → FAQ → sticky Book bar + final CTA. (No reviews.)

**Groups:** photo hero (price above fold) → 3 proof points → how it works (3 steps) → occasion chips → **enquiry form (3–5 fields)** → ~~testimonial REMOVED~~ → FAQ → instant-book split for ≤6 → final CTA.

**Gift-cards:** two-column hero (copy + **card mock**) → amount picker (**€25/€50/€100 + custom**, anchor line) → how gifting works (3 steps) → occasion chips → mini FAQ (redemption/validity) → final CTA. Trust row (instant email, review snippet) near the buy buttons.

**About:** photo hero → **first-person founder story (+ photo slot)** → trust numbers → how we pick our bars → **premium spirits partners (wordmarks)** → **Work with WOGO (brands + bars)** → contact → soft CTA back to routes.

---

## 9. PER-FILE CHANGE LIST

**`index.html`** — add `wg-js` motion system (§7a) + reveal classes (§7b); dash-free `hero_p` (§1b); replace 4 static reviews with dynamic pool + shuffle/auto-advance JS + source badges (§3); drop `r1…r4` i18n keys; add CTA sheen (§7c).

**`rotterdam/` `utrecht/` `amsterdam/` `groningen/`** (hubs) — enrich hero: Ken-Burns + gradient overlay + `wg-hero-anim` (§2A); dash-free `h1`+`hero_sub` (§1a) + `hero_p` (§1b); **remove** review section + keys + CSS (§6b); add full `wg-js` motion system (§7a) + reveal classes.

**`groups/`** — replace flat hero with `group-photo.jpg` photo hero (§2B); dash-free `h1`+`hero_sub`; **remove** review section + keys + CSS (§6a); relocate trust line; add hero trust strip.

**`gift-cards/`** — two-column hero with **CSS gift-card mock** (§4a); dash-free `h1`+`hero_sub`; add **custom-amount 4th tile** + anchor line (§4b); reuse card mock atop `#tiers`; keep Wix links `target="_top"` + Stripe comment.

**`about/`** — replace flat hero with photo hero (§2B); first-person founder story + photo slot + signature (§5a); premium partner wordmarks (§5b); **new "Work with WOGO"** section + keys (§5c); dash-free `h1`+`hero_sub`.

**Route pages** (`rotterdam/witte-de-with/`, `hidden-gems/`, `premium-gin-walk/`, `utrecht/city-centre/`, `amsterdam/ndsm-noord/`, `groningen/gin-walk/`) — dash-free `hero_p` only (§1b); confirm no `.w-review` sections exist (they don't).

---

## 10. VERIFICATION GATE (run after every file edit)

Per hard constraints, after each edited file:
1. **Dash sweep:** `grep -nE 'data-i18n="(hero_h1|hero_p|hero_sub|h2)"' FILE | grep -E '—|–'` → 0 rows (repeat on the NL dict `:` lines).
2. **Tag balance:** `node -e "const s=require('fs').readFileSync('FILE','utf8');const o=(s.match(/<section/g)||[]).length,c=(s.match(/<\/section>/g)||[]).length;if(o!==c)throw'section mismatch '+o+'/'+c;console.log('sections ok',o)"`.
3. **i18n sync:** every `data-i18n="KEY"` in markup has a matching `KEY:` in the NL dict, and no orphaned NL keys remain for removed sections. Quick check: `grep -oE 'data-i18n="[^"]+"' FILE | sort -u` vs the dict keys.
4. **JSON-LD parse:** extract each `application/ld+json` block and `node -e "JSON.parse(...)"` — must parse.
5. **`node --check`** is for JS files; for inline page JS, copy the foot `<script>` body to a temp `.js` and `node --check` it (catches syntax errors in the review-carousel + motion blocks).
6. **No-JS + reduced-motion:** confirm every `wg-reveal/wg-stagger/wg-hero-anim` element is visible with JS off and under `prefers-reduced-motion`; confirm price/CTA/h1 never sit behind a JS-flipped opacity.
7. **Fences untouched:** `WOGO SHARED NAV v4` / `FOOTER v4` blocks and `BASE` / `WOGO_ROUTES` logic byte-identical (NL dict entries may change).

**Brand/CRO guardrails honored:** espresso `#5C2A14` + peach/blush `#F5C9A8` + salmon `#E2641E`, no reds; real numbers only (★4.4 Google · 4.5 Trustpilot · 80,000+ walks · Gemeente Rotterdam); 18+ + reschedule-only (no free cancellation); no fake scarcity; no invented reviews (verbatim, source-labelled, curated by rating only); mobile-first; one primary CTA per screen.

---

## 11. Open decisions for Maroussia (flag, don't block)
1. **Founder photo on About** — add your face (EEAT + trust win) or keep the placeholder slot? Your call; the code is ready either way.
2. **About `about-hero.jpg`** — reuse the NDSM shot, or download a warmer people/behind-the-scenes frame from Wix? Behind-the-scenes matches "the humans behind WOGO" better.
3. **Review pool size** — the more real 4–5★ Trustpilot/Google/GetYourGuide reviews you paste into `WOGO_REVIEWS`, the more variety each visitor sees. Aim for 12–20.
4. **Gift-card validity line** — still blocked on confirming the Wix expiry setting (≥ Dutch 2-year statutory minimum) before we can claim it.
