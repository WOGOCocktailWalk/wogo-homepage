# WOGO Design V5 — implementation spec

Single source of truth for the V5 pass. Builders: apply exactly. Palette is the
canonical WOGO range only (BRAND.md + tokens.css). No red, no terracotta, no ACW.
Dash-ban stays on visible headlines/sublines (day ranges like "Thu–Sat" in fact
labels are allowed — they are ranges, not headline clauses). EN + NL dicts must
stay in sync. Motion is transform/opacity only, reduced-motion + no-JS safe.
Never touch the fenced WOGO SHARED NAV v4 / FOOTER v4 blocks or BASE / WOGO_ROUTES
logic (NL dict entries may change; page CSS/JS outside the fences may change).

Scope: every page EXCEPT the homepage (`index.html`). The homepage hero and its
hero trust row stay exactly as they are. Only touch `index.html` to add the CTA
colour token (section 2) if you recolour its hero button too.

---

## 0. The one shared token you paste on every page (do this first)

Every non-home page already has raw hexes or a mirrored `:root` block. Add these
four custom properties to that page's existing `:root` (route pages don't have a
`:root` block yet — add a tiny one right after the opening `<style>`, it is page
CSS outside the fences so it's allowed):

```css
:root{
  /* V5 primary-CTA — warm salmon→coral, the single high-converting action colour */
  --wogo-cta-bg:       linear-gradient(135deg, #ffaa81 0%, #f2905c 100%); /* salmon → salmon-deep */
  --wogo-cta-bg-hover: linear-gradient(135deg, #f2905c 0%, #f2905c 100%); /* solid salmon-deep */
  --wogo-cta-ink:      #3f2b21;  /* espresso text — AA (5.1:1 on #f2905c, higher on #ffaa81) */
  --wogo-cta-shadow:   0 8px 20px rgba(242,144,92,0.45);
}
```

That token drives sections 2, 3 and 4. It is 100% on-brand: BRAND.md lists salmon
explicitly for "warm CTAs / the accent". `#f2905c` is the canonical `salmon-deep`,
not terracotta.

---

## 1. Lean hero system (all non-home pages)

### The problem being fixed
Current heroes stack: eyebrow + huge H1 + salmon subline + an extra paragraph
(`hero_p`) + button (+ the trust strip). That's 5–6 reads before the eye finds the
action. V5 cuts every hero to **one idea, one action**.

