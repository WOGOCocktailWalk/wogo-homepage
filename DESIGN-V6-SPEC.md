# WOGO DESIGN V6 SPEC — paste-ready

Source of truth for round-6 owner feedback. Palette SoT: `~/Projects/wogo-design-system/BRAND.md` + `tokens.css`. Premium, warm, no red/terracotta. Every colour below is a canonical WOGO token.

**One thing needs YOUR input before item 7 can ship:** GetYourGuide blocks automated review fetching (returns 403, the same wall that stops live price-scraping), so I could not pull verbatim GYG quotes myself. The spec gives you the exact insertion point + object shape + a badge that already exists — you paste the real quotes from your GetYourGuide **Reviews** dashboard. Never invent them. See §7.

---

## Token quick-reference (do not invent new hexes)

| Token | Hex | Role |
|---|---|---|
| `--wogo-blush` | `#ffe5d9` | light background (warm) |
| `--wogo-cream` | `#fffaf6` | lightest background / card surface |
| `--wogo-surface-tint` (peach) | `#fbe9df` | light salmon accent background |
| `--wogo-espresso` | `#3f2b21` | **DARK band** background + primary text on light |
| `--wogo-ink` | `#201611` | **DARKEST band** (hero + final) |
| `--wogo-salmon` | `#ffaa81` | accent only (logo, highlights) |
| `--wogo-salmon-deep` | `#f2905c` | hover / active-step marker |
| `--wogo-cta-bg` | `linear-gradient(135deg,#ffaa81,#f2905c)` | the ONE primary-CTA colour |

Text on dark bands = `--wogo-blush` / `--wogo-cream`; links on dark = `--wogo-salmon`.

---

# 1) SECTION-BACKGROUND CONTRAST RHYTHM (sitewide)

