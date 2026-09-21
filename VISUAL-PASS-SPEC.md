# WOGO Visual Pass — Build Spec (symbols over sentences + motion)

Owner feedback, one line: **"there is still too much text — use more symbols or animations."**
This pass does two things and only two things, to every page type:

1. **Replace the last prose blocks with icon-driven patterns** — icon + ≤4-word label rows, benefit chips, pictogram tags. Exact EN+NL copy below.
2. **Add ONE shared, premium motion layer** — scroll-reveal fade-up (staggered), a gentle hero entrance, chip/card micro-interactions, and an optional one-shot "route line" draw. All CSS-first, transform/opacity only, JS-gated, reduced-motion safe.

It **adds page-scoped CSS/JS and swaps copy only**. It does **not** touch the fenced `WOGO SHARED NAV v4` / `WOGO SHARED FOOTER v4` blocks or the `BASE`/`WOGO_ROUTES` foot `<script>`. Every new class is prefixed `wg-` (motion) or reuses existing `w-` classes (patterns), so there are no collisions.

---

## 0. Global rules (all pages)

- **Never cut, never hide, never delay:** price lines, official route names, trust numbers, the 18+/cancellation-ceiling lines, "what's included" facts, any Book/Buy/sticky CTA. These may sit *inside* a revealed section but must **not** carry a reveal class themselves (see §4).
- **EN default + NL `data-i18n` stay in sync.** Every key you add gets an NL entry; every key you delete gets removed from the page's `NL {}` object. Run `node brace-check` after each file.
- **Palette only:** espresso `#5C2A14`, near-black `#1a1410`, cream `#FAF6F2`, peach `#F5C9A8`, salmon CTA `#E2641E`/`#C8551A`. No reds, no new colors.
- **Motion budget:** transform + opacity only. No `width`/`height`/`top`/`left`/`margin` animation. No infinite loops. Nothing bounces.
- The existing `@media (prefers-reduced-motion: reduce)` rule already zeroes all animation/transition durations. We **extend** it (§3d) so gated-hidden elements can never get stuck invisible.

---

## 1. Where the two pieces get pasted (identical for every page)

**A. The `wg-js` flag — one line, immediately after the opening `<body>` tag** (outside every fence). This makes the reveal-hidden state apply during first paint, so there is no flash-then-hide, and no-JS visitors keep everything visible:

```html
<body>
<script>document.documentElement.classList.add('wg-js');</script>
```

**B. The motion CSS (§3)** — paste as one block inside each page's existing `<style>`, on the line **before** `</style>`, in the page-extras area. The whole `<style>` is page-scoped; no fence lives inside it.

**C. The motion JS (§3c)** — paste as its own `<script>` block on the line **directly before** `</body>`, **after** the existing foot `<script>` (i.e. outside the fenced foot script). It never edits the fenced script.

**D. Add the pattern markup + reveal classes** in the sections named per page in §2. Then retranslate/prune the `NL {}` dictionary.

That's the whole mechanism: one flag line, one CSS block, one JS block, per-page markup swaps.

---

## 2. Prose → icon patterns, per page type (exact copy)

Labels are **max 4 words**. Emoji are drawn from the site's existing set (🗺️🍸🚶📅🕐📍🎂🥂 …) — inline emoji only, no icon fonts, no external assets. Every emoji marker gets `aria-hidden="true"`; the text label carries the meaning.

### 2.1 ROUTE PAGE (reference: `rotterdam/hidden-gems`) — the 3 stop paragraphs

**Cut:** the long `stop1_p / stop2_p / stop3_p` sentences (≈75 words of prose). **Keep** each stop's `h3` (it already names the vibe) and replace the paragraph with a 2-chip tag row. Delete `stop1_p/stop2_p/stop3_p` from `NL`; add the `*_t1/*_t2` keys.

New markup for each `.w-stop` (reuse the card; swap the `<p>` for `.w-stop-tags`):

