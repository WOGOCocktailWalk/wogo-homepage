# Owner security to-do — things only you can do

Everything in `src/` is code, and code ships the moment you `wrangler
deploy`. The seven things below are different: they're switches that only
exist inside a **dashboard** (Cloudflare, UptimeRobot) — nobody can flip
them from the code editor, including future work on this backend. This is
the checklist for those.

All seven are **free**. Total hands-on time if you do them in one sitting:
roughly 45–60 minutes, most of it Cloudflare waiting for you to click
"Save."

**Do these now** (don't need the domain on Cloudflare yet): #3 Turnstile,
#4 UptimeRobot, #7 confirm the R2 backup bucket.
**Do these at cutover** (the moment `CLOUDFLARE-SETUP.md` moves DNS to
Cloudflare — doing them earlier has no effect, doing them AT that moment
matters): #2 Bot Fight Mode, #5 static-site headers, #6 SPF/DKIM/DMARC.
**Do this once the Worker has a custom domain** (see #1's first step):
#1 Cloudflare Access.

---

## 1. Cloudflare Access on `/admin` — a second lock in front of your own login

**Why:** `/admin` already has its own login (your `ADMIN_TOKEN`, plus
optional Turnstile bot-check — #3 below). Access adds a SEPARATE lock in
front of that one, checked by Cloudflare itself before your request even
reaches the Worker: "sign in with Google" (using the same Google account
you already use). If your `ADMIN_TOKEN` ever leaked, whoever has it still
can't get past this second lock without also being logged into YOUR
Google account. Free for up to 50 users (you need one).

**MFA note:** Access "sign in with Google" inherits whatever protection
your Google account already has. If your Google account doesn't have
2-Step Verification turned on yet, turn that on first
(myaccount.google.com → Security → 2-Step Verification) — otherwise this
step adds a login screen but not actually MFA.

**Prerequisite — the Worker needs a real domain, not just
`*.workers.dev`.** Cloudflare Access protects hostnames on YOUR zone; it
can't attach to Cloudflare's own `workers.dev` domain. One-time setup:

1. Cloudflare dashboard → **Workers & Pages** → `wogo-booking-backend` →
   **Settings → Domains & Routes → Add → Custom Domain**. Something like
   `api.wogococktailwalk.com` (needs the `wogococktailwalk.com` zone
   already on Cloudflare — i.e., after `CLOUDFLARE-SETUP.md`'s cutover).
   Cloudflare creates the DNS record and issues the certificate for you.
2. Update the three places that point at the old `workers.dev` URL —
   same three DR.md §3 lists after any redeploy: the Stripe webhook
   endpoint, `WOGO_API` in `backend/widget/wogo-calendar.js`, and your
   UptimeRobot monitors (#4 below).

Then turn Access on:

3. Cloudflare dashboard → left sidebar → **Zero Trust** (may show as "Access"
   depending on when you're reading this — search the dashboard's search
   bar for "Access" if the label moved).
4. **Access → Applications → Add an application → Self-hosted.**
5. Domain: your custom domain from step 1. Path: `/admin` (this leaves
   `/api/*` and `/webhooks/stripe` — the guest widget and Stripe — untouched;
   only the admin dashboard sits behind this).
6. Identity provider: **Google** (Cloudflare has a built-in Google option —
   no separate Google Cloud setup needed for a single-user policy like
   this).
7. Policy: **Include → Emails → paste your exact Google email address.**
   This is the entire access list — just you.
8. Save, then test in a private/incognito window: `/admin` should now show
   a Cloudflare-branded "Sign in with Google" screen BEFORE your app's own
   login form ever appears.

If this ever locks you out by mistake, Cloudflare dashboard → Zero Trust →
Access → Applications → that application → **Delete** removes the lock
instantly (your app's own `/admin` login is untouched and still works).

---

## 2. Bot Fight Mode — free automatic bot blocking

**Why:** blocks known scraper/bot traffic at Cloudflare's edge, before it
ever reaches your site or the Worker. Zero configuration beyond the
toggle.

**Do this at cutover, then test immediately —** the one real caution
here: Bot Fight Mode occasionally flags legitimate non-browser traffic
(Stripe's webhook caller is exactly that shape: a server calling your API
with no browser fingerprint). Don't set this and walk away.

1. Cloudflare dashboard → your domain → **Security → Bots**.
2. Toggle **Bot Fight Mode** on (the free-plan option; "Super Bot Fight
   Mode" is the paid-plan name for the same idea with more controls —
   free is enough here).
3. **Immediately run SETUP.md §10's one real test booking, start to
   finish** — the same test you (should have) already run once at initial
   deploy. If the Stripe webhook step fails where it didn't before, it's
   this toggle: Cloudflare dashboard → **Security → WAF → Custom rules** →
   add a rule "Skip" (bot fight mode) when `URI Path starts with
   /webhooks/` OR `/api/`, leaving Bot Fight Mode fully active on the rest
   of the site.

---

## 3. Turnstile site keys — bot-proofs the admin login page

Already fully documented, plain-language, step by step: **`SETUP.md`
§13**. Five minutes, free, and completely inert until you finish both
halves (the Cloudflare-side site+secret key AND wiring the widget into
`admin.html`/`admin.js` — flag it here when you're ready and that second
half gets wired up together).

---

## 4. UptimeRobot — "is the site actually up" from OUTSIDE Cloudflare

**Why:** the Worker's own built-in health check (already live, checks
itself every 5 minutes) can catch "my database died" but can never catch
"nobody on Earth can reach my domain" — a Worker can't observe its own
DNS/network failure from the inside. UptimeRobot is a second, independent
set of eyes, watching from outside.

Already fully documented: **`SETUP.md` §14**. Two monitors, ~5 minutes,
free tier is plenty (5-minute checks). If you did §1's custom-domain step,
point both monitors at the new domain instead of `workers.dev`.

---

## 4b. Email image assets — flip the asset host at cutover

**Why:** the branded emails (logo, banner, city posters) load their images from
`SITE_ASSET_BASE` in `backend/src/config.js`, currently the live GitHub Pages
host (`https://wogococktailwalk.github.io/wogo-homepage`) so images resolve
during testing. At cutover, change that ONE line to
`https://www.wogococktailwalk.com` and make sure the `/email/` (and `/maps/`)
folders are served from the real domain. A broken image in an email shows a torn
placeholder — verify a test send after flipping. (The `map_url` links seeded in
D1 also point at the `.com` domain and only resolve after cutover.)

---

## 5. Static-site security headers (Transform Rules) — at cutover

**Why:** the Worker already sends these headers on every API/webhook/admin
response (`src/security_headers.js` — done, no owner action needed there).
The STATIC marketing site (the actual `wogococktailwalk.com` pages —
different codebase, `~/Projects/wogo-homepage`) is served straight from
GitHub Pages through Cloudflare's CDN and needs its own copy of the same
headers, set at the Cloudflare edge.

Already fully documented, with the exact header values and a full
Content-Security-Policy line ready to paste: **`CLOUDFLARE-SETUP.md` §4
("Security response headers")**. This only takes effect once
`CLOUDFLARE-SETUP.md`'s DNS cutover has happened (traffic has to actually
flow through Cloudflare for a Cloudflare rule to touch it) — do this step
right after cutover, not before.

---

## 6. SPF / DKIM / DMARC — at cutover, and BEFORE you flip the DNS switch

**Why:** these three DNS records are what stop someone else from sending
forged email that looks like it's from `@wogoamsterdam.com`, and what
keeps your real email out of guests' spam folders. Two separate things
live under this one heading:

**A. Brevo's own records** (for the booking confirmation/notification
emails this backend sends) — already documented step by step:
**`SETUP.md` §5, step 2.** Brevo shows you the exact three DNS records to
add once you add `wogoamsterdam.com` as a sender domain there.

**B. Don't lose your EXISTING email while moving DNS.** This is the
important, easy-to-miss one, and it's not really "add DMARC" so much as
"don't silently break the email wogoamsterdam.com already sends/receives
today" (Gmail/Google Workspace, or whatever you're currently on):

1. **Before** you change any nameservers (`CLOUDFLARE-SETUP.md` step 2),
   go to your CURRENT DNS host (wherever the domain is registered/managed
   right now) and write down — screenshot, or copy into a note — every
   `MX`, `TXT` (SPF is a TXT starting `v=spf1...`), and any existing DKIM/
   DMARC TXT record. This is the single most common way a domain move
   breaks email: the old records exist only at the old host, get left
   behind, and mail silently stops working the moment DNS flips.
2. Re-create every one of those records inside Cloudflare's DNS panel
   BEFORE (or in the very same sitting as) the nameserver switch —
   Cloudflare dashboard → your domain → **DNS → Records → Add record**.
3. Once Brevo's three records (part A) are ALSO added, add one more TXT
   record for DMARC if one doesn't already exist —
   `_dmarc.wogoamsterdam.com` → `v=DMARC1; p=none; rua=mailto:info@wogoamsterdam.com`.
   `p=none` means "just report to me, don't reject/quarantine anything
   yet" — the safe starting policy. Tighten it to `p=quarantine` (and
   eventually `p=reject`) only after a few weeks of confirming nothing
   legitimate is getting flagged in those reports.
4. After cutover, send yourself a test email from `info@wogoamsterdam.com`
   to a Gmail address and check **Show original** (Gmail) for
   `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.

---

## 7. Confirm the R2 bucket for backups

**Why:** this is owner audit item #4 — marked CRITICAL in the code's own
comments (`backend/wrangler.toml`, `backend/src/backup.js`). Without it,
you're relying ENTIRELY on D1's automatic 30-day rolling history
(already on, no setup needed) — genuinely fine for "I fat-fingered
something 10 minutes ago," genuinely NOT enough for "I need last quarter's
numbers" or a true worst-case where D1 itself is gone (`DR.md` §3a).

Already fully documented with the exact commands: **`SETUP.md` §15, item
2.** Three steps, ~5 minutes, free (R2's free tier is 10GB — WOGO's
booking volume won't get near that):

1. `npx wrangler r2 bucket create wogo-backups`
2. Uncomment the `[[r2_buckets]]` block already sitting in
   `backend/wrangler.toml` (it's commented out on purpose — see the note
   right above it in that file).
3. `npx wrangler deploy`.

Confirm it actually ran: after tomorrow's 3am UTC daily cron,
`npx wrangler r2 object list wogo-backups --prefix daily/` should show
today's date. If it's empty a day later, something's wrong — the cron
step is designed to fail silently into a no-op rather than break bookings,
so it won't page you; check `GET /admin/api/error-log` for
`no_r2_binding` or similar.

---

## Quick status table

| # | What | Where | Cost | Timing |
|---|---|---|---|---|
| 1 | Cloudflare Access + Google login on `/admin` | Cloudflare Zero Trust | €0 (≤50 users) | After Worker has a custom domain |
| 2 | Bot Fight Mode | Cloudflare → Security → Bots | €0 | At cutover, test right after |
| 3 | Turnstile site keys | Cloudflare → Turnstile (SETUP.md §13) | €0 | Any time |
| 4 | UptimeRobot monitors | uptimerobot.com (SETUP.md §14) | €0 | Any time |
| 5 | Static-site security headers | Cloudflare → Transform Rules (CLOUDFLARE-SETUP.md §4) | €0 | At cutover |
| 6 | SPF/DKIM/DMARC (Brevo + don't lose existing email) | Brevo + Cloudflare DNS (SETUP.md §5) | €0 | Before/at cutover |
| 7 | Confirm R2 backup bucket | `wrangler` CLI (SETUP.md §15) | €0 | Any time |