### The problem
Blush, cream and peach are all near-identical in value. When three or more sit in a row the seams vanish and the page reads as one flat pink block (owner's "team outings" bleeding into "what our guests say"). The page currently runs **7 light sections in a row** on the homepage.

### The rule (memorise this)
> **Alternate light and dark. Espresso is the recurring dark band and should appear roughly every other section. Never place two *light* sections adjacent unless they are two *different* light tokens separated by a hairline — and never two sections of the *same* token back-to-back.**

Think of it as a striped ribbon: `dark → light → dark → light`. Espresso does the heavy lifting so the page stops looking washed-out.

### Standardise the section classes (paste into every page's `<style>`, replacing the current `.w-section.*` colour rules)

```css
/* ===== WOGO V6 SECTION RHYTHM — identical on every page ===== */
.w-section        { padding: 50px 0; background: var(--wogo-blush); }   /* LIGHT  · warm   */
.w-section.cream,
.w-section.alt    { background: var(--wogo-cream); }                    /* LIGHT  · lightest */
.w-section.peach  { background: var(--wogo-surface-tint); }             /* LIGHT  · salmon-tint */
.w-section.brown  { background: var(--wogo-espresso); }                 /* DARK   · primary band  (NB: was #643e2b on how-it-works — standardise to espresso) */
.w-section.dark   { background: var(--wogo-ink); }                      /* DARKEST · hero echo / final */

/* ---- ONE inversion helper: add `brown` or `dark` and text flips automatically ---- */
.w-section.brown, .w-section.dark { color: var(--wogo-blush); }
.w-section.brown h2, .w-section.dark h2,
.w-section.brown .w-head h2, .w-section.dark .w-head h2 { color: var(--wogo-cream); }
.w-section.brown .w-eyebrow, .w-section.dark .w-eyebrow,
.w-section.brown .w-head p,  .w-section.dark .w-head p  { color: rgba(255,229,217,0.72); }
.w-section.brown p,  .w-section.dark p  { color: rgba(255,229,217,0.88); }
.w-section.brown a:not(.w-btn):not([class*="btn"]),
.w-section.dark  a:not(.w-btn):not([class*="btn"]) { color: var(--wogo-salmon); }
/* Cards inside dark bands keep their cream surface + espresso text — no change needed. */
```

This replaces the hand-styled `.w-how .w-head h2 {color:cream}` / `.w-partners .w-chip {color:blush}` one-offs: any section you mark `brown`/`dark` inverts its own text. Keep the one-offs only where a section has bespoke children.

### Intended sequence — HOMEPAGE (apply now)

| # | Section | V6 class | Tone |
|---|---|---|---|
| 1 | Hero (photo) | `.w-hero` (ink) | **DARK** |
| 2 | How it works strip | `.w-section brown` | **DARK** |
| 3 | Choose your route `#cities` | `.w-section` (blush) | light |
| 4 | Groups | `.w-section brown` ← **change from blush** | **DARK** |
| 5 | Reviews | `.w-section cream` ← **change from peach** | light |
| 6 | As featured in / press | `.w-section brown` ← **change from blush** | **DARK** |
| 7 | Gift cards | `.w-section peach` | light |
| 8 | FAQ | `.w-section` (blush) ← **change from `alt`** | light |
| 9 | Final CTA | `.w-section dark` | **DARK** |

- Dark bands: 1,2,4,6,9 (espresso used 3×) — satisfies "use espresso much more."
- Only one light-light adjacency (7 peach → 8 blush): different tokens, and FAQ already carries a top hairline (`border-top` via its first `<details>`), so the seam stays visible.
- **Remove the standalone mid-CTA button band** (`<div class="w-pad" ...w-mid-cta-btn...>` between Reviews and Press). Move that button to the *end of the Reviews (cream) section* so conversion is preserved without adding a 10th flat-light band. On a dark Groups band (4), the "→ Up to 6 people?" sub-link needs `color: var(--wogo-salmon)` (the inversion helper handles it).

### Intended sequence — HOW IT WORKS (after the §2 compaction)

| # | Section | V6 class | Tone |
|---|---|---|---|
| 1 | Hero (photo) | `.w-hero` | **DARK** |
| 2 | Steps (phone + beside-text) | `.w-section brown` | **DARK** |
| 3 | City-hub picker `#cities` | `.w-section` (blush) | light |
| 4 | Groups strip | `.w-section brown` | **DARK** |
| 5 | Gift strip | `.w-section peach` | light |
| 6 | Final CTA | `.w-section dark` | **DARK** |

(The definition / included / good-to-know sections are deleted in §2 — the "what is a self-guided cocktail walk" keyword now lives in the blog, §4.)

### Intended sequence — ABOUT (after the §5 deletions)

| # | Section | V6 class | Tone |
|---|---|---|---|
| 1 | Hero | `.w-hero` | **DARK** |
| 2 | Our story `#story` | `.w-section` (blush) | light |
| 3 | Where we are today (stats) | `.w-section brown` ← **change from peach** | **DARK** |
| 4 | Brands we've poured with (brand wall) | `.w-section cream` ← **change from `alt`; keep cream** | light |
| 5 | For brands & bars `#partner-with-us` | `.w-section brown` ← **change from `alt`** | **DARK** |
| 6 | Say hello (contact teaser) | `.w-section peach` | light |
| 7 | Groups strip | `.w-section brown` | **DARK** |
| 8 | Gift strip | `.w-section peach` | light |
| 9 | Ready to explore `#cities` | `.w-section` (blush) | light |
| 10 | (no separate final — `#cities` closes) | — | — |

The two deleted sections ("How we pick our bars", "Our premium spirits partners") are what caused the light pile-up on About; removing them plus this mapping fixes it.

### Intended sequence — GROUPS

Apply the same alternation: Hero (dark) → intro/why (blush) → how-groups-works (`brown` dark) → inclusions/pricing (cream) → social proof (`brown` dark) → FAQ (blush) → final CTA (`dark`). Audit the live file and insert an espresso band wherever two lights currently touch.

### Intended sequence — CONTACT (§3) and BLOG (§4)
Specified inline in those sections; both follow the same ribbon.

---

# 2) HOW IT WORKS — COMPACT, ANIMATED PHONE

### What changes
- **Delete** three text-heavy sections: the "What is a self-guided cocktail walk?" definition block, the "What's in your ticket" included/not-included boxes, and the "Good to know" cards. (Keyword coverage moves to the blog, §4.)
- **Keep only the phone frame.** Inside each phone screen, replace the icon+heading+paragraph with a **small CSS/SVG animation** that *shows* the step. The step's short text moves **beside** the phone (desktop) / **below** it (mobile).
- Auto-advance drives the phone screen *and* the highlighted beside-step together (they stay in sync).
- Much less prose: each step is a bold label (3–5 words) + one supporting line (≤12 words).

### Layout (replace the `#steps` section body)

```html
<section class="w-section brown w-pad" id="steps">
  <div class="w-head wg-reveal">
    <div class="w-eyebrow" data-i18n="steps_eyebrow">Step by step</div>
    <h2 data-i18n="steps_h2">Your night, start to last sip</h2>
  </div>

  <div class="hiw-layout wg-reveal">
    <!-- PHONE (unchanged frame; screens now hold animations) -->
    <div class="hiw-phone-col">
      <div class="w-phone">
        <span class="w-phone-notch" aria-hidden="true"></span>
        <div class="w-phone-screen">
          <div class="w-phone-track" id="wPhoneTrack" role="group"
               aria-roledescription="carousel" aria-label="How a WOGO walk works, five steps">

            <article class="w-phone-slide" aria-label="Step 1 of 5">
              <div class="hiw-anim hiw-anim--cal" aria-hidden="true">
                <div class="hiw-cal">
                  <span class="hiw-cal-h"></span>
                  <span class="hiw-cal-d"></span><span class="hiw-cal-d"></span><span class="hiw-cal-d"></span>
                  <span class="hiw-cal-d"></span><span class="hiw-cal-d hiw-cal-pick"></span><span class="hiw-cal-d"></span>
                  <span class="hiw-cal-d"></span><span class="hiw-cal-d"></span><span class="hiw-cal-d"></span>
                </div>
              </div>
            </article>

            <article class="w-phone-slide" aria-label="Step 2 of 5">
              <div class="hiw-anim hiw-anim--mail" aria-hidden="true">
                <div class="hiw-env">
                  <div class="hiw-letter"><span class="hiw-pin"></span></div>
                  <div class="hiw-env-flap"></div>
                  <div class="hiw-env-front"></div>
                </div>
              </div>
            </article>

            <article class="w-phone-slide" aria-label="Step 3 of 5">
              <div class="hiw-anim hiw-anim--pins" aria-hidden="true">
                <svg class="hiw-path" viewBox="0 0 200 120" fill="none"><path d="M18 96 C 70 96, 70 30, 100 30 S 150 96, 182 40"
                  stroke="currentColor" stroke-width="3" stroke-dasharray="4 7" stroke-linecap="round"/></svg>
                <span class="hiw-pin hiw-pin--1"></span>
                <span class="hiw-pin hiw-pin--2"></span>
                <span class="hiw-pin hiw-pin--3"></span>
              </div>
            </article>

            <article class="w-phone-slide" aria-label="Step 4 of 5">
              <div class="hiw-anim hiw-anim--walk" aria-hidden="true">
                <svg class="hiw-path" viewBox="0 0 200 120" fill="none"><path d="M18 90 H 182"
                  stroke="currentColor" stroke-width="3" stroke-dasharray="4 7" stroke-linecap="round"/></svg>
                <span class="hiw-pin hiw-pin--1"></span><span class="hiw-pin hiw-pin--2"></span><span class="hiw-pin hiw-pin--3"></span>
                <span class="hiw-walker">🚶</span>
              </div>
            </article>

            <article class="w-phone-slide" aria-label="Step 5 of 5">
              <div class="hiw-anim hiw-anim--glass" aria-hidden="true">
                <div class="hiw-glass">
                  <div class="hiw-glass-liquid"></div>
                  <svg class="hiw-glass-svg" viewBox="0 0 100 120" fill="none">
                    <path d="M12 14 H88 L54 66 V104 M54 104 H34 M54 104 H74 M50 66 L54 66"
                      stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle class="hiw-cherry" cx="70" cy="40" r="6"/>
                  </svg>
                </div>
              </div>
            </article>

          </div>
          <div class="w-phone-dots" id="wPhoneDots" aria-hidden="true"></div>
        </div>
      </div>
    </div>

    <!-- BESIDE-TEXT (desktop: right of phone; mobile: below) -->
    <ol class="hiw-steps-col" id="hiwSteps">
      <li class="hiw-step active" data-i="0"><span class="hiw-step-n">1</span>
        <div><h3 data-i18n="s1_h">Pick your route &amp; date</h3><p data-i18n="s1_p">Book in two minutes. From €29,95 per person.</p></div></li>
      <li class="hiw-step" data-i="1"><span class="hiw-step-n">2</span>
        <div><h3 data-i18n="s2_h">Your map arrives</h3><p data-i18n="s2_p">Route straight to your inbox. No app to install.</p></div></li>
      <li class="hiw-step" data-i="2"><span class="hiw-step-n">3</span>
        <div><h3 data-i18n="s3_h">Three bars, a surprise</h3><p data-i18n="s3_p">Hand-picked hidden gems, revealed after you book.</p></div></li>
      <li class="hiw-step" data-i="3"><span class="hiw-step-n">4</span>
        <div><h3 data-i18n="s4_h">Walk it your pace</h3><p data-i18n="s4_p">5 to 15 minutes between stops. The night is yours.</p></div></li>
      <li class="hiw-step" data-i="4"><span class="hiw-step-n">5</span>
        <div><h3 data-i18n="s5_h">A cocktail at each</h3><p data-i18n="s5_p">Table waiting. Signature cocktail or mocktail, your pick.</p></div></li>
    </ol>
  </div>

  <div style="text-align:center;margin-top:30px;">
    <a href="#cities" class="w-hero-cta w-scroll" data-i18n="steps_cta">See the cities →</a>
  </div>
</section>
```

### NL dictionary entries (keep in sync; delete the old s1_p…s5_p long strings + def_/inc_/ninc_/gtk_ keys)

```js
steps_h2: "Jouw avond, van start tot laatste slok",
s1_h: "Kies je route &amp; datum", s1_p: "Boek in twee minuten. Vanaf €29,95 per persoon.",
s2_h: "Je routekaart komt binnen", s2_p: "Route direct in je inbox. Geen app nodig.",
s3_h: "Drie bars, een verrassing", s3_p: "Zorgvuldig gekozen verborgen parels, onthuld na je boeking.",
s4_h: "Loop op jouw tempo", s4_p: "5 tot 15 minuten tussen de stops. De avond is van jou.",
s5_h: "Bij elke bar een cocktail", s5_p: "Tafel klaar. Signature cocktail of mocktail, jij kiest.",
steps_cta: "Bekijk de steden →",
```

### Animation CSS (paste into the page `<style>`, transform/opacity only, reduced-motion + no-JS safe)

```css
/* ===== HOW-IT-WORKS · compact two-column phone ===== */
.hiw-layout { display:flex; align-items:center; gap:44px; max-width:960px; margin:0 auto; }
.hiw-phone-col { flex:0 0 300px; }
.hiw-steps-col { flex:1 1 auto; list-style:none; margin:0; padding:0; counter-reset:none; }
.hiw-step { display:flex; gap:14px; align-items:flex-start; padding:16px 0 16px 18px;
  border-left:3px solid transparent; opacity:.55; transition:opacity .35s ease, border-color .35s ease; }
.hiw-step.active { opacity:1; border-left-color:var(--wogo-salmon-deep); }
.hiw-step-n { flex:0 0 30px; width:30px; height:30px; border-radius:50%;
  background:rgba(255,229,217,0.14); color:var(--wogo-cream); font-weight:900; font-size:14px;
  display:flex; align-items:center; justify-content:center; }
.hiw-step.active .hiw-step-n { background:var(--wogo-cta-bg); color:var(--wogo-cta-ink); box-shadow:var(--wogo-cta-shadow); }
.hiw-step h3 { font-size:16px; font-weight:800; color:var(--wogo-cream); margin-bottom:3px; }
.hiw-step p  { font-size:13.5px; line-height:1.5; color:rgba(255,229,217,0.85); font-weight:500; }

/* Each phone screen is a full-bleed light stage that holds one illustration */
.w-phone-slide { padding:0; }
.hiw-anim { position:relative; width:100%; height:100%; background:var(--wogo-blush);
  display:flex; align-items:center; justify-content:center; color:var(--wogo-espresso); overflow:hidden; }
.hiw-path { position:absolute; inset:0; margin:auto; width:82%; height:auto; color:var(--wogo-brown-soft); opacity:.6; }

/* --- Step 1 · calendar: chosen day pops (resting state = already chosen, for no-JS) --- */
.hiw-cal { display:grid; grid-template-columns:repeat(3,26px); grid-auto-rows:26px; gap:9px;
  padding:20px; background:var(--wogo-cream); border-radius:16px; box-shadow:var(--wogo-shadow-md); }
.hiw-cal-h { grid-column:1 / -1; height:8px; border-radius:4px; background:var(--wogo-salmon); opacity:.5; }
.hiw-cal-d { border-radius:50%; background:rgba(63,43,33,0.12); }
.hiw-cal-pick { background:var(--wogo-cta-bg); box-shadow:var(--wogo-cta-shadow); position:relative; }
.hiw-cal-pick::after { content:"✓"; position:absolute; inset:0; display:flex; align-items:center;
  justify-content:center; font-size:15px; font-weight:900; color:var(--wogo-cta-ink); }

/* --- Step 2 · envelope + letter with a pin --- */
.hiw-env { position:relative; width:150px; height:104px; }
.hiw-env-front { position:absolute; inset:auto 0 0 0; height:104px; background:var(--wogo-espresso);
  border-radius:10px; z-index:2; clip-path:polygon(0 34%,50% 74%,100% 34%,100% 100%,0 100%); }
.hiw-env-flap { position:absolute; top:0; left:0; right:0; height:56px; background:var(--wogo-brown);
  border-radius:10px 10px 0 0; transform-origin:top; clip-path:polygon(0 0,100% 0,50% 100%); z-index:3; }
.hiw-letter { position:absolute; left:18px; right:18px; top:6px; height:74px; background:var(--wogo-cream);
  border-radius:8px 8px 0 0; box-shadow:var(--wogo-shadow-sm); z-index:1;
  display:flex; align-items:flex-start; justify-content:center; padding-top:12px; }
.hiw-letter .hiw-pin { position:static; }

/* --- Steps 3 & 4 · map pins --- */
.hiw-pin { position:absolute; width:18px; height:18px; border-radius:50% 50% 50% 0;
  background:var(--wogo-cta-bg); transform:rotate(-45deg); box-shadow:0 3px 8px rgba(242,144,92,0.5); }
.hiw-pin::after { content:""; position:absolute; inset:5px; border-radius:50%; background:var(--wogo-cream); }
.hiw-anim--pins .hiw-pin--1 { left:12%;  bottom:14%; }
.hiw-anim--pins .hiw-pin--2 { left:47%;  top:16%; }
.hiw-anim--pins .hiw-pin--3 { right:10%; bottom:26%; }
.hiw-anim--walk .hiw-pin { bottom:20%; transform:rotate(-45deg); }
.hiw-anim--walk .hiw-pin--1 { left:9%; } .hiw-anim--walk .hiw-pin--2 { left:48%; } .hiw-anim--walk .hiw-pin--3 { right:9%; }
.hiw-walker { position:absolute; left:9%; bottom:14%; font-size:26px; }

/* --- Step 5 · cocktail glass fills --- */
.hiw-glass { position:relative; width:120px; height:150px; color:var(--wogo-espresso); }
.hiw-glass-svg { position:relative; z-index:2; width:100%; height:100%; }
.hiw-cherry { fill:var(--wogo-salmon-deep); }
.hiw-glass-liquid { position:absolute; left:26%; right:26%; top:16%; height:38%; z-index:1;
  background:var(--wogo-cta-bg); border-radius:2px; transform-origin:bottom;
  clip-path:polygon(0 0,100% 0,52% 78%,48% 78%); }

/* ===== play only while the slide is active (JS adds .is-active) ===== */
.w-phone-slide.is-active .hiw-cal-pick { animation:hiwPop .5s cubic-bezier(.22,1.4,.5,1) both; }
.w-phone-slide.is-active .hiw-env-flap { animation:hiwFlap 2.6s ease-in-out infinite; }
.w-phone-slide.is-active .hiw-letter   { animation:hiwLetter 2.6s ease-in-out infinite; }
.w-phone-slide.is-active .hiw-anim--pins .hiw-pin--1 { animation:hiwDrop .6s ease both .05s; }
.w-phone-slide.is-active .hiw-anim--pins .hiw-pin--2 { animation:hiwDrop .6s ease both .35s; }
.w-phone-slide.is-active .hiw-anim--pins .hiw-pin--3 { animation:hiwDrop .6s ease both .65s; }
.w-phone-slide.is-active .hiw-walker { animation:hiwWalk 3s ease-in-out infinite; }
.w-phone-slide.is-active .hiw-glass-liquid { animation:hiwFill 2.4s ease-in-out infinite; }

@keyframes hiwPop   { 0%{transform:scale(0);} 100%{transform:scale(1);} }
@keyframes hiwFlap  { 0%,18%{transform:rotateX(0);} 45%,100%{transform:rotateX(-172deg);} }
@keyframes hiwLetter{ 0%,30%{transform:translateY(14px);} 60%,100%{transform:translateY(-30px);} }
@keyframes hiwDrop  { 0%{transform:translateY(-26px) rotate(-45deg); opacity:0;}
                      70%{transform:translateY(3px) rotate(-45deg); opacity:1;} 100%{transform:translateY(0) rotate(-45deg);} }
@keyframes hiwWalk  { 0%{transform:translateX(0);} 100%{transform:translateX(150px);} }
@keyframes hiwFill  { 0%{transform:scaleY(0);} 55%,100%{transform:scaleY(1);} }

/* ---- mobile: text below the phone (all steps visible, active highlighted) ---- */
@media (max-width:760px){
  .hiw-layout { flex-direction:column; gap:22px; }
  .hiw-phone-col { flex:0 0 auto; }
  .hiw-steps-col { width:100%; max-width:340px; }
}
/* ---- resting / no-JS state: illustrations sit at a sensible final frame ---- */
.hiw-glass-liquid { transform:scaleY(1); }          /* glass looks full  */
.hiw-env-flap { transform:rotateX(0); }             /* envelope closed but letter peeking */
@media (prefers-reduced-motion: reduce){
  .w-phone-slide.is-active * { animation:none !important; }
  .hiw-cal-pick, .hiw-pin, .hiw-glass-liquid { animation:none !important; }
}
```

### JS — sync beside-list with the existing carousel
In the existing phone-carousel IIFE, extend `setActive(i)` (it already toggles the dots):

```js
var hiwSteps = document.querySelectorAll('#hiwSteps .hiw-step');
var hiwSlides = track.children;
function setActive(i){ cur = i;
  for(var k=0;k<dots.children.length;k++) dots.children[k].classList.toggle('active', k===i);
  for(var s=0;s<hiwSteps.length;s++) hiwSteps[s].classList.toggle('active', s===i);
  for(var m=0;m<hiwSlides.length;m++) hiwSlides[m].classList.toggle('is-active', m===i);
}
// let a beside-step jump the phone:
hiwSteps.forEach(function(li){ li.addEventListener('click', function(){ go(+li.getAttribute('data-i'), true); }); });
setActive(0); // ensure slide 0 gets .is-active on load
```

Keep the existing 4.5s auto-advance, hover/touch pause, and reduced-motion guard. Result: phone screen animation + highlighted step advance together.

---

# 3) CONTACT PAGE `/contact/`

Copy the how-it-works template folder → `/contact/`. `BASE = '../'`. Lean, premium, one clear job: get a message to the inbox. **Front-end only**, mailto fallback, backend commented.

### Structured data (light)
```html
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"ContactPage","name":"Contact WOGO",
"url":"https://www.wogococktailwalk.com/contact/",
"mainEntity":{"@type":"Organization","name":"WOGO Cocktail Walk","email":"info@wogoamsterdam.com",
"telephone":"+31202101168","address":{"@type":"PostalAddress","streetAddress":"Oude-IJsselstraat 32-2",
"postalCode":"1078 CP","addressLocality":"Amsterdam","addressCountry":"NL"}}}
</script>
```

### Sequence: Hero (dark) → Form + details (blush) → Groups/Gift strips (brown/peach) → Final (dark).

### Body (two columns: form left, real details right)

```html
<section class="w-section w-pad" id="contact">
  <div class="w-head wg-reveal"><div class="w-eyebrow" data-i18n="ct_eyebrow">Say hello</div>
    <h2 data-i18n="ct_h2">Talk to a human</h2>
    <p data-i18n="ct_p">A booking question, a group plan, or a press ask. We reply within one working day.</p></div>

  <div class="ct-grid">
    <!-- FORM -->
    <form class="ct-form wg-reveal" id="wContactForm" novalidate>
      <label class="ct-field"><span data-i18n="ct_name">Your name</span>
        <input type="text" name="name" autocomplete="name" required></label>
      <label class="ct-field"><span data-i18n="ct_email">Email</span>
        <input type="email" name="email" autocomplete="email" required></label>
      <label class="ct-field"><span data-i18n="ct_topic">What's it about?</span>
        <select name="topic" required>
          <option value="Booking question" data-i18n="ct_t1">Booking question</option>
          <option value="Group booking"   data-i18n="ct_t2">Group booking</option>
          <option value="Gift cards"       data-i18n="ct_t3">Gift cards</option>
          <option value="Press & partnerships" data-i18n="ct_t4">Press &amp; partnerships</option>
          <option value="Something else"   data-i18n="ct_t5">Something else</option>
        </select></label>
      <label class="ct-field"><span data-i18n="ct_msg">Message</span>
        <textarea name="message" rows="5" required></textarea></label>
      <button type="submit" class="w-hero-cta" data-i18n="ct_send">Send message →</button>
      <p class="ct-note" id="wContactNote" data-i18n="ct_fallback">
        This opens your email app with everything filled in. Prefer to write us directly?
        <a class="w-mail" href="mailto:info@wogoamsterdam.com">info@wogoamsterdam.com</a></p>
    </form>

    <!-- REAL DETAILS -->
    <aside class="ct-details wg-reveal">
      <div class="ct-detail"><span class="ct-detail-l" data-i18n="ct_d_email">Email</span>
        <a href="mailto:info@wogoamsterdam.com">info@wogoamsterdam.com</a></div>
      <div class="ct-detail"><span class="ct-detail-l" data-i18n="ct_d_phone">Phone</span>
        <a href="tel:+31202101168">+31 20 210 1168</a></div>
      <div class="ct-detail"><span class="ct-detail-l" data-i18n="ct_d_hours">Hours</span>
        <span data-i18n="ct_hours">Monday to Friday, 10:00 – 18:00</span></div>
      <div class="ct-detail"><span class="ct-detail-l" data-i18n="ct_d_addr">Office</span>
        <span>Oude-IJsselstraat 32-2, Amsterdam</span></div>
      <div class="ct-socials">
        <a href="https://www.instagram.com/wogococktailwalk/" target="_blank" rel="noopener">Instagram</a>
        <a href="https://www.tiktok.com/@wogococktailwalk" target="_blank" rel="noopener">TikTok</a>
        <a href="https://www.facebook.com/wogoamsterdam" target="_blank" rel="noopener">Facebook</a>
      </div>
    </aside>
  </div>
</section>
```

### Form CSS
```css
.ct-grid { max-width:960px; margin:0 auto; display:grid; grid-template-columns:1.4fr 1fr; gap:40px; align-items:start; }
.ct-form { display:flex; flex-direction:column; gap:16px; }
.ct-field { display:flex; flex-direction:column; gap:6px; font-size:12.5px; font-weight:800;
  letter-spacing:.04em; text-transform:uppercase; color:var(--wogo-brown); }
.ct-field input, .ct-field select, .ct-field textarea { font:inherit; font-weight:500; text-transform:none;
  letter-spacing:normal; color:var(--wogo-espresso); background:var(--wogo-cream);
  border:1.5px solid var(--wogo-line); border-radius:12px; padding:13px 14px; }
.ct-field input:focus, .ct-field select:focus, .ct-field textarea:focus {
  outline:none; border-color:var(--wogo-salmon-deep); box-shadow:0 0 0 3px rgba(242,144,92,0.18); }
.ct-form .w-hero-cta { align-self:flex-start; margin-top:4px; }
.ct-note { font-size:12.5px; color:var(--wogo-brown-soft); font-weight:500; line-height:1.5; }
.ct-details { background:var(--wogo-cream); border:1px solid var(--wogo-line-soft);
  border-radius:16px; padding:26px; display:flex; flex-direction:column; gap:18px; box-shadow:var(--wogo-shadow-md); }
.ct-detail { display:flex; flex-direction:column; gap:3px; }
.ct-detail-l { font-size:10.5px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--wogo-brown-soft); }
.ct-detail a { font-size:15px; font-weight:700; color:var(--wogo-espresso); text-decoration:none; }
.ct-detail a:hover { color:var(--wogo-salmon-deep); }
.ct-socials { display:flex; gap:8px; flex-wrap:wrap; margin-top:4px; }
.ct-socials a { font-size:12.5px; font-weight:700; color:var(--wogo-espresso); text-decoration:none;
  border:1.5px solid var(--wogo-line); border-radius:999px; padding:8px 14px; }
.ct-socials a:hover { background:var(--wogo-espresso); color:var(--wogo-blush); border-color:var(--wogo-espresso); }
@media (max-width:760px){ .ct-grid { grid-template-columns:1fr; gap:26px; } }
```

### Submit JS — mailto (the €0, no-backend path)
```html
<script>
/* CONTACT · front-end mailto. No server, works on static hosting.
   BACKEND LATER (still €0): if this repo moves to Netlify, add
   `data-netlify="true" name="contact"` to the <form> and a hidden
   honeypot, then delete this script — Netlify Forms captures 100
   submissions/month free. Formspree free tier is the fallback. */
(function(){
  var f = document.getElementById('wContactForm'); if(!f) return;
  f.addEventListener('submit', function(e){
    e.preventDefault();
    var name = (f.name && f.name.value || '').trim();
    var email = (f.email && f.email.value || '').trim();
    var topic = f.topic ? f.topic.value : '';
    var msg  = (f.message && f.message.value || '').trim();
    if(!name || !email || !msg){ f.reportValidity && f.reportValidity(); return; }
    var subject = 'WOGO — ' + topic + ' (' + name + ')';
    var body = 'Name: ' + name + '\nEmail: ' + email + '\nTopic: ' + topic + '\n\n' + msg;
    window.location.href = 'mailto:info@wogoamsterdam.com'
      + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(body);
  });
})();
</script>
```

### NL keys
```js
ct_eyebrow:"Zeg hallo", ct_h2:"Praat met een mens",
ct_p:"Een vraag over je boeking, een groepsplan of een persverzoek. We reageren binnen één werkdag.",
ct_name:"Je naam", ct_email:"E-mail", ct_topic:"Waar gaat het over?",
ct_t1:"Vraag over boeking", ct_t2:"Groepsboeking", ct_t3:"Cadeaubonnen",
ct_t4:"Pers &amp; samenwerkingen", ct_t5:"Iets anders",
ct_msg:"Bericht", ct_send:"Verstuur bericht →",
ct_fallback:"Dit opent je e-mailapp met alles alvast ingevuld. Liever direct mailen? <a class=\"w-mail\" href=\"mailto:info@wogoamsterdam.com\">info@wogoamsterdam.com</a>",
ct_d_email:"E-mail", ct_d_phone:"Telefoon", ct_d_hours:"Openingstijden", ct_d_addr:"Kantoor",
ct_hours:"Maandag t/m vrijdag, 10:00 – 18:00",
```

**Add `Contact` to the nav** (currently only in the footer). In the shared nav links + overlay, add `<li><a href="contact/" class="w-navlink" data-i18n="nav_contact">Contact</a></li>` (BASE-relative per page) and `nav_contact:"Contact"` to every NL dict. Footer already links Contact → repoint it from the raw mailto to `contact/`.

---

# 4) BLOG `/blog/` + posts

On-brand SEO hub. Indexable-quality copy, but keep `<meta name="robots" content="noindex">` until cutover like every content page. Voice: lowercase, warm, benefit-led, scannable.

### 4a. Blog index `/blog/index.html`
Sequence: Hero (dark) → post grid (blush) → Gift/Groups strips → Final (dark).

```html
<section class="w-section w-pad" id="blog">
  <div class="w-head wg-reveal"><div class="w-eyebrow" data-i18n="bl_eyebrow">The WOGO journal</div>
    <h2 data-i18n="bl_h2">Stories, city guides &amp; cocktail curiosities</h2></div>
  <div class="bl-grid wg-stagger">

    <a class="bl-card" href="what-is-a-self-guided-cocktail-walk/">
      <div class="bl-card-img"><img loading="lazy" decoding="async"
        src="../how-it-works/how-it-works-hero.jpg" alt="Friends on a self-guided cocktail walk"></div>
      <div class="bl-card-body">
        <span class="bl-cat" data-i18n="bl_c_guide">Explained</span>
        <h3 data-i18n="bl_p1_t">What is a self-guided cocktail walk?</h3>
        <p data-i18n="bl_p1_x">The bar crawl, upgraded: a curated route, tables reserved, zero planning. Here's how it works.</p>
        <span class="bl-meta" data-i18n="bl_p1_m">5 min read</span>
      </div>
    </a>

    <a class="bl-card" href="best-cocktail-bars-in-rotterdam/">
      <div class="bl-card-img"><img loading="lazy" decoding="async"
        src="../rotterdam/hidden-gems/hidden-gems-hero.jpg" alt="A cocktail bar in Rotterdam"></div>
      <div class="bl-card-body">
        <span class="bl-cat" data-i18n="bl_c_city">City guide</span>
        <h3 data-i18n="bl_p2_t">The best cocktail bars in Rotterdam</h3>
        <p data-i18n="bl_p2_x">Where Rotterdam actually drinks: the neighbourhoods, the vibe, and how to taste the best of it in one night.</p>
        <span class="bl-meta" data-i18n="bl_p2_m">7 min read</span>
      </div>
    </a>

  </div>
</section>
```

```css
.bl-grid { max-width:1000px; margin:0 auto; display:grid; grid-template-columns:1fr 1fr; gap:22px; }
.bl-card { display:flex; flex-direction:column; background:var(--wogo-cream); border-radius:16px;
  overflow:hidden; text-decoration:none; box-shadow:var(--wogo-shadow-md); border:1px solid var(--wogo-line-soft);
  transition:transform .3s, box-shadow .3s; }
.bl-card:hover { transform:translateY(-4px); box-shadow:0 16px 32px var(--wogo-shadow); }
.bl-card:hover .bl-card-img img { transform:scale(1.05); }
.bl-card-img { aspect-ratio:16/10; overflow:hidden; }
.bl-card-img img { width:100%; height:100%; object-fit:cover; transition:transform .5s; }
.bl-card-body { padding:18px 20px 22px; display:flex; flex-direction:column; gap:8px; }
.bl-cat { font-size:10.5px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--wogo-salmon-deep); }
.bl-card h3 { font-size:19px; font-weight:900; color:var(--wogo-ink); line-height:1.2; }
.bl-card p { font-size:14px; line-height:1.55; color:var(--wogo-espresso); font-weight:500; }
.bl-meta { font-size:12px; font-weight:700; color:var(--wogo-brown-soft); margin-top:2px; }
@media (max-width:760px){ .bl-grid { grid-template-columns:1fr; } }
```

Index JSON-LD: `{"@type":"Blog","name":"The WOGO Journal","url":".../blog/"}`. Add **Blog** to the footer "Discover" column on every page (`<a href="blog/" data-i18n="foot_blog">Blog</a>`, BASE-relative; `foot_blog:"Blog"`).

### 4b. Post template `/blog/{slug}/index.html`
- Hero: photo, `.w-hero`, H1 = post title, subline = one-line hook, no trust strip (content page).
- Body: `.bl-post` max-width 720, generous line-height; H2 subheads; one inline CTA band mid-article; "back to journal" + a route CTA at the end.
- JSON-LD `BlogPosting` with headline, datePublished, author `{"@type":"Organization","name":"WOGO"}`, image, mainEntityOfPage.

```css
.bl-post { max-width:720px; margin:0 auto; }
.bl-post p { font-size:16px; line-height:1.75; color:var(--wogo-espresso); font-weight:400; margin-bottom:18px; }
.bl-post h2 { font-size:clamp(22px,3vw,30px); font-weight:900; color:var(--wogo-ink);
  text-transform:none; letter-spacing:-0.01em; margin:34px 0 12px; }
.bl-post h2::after { content:""; display:block; width:44px; height:3px; margin-top:10px;
  border-radius:2px; background:var(--wogo-cta-bg); }
.bl-post ul { margin:0 0 18px 20px; } .bl-post li { font-size:16px; line-height:1.7; margin-bottom:8px; }
.bl-post a { color:var(--wogo-salmon-deep); font-weight:700; text-decoration:underline; text-underline-offset:3px; }
.bl-cta-band { margin:30px 0; padding:26px; border-radius:16px; background:var(--wogo-surface-tint);
  text-align:center; } /* mid-article conversion nudge */
.bl-back { display:inline-block; margin-top:24px; font-size:13px; font-weight:800; color:var(--wogo-brown); }
```

### 4c. Post 1 — "What is a self-guided cocktail walk?"
`slug: what-is-a-self-guided-cocktail-walk` · category: Explained · ~5 min.

- **Meta title (EN):** What Is a Self-Guided Cocktail Walk? | WOGO
- **Meta description (EN):** A self-guided cocktail walk is a curated bar crawl with your tables reserved and a cocktail waiting at every stop. Here's exactly how it works.
- **Meta title (NL):** Wat is een zelfgeleide cocktailwandeling? | WOGO
- **Meta description (NL):** Een zelfgeleide cocktailwandeling is een uitgestippelde kroegentocht met gereserveerde tafels en bij elke stop een cocktail. Zo werkt het.

**H1:** What is a self-guided cocktail walk?
**Hook:** the bar crawl, minus the planning and the queueing.

Outline (paste-ready draft copy, expand each into 2–3 short paragraphs):
- **Lead:** define it in one sentence — a curated route past three hand-picked cocktail bars, tables pre-arranged, one signature cocktail included at each, walked at your own pace with no guide and no group.
- **H2 · Self-guided means no guide, no group.** Just you and your people, a map on your phone, the city as your bar. Contrast with a guided tour (badges, strangers, a fixed pace).
- **H2 · How a cocktail walk works, step by step.** Book → tables reserved same day → route lands in your inbox → walk bar 1 → 2 → 3. Mirror the five steps (link to `/how-it-works/`).
- **H2 · What's included (and what isn't).** Three bars, three drinks, reserved tables, digital map. Not included: transport (it's a walk), dinner. Honesty = trust.
- **H2 · Who it's for.** Date night, catch-ups, birthdays, bachelorettes, team outings; mocktail option so no one sits out; 18+.
- **bl-cta-band:** "Ready to try one? Routes in Amsterdam, Rotterdam, Utrecht &amp; Groningen from €29,95." → button to `/#cities`.
- **Close:** the only planning you'll do is choosing a date.
- Internal links: `/how-it-works/`, `/#cities`, `/groups/`. Keywords woven naturally: *self-guided cocktail walk, cocktail walk, self-guided bar crawl, how does a cocktail walk work* (EN) / *zelfgeleide cocktailwandeling, kroegentocht* (NL).

### 4d. Post 2 — "The best cocktail bars in Rotterdam"
`slug: best-cocktail-bars-in-rotterdam` · category: City guide · ~7 min.

**Guardrail:** WOGO's routes keep the specific bars a surprise ("the bars are a surprise" is a selling point). So this post is a *neighbourhood / scene guide*, not a list that spoils the reserved WOGO bars. Position the walk as the effortless way to discover them.

- **Meta title (EN):** The Best Cocktail Bars in Rotterdam: A Local's Guide | WOGO
- **Meta description (EN):** Where Rotterdam actually drinks — the best neighbourhoods and cocktail spots, and the easiest way to taste three of them in one night.
- **Meta title (NL):** De beste cocktailbars in Rotterdam: een lokale gids | WOGO
- **Meta description (NL):** Waar Rotterdam écht drinkt — de beste buurten en cocktailplekken, en de makkelijkste manier om er drie op één avond te proeven.

**H1:** The best cocktail bars in Rotterdam
**Hook:** a city that mixes above its weight, one neighbourhood at a time.

Outline:
- **Lead:** Rotterdam's cocktail scene is bolder and less touristy than you'd expect — architecture-cool rooms, hidden upstairs bars, ex-industrial spaces turned intimate.
- **H2 · Witte de Withstraat: the beating heart.** The street everyone starts on; density of good bars, art-crowd energy. (Neighbourhood, not a spoiler.)
- **H2 · The hidden gems off the main drag.** Speakeasy-style rooms, harbourside spots, places with no sign — the ones locals guard.
- **H2 · What makes a great Rotterdam cocktail bar.** Craft over flash, a bartender who asks what you actually like, a room with a point of view.
- **H2 · How to taste the best of it in one night.** This is where WOGO fits: three hand-picked bars, tables reserved, a route that walks 5–15 min between stops — no research, no queueing, the surprise is the point. Link to `/rotterdam/`.
- **bl-cta-band:** "See it for yourself — the Rotterdam Cocktail Walk, from €29,95." → button to `/rotterdam/`.
- **Close:** the best bar in Rotterdam is the next one on your route.
- Internal links: `/rotterdam/`, `/rotterdam/witte-de-with/`, `/rotterdam/hidden-gems/`, `/#cities`. Keyword: *best cocktail bars in Rotterdam* in H1, intro, one H2, meta.

> Full Dutch translations for both posts go in each post's NL dict. Because posts are long-form, translate the whole body (not just labels); keep numbers/prices identical.

---

# 5) ABOUT PAGE DELETIONS

1. **Delete the entire "How we pick our bars" section** (`<section class="w-section alt w-pad">` holding `pick_eyebrow` / `pick_h2` / `pick_p`, the three `w-hs-item` criteria, and the `pick_more` link). Remove its NL keys: `pick_eyebrow, pick_h2, pick_p, crit1_h, crit2_h, crit3_h, pick_more`.
2. **Delete the entire "Our premium spirits partners" section** (`<section class="w-section brown w-partners w-pad">` with `partners_eyebrow` / `partners_h2` / `partners_p` + the spirit chips + `partners_more`). The brand wall already covers partners. Remove its NL keys: `partners_eyebrow, partners_h2, partners_p, partners_more` (and any per-chip keys).
3. **Brand wall:** remove exactly one line — `<li class="w-brandmark">Smith &amp; Sinclair</li>` — it's an edible-cocktail/experience brand, not a drinks brand. Leave every other `w-brandmark`. If the grid now has an awkward orphan on desktop, that's fine; `repeat(2,1fr)` on mobile still balances.
4. **Re-apply the §1 rhythm** to About using the table in §1 (the two deletions are what caused the light pile-up; the stats band → `brown`, brand wall → `cream`, partner-with-us → `brown` restores the stripe).
5. **`brands_h2` stays "Brands we've poured with"** — accurate for a drinks-only wall now that Smith & Sinclair is gone.

---

# 6) FOOTER ROUTE NAMES (data fix, applied identically on every page)

The footer Routes column currently shows internal nicknames ("Witte de With", "Hidden Gems — best seller", "NDSM & Noord") that don't match the homepage cards. Fix the `WOGO_ROUTES` labels to the **exact card names**, and drop the redundant per-city sub-heading in the footer render so the list reads cleanly as the six cards.

### New data block (paste identically into every page's foot script; only `var BASE` differs per folder)
```js
var WOGO_ROUTES = { countries: [ { code:'nl', name:{en:'Netherlands',nl:'Nederland'}, cities: [
  { name:'Rotterdam', hub:'rotterdam/', routes:[
      {name:'Rotterdam Route 1', url:'rotterdam/witte-de-with/'},
      {name:'Rotterdam Route 2', url:'rotterdam/hidden-gems/'},
      {name:'Rotterdam Premium', url:'rotterdam/premium-gin-walk/'} ] },
  { name:'Utrecht',   hub:'utrecht/',   routes:[ {name:'Utrecht',           url:'utrecht/city-centre/'} ] },
  { name:'Amsterdam', hub:'amsterdam/', routes:[ {name:'Amsterdam Route 1', url:'amsterdam/ndsm-noord/'} ] },
  { name:'Groningen', hub:'groningen/', routes:[ {name:'Groningen',         url:'groningen/gin-walk/'} ] }
] } ] };
```

### Render tweak (one line) — in `renderRoutes`, the footer branch, delete the duplicate city sub-heading so labels don't read "Rotterdam / Rotterdam Route 1":
```js
c.cities.forEach(function (city) {
  var hubLink = '<a href="' + esc(BASE + city.hub) + '" class="w-navlink">' + esc(city.name) + '</a>';
  navHTML += '<li>' + hubLink + '</li>';
  ovHTML  += hubLink;
  // FOOTER: flat list of the exact route-card names (no per-city sub-heading —
  // the names already carry the city). Country heading still appears when multi-country.
  (city.routes || []).forEach(function (r) {
    footHTML += '<a href="' + esc(BASE + r.url) + '" class="w-navlink">' + esc(r.name) + '</a>';
  });
});
```
Footer Routes now reads exactly: **Rotterdam Route 1 · Rotterdam Route 2 · Rotterdam Premium · Utrecht · Amsterdam Route 1 · Groningen.** The nav dropdown / mobile chips keep listing city hubs (Rotterdam, Utrecht, Amsterdam, Groningen) — those are cities, not route cards, and are correct as-is. This edit is inside the shared block region, so **apply it byte-identically on every page.**

---

# 7) HOMEPAGE REVIEWS — add GetYourGuide (needs your paste)

The review rail is data-driven from `WOGO_REVIEWS`, and the GetYourGuide badge is **already styled**: `.w-review-src[data-src="GetYourGuide"]` (salmon-pink pill). To add GYG reviews, append objects with `src:"GetYourGuide"`.

**I could not fetch verbatim GYG reviews** — GetYourGuide returns HTTP 403 to automated requests (the same wall that blocks live price-scraping). Per WOGO's no-fabrication rule, I will not invent them. **You paste them:** open your GetYourGuide **Supplier dashboard → Reviews**, copy 4–6 real 4–5★ quotes verbatim (or trim only with a trailing …), and drop them in like this:

```js
// --- GetYourGuide (paste REAL quotes from your GYG Reviews dashboard; verbatim only) ---
{ q:"PASTE VERBATIM REVIEW TEXT", name:"First name L.", meta:"City or Verified booking", src:"GetYourGuide", stars:5 },
{ q:"PASTE VERBATIM REVIEW TEXT", name:"First name",    meta:"",                          src:"GetYourGuide", stars:5 },
```
Rules: real text only; first name (+ initial) as GYG shows it; `stars` matches the real rating; `src:"GetYourGuide"` exactly (drives the badge). No edits to wording, no translation. The shuffle picks them up automatically.

*(Verified today: WOGO's live GYG listing exists — "Rotterdam Center: Cocktail Bar Walking Tour – Self-Guided" — so a real review pool is available to you; it just can't be machine-read.)*

---

# 8) "AS FEATURED IN" — more REAL press (verified only)

Verified live mentions today (keep all five, they're real):
- Amsterdam Cocktail Week · Horecatrends · #RotterdamCentrum · Uitagenda Rotterdam · Rotterdampas.

**New this round that I could verify** (add if you want): Uitagenda Rotterdam has a *second* live article — you can either keep one chip or add the agenda piece as an internal link, not a second logo (same publication):
`https://www.uitagendarotterdam.nl/agenda/ontdek-de-beste-cocktail-bars-in-rotterdam-met-de-wogo-cocktail-walk/`

**I found no additional independent editorial publication I can verify** beyond those five. Tripadvisor / Viator / GetYourGuide list WOGO with real ratings, but they're booking platforms — putting them in a premium "As featured in" strip cheapens it and blurs press with sales. If you want them, use a separate lower row labelled "Also bookable on", not the press strip.

**To add a genuinely new press hit** (paste-ready shape; verification rule below):
```html
<a href="REAL_ARTICLE_URL" target="_blank" rel="noopener" class="w-chip">Publication Name</a>
```
Verification rule before any chip ships: (1) the URL loads, (2) it's an article that actually names WOGO, (3) it's an independent publication, not WOGO's own channel. You almost certainly have more PR hits in your inbox than search surfaces — send me the URLs and I'll add them.

---

# 9) PALETTE — source of truth (reaffirmed)

- Colours come only from `~/Projects/wogo-design-system/tokens.css` via `var(--wogo-*)`; no new hexes on the page except the already-agreed `--wogo-cta-bg` salmon gradient.
- **No red, no terracotta orange, no ACW branding.** Every V6 "dark band" is espresso `#3f2b21` or ink `#201611` — warm browns, never red.
- Salmon stays a spice: accent, active-step marker, CTA gradient, link colour on dark. Never a big flat fill.

---

## Per-file ship checklist (run after every edit)
1. **Tag balance** — each new `<section>/<form>/<article>` closes.
2. **i18n sync** — every new `data-i18n` key has an NL entry; deleted sections' keys removed from NL.
3. **JSON-LD parses** — validate the ContactPage / Blog / BlogPosting blocks.
4. **`node --check`** on any page whose foot `<script>` you touched (WOGO_ROUTES, contact mailto, phone-sync).
5. **Shared blocks identical** — the WOGO_ROUTES data + renderRoutes tweak (§6) are byte-identical on every page except `var BASE`.
6. **Rhythm audit** — read each page top-to-bottom: no two adjacent sections share a background token; no run of 3+ light sections.
7. **Motion** — animations are transform/opacity only; reduced-motion freezes at a sensible frame; no-JS shows a static illustration.
8. **Guardrails** — 80,000+ kept; no free-cancellation; no invented reviews/press; no dashes in visible headlines/sublines; hero trust strip homepage-only.
</content>
</invoke>
