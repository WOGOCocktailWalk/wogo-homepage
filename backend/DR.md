# Emergency guide — WOGO booking system

Plain-language runbook for "something is badly wrong". Read it once when
things are calm. Commands assume you are in the `backend/` folder with
`npm install` done once.

**How the live system fits together (since 16 Nov 2026)**

- The website (pages) is served from GitHub Pages. Pushing to `main` changes it.
- DNS is on **Cloudflare** (the name servers were moved from Wix). The
  domain is registered at Namecheap.
- Bookings, payments, emails and the dashboard run through one **Cloudflare
  Worker** (`wogo-booking-backend`) with its D1 database. Stripe takes the
  money, Brevo sends the emails.
- The **old Wix site is still connected for about 30 days** (until roughly
  16 Dec 2026). It is the only way back to the old system, and only while
  that Wix subscription is paid. There is no "Wix book now button" on the new
  pages any more, so there is no quick switch back to it.
- Alerts: the system pushes to your phone and emails you for crashes, failed
  payments, failed emails and failed health checks. A GitHub check from
  outside (`.github/workflows/uptime-check.yml`) emails you if the site or the
  backend cannot be reached.

## 0. First two minutes: what kind of problem is it?

| What you see | Go to |
|---|---|
| Guests cannot pay / the calendar shows an error | 0a, then section 2 |
| Guests paid but got no confirmation email | 0b |
| The whole site is down | section 5 |
| Wrong or missing data in the dashboard | section 1 |
| You are not sure | 0a first. It is always safe. |

### 0a. Stop NEW bookings, keep everything else running (safe, reversible)

1. Open the dashboard, go to **Routes**, open the route and switch it to
   **Hidden** (the "Live" checkbox). The calendar stops offering it.
2. Existing bookings are not touched. Switch it back to Live when fixed.
3. Tell guests who already tried: WhatsApp/Instagram message from the
   business account.

Do NOT set `WOGO_API = ""` in `backend/widget/wogo-calendar.js`. Older
instructions said this falls back to a Wix button. That button no longer
exists: it would leave an empty space where the calendar was.

### 0b. Paid but no confirmation

1. Stripe, **Developers, Webhooks**: open the endpoint and look at recent
   deliveries. Red ones mean the Worker rejected or failed them. A
   "signature" problem means the signing secret in the Worker differs from
   Stripe's: fix with `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
   (paste the "Signing secret" from that same Stripe page).
2. After fixing, use **Resend** on each failed delivery in Stripe. The
   system ignores events it already processed, so resending is safe.
3. The dashboard error log shows the rejected messages (starting 17 Nov 2026).
4. If you cannot fix it quickly, confirm each paid guest by hand: Stripe
   Payments shows who paid; add the booking in the dashboard and email them.

## 1. The database has wrong or missing data

**Target: under 15 minutes.** D1 keeps a rolling ~30-day history of the
whole database. Nothing to set up.

```bash
npx wrangler d1 time-travel info wogo-bookings
npx wrangler d1 time-travel restore wogo-bookings --timestamp="2026-11-20T12:00:00Z"
```

This
puts the entire database back to that moment, including any bookings made
after it, so pick the time carefully. Note the bookmark it prints: you can
undo a restore with the same command and that bookmark.

**More than 30 days back, or Cloudflare itself is the problem:** use the
nightly file in R2 (bucket `wogo-backups`, one file per day, kept 60 days,
written at 03:00 UTC).

```bash
# Download one day's file (the bucket's Objects page in the Cloudflare
# dashboard lists the dates; wrangler has no "list" command for R2 objects):
npx wrangler r2 object get wogo-backups/daily/2026-11-20.json --file=./backup.json --remote
```

The file has 17 tables: routes, bars, date overrides, bookings, extras, gift
cards and redemptions, subscribers and opt-outs, inquiries, admin users,
blog posts, settings, admin audit and payment-event ids. Deliberately NOT in
it: login tokens, phone-push registrations, rate-limit and login-attempt
logs, error log, notifications, retry queues (all rebuilt by the system).

