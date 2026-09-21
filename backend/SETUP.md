# Deploy guide — WOGO booking backend (plain language)

Who this is for: you, not a developer. Every command below is copy‑paste‑able
into the **Terminal** app on your Mac. Where you see `<like this>`, that's a
placeholder — replace it with your own value, angle brackets and all removed.

Cost at the end of this guide: **€0/month**. Cloudflare Workers, D1, and
Brevo are all free at your volume. Stripe only charges when a guest actually
pays (their normal per‑transaction fee — no monthly fee).

Everything below happens in `~/Projects/wogo-homepage/backend/`. Open
Terminal and run this once so every command in this guide "just works":

```bash
cd ~/Projects/wogo-homepage/backend
```

---

## 0. Look at it first — zero setup, zero risk

Before touching Cloudflare at all, see the actual screens with realistic
fake data:

- **Guest calendar** — double‑click `backend/preview/guest.html` (or drag it
  into a Chrome/Safari tab). This is the exact widget code that will run on
  the real site, just fed pretend availability instead of your real Worker.
  Start by tapping the **Book your walk** button at the top — it auto‑scrolls
  you to the calendar, exactly what guests will feel on the real route pages
  (see step 8), then click through day → time → guests → checkout.
- **Admin dashboard** — double‑click `backend/preview/admin.html` the same
  way. Same deal: real screens, fake bookings.

Nothing here talks to the internet. Close the tab and nothing is saved —
purely a "does this look and feel right" check. If something about the
look needs to change, that's the moment to say so, before we wire it to
real money.

Also confirm the test suite is green (it checks the seat‑counting math,
the no‑double‑booking logic, the 15‑minute hold expiry, the email logic,
and — as of the 2026‑07 security pass — the seat‑hold abuse limits and
admin login lockout too: 141 checks):

```bash
npm test
```

You should see `pass 141` and `fail 0` at the bottom. If anything fails,
stop and flag it — don't deploy on top of a failing test.

---

## 1. Get a free Cloudflare account

If you already made one while following `CLOUDFLARE-SETUP.md` (to point
your domain at GitHub Pages), **reuse that same account** — no need for a
second one. Otherwise: go to https://dash.cloudflare.com/sign-up, sign up
free, verify your email. No credit card needed for what we're doing here
(Workers and D1 both have a generous free tier that's more than enough at
your booking volume).

## 2. Install Wrangler (Cloudflare's deploy tool) — one command

Wrangler is the command-line tool that pushes your code to Cloudflare. It
gets installed *inside* the `backend` project (not system-wide), so it
never goes stale or clashes with anything else on your Mac:

```bash
npm install -D wrangler
```

From here on, every Wrangler command is typed as `npx wrangler ...` — `npx`
just means "run the one I installed right here in this folder."

Log in (opens your browser, click "Allow"):

```bash
npx wrangler login
```

## 3. Create the database (D1) and load the schema

D1 is Cloudflare's free SQLite database — this is where every booking,
route, and timeslot lives.

```bash
npx wrangler d1 create wogo-bookings
```

This prints a block that includes a line like:

