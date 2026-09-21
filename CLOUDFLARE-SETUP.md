# Cloudflare setup guide (plain language, for Maroussia)

**Do this at cutover time, not before.** This is one of the last steps in
`SITE-PLAN.md`'s migration order — after the new site is fully built and
tested, but before you cancel Wix. It's free forever (Cloudflare's Free
plan), it's a one-time setup, and it stays in place with basically zero
maintenance afterwards.

## Why you need this at all

Think of your domain (`wogococktailwalk.com`) like a phone number, and DNS
like the phone company's directory that says which physical building that
number rings through to. Right now that directory says "ring Wix." At
cutover we change the entry to "ring GitHub Pages" (where the new site
lives, for free).

**Cloudflare sits in front of that directory as a free security guard.**
Two things it does that GitHub Pages genuinely cannot do on its own:

1. **Real redirects.** When you retire the old Wix URLs, anyone (or any
   Google search result) that still has the old link needs to land on the
   new page automatically, invisibly, and in a way Google understands as
   "this moved permanently, transfer the ranking too." GitHub Pages has no
   mechanism for this at all — it can only serve files that exist at exact
   paths. Cloudflare's **Bulk Redirects** feature is built exactly for this.
2. **Security headers.** GitHub Pages already forces every visitor onto
   HTTPS (the padlock icon) — that part is already handled and needs no
   work from you. What GitHub Pages **cannot** do is add extra security
   instructions to every page it serves (things like "never let this site
   be embedded in someone else's page" or "only ever load scripts from our
   own domain"). Cloudflare can inject those on the way through, because it
   sits between the visitor and GitHub Pages.

Everything below is done by clicking around in Cloudflare's website — no
code, no terminal.

---

## Step 0 — Before you start

- Know where `wogococktailwalk.com` is currently registered (which company
  you pay each year to "own" the domain — GoDaddy, Wix itself, TransIP,
  etc.). You are **not** moving the domain to Cloudflare, just pointing its
  DNS at Cloudflare. You'll need to log into that registrar for one step.
- Have `REDIRECT-MAP.md` (in this repo) open — it lists the internal page
  moves already known. You'll add the old Wix URLs to it once you've pulled
  them from Google Search Console (see `SITE-PLAN.md`, Decision #4).
- Don't touch DNS until the new site has processed a real test booking
  end-to-end (`SITE-PLAN.md` §4, "Cutover order"). Adding Cloudflare itself
  is safe to do early — it only becomes risky when you flip the actual
  traffic switch in Step 2.

---

## Step 1 — Add the domain to Cloudflare (free plan)

1. Go to cloudflare.com → **Sign up** → verify your email.
2. Click **Add a site** → type `wogococktailwalk.com` → choose the **Free**
   plan.
3. Cloudflare scans your current DNS records automatically and shows you a
   list (this is just a copy of what Wix has set up today) — leave them as
   they are for now, click through to continue.
4. Cloudflare gives you **two nameservers** (they look like
   `ana.ns.cloudflare.com` / `bob.ns.cloudflare.com` — yours will be
   different). Copy both.
5. Log into your domain **registrar** (from Step 0), find "Nameservers" or
   "DNS settings" for `wogococktailwalk.com`, and replace whatever is there
   with Cloudflare's two nameservers.
6. Wait. This can take anywhere from 10 minutes to 24 hours to "propagate."
   Cloudflare emails you the moment it's active. **Nothing changes for
   visitors during this wait** — the site keeps serving from wherever it
   was pointed before (Wix, if you haven't flipped anything else yet).

Once Cloudflare shows the domain as **Active**, everything below happens
inside the Cloudflare dashboard for that domain.

## Step 2 — Point DNS at GitHub Pages (the actual cutover moment)

This is the step that makes the new site go live. Do this only once
end-to-end booking testing has passed.

1. In Cloudflare, go to **DNS** → **Records**.
2. Delete the old Wix DNS records (the ones Wix originally set up).
3. Add these records (GitHub Pages' fixed addresses — same for every GitHub
   Pages site, you don't need to look them up):

   | Type | Name | Content | Proxy status |
   |---|---|---|---|
   | A | `@` (root/apex) | `185.199.108.153` | Proxied (orange cloud) |
   | A | `@` | `185.199.109.153` | Proxied |
   | A | `@` | `185.199.110.153` | Proxied |
   | A | `@` | `185.199.111.153` | Proxied |
   | CNAME | `www` | `wogococktailwalk.github.io` | Proxied |

4. In the GitHub repo (`wogo-homepage`) → **Settings → Pages**, set the
   custom domain to `www.wogococktailwalk.com` and tick **Enforce HTTPS**
   once it's available (GitHub needs the DNS from step 3 live first — it
   greys this out until it can verify the domain).
5. Keep "Proxy status = Proxied" (orange cloud) on every record above —
   that's what lets Cloudflare add the security headers and redirects in
   the steps below. If a record shows a grey cloud ("DNS only"), click it
   to turn it orange.

## Step 3 — Always Use HTTPS + HSTS

1. Cloudflare dashboard → **SSL/TLS** → **Overview** → set encryption mode
   to **Full (strict)**. (GitHub Pages has a valid certificate, so "strict"
   is safe and is the most secure option.)
2. **SSL/TLS → Edge Certificates**:
   - Turn on **Always Use HTTPS** (any visitor who types `http://` gets
     bounced to `https://` automatically).
   - Turn on **HTTP Strict Transport Security (HSTS)**. Cloudflare shows a
     warning dialog — read it once, then set:
     - **Max Age:** start with **6 months**, not longer. HSTS tells
       browsers "never try this site over plain HTTP again, for this many
       months" — that's great once you're sure HTTPS is rock solid, but
       hard to reverse quickly if something's wrong, so start modest and
       raise it later (e.g. to 1–2 years) once the site's been stable for
       a while.
     - **Include subdomains:** leave **off** for now unless every future
       subdomain (like a future `shop.` or `blog.` subdomain) will also
       always be HTTPS.
     - **Preload:** leave **off**. Submitting to the browser preload list
       is close to permanent (removal takes months) — only do this later,
       deliberately, once HSTS has run cleanly for a while.
   - Turn on **Automatic HTTPS Rewrites** (fixes any stray `http://` links
     left in old copy).

## Step 4 — Security response headers

These are small labels Cloudflare stamps onto every page as it passes
through, telling browsers how to treat the site safely. Free plan supports
this via **Transform Rules**.

1. Cloudflare dashboard → **Rules → Transform Rules → Modify Response
   Header** → **Create rule**.
2. Name it something like `Security headers — all pages`.
3. **When incoming requests match:** choose **All incoming requests** (or
   `Hostname equals www.wogococktailwalk.com` if you want to scope it).
4. Under **Then modify response header**, add each of these one at a time
   (pick **Set static**, type the header name, paste the value):

   | Header name | Value |
   |---|---|
   | `Strict-Transport-Security` | `max-age=15768000` *(matches the 6-month HSTS setting from Step 3 — raise both together later)* |
   | `X-Frame-Options` | `DENY` |
   | `X-Content-Type-Options` | `nosniff` |
   | `Referrer-Policy` | `strict-origin-when-cross-origin` |
   | `Permissions-Policy` | `geolocation=(), microphone=(), camera=(), payment=(self "https://checkout.stripe.com")` |
   | `Cross-Origin-Opener-Policy` | `same-origin` |
   | `Cross-Origin-Resource-Policy` | `same-origin` |
   | `Cross-Origin-Embedder-Policy` | `unsafe-none` |
   | `Content-Security-Policy` | *(see below — it's long, its own step)* |

   A quick plain-language translation of what these actually do:
   - `X-Frame-Options: DENY` — stops another site from putting your pages
     inside an invisible frame to trick visitors (clickjacking).
   - `X-Content-Type-Options: nosniff` — stops the browser from
     "guessing" a file's type in a way attackers can abuse.
   - `Referrer-Policy` — controls how much of the URL a visitor was on
     gets shared with the next site they click to. This setting shares
     the full page they came from with your own site, but only the bare
     domain (not full URL) when they leave to somewhere else — a sane
     privacy default.
   - `Permissions-Policy` — turns off browser features (camera, mic,
     location) for every page except ones that genuinely need them —
     `payment` is left open for Stripe's checkout once that's added.
   - The three `Cross-Origin-*` headers — a set that keeps your site's
     data isolated from other tabs/sites in the browser. `Embedder-Policy`
     is set to `unsafe-none` (the relaxed option) because Stripe's
     embedded checkout and YouTube/Vimeo-style embeds generally need it;
     tighten this later only if you confirm nothing embeds cross-origin
     content.

   **Content-Security-Policy** — this is the header that says "only ever
   load scripts/styles/images/fonts from these trusted places." It's the
   single most protective header on this list (stops injected malicious
   scripts even if something else goes wrong), and the trickiest to get
   right because it has to list every real source your pages use. Your
   current pages use **inline** `<style>` and `<script>` tags directly in
   the HTML (not separate files), so the starter policy below explicitly
   allows that — it's less strict than the ideal (which uses per-script
   "nonces"), but it's the correct realistic starting point for a
   hand-written HTML site with zero build tooling. Set it as one single
   line (no line breaks) with this value:

   ```
   default-src 'self'; script-src 'self' 'unsafe-inline' https://js.stripe.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.stripe.com https://cloudflareinsights.com; frame-src https://js.stripe.com https://checkout.stripe.com; object-src 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; upgrade-insecure-requests
   ```

   What each piece allows, in short: your own domain for everything by
   default; Stripe's JS + checkout iframe once booking payments are wired
   up (`SITE-PLAN.md` §2); Cloudflare's own analytics script (Step 5);
   images from anywhere over HTTPS (useful while some photos are still
   hotlinked from Wix/Contentful during migration — tighten this to just
   `'self'` once all media is self-hosted, per the SEO findings memory);
   no `<object>`/Flash-era embeds; forms can only submit to your own
   domain or Stripe's checkout; and the site refuses to ever be framed by
   anyone (`frame-ancestors 'none'` — belt-and-braces alongside
   `X-Frame-Options` above).

   **Test before you trust it:** after saving, browse the live site
   yourself — open the browser's dev tools (right-click → Inspect →
   Console tab) and look for red "Content Security Policy" errors. If
   something legitimate gets blocked (a new embed, a new script), add its
   exact domain to the relevant `-src` list and save again. This is
   normal and expected the first time.

5. Click **Deploy**.

## Step 5 — Cloudflare Web Analytics (free, cookie-free, no consent banner needed)

Because it doesn't use cookies or fingerprinting, this is legally exempt
from needing a cookie-consent popup under GDPR/ePrivacy — unlike Google
Analytics. Good fit for keeping the site simple.

1. Cloudflare dashboard → **Analytics & Logs → Web Analytics**.
2. Click **Add a site** → since `wogococktailwalk.com` is already active
   on Cloudflare and proxied (orange cloud), tick **Automatically inject
   the JavaScript snippet** — Cloudflare adds the tracking script to every
   page for you, no HTML editing needed.
3. Save. Traffic will start appearing in the Web Analytics tab within a
   few minutes of the next visit.
4. (If you ever move the site off Cloudflare's proxy, the alternative is
   pasting a small `<script>` snippet into the shared footer once, on
   every page — same "edit the fenced footer block, find-and-replace
   everywhere" process already used for nav/footer changes.)

## Step 6 — Bulk Redirects (Wix → new site URL map)

This is what carries your Google rankings and the 5 press backlinks across
the move, per `SITE-PLAN.md` §4.

1. First, pull the **complete** historical URL list for
   `wogococktailwalk.com` from Google Search Console (`SITE-PLAN.md`,
   Decision #4) — the list below is only what's currently known from
   existing links, not the full history. Add anything GSC surfaces to
   `REDIRECT-MAP.md` before doing this step, so the file stays the one
   source of truth.

2. Known mappings so far (old Wix path → new site path):

   | Old Wix URL | New URL |
   |---|---|
   | `/` | `/` (no change) |
   | `/utrecht` | `/utrecht/` |
   | `/rotterdam-cocktail-walk-route1` | `/rotterdam/witte-de-with/` *(best guess — Route 1; confirm against real Wix page content before going live)* |
   | `/rotterdam-cocktail-walk-route-2` | `/rotterdam/hidden-gems/` *(best guess — Route 2, the best-seller; confirm before going live)* |
   | `/rotterdam-premium-cocktail-walk` | `/rotterdam/premium-gin-walk/` |
   | `/amsterdam-cocktailwalk-route1` | `/amsterdam/` |
   | `/groningen-cocktail-walk` | `/groningen/` |
   | `/groupbookings` | `/groups/` |
   | `/gift-cards` | `/gift-cards/` |
   | `/booking-calendar/*` (5 pages, exact paths not yet pulled) | `/` (homepage) until GSC gives the real paths, then re-map each one to its matching city or route page |

   Plus the internal restructuring moves already logged in
   `REDIRECT-MAP.md` (these matter even before Wix is cancelled, in case
   anyone already bookmarked or shared them):

   | Old internal URL | New URL |
   |---|---|
   | `/utrecht/city-centre/` | `/utrecht/` |
   | `/amsterdam/ndsm-noord/` | `/amsterdam/` |
   | `/groningen/gin-walk/` | `/groningen/` |

3. In Cloudflare: **Rules → Bulk Redirects** → **Create a Bulk Redirect
   List** (name it e.g. `wogo-wix-migration`) → **Create redirect** and
   add each row from the tables above: **Source URL** = full old URL
   (`https://www.wogococktailwalk.com/utrecht`), **Target URL** = full new
   URL (`https://www.wogococktailwalk.com/utrecht/`), **Status code** =
   **301 (Permanent Redirect)**, **Preserve query string** = on. Repeat for
   every row.
4. Click **Create a Bulk Redirect Rule**, select the list you just made,
   leave it applying to all requests, **Deploy**.
5. Test 3–4 of the old URLs directly in a browser once DNS has switched
   (Step 2) — each should land on the new page instantly with no flash of
   an old page first.
6. Free plan note: Cloudflare's docs say up to 10,000 entries are allowed
   on the Free plan; a handful of accounts have reported being capped
   lower (around 20) and needing a quick support-ticket bump. WOGO only
   needs ~15–20 rows total, so either ceiling is fine — just don't be
   surprised if you hit a wall and need to message Cloudflare support once.

---

## After all 6 steps: sanity checklist

- [ ] `https://www.wogococktailwalk.com` loads the new GitHub Pages site
      (not Wix), with a padlock, no browser warnings.
- [ ] Typing `http://wogococktailwalk.com` (no `https`, no `www`) still
      ends up on `https://www.wogococktailwalk.com`.
- [ ] Dev tools Console tab shows no red CSP errors on the homepage, a
      city page, and (once built) the Stripe checkout flow.
- [ ] At least 3 old Wix URLs from the table above redirect correctly.
- [ ] `robots.txt` and `sitemap.xml` (this repo, root folder) are reachable
      at `https://www.wogococktailwalk.com/robots.txt` and `/sitemap.xml`.
- [ ] Cloudflare Web Analytics shows real visits within an hour of traffic.
- [ ] Submit `sitemap.xml` in Google Search Console + Bing Webmaster Tools
      (`SITE-PLAN.md` §4, step 7).

**Only after a full week of bookings has flowed cleanly through the new
site** — per `SITE-PLAN.md`'s cutover order — cancel the Wix subscription.