**Practise the restore on your own Mac (safe, nothing online is touched):**

```bash
cd backend
node scripts/restore_backup.mjs ./backup.json --out ./restored.sqlite
```

It rebuilds a local database from the file, prints every table with
"expected / restored" counts and ends with `RESULT: PASS` or `RESULT: FAIL`.
Open `restored.sqlite` with any SQLite viewer to look at the data. Delete
`backup.json` and `restored.sqlite` afterwards: they contain guest data.
Backups written before 17 Nov 2026 hold only 4 tables; the script says so.

Putting a restored file back into the live D1 is a deliberate, careful step
(it replaces live data). Do not improvise it: ask for help, and use Time
Travel instead whenever the problem is less than 30 days old.

## 2. The Worker is broken (bad deploy, not a data problem)

**Target: under 5 minutes.** Rolling code back never touches booking data.

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id-from-the-list-above>
```

No terminal: Cloudflare dashboard, **Workers & Pages**, `wogo-booking-backend`,
**Deployments**, pick the last good one, **Rollback**.

## 2b. The website pages are broken (bad push)

```bash
git log --oneline -5          # find the bad commit
git revert <commit-id>
git push origin main
```

GitHub Pages republishes in about a minute. Browsers may show the old page
for up to 10 more minutes.

## 3. The Worker itself got deleted from Cloudflare

**Target: under 30 minutes** (mostly waiting on DNS/webhook propagation,
not typing commands).

The Worker's entire source lives in this Git repo — nothing is only stored
inside Cloudflare's dashboard.

```bash
cd backend
npx wrangler deploy
```

This recreates the Worker from scratch using `wrangler.toml` (which already
has the D1 `database_id`, so it reconnects to your EXISTING database —
nothing needs re-migrating unless D1 was *also* deleted, see below).

Then re-check the three things that point AT the Worker's URL, since a
fresh deploy can occasionally land on a slightly different `*.workers.dev`
subdomain (won't happen if you're on a custom domain — one more reason to
set one up, see `SETUP.md`'s "Optional custom domain" note):
1. **Stripe webhook** — Developers → Webhooks → confirm the endpoint URL
   still matches; update + note the (probably-unchanged) signing secret.
2. **`WOGO_API`** in `backend/widget/wogo-calendar.js` — confirm it still
   points at the right URL.
3. **The uptime check** (`.github/workflows/uptime-check.yml`) — update the backend URL in it.

## 3a. The D1 database ALSO got deleted (rare — this is the real worst case)

**Target: under 45 minutes.**

```bash
npx wrangler d1 create wogo-bookings
```
Copy the new `database_id` into `wrangler.toml`, then reload every
migration in order (every file in `backend/migrations/`, oldest first; see
`SETUP.md` §3 and §12 for the commands).

Then bring the data back from the newest nightly export. The rebuild script
in section 1 shows exactly what is in the file; loading it into the new D1 is
a few lines of SQL per table that you should rehearse beforehand, not invent
under stress. If you ever get here, stop and ask for help first.

---

## 4. Secrets are gone (e.g., a Worker got recreated and lost its Worker
Secrets — these are NOT part of `wrangler.toml` or the Git repo on purpose)

**Target: under 15 minutes**, assuming you still have the original values
saved in your password manager (you should — `SETUP.md` §4 says so at
setup time; if you don't, you'll need fresh ones from Stripe/Brevo, which
is also fine, just re-point the webhook/API key after).

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ADMIN_SESSION_SECRET
npx wrangler secret put CRON_SECRET
# Only if you turned Turnstile on (SETUP.md §13):
npx wrangler secret put TURNSTILE_SECRET_KEY
```
Each one prompts you to paste the value — see `SETUP.md` §4 for where each
one comes from. Confirm the full set with:
```bash
npx wrangler secret list
```
(shows names only, never values — that's by design, nothing to worry about
if the list looks right).