```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy that `database_id` value and paste it into `backend/wrangler.toml`,
replacing the placeholder on this line:

```toml
database_id = "REPLACE_AFTER_RUNNING_wrangler_d1_create"
```

Now load the table structure (migration 1), the 6 real WOGO routes
(migration 2), and every schema update since (migrations 3–9 — per‑timeslot
capacity, the Customers/manual‑booking columns, the security tables covered
in step 9a below, and the production‑hardening tables covered in §12 below)
into that database, **in this exact order**:

```bash
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0002_seed_routes.sql
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0003_slot_capacity.sql
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0004_customers_manual_discount.sql
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0005_security.sql
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0006_error_log.sql
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0007_admin_audit.sql
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0008_failed_email.sql
npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0009_webhook_processing_status.sql
```

(If you're re-running this against a database that already has 0001–0005
loaded from an earlier deploy, you only need the last four commands.)

Each command should end by saying it ran successfully. If you ever want to
double‑check what's in there:

```bash
npx wrangler d1 execute wogo-bookings --remote --command "SELECT id, name, price_cents FROM routes;"
```

You should see all 6 routes (Amsterdam, Utrecht, Groningen, and the 3
Rotterdam routes) with placeholder‑ish prices — that's expected, migration
2's comment explains a few fields (bar names/emails, map links) are
deliberately seeded as placeholders because they're not public. You'll fill
in the real ones from the Admin dashboard's **Route manager** once it's
live (step 6 has a note on exactly which ones to fill in before your test).

## 4. Set your secrets

"Secrets" are the passwords/keys the Worker needs but that must never sit
in a file in your repo. Each command below will *prompt* you to paste a
value — type or paste it, press Enter, done. Nothing you paste is echoed
back or stored anywhere except Cloudflare's encrypted secret store.

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```
→ paste your Stripe **secret key** (Stripe Dashboard → Developers → API
keys). Use the **test mode** one (starts `sk_test_...`) until you're ready
to go live with real money — then repeat this command with the live one
(starts `sk_live_...`).

```bash
npx wrangler secret put BREVO_API_KEY
```
→ paste your Brevo API key (Brevo → Settings → SMTP & API → API Keys).

```bash
npx wrangler secret put ADMIN_TOKEN
```
→ make up a strong password — this is what YOU type to log into `/admin`.
Save it in your password manager now; there's no "forgot password" flow.

```bash
npx wrangler secret put ADMIN_SESSION_SECRET
```
→ this one you never type again — it just needs to be long and random, to
sign the login cookie. Generate one and copy it straight in:
```bash
openssl rand -base64 32
```
(run that, copy the output, then paste it when `wrangler secret put` asks.)

```bash
npx wrangler secret put CRON_SECRET
```
→ optional but recommended (costs nothing to set). Only matters if this
ever moves off Cloudflare (see `PORTABILITY.md`) — generate one the same
way as above (`openssl rand -base64 32`).

**Skip this one for now — it's a documented TODO, not a blocker:**
`META_ACCESS_TOKEN` (Meta Conversions API token). Until you set it, the
Worker just logs "skipping CAPI Purchase event" and moves on — bookings
still work perfectly. Come back to this later if/when you want server-side
Meta purchase tracking; ask and we'll wire it up together.

**`STRIPE_WEBHOOK_SECRET` — skip for now too.** You can't get this value
until Stripe knows your Worker's URL, which you don't have until after step
6 (Deploy). Come back for it in step 7.

## 5. Brevo — the email sender (no templates to create!)

All email designs live in the engine's own code (`src/emails.js`) — the
engine hands Brevo each finished email at send time. You never build
anything in Brevo's template editor. Brevo setup is just three things:

1. **Create a free account** at brevo.com (use info@wogoamsterdam.com).
2. **Authenticate the sending domain** — Brevo → Settings → Senders &
   Domains → Domains → add `wogoamsterdam.com`. Brevo shows three DNS
   records (SPF, DKIM, DMARC — the "passport stamps" that keep the emails
   out of spam). Add them in the domain's DNS (Cloudflare, once the DNS
   lives there — takes ~2 minutes) and click Verify. Do this EARLY in the
   session; verification can take a little while to propagate.
3. **Copy the API key** — Brevo → Settings → SMTP & API → API Keys →
   Generate a new key. This goes into the Worker's secrets in step 4
   (`BREVO_API_KEY`). Never paste it anywhere else.

That's the whole Brevo side. To preview every email exactly as it will be
sent, open `backend/preview/emails.html` in a browser.

## 6. Deploy

```bash
npx wrangler deploy
```

This prints a URL that looks like:

```
https://wogo-booking-backend.<your-cloudflare-subdomain>.workers.dev
```