```html
<div class="w-stop">
  <h3 data-i18n="stop1_h">1 · Playful &amp; energetic</h3>
  <div class="w-stop-tags">
    <span class="w-minichip"><span aria-hidden="true">🔥</span><span data-i18n="stop1_t1">Big energy</span></span>
    <span class="w-minichip"><span aria-hidden="true">🍸</span><span data-i18n="stop1_t2">Bold flavours</span></span>
  </div>
</div>
```

| Key | EN (≤4 words) | NL (≤4 words) |
|---|---|---|
| `stop1_t1` | 🔥 Big energy | 🔥 Volle energie |
| `stop1_t2` | 🍸 Bold flavours | 🍸 Gedurfde smaken |
| `stop2_t1` | 🕰️ Vintage charm | 🕰️ Vintage charme |
| `stop2_t2` | 🍜 Thai bites | 🍜 Thaise hapjes |
| `stop3_t1` | 🥂 Refined finish | 🥂 Verfijnde afsluiter |
| `stop3_t2` | 👨‍🍳 Expert mixologists | 👨‍🍳 Topbartenders |

(Emoji sit in the EN/NL string here because these are decorative tags, not sentences; keep `aria-hidden` on the emoji span in markup so screen readers read only the words.)

**Trim (don't delete) the SEO intro `story_p`** to one shorter sentence, keywords kept:

- EN: `The best hidden-gem cocktail bars in Rotterdam — three handpicked spots, one night, a table reserved at each.`
- NL: `De beste verborgen cocktailbars van Rotterdam — drie handgekozen plekken, één avond, overal een tafel gereserveerd.`

Leave `.w-incl-list` (what's included) and the `.w-howstrip` 3-icon row exactly as they are — they are already the target pattern.

### 2.2 GIFT-CARDS — the 3 tier paragraphs

**Cut:** `tier1_p / tier2_p / tier3_p` sentences. Replace each with a one-line benefit chip. Keep the amount, `w-tier-sub`, and the Buy button untouched. Keep `tiers_note` (it carries "walks from €29,95"). Delete `tier1_p/2_p/3_p` from `NL`; add `tier1_b/2_b/3_b`.

New markup (swap the `<p data-i18n="tierN_p">…</p>` for):

```html
<div class="w-tier-benefit"><span aria-hidden="true">✨</span><span data-i18n="tier1_b">A little treat</span></div>
```

| Key | EN (≤4 words) | NL (≤4 words) |
|---|---|---|
| `tier1_b` | ✨ A little treat | ✨ Een klein cadeau |
| `tier2_b` | 🍸 One full walk | 🍸 Eén hele walk |
| `tier3_b` | 👥 A night for two | 👥 Avond voor twee |

The `#how` 3-step block (`g1_p/g2_p/g3_p`) is already icon + short line — **leave it**. The mini-FAQ stays prose (it's an FAQ; users expect sentences on tap).

### 2.3 GROUPS — already lean, motion only

Groups is already chip- and checklist-driven (occasion chips, extras chips, `.w-incl-list`, the enquiry form). **No prose swaps needed.** Apply the motion layer only (§2.5). Do **not** touch the form fields' focus styles or the legal `cont_note`.

### 2.4 ABOUT — the "How we pick our bars" criteria

**Cut:** the three criteria paragraphs (`crit1_p / crit2_p / crit3_p`, ≈90 words). Convert the `.w-gtk` criteria grid into an icon + ≤4-word label row (same family as `.w-howstrip`). Keep each `h3` idea compressed into the label; drop the paragraph. Delete `crit*_p` from `NL`; the `crit*_h` keys become the short labels below (retranslate them to ≤4 words).

New markup for the criteria block body (replace the three `.w-gtk-card`s):

```html
<div class="w-howstrip w-hs-dark wg-stagger" style="flex-wrap:wrap;">
  <div class="w-hs-item"><div class="w-hs-ico" aria-hidden="true">💎</div><div class="w-hs-tx" data-i18n="crit1_h">Hidden gems</div></div>
  <div class="w-hs-item"><div class="w-hs-ico" aria-hidden="true">🚶</div><div class="w-hs-tx" data-i18n="crit2_h">5–15 min apart</div></div>
  <div class="w-hs-item"><div class="w-hs-ico" aria-hidden="true">🪑</div><div class="w-hs-tx" data-i18n="crit3_h">Tables reserved</div></div>
</div>
```

| Key | EN (≤4 words) | NL (≤4 words) |
|---|---|---|
| `crit1_h` | Hidden gems | Verborgen parels |
| `crit2_h` | 5–15 min apart | 5–15 min lopen |
| `crit3_h` | Tables reserved | Tafels gereserveerd |

Keep the `pick_p` intro but trim to: EN `Every bar is hand-picked by our team in Amsterdam. Here's what earns a spot.` / NL `Elke bar kiezen we met de hand vanuit Amsterdam. Dit verdient een plek.`

**Our-story block:** keep it (this is the one story block a trust page needs) but tighten each paragraph to ≤28 words:
- `story_p1` EN: `WOGO began in Amsterdam during lockdown, when the city's bars needed every bit of support. The cocktail walk was our answer.`
  NL: `WOGO ontstond in Amsterdam tijdens de lockdown, toen de bars alle steun konden gebruiken. De cocktailwandeling was ons antwoord.`
- `story_p2` EN: `Today we curate walks in Amsterdam, Rotterdam, Utrecht and Groningen — 80,000+ booked, every bar still hand-picked.`
  NL: `Vandaag stellen we walks samen in Amsterdam, Rotterdam, Utrecht en Groningen — 80.000+ geboekt, elke bar met de hand gekozen.`

**Partners intro `partners_p`** trim to: EN `Your cocktails are crafted with 20+ premium brands.` / NL `Je cocktails worden gemaakt met 20+ premium merken.` The chips already carry the names — keep them.

Trust numbers (`.w-stats`) are already stat blocks — **leave them**.

### 2.5 New pattern CSS (small; part of the paste-in block in §3)

```css
/* ── Icon patterns: stop tag chips + tier benefit line ── */
.w-stop-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.w-minichip { display: inline-flex; align-items: center; gap: 6px; background: #FAF6F2; border: 1px solid rgba(92,42,20,0.16); color: #5C2A14; font-size: 12.5px; font-weight: 700; padding: 6px 12px; border-radius: 999px; line-height: 1; }
.w-tier-benefit { display: inline-flex; align-items: center; gap: 8px; justify-content: center; font-size: 13.5px; font-weight: 800; color: #5C2A14; flex: 1 1 auto; }
```

(About's criteria reuse the existing `.w-howstrip` / `.w-hs-item` / `.w-hs-tx` / `.w-hs-dark` classes — no new CSS.)

---

## 3. The motion layer (one CSS block + one JS block, pasted per page)

### 3a. What each class does

- `wg-reveal` — put on a **single element or a whole section** you want to fade-up once on scroll-in.
- `wg-stagger` — put on a **container**; its *direct children* fade-up one after another (70 ms apart, capped at 8).
- `wg-hero-anim` — put on the hero's `.w-hero-content` for a gentle one-time entrance on load.
- Micro-interactions on `.w-chip` / `.w-minichip` (hover lift + tap press) are automatic once the CSS is in.

### 3b. CSS — paste inside each page's `<style>`, before `</style>`

```css
/* ============================================================
   WOGO VISUAL PASS — motion layer (JS-gated, reduced-motion safe).
   Hidden states apply ONLY when <html class="wg-js"> is set, so if
   JS never runs everything stays visible. Transform/opacity only.
   ============================================================ */

/* Scroll-reveal: single element / section */
html.wg-js .wg-reveal { opacity: 0; transform: translateY(16px); transition: opacity .55s ease, transform .55s cubic-bezier(.22,.61,.36,1); will-change: opacity, transform; }
html.wg-js .wg-reveal.wg-in { opacity: 1; transform: none; }

/* Scroll-reveal: staggered children */
html.wg-js .wg-stagger > * { opacity: 0; transform: translateY(14px); transition: opacity .5s ease, transform .5s cubic-bezier(.22,.61,.36,1); will-change: opacity, transform; }
html.wg-js .wg-stagger.wg-in > * { opacity: 1; transform: none; }
html.wg-js .wg-stagger > *:nth-child(1) { transition-delay: 0ms; }
html.wg-js .wg-stagger > *:nth-child(2) { transition-delay: 70ms; }
html.wg-js .wg-stagger > *:nth-child(3) { transition-delay: 140ms; }
html.wg-js .wg-stagger > *:nth-child(4) { transition-delay: 210ms; }
html.wg-js .wg-stagger > *:nth-child(5) { transition-delay: 280ms; }
html.wg-js .wg-stagger > *:nth-child(6) { transition-delay: 350ms; }
html.wg-js .wg-stagger > *:nth-child(7) { transition-delay: 420ms; }
html.wg-js .wg-stagger > *:nth-child(n+8) { transition-delay: 490ms; }

/* Hero entrance — TRANSFORM ONLY (no opacity) so the LCP headline paints
   immediately and is never delayed; it just drifts up into place. */
html.wg-js .wg-hero-anim > * { transform: translateY(14px); transition: transform .6s cubic-bezier(.22,.61,.36,1); }
html.wg-js .wg-hero-anim > *:nth-child(2) { transition-delay: 60ms; }
html.wg-js .wg-hero-anim > *:nth-child(3) { transition-delay: 120ms; }
html.wg-js .wg-hero-anim > *:nth-child(4) { transition-delay: 180ms; }
html.wg-js .wg-hero-anim > *:nth-child(5) { transition-delay: 240ms; }
html.wg-js .wg-hero-anim > *:nth-child(n+6) { transition-delay: 300ms; }
html.wg-js .wg-hero-anim.wg-hero-go > * { transform: none; }

/* Chip / mini-chip micro-interactions (hover lift + tap press) */
.w-chip, .w-minichip { transition: transform .18s ease, box-shadow .2s ease, background .2s ease, border-color .2s ease, color .2s ease; }
.w-chip:hover, .w-minichip:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(92,42,20,0.12); }
.w-chip:active, .w-minichip:active { transform: scale(.97); }
@media (hover: none) { .w-chip:hover, .w-minichip:hover { transform: none; box-shadow: none; } }

/* Optional one-shot "route line" accent (see §3e) */
html.wg-js .wg-routeline path { stroke-dasharray: 1; stroke-dashoffset: 1; transition: stroke-dashoffset 1.1s ease .15s; }
html.wg-js .wg-routeline.wg-in path { stroke-dashoffset: 0; }

/* ── Reduced-motion safety net: never leave a gated element hidden ── */
@media (prefers-reduced-motion: reduce) {
  html.wg-js .wg-reveal,
  html.wg-js .wg-stagger > *,
  html.wg-js .wg-hero-anim > * { opacity: 1 !important; transform: none !important; }
  html.wg-js .wg-routeline path { stroke-dashoffset: 0 !important; }
}
```

### 3c. JS — paste on its own line before `</body>`, after the foot `<script>`

```html
<script>
/* WOGO VISUAL PASS — scroll-reveal + hero entrance. Outside all fenced blocks.
   Everything is fully visible if this never runs (hidden states need .wg-js,
   the reveal only ADDS a class). */
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Hero entrance: flip on next frame so the transition plays once. */
  requestAnimationFrame(function () { root.classList.add('wg-hero-go'); });

  var targets = document.querySelectorAll('.wg-reveal, .wg-stagger, .wg-routeline');

  /* No IntersectionObserver, or user prefers reduced motion → show everything now. */
  if (reduce || !('IntersectionObserver' in window)) {
    for (var i = 0; i < targets.length; i++) targets[i].classList.add('wg-in');
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('wg-in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

  for (var j = 0; j < targets.length; j++) io.observe(targets[j]);
})();
</script>
```

### 3d. No-JS + reduced-motion fallbacks (how each is covered)

- **JS disabled / fails:** `.wg-js` is never added → none of the hidden-state CSS matches → the page renders fully visible, exactly as today. Hero `wg-hero-go` never fires, but hero is visible because its hidden state is also `.wg-js`-gated (transform-only anyway).
- **`IntersectionObserver` missing (old browsers):** the JS adds `.wg-in` to every target immediately → all content shows, no animation lost.
- **`prefers-reduced-motion: reduce`:** two layers protect it — (1) the existing global rule zeroes durations, and (2) the §3b safety-net block forces `opacity:1 / transform:none` on every gated element and fully draws the route line. The JS also early-returns and reveals everything up front.
- **Mobile (~85%):** hero is transform-only, so the LCP headline is painted on first frame and never gated by opacity. Reveals fire ~8% before the element reaches the bottom edge, so content is on-screen before it animates.

### 3e. Optional "route line" accent (route page §3 only — premium signature)

A subtle dashed line that **draws once** as the "The night" section scrolls in — evokes walking a route between the three stops. One-shot, no loop. Drop this inline SVG just under the section `<h2>` (inside `.w-head`, or between the intro and the stops), and add `wg-routeline` to it:

```html
<svg class="wg-routeline" width="200" height="12" viewBox="0 0 200 12" aria-hidden="true" focusable="false"
     style="display:block;margin:14px auto 0;overflow:visible;">
  <path d="M4 6 H196" fill="none" stroke="#E2641E" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="2 10" pathLength="1"/>
</svg>
```

`pathLength="1"` normalises the dash math so the CSS `stroke-dasharray:1; stroke-dashoffset:1→0` draws it cleanly at any width. Reduced-motion shows it fully drawn. **Route page only** — do not scatter it elsewhere. (Skip the "animated cocktail glass" idea: a looping bob reads gimmicky and violates the no-infinite-loop rule.)

---

## 4. Where to place the reveal classes, per page (unambiguous)

Add classes to the **section wrappers / rows** listed. Never add a reveal class to the nav, footer, sticky CTA, a Book/Buy button, a price line, or a hero LCP `<h1>`.

**Route page (`*/index.html`, 2 folders deep):**
- Hero: add `wg-hero-anim` to `.w-hero-content`.
- §2 quick facts: `wg-stagger` on `.w-facts`.
- §3 "The night": `wg-reveal` on the `.w-head`; `wg-stagger` on `.w-stops`; `wg-stagger` on `.w-incl-list`; `wg-stagger` on the `.w-howstrip`; optional `wg-routeline` SVG (§3e).
- §4 `#book`: `wg-reveal` on the inner `.w-eyebrow`/`<h2>` group **only** — leave the price and `.w-book-btn` un-gated (they must never fade/delay). Simplest safe move: put `wg-reveal` on the `.w-eyebrow` and `<h2>` individually, not the whole section.
- §5 more routes: `wg-reveal` on `.w-head`; `wg-stagger` on the `.w-scroller` (`#sibScroller`).

**Groups (`groups/index.html`, 1 deep):**
- Hero: `wg-hero-anim` on `.w-hero-content`.
- `#occasions`: `wg-stagger` on `.w-chips`.
- Photo + contains: `wg-reveal` on `.w-group-photo`; `wg-stagger` on the `.w-incl-list`.
- Extras: `wg-stagger` on the peach `.w-chips`.
- `#enquire`: `wg-reveal` on the `.w-head` only. **Do not** gate the `<form>` or its fields.
- Review: `wg-reveal` on `.w-review`.
- `#cities`: `wg-stagger` on `.w-cityhub`.

**Gift-cards (`gift-cards/index.html`, 1 deep):**
- Hero: `wg-hero-anim` on `.w-hero-content`.
- `#tiers`: `wg-stagger` on `.w-tiers` (each `.w-tier` fades in; Buy buttons inside are fine — the card reveals as a unit, quickly).
- `#how`: `wg-stagger` on `.w-steps-wrap`.
- "Perfect for": `wg-stagger` on `.w-chips`.
- FAQ: `wg-reveal` on `.w-head` only (leave `<details>` interactive, un-gated).
- `#cities`: `wg-stagger` on `.w-cityhub`.
- Final CTA: `wg-reveal` on the `<h2>`/`<p>` — **not** the `.w-final-btn`.

**About (`about/index.html`, 1 deep):**
- Hero: `wg-hero-anim` on `.w-hero-content`.
- `#story`: `wg-reveal` on `.w-story-img`; `wg-reveal` on `.w-story-text`.
- Trust numbers: `wg-stagger` on `.w-stats`.
- Criteria row: `wg-stagger` already on the new `.w-howstrip` (§2.4).
- Partners: `wg-stagger` on `.w-partners-grid`.
- Contact: `wg-reveal` on `.w-contact-card`.
- `#cities`: `wg-stagger` on `.w-cityhub`.

---

## 5. What NOT to animate (hard list)

- **The fenced blocks** — never add `wg-*` classes inside `WOGO SHARED NAV v4`, `WOGO SHARED FOOTER v4`, or the foot `<script>`.
- **Conversion-critical content** — no reveal on any Book/Buy/enquiry/sticky CTA, no reveal that hides a **price**, a **trust number**, the **18+/cancellation** line, or a hero **LCP `<h1>`** via opacity.
- **Layout properties** — never animate `width`, `height`, `top`, `left`, `margin`, `padding`, `font-size`. Transform + opacity only.
- **No infinite / looping motion** — no bobbing cocktail glass, no pulsing badges, no spinning icons, no parallax, no marquee. The route line draws once and stops.
- **No hover motion on touch** — the `@media (hover:none)` rule already disables chip lift on phones; don't add tap-triggered movement to non-interactive elements.
- **Form fields** — leave the existing focus ring/box-shadow behaviour on `.w-field` inputs untouched.
- **Images** — the existing card image `scale(1.05)` on hover (inside `overflow:hidden`) stays; don't add new image zoom or filters.
- **Stagger caps at 8** children (CSS handles the overflow with a single final delay) — don't hand-delay long lists.

---

## 6. Per-file QA (run after every edit)

1. **Tag balance** — added `<div>`/`<svg>`/`<span>` all closed; section open == close.
2. **i18n sync** — `node brace-check`: every new `data-i18n` key (`stop*_t1/t2`, `tier*_b`, retranslated `crit*_h`) has an `NL` entry; every deleted key (`stop*_p`, `tier*_p`, `crit*_p`) is gone from `NL`.
3. **JSON-LD parses** — unchanged by this pass, but re-run `node -e "JSON.parse(...)"` on each `application/ld+json` block to confirm nothing was disturbed.
4. **Inline JS** — `node --check` on the pasted motion `<script>` (and confirm the fenced foot script is byte-unchanged).
5. **No-JS check** — temporarily disable JS (or delete the `.wg-js` line mentally): every section must still be fully visible.
6. **Reduced-motion check** — with "Reduce motion" on, all content shows instantly, route line fully drawn, no transitions.
7. **Guardrails** — no reds, no new colors, no fenced-block edits, no gated CTA/price/trust line, ≤4 words per new label, EN+NL in sync.

---

## 7. Summary of net text removed

| Page | Prose removed | Replaced by |
|---|---|---|
| Route | 3 stop paragraphs (~75 words) + trimmed intro | 6 mini-chips (≤3 words each) + 1 short sentence |
| Gift-cards | 3 tier paragraphs (~60 words) | 3 benefit chips (≤4 words) |
| About | 3 criteria paragraphs (~90 words) + trimmed story/partners | 3 icon labels + tightened copy |
| Groups | already lean | motion layer only |

Every page also gains the shared motion layer: hero drift-in, staggered scroll-reveals, chip/card micro-interactions, and (route only) the one-shot route-line draw — all reduced-motion and no-JS safe.