---

## 5. The whole site is unreachable (or you must go back to Wix)

First find out which part is down. Open, in this order:
1. `https://wogo-booking-backend.purple-glitter-720e.workers.dev/api/routes`
   shows data: the backend is fine. If not, see section 2 and 3.
2. githubstatus.com and cloudflarestatus.com: any incident listed? Then wait
   and watch. Also check the repo's Settings, Pages: it should say the site is
   live at the custom domain.
3. Cloudflare dashboard, the domain, **DNS**: the records for `www` and the
   apex must still exist and point where they did (see `CLOUDFLARE-SETUP.md`).

**Going back to the old Wix site is the last resort**, because bookings,
gift cards and emails made on the new system since launch do NOT exist in
Wix. Only do it if the new system cannot be fixed within a few hours, and
only before the Wix subscription ends (about 16 Dec 2026). Steps:

1. Dashboard: export the bookings made since 16 Nov (so you can honour them
   by hand and block the seats in Wix).
2. Wix dashboard, **Domains**, the domain's connection instructions: copy
   the A and CNAME records Wix asks for. Because the name servers now live
   at Cloudflare, you do not move them back: you re-create those records in
   Cloudflare.
3. Cloudflare, **DNS**: change the `www` and apex records to Wix's values and
   set each to **DNS only** (grey cloud, not orange). Also turn off any
   redirect rules sending old Wix addresses to new pages.
4. Wait for Wix to show the domain as connected (a few minutes up to an hour)
   and check the site from your phone on mobile data.
5. Stripe keeps sending its messages to the Worker, which keeps working, so
   payments already made are still recorded. Hide the routes (0a) first so
   nobody can pay on the new system while the old site is live.

**Do today, while Wix still works:** write the exact record values from
step 2 into your password manager (NOT into this public repository). Right
now they are not stored anywhere in the project, so a rollback would start
with an hour of searching.

## 6. The whole GitHub repo is gone

**Target: under 10 minutes**, IF you (or a collaborator) has a local clone
— which you do, since you're reading this file from one.

```bash
# From your local clone:
git remote -v   # confirms the current remote — currently
                # https://github.com/WOGOCocktailWalk/wogo-homepage.git
```
Create a brand-new empty repo on GitHub (or any other Git host), then:
```bash
git remote set-url origin <new-repo-url>
git push -u origin main
```
Nothing about the Worker or D1 needs to change — they don't know or care
where the code's Git history lives; the repo is only ever the SOURCE for
`wrangler deploy`, not something the running system depends on live.

**If NO local clone exists anywhere** (the true worst case — everyone's
laptop is gone too): the Worker keeps running exactly as deployed (Workers
don't need Git to function day-to-day), so there's no service outage — but
you've lost version history and any uncommitted-and-unpushed work. Rebuild
from the live Worker's deployed source (`npx wrangler` can't pull deployed
source back down, so this genuinely means recreating files by hand from
`SETUP.md`/`SPEC.md`'s documentation) — this is the one scenario worth
actively preventing rather than recovering from: keep at least one other
machine with a clone, or add a second GitHub collaborator with their own
clone.

---

## Quick reference — what's backed up where

| What | Where | Retention | Automatic? |
|---|---|---|---|
| All data | D1 Time Travel | ~30 days, any minute | Yes, always on |
| All business tables (17, see `src/backup.js`) | R2 nightly export `daily/YYYY-MM-DD.json` | 60 days | Yes, 03:00 UTC |
| Worker code | This Git repo + GitHub | Forever (Git history) | Yes, as long as you `git push` |
| Secrets (API keys, admin token) | Cloudflare's encrypted secret store + your password manager | Forever, but ONLY where you saved them | No — you must save them yourself at setup time |
| Error history | `error_log` D1 table | 90 days | Yes |
| Admin action history | `admin_audit` D1 table | ~13 months | Yes |
