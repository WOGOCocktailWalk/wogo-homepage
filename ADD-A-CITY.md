# Add a new WOGO city — the ~1-hour recipe

This is the step-by-step for launching a new city (London, New York, …) on the WOGO
site. It's written to be repeatable: copy an existing city, change the labels, flip a
few switches. No new tools, no subscriptions — everything here is €0.

Think of it like opening a new WOGO location using a floor-plan you already have. You're
not building rooms from scratch; you're re-labelling a proven layout.

**Live worked example:** the `/london/` folder is a finished placeholder you can copy
from. It's the whole flow already done once — home → United Kingdom → London → route →
book — in GBP, English default, Dutch toggle working. Open those three files side by side
with your new city and you'll see exactly what to change.

> **Out of scope: Shanghai / China.** China needs a separate, China-hosted build (the
> booking engine and fonts/scripts don't load reliably behind the Great Firewall).
> Don't add Chinese cities to this site.

---

## The 3 things that make a city "international"

Every new city outside the Netherlands needs exactly three things set correctly. Get
these right and everything else is just copy:

1. **Currency** — the price symbol + format. NL = `EUR` → `€34,95` (comma). UK = `GBP` →
   `£34.95` (point). US = `USD` → `$34.95` (point). You never type the symbol by hand in
   the widget — you set the currency *once* on the route in the booking engine and the
   price shows correctly everywhere automatically.
2. **Timezone** — so a London bar is told the correct *London* local hour on its booking
   email, not Amsterdam time. NL = `Europe/Amsterdam`, London = `Europe/London`,
   New York = `America/New_York`.
3. **Country group in the menu** — the new city appears under its country heading
   (United Kingdom, United States…) in the Routes menu and footer.

---

## Part A — The booking engine (do this first, ~15 min)

The website *shows* the price and calendar, but the booking engine is the source of truth.
A new city's route needs a row in the booking database with its currency and timezone.

Two columns already exist for this (added in migration `0011_currency_timezone.sql`):
`currency` (defaults to `EUR`) and `timezone` (defaults to `Europe/Amsterdam`).

**To add a route for a new city, set these when you create the route:**

| Field | London example | New York example |
|---|---|---|
| `id` (route slug) | `london-soho` | `newyork-les` |
| `currency` | `GBP` | `USD` |
| `timezone` | `Europe/London` | `America/New_York` |
| `price_cents` | `3495` (= £34.95) | `3995` (= $39.95) |

You create routes either in the **admin dashboard** (easiest — the currency + timezone are
fields on the route) or with a new seed migration file (`0012_...sql` and up — **never
edit the old numbered migrations**, always add a new higher-numbered one).

**In the dashboard:** open the **Routes** tab → **"+ Add a new tour"**. Fill in Slug
(url id, lowercase), Display name, City, Price per person, Currency, Seats per departure,
Max per booking, Timezone, Open days, and Start times, then **"Create tour"**.

The website widget reads the price + currency straight from the engine, so once the route
exists with `currency: GBP`, the booking calendar shows `£34.95` on its own. You don't
touch the widget.

> If you launch the website pages *before* the engine route is seeded, that's fine — the
> booking page shows the price and a small "Live booking opens when this city launches"
> note (that's the `data-placeholder="1"` on the London book page). Remove that attribute
> once the route is live in the engine.

### Add the route's bars (and their real emails)

A route isn't bookable in any useful sense until it has bars attached — without this step,
guests can still complete a booking, but **no arrival email ever reaches a bar**, so no
table is actually held.

Still in the dashboard: click into the new route → **Bars** tab → **"+ Add bar"**, once
for each stop, in the order guests visit them. For every bar set:

- **Bar name.**
- **Bar email** — the real address that bar wants booking notices at. "+ Add bar"
  pre-fills `bookings@wogoamsterdam.com` as a placeholder — **replace it with the bar's
  actual email before launch**, or every arrival notice for that stop silently lands in
  WOGO's own inbox instead of the bar's.
- **Minutes offset** — how many minutes after the booked start time this bar's guests
  arrive. The first bar is always `0`; the dashboard suggests 75-minute gaps after that —
  adjust to match the route's real walking/drinking pace. These arrival times are computed
  in the **route's own timezone** (migration `0011`), so a London bar is told the correct
  London local time even though the server runs in UTC.

Click **"Save bars"** once all stops are entered. Confirm each bar's email address with
that bar directly — a typo here means a table never gets held and nobody notices until a
guest shows up.

### Add the route's two map PDFs (English + Dutch)

The guest confirmation email has an **"Open your route map"** button, and it picks the
map in the guest's own language: guests who booked in Dutch get the Dutch map, everyone
else gets the English one. So every city needs **two "mail version" map PDFs** — the
same map you already make per route, exported once in English and once in Dutch (like
"Utrecht Cocktail Walk ENG (mail).pdf" and its NL twin).

1. **Drop both PDFs into the site repo's `/maps/` folder**, named after the city:

   ```
   maps/<city>-en.pdf     e.g. maps/utrecht-en.pdf
   maps/<city>-nl.pdf     e.g. maps/utrecht-nl.pdf
   ```

   They deploy with the site, so their public links become
   `https://www.wogococktailwalk.com/maps/<city>-en.pdf` (and `-nl.pdf`). €0 — no map
   hosting service needed.

2. **Set both links on the route** in the dashboard: the add/edit-route form has two
   fields side by side — **"Route map link — English"** and **"Route map link — Dutch"**.
   Paste the `-en.pdf` link in the first and the `-nl.pdf` link in the second.

If the Dutch field is left blank, Dutch guests simply get the English map (nothing
breaks). If *both* are blank, the confirmation email just goes out without a map button —
so treat the two PDFs as part of launching the city, not an optional extra. (Utrecht and
Groningen are already done — their four PDFs live in `/maps/` and their routes point at
them.)

---

## Part B — The website pages (~30 min)

Each city has three pages. Copy the closest existing city folder:

- **Single route** (like Utrecht / Amsterdam / London Soho): copy the `london/` folder.
- **Several routes in one city** (like Rotterdam's three): copy the `rotterdam/` folder.

A city folder holds:

```
<city>/index.html            ← the city hub page (lists the routes)
<city>/<route>/index.html    ← the route detail page (the story + price)
<city>/<route>/book/index.html ← the booking page (the calendar)
```

**In each file, only touch the parts marked `CITY-EDIT` / `ROUTE-EDIT` in the comments.**
Everything else (the top menu, the footer, the styling, the cookie banner) is *shared* and
must stay identical across every page — don't hand-edit it here (see Part C).

Go through each file and change:

1. **The `<title>`, description, canonical link, and social (`og:` / `twitter:`) tags** at
   the very top — swap the city + route name and the price.
2. **The structured data** (`application/ld+json` blocks) — city name, route name, the
   breadcrumb trail, and **`priceCurrency`** (`EUR` → `GBP`/`USD`) + the `price` number.
3. **The visible copy** — hero headline, the route story, the quick facts, the "Book" band.
   Keep it short and in WOGO's voice.
4. **Every price** — the ticket card, the book band, the mobile sticky bar. For GBP write
   `£34.95` (point, symbol first); for USD `$39.95`.
5. **The photo** — swap in a real, self-hosted city photo (download from your media
   library into the city folder — never hotlink or use stock). Until you have one, point
   at the shared `hero-poster-1600.webp` like the London example does.
6. **The Dutch dictionary** at the foot of each page (`var NL = { … }`) — every English
   label on the page must have a natural-Dutch line. The English/Dutch toggle stays on
   every page, including English-first cities.
7. **On the booking page only**, set the calendar's `data-route` to your engine route slug
   (e.g. `data-route="london-soho"`), and its `data-currency` / `data-price-cents` for the
   placeholder price.

**English-first cities (London, New York):** the page defaults to English automatically —
you don't change anything for that. The Dutch toggle stays and still works.

---

## Part C — Put the city in the menu (~10 min)

This is the one step that touches *every* page, because the menu + footer are copied onto
each page identically. There's a single block of data called `WOGO_ROUTES` near the foot of
every page. Add your city under the right country:

```js
{ code:'gb', name:{en:'United Kingdom',nl:'Verenigd Koninkrijk'}, cities: [
    { name:'London', hub:'london/', routes:[ {name:'London Soho', url:'london/soho/'} ] }
] }
```

- To add a **new country**, add a new `{ code, name, cities }` block (like `gb` above). The
  country heading appears in the menu automatically as soon as there's more than one
  country — with only the Netherlands it stays clean and heading-free.
- To add a **city to an existing country**, add a `{ name, hub, routes }` line to that
  country's `cities` list.
- To add a **route to an existing city**, add a `{name, url}` to that city's `routes`.

**Important:** this `WOGO_ROUTES` block must be **exactly the same on every page** (only one
line, `var BASE = …`, is allowed to differ — it's each page's path back to the site root).
The simplest way: edit it on the homepage, then copy that exact block onto every other page.

---

## Part D — Check it before you ship

Run these from the `wogo-homepage` folder. They're read-only — they just look, they don't
change anything.

**1. The menu data is identical on every page** (should print one line, all pages agree):

```bash
for f in $(grep -rl "WOGO_ROUTES = { countries:" --include=index.html .); do
  awk '/var WOGO_ROUTES = \{ countries:/{f=1} f{print} f&&/\] \};$/{exit}' "$f" | md5 -q
done | sort | uniq -c
```

**2. Every link in your new city's pages resolves** (no typos in folder names) — open each
page in a browser and click through: home → country → city → route → book.

**3. The booking engine tests still pass** (from the `backend` folder):

```bash
npm test
```

**4. Add the new pages to `sitemap.xml`** — one `<url><loc>…</loc></url>` block per page
(home already links to them once Part C is done; the sitemap is what tells Google they
exist). Do this as part of launch, not before — a `noindex` page has no business in a
sitemap.

**5. Final launch switch:** when the city is really live, **remove `<meta name="robots"
content="noindex">`** from the new pages and the `data-placeholder="1"` from the booking
page's calendar widget. Until then they stay `noindex` (hidden from Google) — which is
exactly what the London example is right now.

---

## The 60-second mental model

- **Currency + timezone live on the route in the booking engine.** Set them once there.
- **The website reads them** — the widget, the price copy, the structured data all follow.
- **The menu is data** (`WOGO_ROUTES`) — one block, kept identical on every page.
- **Copy a finished city** (`london/` or `rotterdam/`), change only the `CITY-EDIT` /
  `ROUTE-EDIT` bits, keep the shared menu/footer untouched.
- **`noindex` until launch** — ship quietly, flip it on when it's ready.
