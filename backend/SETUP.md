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
it's already wired into `rotterdam/route-2/index.html` (see that
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
  then open `http://localhost:8000/rotterdam/route-2/` — `localhost` is
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

## 17. Contact + group booking form — `POST /api/contact` (2026-09-28)

New backend for the site's **Contact** form and **Group booking request**
form (`migrations/0021_inquiries.sql`, `src/guest_api.js:handleContact`).
This is a lead inbox — it does NOT create a booking hold and doesn't touch
routes/bookings at all, so the frontend can wire it up independently of the
booking widget. Whoever builds the actual `<form>` HTML (the frontend
agent, or Maroussia by hand) needs this contract:

**Endpoint:** `POST https://<your-worker>.workers.dev/api/contact`
(same base URL the booking widget already uses — `WOGO_API` in
`widget/wogo-calendar.js`). CORS is the same allowlist as every other guest
endpoint (`isAllowedOrigin`, `src/config.js`).

**Request body** (JSON):

```json
{
  "kind": "contact",           // or "group" — REQUIRED, exactly one of these two strings
  "name": "Anna Guest",        // REQUIRED
  "email": "anna@example.com", // REQUIRED, valid email
  "phone": "+31 6 12345678",   // optional
  "city": "Utrecht",           // optional — meaningful for kind:"group" only
  "date": "mid November",      // optional, FREE TEXT (not a strict date — a group
                                // request doesn't always have a fixed date yet)
  "party_size": 18,            // optional, positive integer — kind:"group" only
  "message": "We'd like a private walk for a work outing.", // REQUIRED
  "locale": "en",              // "en" or "nl" — decides which language the guest's
                                // auto-reply is sent in; defaults to "en" if omitted
  "website": ""                // HONEYPOT — a real visitor never sees this field.
                                // Hide it with CSS (NOT type="hidden", a bot can see
                                // that) e.g. absolutely positioned off-screen. MUST be
                                // submitted empty by real users.
}
```

Use `kind:"contact"` for the plain contact form (city/date/party_size
omitted or ignored) and `kind:"group"` for the group-booking-request form.

**Success response** — `200 {"ok": true, "id": "inq_..."}`. The guest then
gets an automatic email acknowledgement ("we got your message, we reply
within 1 working day") in their own language; the owner gets a notification
at info@wogoamsterdam.com with reply-to set to the guest, so replying in the
inbox goes straight back to them.

**Error responses** — same shape as the rest of the guest API
(`{"error": "<code>", "message": "<human text>"}`):
- `400 bad_request` — a required field is missing/invalid (check
  `message` for which one).
- `403 forbidden` — request Origin isn't on the allowlist (shouldn't happen
  from the real site; only matters if testing from an unlisted domain).
- `429 rate_limited` — too many submissions from this visitor's IP in a
  10-minute window; body includes `retry_after_seconds`, and the response
  also carries a standard `Retry-After` header — show the guest a "please
  wait a moment and try again" message, ideally using that number.

**A filled honeypot is NOT an error** — it still gets `200 {"ok": true}` (so
a bot has no signal to react to) but nothing is actually stored or emailed.
Don't treat a 200 as proof the message reached anyone if you're debugging a
suspiciously-quiet form — check `GET /admin/api/inquiries` (admin session
required) to see what's actually landed.

**No admin UI for this yet** — `GET /admin/api/inquiries` lists everything
newest-first, but there's no dashboard tab to mark one read/replied/closed.
Today the owner works from the notification emails; a dashboard tab is a
natural follow-up whenever the admin UI gets touched next.

### Side note for the frontend: same-day slots can now show as "Sold out" near/after their start time

Unrelated to the contact form, but worth knowing if you're touching the
booking widget around the same time: as of 2026-09-28, `GET /api/slots` and
`GET /api/availability` report `seats_left: 0` for any TODAY slot that's
already started, or starts within `SAME_DAY_CUTOFF_MINUTES` (60 minutes,
`src/config.js`) — reusing the widget's existing "Sold out" / disabled
rendering (`soldout = s.seats_left <= 0` in `wogo-calendar.js`), so no
widget code changed for this. It's a correct fix (a guest could otherwise
"book" a walk that already started), but the label reads as "Sold out"
which isn't quite accurate for a slot that's simply too late in the day.
Backend-only fix for now; if you want a friendlier "Past" label instead of
"Sold out" for same-day slots, that's a small widget-side follow-up (compare
the slot's clock time to "now" client-side) — not required, just noted.