### The rule: max text elements per hero
- **Eyebrow** (1 line, ≤5 words)
- **H1** (the page's one promise; route pages = official route name only)
- **ONE subline** (≤10 words, salmon)
- **ONE primary action** (a button, or — on route pages — the ticket card which
  carries price + Book button)

**Delete from every hero:** the extra descriptive paragraph (`hero_p`) and the
hero trust strip (section 5). On route pages also delete `hero_brand`
("The Cocktail Walk") — it duplicates the eyebrow. Keep breadcrumbs on route pages
(SEO + orientation, they're small and don't count as a "read").

### Shared hero type scale (unchanged sizes, just fewer elements)
| Element | Size | Notes |
|---|---|---|
| eyebrow | 11px / 700 / `0.22em` caps | salmon on dark hero |
| H1 | `clamp(28px, 4.6vw, 52px)` / 900 | max ~18ch |
| subline | `clamp(14.5px, 1.6vw, 20px)` / 800 | salmon, max 22ch, `margin:-2px 0 18px` |
| primary CTA | pill, `--wogo-cta-bg` | one only |

Spacing between hero elements: eyebrow `mb 10px`, H1 `mb 14px`, subline `mb 20px`,
then the CTA / ticket card. Hero min-height and overlay stay as they are per page.

### Three variants (visually unified — same scale, same overlay, same CTA)
1. **Route** (`/rotterdam/hidden-gems/`, `/witte-de-with/`, `/premium-gin-walk/`,
   `/utrecht/city-centre/`, `/groningen/gin-walk/`, `/amsterdam/ndsm-noord/`):
   LEFT-aligned. breadcrumbs → eyebrow (`CITY · THEME`) → H1 (route name) →
   subline → **ticket card** (price + Book button = the action). Keep `hero_flag`
   only when genuine.
2. **Hub** (`/rotterdam/`, `/utrecht/`, `/groningen/`, `/amsterdam/`): CENTERED.
   eyebrow → H1 → subline → one CTA (`View dates →`, scrolls to route grid).
3. **Content** (`/how-it-works/`, `/groups/`, `/gift-cards/`, `/about/`, `/faq/`):
   CENTERED. eyebrow → H1 → subline → one CTA.

### Exact replacement hero copy (EN + NL). Remove `hero_p` / `hero_brand` entirely.

**Hubs** — keep existing eyebrow/H1/sub, just delete `hero_p`. Copy already lean:
| Page | H1 | Subline EN | Subline NL | CTA EN / NL |
|---|---|---|---|---|
| rotterdam | Rotterdam Cocktail Walk | Three bars. Three cocktails. One unforgettable night. | Drie bars. Drie cocktails. Eén onvergetelijke avond. | View dates → / Bekijk data → |
| utrecht | Utrecht Cocktail Walk | Three bars. Three cocktails. Every single night. | Drie bars. Drie cocktails. Elke avond van de week. | View dates → / Bekijk data → |
| groningen | Groningen Cocktail Walk | Three hidden bars. Three Bobby's Gin cocktails. One night. | Drie verborgen bars. Drie Bobby's Gin-cocktails. Eén avond. | View dates → / Bekijk data → |
| amsterdam | Amsterdam Cocktail Walk | From the wharf to the centre. Three bars, one night. | Van de werf tot het centrum. Drie bars, één avond. | View dates → / Bekijk data → |

**Content pages** — delete `hero_p`; keep/lightly trim sublines:
| Page | H1 | Subline EN | Subline NL | CTA EN / NL |
|---|---|---|---|---|
| how-it-works | How a WOGO Cocktail Walk Works | No guide. No group. All the planning done. | Geen gids. Geen groep. Al het regelwerk gedaan. | See the 5 steps ↓ / Bekijk de 5 stappen ↓ |
| groups | Cocktail Walks, Built for Groups | Bachelorettes, birthdays, team outings. We handle the bars. | Vrijgezellenfeesten, verjaardagen, teamuitjes. Wij regelen de bars. | Plan your group walk → / Plan jullie groepswandeling → |
| gift-cards | Give a Cocktail Walk Gift Card | A night out they'll remember. In their inbox in minutes. | Een avond uit die bijblijft. Binnen minuten in de inbox. | Buy a gift card → / Koop een cadeaubon → |
| about | Explore your city, one cocktail at a time | Born in lockdown to back local bars. Still hand-picked, every route. | Ontstaan in lockdown om lokale bars te steunen. Nog steeds met de hand gekozen. | Read our story ↓ / Lees ons verhaal ↓ |
| faq | Frequently Asked Questions | Every answer before you book. All on one page. | Elk antwoord vóór je boekt. Alles op één pagina. | Jump to the questions ↓ / Ga naar de vragen ↓ |

> **FLAG (about):** the current About subline says "80,000+ walks later" — this
> contradicts the real ~2,500 lifetime bookings and is deliberately removed above.
> Do not reintroduce a walk-count number until the owner confirms the real figure.
> (The footer trust line still carries "80,000+" and is out of scope here — confirm
> with the owner separately.)

**Route pages** — keep eyebrow (`CITY · THEME`), H1 (official name), subline;
delete `hero_brand` and `hero_p`. Sublines already lean, keep as-is:
| Route page | Subline EN | Subline NL |
|---|---|---|
| rotterdam/hidden-gems | Three brand-new hidden-gem bars, from playful to refined. | Drie gloednieuwe verborgen bars, van speels tot verfijnd. |
| (others) | keep each page's existing one-line `hero_p`→move its short first sentence into the subline; drop the price sentence (price lives on the ticket card). |

For the 5 non-reference route pages, collapse the existing two-part `hero_p` to its
first clause as the subline and delete the rest. Keep it ≤12 words, no price, no dash-glue.

---

## 2. Primary-CTA colour — the winner

### Before → after
- **Before (ticket-card Book button):** flat espresso — `background:#3f2b21; color:#ffe5d9`.
- **After (all primary CTAs):** `background: var(--wogo-cta-bg); color: var(--wogo-cta-ink)`
  — salmon→coral gradient, espresso text, `box-shadow: var(--wogo-cta-shadow)`.
- **Hover:** `background: var(--wogo-cta-bg-hover); transform: translateY(-2px)`.

Why this over flat espresso: espresso reads muted/corporate and recedes on the dark
route hero; the warm salmon→coral gradient is the brand's signature accent, carries
the most visual "click me" energy while staying premium, and passes AA with espresso
text. It also unifies the hero CTAs (currently flat salmon) into one richer treatment.

### Apply the SAME token to every page's PRIMARY action
Repoint these existing button rules to the token (change only `background`, `color`,
`box-shadow`; keep padding/radius/size). One primary CTA per page — leave genuinely
secondary buttons (gift strip on non-gift pages, ghost/secondary) as espresso/ghost
so hierarchy stays clean.

| Selector | Where | Change |
|---|---|---|
| `.w-ticket-cta` | route hero ticket card | espresso → `--wogo-cta-bg` (the headline change) |
| `.w-book-btn` | route `#book` | flat salmon → `--wogo-cta-bg` |
| `.w-hero-cta` | content/hub hero button | flat salmon → `--wogo-cta-bg` |
| `.w-nav-cta` | nav (page CSS, NOT the fenced markup) | flat salmon → `--wogo-cta-bg` |
| `.w-sticky-cta-btn` | mobile sticky | flat salmon → `--wogo-cta-bg` |
| `.w-citycard-btn-primary` | route/hub cards | flat salmon → `--wogo-cta-bg` |
| `.w-final-btn` | content final strip | flat salmon → `--wogo-cta-bg` |
| `.w-group-btn` | groups strip (primary on /groups/) | flat salmon → `--wogo-cta-bg` |
| `.w-gift-btn` on `/gift-cards/` only | that page's primary action | espresso → `--wogo-cta-bg` |

Example edit (ticket CTA):
```css
.w-ticket-cta { background: var(--wogo-cta-bg); color: var(--wogo-cta-ink);
  box-shadow: var(--wogo-cta-shadow); /* rest unchanged */ }
.w-ticket-cta:hover { background: var(--wogo-cta-bg-hover); transform: translateY(-2px); }
```
The existing salmon-flat rules elsewhere become the same three-line pattern. The
`.w-nav-cta` colour lives in each page's `<style>` (page CSS), not in the fenced
nav markup — recolouring the CSS rule is allowed and does not touch the fence.

---

## 3. Ticket-card change — real operating days + CTA recolour

Two edits inside `.w-ticket` on each route page:

**(a) Days line.** Keep the icon+label format
(`<span class="w-ticket-ico">📅</span><span data-i18n="ticket_r4">…</span>`).
Replace `ticket_r4` text (EN) and its NL entry with the route's REAL days:

| Route page (official name) | `ticket_r4` EN | `ticket_r4` NL |
|---|---|---|
| rotterdam/witte-de-with (Route 1) | Thu–Sat | do–za |
| rotterdam/hidden-gems (Route 2) | Thu–Sat | do–za |
| rotterdam/premium-gin-walk (Premium) | Tue–Sat | di–za |
| utrecht/city-centre | Daily | Dagelijks |
| groningen/gin-walk | Wed–Sat | wo–za |
| amsterdam/ndsm-noord (NDSM Noord) | Thu–Sat | do–za |

Keep the label to the days only (the four ticket rows are short-balanced labels;
exact start times already live in the quick-facts strip `fact_2` and the booking
calendar). Day ranges use the en-dash `–` exactly as the existing route cards do.

> **FLAG (Route 2 / hidden-gems):** its live Wix ticket graphic currently reads
> "Daily, every week", but every sibling card lists Rotterdam Route 2 as "Thu–Sat".
> Spec value above is **Thu–Sat** (matches the sibling data + the owner's example).
> Confirm the true days with the owner before cutover; if it's genuinely daily,
> use "Daily" / "Dagelijks" and update the TouristTrip JSON-LD `description`
> ("Available every week") to match.

**(b) CTA recolour** — see section 2: `.w-ticket-cta` espresso → `--wogo-cta-bg`.

Also update the route JSON-LD `description` where it says "Available every week" to
the route's real cadence so structured data and the card agree.

---

## 4. How-it-works — 5 steps as a swipeable phone mockup

Replaces the current `.w-steps-wrap` numbered list inside `#steps` (how-it-works
ONLY — no other page gets this; the homepage keeps its own how-strip). Reuses the
existing `s1_h`/`s1_p` … `s5_h`/`s5_p` i18n keys, so no new dict work beyond markup.

### Markup (drop-in, replaces the `<div class="w-steps-wrap …">…</div>`)
```html
<div class="w-phone-wrap wg-reveal">
  <div class="w-phone">
    <span class="w-phone-notch" aria-hidden="true"></span>
    <div class="w-phone-screen">
      <div class="w-phone-track" id="wPhoneTrack" role="group"
           aria-roledescription="carousel" aria-label="How a WOGO walk works, five steps">
        <article class="w-phone-slide" aria-label="Step 1 of 5">
          <span class="w-phone-num" aria-hidden="true">1</span>
          <span class="w-phone-ico" aria-hidden="true">🗓️</span>
          <h3 data-i18n="s1_h">Pick your city, route and date</h3>
          <p data-i18n="s1_p">Book online in a couple of minutes…</p>
        </article>
        <article class="w-phone-slide" aria-label="Step 2 of 5">
          <span class="w-phone-num" aria-hidden="true">2</span>
          <span class="w-phone-ico" aria-hidden="true">📩</span>
          <h3 data-i18n="s2_h">Get your map</h3>
          <p data-i18n="s2_p">Your digital Cocktail Walk Map Guide…</p>
        </article>
        <article class="w-phone-slide" aria-label="Step 3 of 5">
          <span class="w-phone-num" aria-hidden="true">3</span>
          <span class="w-phone-ico" aria-hidden="true">🤫</span>
          <h3 data-i18n="s3_h">The bars are a surprise</h3>
          <p data-i18n="s3_p">Which three bars? That stays secret…</p>
        </article>
        <article class="w-phone-slide" aria-label="Step 4 of 5">
          <span class="w-phone-num" aria-hidden="true">4</span>
          <span class="w-phone-ico" aria-hidden="true">🚶</span>
          <h3 data-i18n="s4_h">Walk it your way</h3>
          <p data-i18n="s4_p">Only your start time at bar 1 is fixed…</p>
        </article>
        <article class="w-phone-slide" aria-label="Step 5 of 5">
          <span class="w-phone-num" aria-hidden="true">5</span>
          <span class="w-phone-ico" aria-hidden="true">🍸</span>
          <h3 data-i18n="s5_h">At each bar</h3>
          <p data-i18n="s5_p">Walk in, show your booking…</p>
        </article>
      </div>
      <div class="w-phone-dots" id="wPhoneDots" aria-hidden="true"></div>
    </div>
  </div>
</div>
```
(Paste the full existing EN paragraph text into each `<p>`; the NL comes from the
existing `s1_p…s5_p` dict entries, unchanged.)

### CSS (page CSS, outside the fences)
```css
.w-phone-wrap { max-width: 330px; margin: 0 auto; padding: 4px 8px 8px; }
.w-phone { position: relative; width: 100%; aspect-ratio: 300 / 620;
  background: var(--wogo-ink); border-radius: 46px; padding: 14px;
  box-shadow: 0 30px 60px rgba(32,22,17,0.34), inset 0 0 0 2px rgba(255,255,255,0.06); }
.w-phone-notch { position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  width: 116px; height: 24px; background: var(--wogo-ink); border-radius: 0 0 16px 16px; z-index: 3; }
.w-phone-screen { position: relative; height: 100%; border-radius: 32px;
  overflow: hidden; background: var(--wogo-blush); }
.w-phone-track { display: flex; height: 100%; overflow-x: auto; overflow-y: hidden;
  scroll-snap-type: x mandatory; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.w-phone-track::-webkit-scrollbar { display: none; }
.w-phone-slide { flex: 0 0 100%; scroll-snap-align: center; height: 100%;
  overflow-y: auto; display: flex; flex-direction: column; align-items: center;
  justify-content: center; text-align: center; gap: 14px; padding: 56px 26px 46px; }
.w-phone-num { width: 46px; height: 46px; border-radius: 50%;
  background: var(--wogo-cta-bg); color: var(--wogo-cta-ink); box-shadow: var(--wogo-cta-shadow);
  font-size: 20px; font-weight: 900; display: flex; align-items: center; justify-content: center; }
.w-phone-ico { font-size: 40px; line-height: 1; }
.w-phone-slide h3 { font-size: 17px; font-weight: 800; color: var(--wogo-ink); }
.w-phone-slide p { font-size: 13.5px; line-height: 1.6; font-weight: 500; color: var(--wogo-espresso); }
.w-phone-dots { position: absolute; bottom: 16px; left: 0; right: 0; z-index: 4;
  display: flex; gap: 7px; justify-content: center; }
.w-phone-dot { width: 8px; height: 8px; padding: 0; border: none; border-radius: 50%;
  background: rgba(63,43,33,0.26); cursor: pointer; transition: transform .2s, background .2s; }
.w-phone-dot.active { background: var(--wogo-salmon-deep); transform: scale(1.35); }
@media (max-width: 720px){ .w-phone-wrap { max-width: 300px; } .w-phone-slide p { font-size: 13px; } }
```

### JS (add to how-it-works page's own foot script area — NOT the shared foot script)
```html
<script>
(function(){
  var track = document.getElementById('wPhoneTrack');
  var dots  = document.getElementById('wPhoneDots');
  if(!track || !dots) return;                     // no-JS: native scroll-snap still works, step 1 shown
  var n = track.children.length, cur = 0, timer = null, raf = null;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  for(var i=0;i<n;i++){ (function(i){
    var b = document.createElement('button');
    b.className = 'w-phone-dot' + (i===0 ? ' active' : '');
    b.setAttribute('aria-label', 'Go to step ' + (i+1));
    b.addEventListener('click', function(){ go(i, true); });
    dots.appendChild(b);
  })(i); }
  dots.removeAttribute('aria-hidden');

  function setActive(i){ cur = i;
    for(var k=0;k<dots.children.length;k++) dots.children[k].classList.toggle('active', k===i); }
  function go(i, user){ i = (i % n + n) % n;
    track.scrollTo({ left: i * track.clientWidth, behavior: reduce ? 'auto' : 'smooth' });
    setActive(i); if(user) restart(); }

  track.addEventListener('scroll', function(){ if(raf) return;
    raf = requestAnimationFrame(function(){ raf = null;
      var i = Math.round(track.scrollLeft / track.clientWidth);
      if(i !== cur) setActive(i); }); }, { passive:true });

  function start(){ if(!reduce) timer = setInterval(function(){ go(cur+1, false); }, 4500); }
  function stop(){ if(timer){ clearInterval(timer); timer = null; } }
  function restart(){ stop(); start(); }
  ['mouseenter','touchstart','focusin'].forEach(function(e){ track.addEventListener(e, stop, {passive:true}); });
  ['mouseleave','touchend','focusout'].forEach(function(e){ track.addEventListener(e, restart, {passive:true}); });
  start();
})();
</script>
```

Safety: transform/opacity + native scroll only. **No-JS** → dots stay empty/hidden,
the track is a native horizontally-swipeable scroll-snap list showing step 1 first.
**Reduced-motion** → no auto-advance, instant (non-smooth) jumps, no Ken-Burns.
Keep the section heading (`steps_eyebrow` / `steps_h2` / `steps_p`) above the phone.

---

## 5. Trust-strip removal (non-home pages)

**Delete the entire hero trust strip** — the single markup node:
```html
<div class="w-hero-trust"> … ★ 4.4 on Google · Trustpilot 4.5 · 80,000+ walks booked · Partner of Gemeente Rotterdam … </div>
```
on **every** non-home page: all 6 route pages, all 4 city hubs, how-it-works,
groups, gift-cards, about, faq. One `.w-hero-trust` markup node per page — the
extra `w-hero-trust` matches in a grep are CSS rules (`.w-hero-trust`,
`.w-hero-trust .w-star`, `.w-trust-hide-m`, mobile overrides) — leave the CSS,
remove only the markup `<div>`. On route pages this also removes the Rotterdam-only
"Partner of Gemeente Rotterdam" and the disputed "80,000+" line — intended.

- **KEEP** the homepage (`index.html`) hero trust row exactly as-is.
- **KEEP** the footer trust line (`.w-footer-trust`) on all pages — it's the footer,
  not the hero strip, and owner allows subtle trust in body/footer.
- After deleting, remove the now-orphaned `t_google` / `t_trustpilot` / `t_guests` /
  `t_partner` i18n keys from that page's NL dict **only if** they're unused elsewhere
  on the page (grep the key first). If used by another block, keep them.

---

## 6. About — "brands we've worked with" wall

A premium, uniform **wordmark** wall (styled text, not logo images — a consistent
type wall reads more premium than mismatched logos, and avoids hotlinking/fabricating
files). Add as a new section on `/about/` (blush or cream background, its own
`w-head`). Real logo files can be swapped into each cell later without changing the grid.

### Markup
```html
<section class="w-section alt w-pad">
  <div class="w-head wg-reveal">
    <div class="w-eyebrow" data-i18n="brands_eyebrow">In good company</div>
    <h2 data-i18n="brands_h2">Brands we've poured with</h2>
    <p data-i18n="brands_p">The spirits, mixers and makers behind our signature menus.</p>
  </div>
  <ul class="w-brandwall wg-stagger" aria-label="Brands WOGO has worked with">
    <li class="w-brandmark">London Essence</li>
    <li class="w-brandmark">Damrak</li>
    <li class="w-brandmark">Gin 1689</li>
    <li class="w-brandmark">Lillet</li>
    <li class="w-brandmark">Three Cents</li>
    <li class="w-brandmark">Passoã</li>
    <li class="w-brandmark">Coca-Cola</li>
    <li class="w-brandmark">Bols</li>
    <li class="w-brandmark">Bacardí</li>
    <li class="w-brandmark">Bandoeng 22</li>
    <li class="w-brandmark">Beefeater</li>
    <li class="w-brandmark">Lyre's</li>
    <li class="w-brandmark">Hendrick's</li>
    <li class="w-brandmark">Leonista</li>
    <li class="w-brandmark">Tequila Patrón</li>
    <li class="w-brandmark">Absolut</li>
    <li class="w-brandmark">Crystal Head Vodka</li>
    <li class="w-brandmark">Smith &amp; Sinclair</li>
    <li class="w-brandmark">Bandoeng 22</li>
    <li class="w-brandmark">aidsfonds</li>
  </ul>
  <p class="w-brandwall-note" data-i18n="brands_note">Selected partners across our routes.</p>
</section>
```
(Owner's list, de-duplicated — "Bandoeng 22" appears once; the placeholder second
cell above should be removed. Final unique count: 19 brands.)

### CSS
```css
.w-brandwall { list-style: none; max-width: 1000px; margin: 0 auto;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.w-brandmark { display: flex; align-items: center; justify-content: center; text-align: center;
  min-height: 74px; padding: 14px 16px; border-radius: 14px;
  background: var(--wogo-cream); border: 1px solid var(--wogo-line-soft);
  color: var(--wogo-brown); font-family: var(--wogo-font-head, "Poppins", sans-serif);
  font-size: 14px; font-weight: 700; letter-spacing: 0.04em; line-height: 1.2;
  transition: transform .3s cubic-bezier(.22,.61,.36,1), box-shadow .3s ease, color .3s ease; }
.w-brandmark:hover { transform: translateY(-3px); color: var(--wogo-espresso);
  box-shadow: 0 12px 26px var(--wogo-shadow); }
@media (hover:none){ .w-brandmark:hover { transform: none; box-shadow: none; } }
.w-brandwall-note { text-align: center; margin-top: 16px; font-size: 12.5px;
  font-weight: 600; color: var(--wogo-brown-soft); }
@media (max-width: 720px){ .w-brandwall { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .w-brandmark { min-height: 64px; font-size: 13px; } }
```
Uniform tiles, one type treatment, warm-neutral palette, gentle hover lift.
NL dict entries needed: `brands_eyebrow`, `brands_h2`, `brands_p`, `brands_note`
(brand names stay in Latin script, untranslated).

> **FLAG:** these are styled text wordmarks. Real official logo SVG/PNG files can be
> dropped into each `.w-brandmark` later (swap text for `<img>`), keeping the grid.

---

## 7. Palette guardrail

Everything above uses only the canonical range: blush `#ffe5d9`, cream `#fffaf6`,
brown-soft `#7e5541`, brown `#643e2b`, espresso `#3f2b21`, ink `#201611`, salmon
`#ffaa81`, salmon-deep `#f2905c`. No red, no terracotta, no ACW. Salmon stays a
spice — used for the accent, the roundel, and the one primary CTA per page, never a
big flat base fill.

---

## Per-file checklist (run after every edit)
1. Tags balanced; `node --check` any changed `<script>`.
2. Every `data-i18n` key on the page has an EN default AND a matching NL entry
   (key-sync). Removed keys deleted from both.
3. JSON-LD still valid; route `description` cadence matches the new `ticket_r4`.
4. Hero shows exactly: eyebrow + H1 + subline + one action (route pages: + ticket card).
5. `.w-hero-trust` markup gone on non-home pages; present on homepage; footer trust intact.
6. Book/gift CTAs keep their existing `wogococktailwalk.com` URLs + `target="_top"`.
7. Phone mockup: JS off → step 1 visible + swipeable; reduced-motion → no auto-advance.
</content>
</invoke>