**Copy that URL — you need it for the next two steps.**

Before your real test, open `/admin` at that URL in your browser
(`https://.../admin`), log in with the `ADMIN_TOKEN` you set in step 4, go
to **Route manager**, and for the route you'll test with:
- fill in a **Map URL** (any real Google Maps link is fine — this is what
  makes the 2nd guest email send; it's silently skipped if left blank)
- set at least one **bar's name + email** to something real you can check
  (your own inbox is fine for a test) — the seeded bars are all
  placeholders ("Bar 1 (TBD...)") pointing at a shared inbox, so you won't
  see the arrival email land anywhere obvious until you do this

## 7. Point Stripe's webhook at your Worker

This is how Stripe tells your Worker "this guest actually paid."

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**
2. Endpoint URL: `https://<your-worker-url-from-step-6>/webhooks/stripe`
3. Select events to send: `checkout.session.completed` and
   `checkout.session.expired`
4. Save. Click into the new endpoint, find **Signing secret**, click
   "Reveal", copy the value (starts `whsec_...`)
5. Set it as the secret you skipped earlier:
   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```
   paste the `whsec_...` value. No redeploy needed — secrets apply
   instantly.

## 8. Turn the guest calendar on

Open `backend/widget/wogo-calendar.js` and find this line near the top:

```js
const WOGO_API = "";
```

Change it to your Worker URL from step 6:

```js
const WOGO_API = "https://wogo-booking-backend.<your-subdomain>.workers.dev";
```

That's the **only** file that controls whether the calendar is on or off —
it's already wired into `rotterdam/hidden-gems/index.html` (see that
page's "OPTIONAL: WOGO SELF-HOSTED GUEST CALENDAR" comment block for
exactly what was added and how to copy it onto the other 5 route pages).
The moment this one line has a real URL in it, the calendar activates on
every route page that has the block — no other file needs editing.

**The Book buttons re-aim themselves — don't edit them.** On any page
where the calendar is active, the widget automatically redirects every
existing booking button (the big "Book your walk" button in the booking
section, the sticky bar at the bottom on mobile, and the "Book your walk"
button in the top menu) so that tapping it glides the guest down to the
new calendar on the same page instead of leaving for the old Wix
calendar. Gift-card and group links are never touched. And because the
buttons themselves are never edited in the page files, rollback is still
one line: set `WOGO_API = ""` again and every button points back at Wix
exactly as before.

Commit and push this change (and everything else in `backend/`) the normal
way, then let GitHub Pages finish deploying, same as any other site change.

## 9. Confirm the cron trigger is running

Every 5 minutes, a scheduled job releases any payment holds that timed out
(someone started checking out and never finished — their seats go back to
"available" after 15 minutes). This is already declared in
`wrangler.toml` and switches on automatically the moment you deploy — to
double‑check it's really there:

Cloudflare dashboard → **Workers & Pages** → `wogo-booking-backend` →
**Triggers** tab → you should see a **Cron Trigger** listed as
`*/5 * * * *`. If it's there, you're done — nothing else to click.
(As of the 2026‑07 security update, this same 5‑minute job also cleans up
two new small housekeeping tables — nothing you need to do, it's automatic.)

## 9a. Add the free Cloudflare WAF rate-limiting rule (recommended, one rule, costs nothing)

The Worker already protects itself in code against two kinds of abuse: someone
scripting endless fake bookings to lock up all the seats without paying, and
someone guessing your admin password over and over. Those protections work on
their own — this step just adds a second, outer layer at Cloudflare's edge, so
abusive traffic gets turned away *before* it even reaches your Worker (which
also saves you Worker request-count budget, though you're nowhere near the
free-tier ceiling at your volume).

This uses Cloudflare's free tier, which includes **one** rate-limiting rule at
no cost — exactly one is all you need here.

1. Cloudflare dashboard → pick your domain (the same zone `CLOUDFLARE-SETUP.md`
   already pointed at GitHub Pages) → **Security** → **WAF** → **Rate limiting
   rules** → **Create rule**.
2. Name it something like `booking-api-rate-limit`.
3. **If your Worker is on a subdomain of this same zone** (e.g. you did the
   optional custom-domain step and it's `api.wogococktailwalk.com`):
   - **Field:** URI Path, **Operator:** contains, **Value:** `/api/book`
   - **Rate:** 10 requests per 1 minute, per IP address
   - **Action:** Block, **Duration:** 1 minute (or longer if you want it
     stricter — this is just the outer net, the code-level protection in step
     3's migration is the real guarantee)
4. **If you're still on the free `*.workers.dev` URL** (no custom domain), the
   WAF rule can't target it directly — Cloudflare's WAF only applies to zones
   you manage. In that case this step is a "come back to it" once you add the
   custom domain (§ Deploy, "Optional custom domain") — not a blocker to
   deploying and using the booking system today. The code-level protection in
   step 3's migration (`migrations/0005_security.sql`) is already active and
   sufficient on its own.
5. Deploy the rule. Nothing else to configure — it runs automatically from
   here on, no code, no redeploy.

**What this does NOT replace:** the per-email/per-IP hold limits and the
admin-login lockout are already enforced by the Worker itself (D1-backed, so
they work correctly even across Cloudflare's many parallel servers) — this
WAF rule is a belt-and-suspenders extra, not a requirement for the booking
system to be safe.

## 10. Run ONE real test booking, start to finish

Use Stripe's **test card**: `4242 4242 4242 4242`, any future expiry, any
3‑digit CVC, any postcode. (For iDEAL: pick any of the fake test banks
Stripe's checkout page offers — it auto‑completes as "paid" in test mode,
no real bank involved.)

A quick note on *where* to click "Book" for this test — `preview/guest.html`
always uses fake pretend data (that's the point of it, see step 0), it can't
be pointed at your real Worker. Use the real route page instead, either:
- the live site, once step 8's edit is pushed and GitHub Pages has
  redeployed (a minute or two after pushing), or
- a local server for a faster loop, from the repo root (`~/Projects/wogo-homepage`):
  ```bash
  python3 -m http.server 8000
  ```
  then open `http://localhost:8000/rotterdam/hidden-gems/` — `localhost` is
  already on the Worker's allowed-origins list (`src/config.js`), so this
  works without any extra setup. (Opening the HTML file directly by
  double-clicking it, i.e. a `file://` address, will NOT work here — the
  Worker's CORS check rejects that origin on purpose, as a security
  measure. Use one of the two options above instead.)

Checklist — tick each one as it happens:

- [ ] **Hold appears in D1.** On the route page, pick a day → time → party
      size → fill your name/email → click Book. Before you finish paying,
      check:
      ```bash
      npx wrangler d1 execute wogo-bookings --remote --command "SELECT id, status, route_id, date, slot, party, hold_expires FROM bookings ORDER BY created_at DESC LIMIT 1;"
      ```
      You should see one row, `status = hold`, with a `hold_expires` a few
      minutes in the future.
- [ ] **Pay with the test card (or iDEAL) on the Stripe page** you get
      redirected to.
- [ ] **Webhook confirms.** Re-run the same D1 query above — `status`
      should now say `confirmed` and `stripe_session` should be filled in.
      (If it's still `hold` after a minute, see Troubleshooting below.)
- [ ] **3 emails arrive**: the guest confirmation (to the email you typed),
      the route‑map email (same inbox — only if you set a Map URL in step
      6), and the bar arrival email (to whichever address you set as the
      test bar's email in step 6).
- [ ] **Admin shows the booking.** Log into `/admin`, the new booking
      should be in the list, filterable by route, and show up as a bar in
      the participants‑per‑hour view for that date.

**One known gap, flagged so it doesn't confuse you mid‑test:** after
paying, Stripe redirects the guest to
`https://www.wogococktailwalk.com/booking-confirmed/?session_id=...` — that
thank‑you page doesn't exist on the site yet, so you'll see a 404 at the
very last step even though the booking itself worked correctly (the D1 row
and all 3 emails don't depend on that page existing). Say the word and
we'll build a simple thank‑you page next — it's a five-minute page, just
outside what this deploy guide covers.

**Troubleshooting a stuck `hold`:**
- Check the webhook actually reached Stripe → **Developers → Webhooks** →
  click your endpoint → recent deliveries. A red/failed delivery there
  means the URL or signing secret is wrong — recheck step 7.
- Cloudflare dashboard → your Worker → **Logs** (turn on "Begin log
  stream") shows any error the Worker hit while handling the webhook.

## 11. Rollback — if something goes wrong

Three levels, cheapest first:

1. **Turn the calendar back off, instantly:** set
   `WOGO_API = ""` in `backend/widget/wogo-calendar.js` and push. Every
   route page falls straight back to its Wix "Book now" button — nothing
   else changes, no data is lost, guests never notice anything happened.
2. **Roll back the Worker code** to the previous deploy, without touching
   any booking data (D1 is separate from the Worker code and is never
   affected by this):
   ```bash
   npx wrangler deployments list
   npx wrangler rollback <deployment-id-from-the-list-above>
   ```
3. **Full teardown** (only if truly abandoning this for good — this is
   the one irreversible step in this whole guide):
   ```bash
   npx wrangler d1 delete wogo-bookings
   ```
   Don't run this unless you mean it.

---

## 12. Production hardening (2026-07) — what's new, and what you need to do

Everything below shipped in the codebase already and deploys with your next
`wrangler deploy` — it does **not** change anything about how the booking
system behaves today. Every new feature is either fully automatic (crons,
error logging, the audit trail) or **off until you flip it on** (Turnstile,
the R2 backup). Nothing here costs money.

**New migrations** — load these once (see §3 above for the exact commands):
`0006_error_log.sql`, `0007_admin_audit.sql`, `0008_failed_email.sql`,
`0009_webhook_processing_status.sql`.

**New optional secrets** (only set these when you get to the matching
section below — leaving them unset is safe, everything stays inert):
`TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` (§13).

**New cron schedule** — `wrangler.toml` now declares two triggers instead
of one: the existing 5-minute sweep, plus a new once-a-day one at 03:00 UTC
for backups/retention/log-pruning. Nothing to do — it's in the file already
and switches on the moment you deploy. Re-check it the same way as step 9:
Cloudflare dashboard → your Worker → **Triggers** → you should now see
**two** Cron Triggers listed.

### What each piece does

- **Crash alerts (automatic).** Any unexpected error anywhere in the Worker
  now gets logged to a new `error_log` table AND emails you (throttled to
  at most one email per 30 minutes, so a crash loop can't flood your inbox).
  See it any time: `GET /admin/api/error-log` (with your admin session —
  easiest via the browser once you're logged into `/admin`, or `curl` with
  your session cookie).
- **Admin action audit trail (automatic).** Every change made from `/admin`
  (editing a route, adding/removing a bar, closing a date, editing a
  customer, a manual phone booking, resending a confirmation, exporting the
  CSV) now gets logged: who (IP address), what, and when. See it at
  `GET /admin/api/audit-log`.
- **Failed-email retry (automatic).** If Brevo is briefly down when a
  booking confirmation/owner-notification/bar-notification email tries to
  send, it's no longer just dropped — it's queued and retried automatically
  (5 attempts over 5min → 15min → 1h → 4h → 12h), and you get one email if
  it truly never goes through after all 5 tries. See the queue at
  `GET /admin/api/failed-emails`.
- **Health check (automatic).** Every 5 minutes the Worker checks itself
  (database reachable, every required secret still set) and emails you if
  something's wrong — this catches "oops, a secret got deleted" style
  problems long before a guest would hit them. On-demand check any time:
  `GET /admin/api/health`.
- **Webhook reliability fix.** Fixed a subtle ordering bug where a Stripe
  webhook that failed partway through writing a confirmed booking to the
  database could get marked "already handled" — meaning Stripe's automatic
  retry would silently skip it, and the guest would have paid without ever
  getting confirmed. Now a failed write is correctly retried on Stripe's
  next delivery attempt.
- **Security headers (automatic).** Every response now carries
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, `Strict-Transport-Security`, and a
  `Content-Security-Policy` — standard browser-side hardening against
  clickjacking/MIME-sniffing/etc. Nothing for you to configure.
- **GDPR retention (automatic).** A new daily job anonymizes the
  name/email/phone on bookings older than 24 months (only ones that are
  fully finished — confirmed, cancelled, or expired; never an active hold).
  The booking record itself stays for your reporting/history, just with the
  personal details scrubbed. 24 months is a sensible default; say the word
  if you want it shorter or longer (`GDPR_RETENTION_MONTHS` in
  `src/config.js`).

## 13. Turnstile — bot protection for admin login (optional, free)

Cloudflare Turnstile is a free, invisible alternative to those annoying
"click all the traffic lights" CAPTCHAs — it protects your `/admin` login
page from automated password-guessing bots. **This is entirely optional and
off by default** — the login page works exactly as it does today until you
set it up.

1. Cloudflare dashboard → **Turnstile** → **Add site**. Give it any name,
   add your domain (or leave it open for now if you're not sure yet).
   Choose the **Managed** widget mode (it's usually invisible to real
   people).
2. Cloudflare shows you two keys — a **Site Key** (public, safe to expose)
   and a **Secret Key** (keep private). Set them:
   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```
   → paste the Secret Key.
   
   The Site Key is NOT a secret (Cloudflare shows it in your page's HTML on
   every Turnstile-protected site) — it goes in `wrangler.toml` as a plain
   var instead of a Worker Secret:
   ```toml
   [vars]
   TURNSTILE_SITE_KEY = "0x4AAAAAAA..."
   ```
3. Redeploy (`npx wrangler deploy`). That's it — the moment
   `TURNSTILE_SECRET_KEY` exists, login attempts without a valid Turnstile
   token get rejected automatically; before that, it's a complete no-op.

**One more piece, on the admin dashboard side:** the login page needs a
small addition (a Turnstile widget + sending its token along with the
login request) to actually show the challenge to a human. That's a
dashboard UI change, not a backend one — flag it and we'll wire up
`src/admin/admin.html`/`admin.js` together once you're ready to turn this
on; the backend side above is already fully ready and waiting for it.

## 14. Monitoring & health checks

Two layers, both free:

1. **Built-in (automatic, already covered in §12 above).** The Worker
   checks itself every 5 minutes and emails you if something's actually
   broken (database unreachable, a required secret went missing). This
   can't catch "the whole domain is unreachable from the outside" — a
   Worker can't observe its own DNS/network failures, only external
   monitoring can.
2. **External uptime — UptimeRobot (free, ~5 minutes to set up).**
   1. Create a free account at uptimerobot.com.
   2. Add a monitor: type "HTTP(s)", URL = your Worker's `/api/routes`
      endpoint (e.g. `https://wogo-booking-backend.<your-subdomain>.workers.dev/api/routes`),
      check interval = 5 minutes.
   3. Add a second monitor the same way for `/admin/login` — this catches
      "the API works but the admin dashboard is down" separately.
   4. Set the alert contact to your email (or add Telegram/SMS — your
      free-tier choice).

Optional: once your Worker has a real public URL and you want the
built-in health check to ALSO self-test those two endpoints (not just its
own database/secrets), set `HEALTH_CHECK_BASE_URL` in `wrangler.toml`'s
`[vars]` block to that base URL and redeploy — see the commented example
already sitting in the file.

## 15. Backups & disaster recovery

Two layers — see [`DR.md`](./DR.md) for the full step-by-step recovery
playbook (what to do, in order, for every "something is badly wrong"
scenario). The short version:

1. **D1 Time Travel (automatic, already on — no setup).** Cloudflare's D1
   keeps a rolling ~30-day point-in-time history of your ENTIRE database
   automatically, no configuration needed. If you (or a bug) deletes or
   corrupts something, you can restore the whole database to any minute in
   the last 30 days:
   ```bash
   # See available restore points:
   npx wrangler d1 time-travel info wogo-bookings --remote
   # Restore to a specific point (get the timestamp from the command above):
   npx wrangler d1 time-travel restore wogo-bookings --remote --timestamp="2026-07-30T12:00:00Z"
   ```
   This is genuinely a full restore — test it on a quiet day so you know
   the command works before you ever need it under pressure.
2. **Daily offsite export to R2 (optional, free, off until you set it up).**
   Beyond Time Travel's 30-day window, a daily job can also copy your core
   business tables (routes, bars, date overrides, bookings) to Cloudflare
   R2 as a plain JSON file — useful for "I need last quarter's numbers back"
   or extra peace of mind beyond Time Travel. R2's free tier is 10GB, which
   at WOGO's volume is effectively unlimited. To turn it on:
   ```bash
   npx wrangler r2 bucket create wogo-backups
   ```
   then uncomment the `[[r2_buckets]]` block already sitting (commented) in
   `wrangler.toml`, and redeploy. Until you do both of those, this is a
   harmless no-op — nothing breaks, nothing is exported. Once it's on, you
   can see what's in the bucket any time:
   ```bash
   npx wrangler r2 object get wogo-backups/daily/2026-07-30.json --file=./restore.json
   ```
   Snapshots older than 60 days are pruned automatically.

**Verifying foreign-key constraints are actually enforced in production**
(a one-time sanity check, not something you need to repeat): D1 documents
that it enforces `FOREIGN KEY` constraints by default (unlike plain SQLite,
which defaults that off) — this codebase's tables already declare the
constraint (`bookings.route_id`, `routes_bars.route_id`,
`date_overrides.route_id`, all referencing `routes.id`). To confirm it's
really active on your instance:
```bash
npx wrangler d1 execute wogo-bookings --remote --command "INSERT INTO bookings (id, route_id, date, slot, party, name, email, status) VALUES ('fk-test-delete-me', 'route-that-does-not-exist', '2099-01-01', '18:00', 1, 'FK Test', 'test@example.com', 'hold');"
```
You should get a `FOREIGN KEY constraint failed` error (not a silently
inserted row). Then nothing to clean up — the insert was rejected, not
saved. If it DOES insert successfully, tell us immediately — that would
mean a fix is needed before this is truly production-safe.

## 16. Where the security headers come from

Already covered above in §12 — mentioned again here because it's the kind
of thing worth knowing WHERE to look if a browser tool (like Mozilla
Observatory or securityheaders.com) ever flags something: the Worker's own
responses are hardened in `src/security_headers.js`; the static site's
(GitHub Pages / your future custom domain) equivalent headers are set via
Cloudflare Transform Rules, already documented in `CLOUDFLARE-SETUP.md`.

---

## Moving to another host later

Nothing here locks you into Cloudflare forever — see
[`PORTABILITY.md`](./PORTABILITY.md) for exactly which pieces are
Cloudflare-specific (just 3 small things) and what to swap them for.

## If you ever edit the admin dashboard's look

`admin.html` / `admin.css` / `admin.js` in `backend/src/admin/` are the
editable source files. After changing any of them, rebuild before
deploying (safe to run any time — it's a pure local file rewrite, no
network calls):

```bash
node src/admin/build.mjs
npx wrangler deploy
```