---

## 18. Newsletter subscribers — the site form's contract (2026-10)

New backend for the site's **newsletter signup** (site footer) and the
thank-you/confirmation page it needs. This is the frontend agent's (or your
own) contract for wiring up the `<form>` and the `/subscribed/` page.

### 18.1 One-time setup, before the form goes live

0. **Load migration 0024** (if you haven't already loaded every migration up
   through 0023 — see step 3 above — load those first, in order, then this
   one):
   ```bash
   npx wrangler d1 execute wogo-bookings --remote --file=./migrations/0024_subscribers.sql
   ```
1. **Set `BREVO_API_KEY`** — already covered in step 4 above; nothing new here.
2. **Run the Brevo setup once** (creates the folder/list/attributes in Brevo —
   nothing to click together in Brevo's own dashboard):
   ```bash
   curl -X POST https://<your-worker>.workers.dev/admin/api/brevo/setup \
     -H "Cookie: <your admin session cookie — log into /admin in a browser and copy it>" \
     -H "X-Requested-With: wogo-admin"
   ```
   Safe to re-run any time — it finds what already exists and only creates
   what's missing. Easiest in practice: once the dashboard's **Subscribers**
   tab is live, just click its **"Sync Brevo setup"** button instead of
   using curl.
3. **Create the WELCOME10 code in Stripe**:
   ```bash
   curl -X POST https://<your-worker>.workers.dev/admin/api/stripe/ensure-welcome-code \
     -H "Cookie: <your admin session cookie>" \
     -H "X-Requested-With: wogo-admin"
   ```
   This makes `WELCOME10` a real, usable Stripe promotion code (10% off,
   approximately "once per customer" — see the honest caveat in `SPEC.md`
   §17.8: Stripe's closest restriction is "first payment ever on this
   Stripe Customer," not "once per customer even on a later purchase"). The
   booking checkout already has `allow_promotion_codes: true` turned on, so
   the moment this code exists, guests can type it in at checkout — no
   further wiring needed on the booking side.
4. **Build the `/subscribed/` thank-you page** (site repo, not this backend)
   — see §18.4 below for exactly which states it needs to handle.

### 18.2 `POST /api/subscribe` — the signup form itself

**Endpoint:** `POST https://<your-worker>.workers.dev/api/subscribe` (same
base URL as every other guest endpoint — `WOGO_API` in
`widget/wogo-calendar.js`). CORS is the same allowlist as the booking widget.

**Request body** (JSON):
```json
{
  "email": "anna@example.com",   // REQUIRED, valid email
  "first_name": "Anna",          // optional
  "locale": "en",                // "en" or "nl" — which language the
                                  // confirmation + welcome emails render in
  "city": "Amsterdam",           // optional — which city's updates they care about
  "source": "site_footer",       // REQUIRED, exactly this string for the footer form
  "website": ""                  // HONEYPOT — same rule as the contact form:
                                  // hide with CSS (not type="hidden"), real
                                  // visitors always submit it empty
}
```

**Success response** — always `200 {"ok": true}`, or `200 {"ok": true,
"already": true}` if this email was already a confirmed subscriber (no
email is sent in that case — don't treat `already:true` as an error, it's a
normal outcome). The guest then gets a confirmation email ("Confirm your
subscription" / "Bevestig je inschrijving") with one button — nothing is
added to the mailing list, and no welcome code is sent, until they click it.

**Error responses** — same shape as every other guest endpoint
(`{"error": "<code>", "message": "<human text>"}`):
- `400 bad_request` — a required field is missing/invalid.
- `403 forbidden` — Origin not on the allowlist.
- `429 rate_limited` — too many signups from this IP in a 10-minute window;
  body includes `retry_after_seconds`, response carries `Retry-After`.

A filled honeypot still gets `200 {"ok": true}` but nothing is stored or
emailed — same "don't give the bot a signal" reasoning as the contact form.

### 18.3 The confirmation link and unsubscribe link

Both are plain `GET` links the guest clicks straight out of an email — the
frontend never calls these as `fetch()`, and never needs to build the URLs
itself (they're embedded ready-made in the emails):

- `GET /api/subscribe/confirm?token=…` — always redirects (`302`) to
  `https://www.wogococktailwalk.com/subscribed/?lang=en` (or `nl`) on
  success, or `…/subscribed/?state=invalid` for an unknown, already-used-by-
  someone-else, expired (48 hours), or previously-unsubscribed token.
- `GET /api/unsubscribe?token=…` — only ever appears in the footer of the
  WELCOME email (never in a transactional booking email) — redirects to
  `…/subscribed/?state=unsubscribed` on success (or an already-unsubscribed
  click — that's still a normal, not-an-error outcome) or `?state=invalid`
  for an unknown token.

### 18.4 The `/subscribed/` page — states it must handle

One static page, driven entirely by its own URL's query string (no API call
needed from the page itself):

| URL | Meaning | What to show |
|---|---|---|
| `/subscribed/?lang=en` or `?lang=nl` | Just confirmed (first time) | The "you're in!" state. **This is the ONLY place the 10% welcome code is shown on the site** — but the code is also emailed (see below), so the page doesn't strictly have to display it if that's simpler; showing it is a nice-to-have, not a requirement, since the WELCOME email always carries `WELCOME10` regardless. |
| `/subscribed/?state=invalid` | Bad/expired/already-unsubscribed link | A gentle "this link didn't work — try subscribing again" message + the signup form (or a link back to it). |
| `/subscribed/?state=unsubscribed` | Successfully unsubscribed | A simple "you're unsubscribed, sorry to see you go" confirmation. |

**Do not send the welcome code to anyone who lands on this page without a
valid `lang=` param** — the code is only ever genuinely earned via a real
confirm click or a booking's own opt-in checkbox, both of which land here
with the right state.

### 18.5 Booking widget — no change needed

The booking widget already sends `marketing_opt_in` on every `POST
/api/book` call (its existing checkbox) — this now ALSO subscribes the
guest directly (no confirmation email needed; the booking itself is the
consent) and sends them the exact same welcome code, first time only. No
widget change required for this to work.

### 18.6 Importing the old Wix newsletter list (one-time)

1. **Export from Wix**: Wix's Contacts app → Export → CSV (do this *before*
   cancelling Wix — see the urgent note in `BACKEND-PLAN.md`).
2. **Convert to the JSON shape this endpoint wants** — a local script (ask
   your main Claude session to write a quick one-off converter) turning
   Wix's CSV columns into:
   ```json
   [
     {"email": "anna@example.com", "first_name": "Anna", "locale": "nl", "city": "Amsterdam"},
     {"email": "bram@example.com"}
   ]
   ```
3. **Import** (max 2000 rows per call — split a bigger export into chunks):
   ```bash
   curl -X POST https://<your-worker>.workers.dev/admin/api/subscribers/import \
     -H "Content-Type: application/json" \
     -H "Cookie: <your admin session cookie>" \
     -H "X-Requested-With: wogo-admin" \
     -d @converted-subscribers.json
   ```
   Every imported row lands straight as **confirmed** (it's historical,
   already-consented data — no confirmation email is sent) and is synced
   into Brevo's list automatically.

---

## 19. Team logins — inviting Selin (or anyone else) (2026-10)

You don't need to share your `ADMIN_TOKEN` with anyone anymore. Each
teammate gets their OWN login, tied to their own email, with a role that
controls what they can see and do.

**You're already set up to log in** — the migration seeded both of your
addresses (`info@wogoamsterdam.com` and `maroussiastyles@gmail.com`) as
`owner`. On the login page, use "Log in met e-mail" instead of the token box:
type your email, check your inbox for the link, click it, you're in. Your old
token still works too (useful as a backup if email is ever down).

**To invite Selin:**
1. Log in, go to the **Team** tab (only owners see it).
2. "+ Invite teammate" → her name, her email, and a role:
   - `viewer` — can only look (bookings, analytics). Good for "just checking numbers."
   - `staff` — day-to-day bookings work (manual bookings, reschedule/cancel,
     date overrides, gift cards, resending confirmations) but can't touch
     routes, Brevo/Stripe setup, or other people's logins.
   - `owner` — everything, including inviting/removing other people. Use
     sparingly.
3. Send. She gets an email with a login link — she clicks it, she's in. No
   password for her to remember or for you to hand over.

**To remove someone or change their role**: Team tab → change their role in
the dropdown, or hit "Disable." A disabled person is locked out on their
VERY NEXT click, not just next time they'd otherwise log in.

**One thing to double-check if invites don't seem to arrive**: if you ever
set the `EMAIL_TEST_REDIRECT` secret (used during pre-launch testing to
redirect every outgoing email to one test inbox), invites and login links go
there too, not to the real person. Check with:
```bash
npx wrangler secret list
```
If `EMAIL_TEST_REDIRECT` is listed and you're live, remove it:
```bash
npx wrangler secret delete EMAIL_TEST_REDIRECT
```

## 20. Analytics — connecting Google Analytics for the Traffic tab (optional, free)

The Analytics tab's **Sales** page works today with zero setup — it's your
own booking numbers. The **Traffic** page (sessions, visitors, top pages,
where people come from) needs a one-time connection to Google Analytics —
free, takes about 10 minutes, and only has to be done once.

1. **Create a Google Cloud project** (free) at console.cloud.google.com if
   you don't have one already.
2. **Create a service account**: APIs & Services → Credentials → Create
   Credentials → Service account. Give it any name (e.g. "wogo-ga4-reader").
3. **Create a JSON key** for it: on the service account's page → Keys → Add
   Key → Create new key → JSON. This downloads a `.json` file — keep it
   somewhere safe, you'll paste its CONTENTS in a moment.
4. **In Google Analytics**: Admin (gear icon, bottom left) → under the
   Property column → "Property access management" → the `+` button → add
   the service account's email (it's the `client_email` field inside the
   JSON file, looks like `wogo-ga4-reader@your-project.iam.gserviceaccount.com`)
   as a **Viewer**.
5. **Find your Property ID**: still in GA4 Admin → Property Settings → it's
   the numeric ID at the top (NOT the "G-XXXXXXX" measurement ID — a plain
   number like `123456789`).
6. **Paste both into your Worker**:
   ```bash
   npx wrangler secret put GA4_SERVICE_ACCOUNT_JSON
   ```
   → paste the ENTIRE contents of the downloaded `.json` file (open it in a
   text editor, select all, copy, paste here).
   ```bash
   npx wrangler secret put GA4_PROPERTY_ID
   ```
   → paste the numeric property ID from step 5.
7. Redeploy (`npx wrangler deploy`) and refresh the dashboard's Analytics →
   Traffic tab — it should now show real numbers instead of the "Connect
   Google Analytics" card.

Nothing breaks if you skip this — the Traffic tab just keeps showing the
connect-it card, and every other tab works exactly the same either way.

## 21. "How was your walk?" review emails (2026-10)

The day after someone's walk, they automatically get a short, friendly email
asking for a review (Trustpilot always; Google too, once you add your Google
review link — see below). Nothing to set up — it just starts working once
this is deployed.

**To turn on the Google review button**: open `src/config.js`, find
`REVIEW_GOOGLE_URL = ''`, and paste your Google review link between the
quotes (find it via Google Business Profile → "Ask for reviews" → copy
link). Redeploy. Until you do this, only the Trustpilot button shows — never
a broken or wrong Google link.

**To test it on one specific booking** (without waiting for tomorrow's
batch): open that booking in the dashboard and use "Send review request" in
its detail panel, or:
```bash
curl -X POST https://<your-worker>.workers.dev/admin/api/bookings/<booking-id>/send-review \
  -H "Cookie: <your admin session cookie>" \
  -H "X-Requested-With: wogo-admin"
```
It only works once per booking (sending it twice on purpose just tells you
it's already been sent).

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
