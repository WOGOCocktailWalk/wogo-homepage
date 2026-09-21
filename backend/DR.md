# Disaster recovery — WOGO booking backend

Plain-language runbook for "something is badly wrong." Four scenarios,
worst-case time to fully recover, and the exact commands. Read this once
when things are calm so the steps aren't unfamiliar the one day you need
them under pressure — and consider doing a dry run of §1 and §2 on a quiet
afternoon (D1 Time Travel restore and a Worker rollback are both safe to
practice for real).

Every command below assumes you're in the `backend/` folder with Wrangler
installed (`npm install` once, if you haven't already — see `SETUP.md` §2).

---

## 1. D1 database is corrupted, or someone deleted/changed data by mistake

**Target: under 15 minutes.**

Cloudflare D1 keeps an automatic rolling ~30-day point-in-time history of
the ENTIRE database — no setup, already on, already running.

```bash
# See what restore points are available:
npx wrangler d1 time-travel info wogo-bookings --remote

# Restore the whole database to a specific moment (UTC timestamp):
npx wrangler d1 time-travel restore wogo-bookings --remote --timestamp="2026-07-30T12:00:00Z"
```

That's the entire recovery — the database is back exactly as it was at that
timestamp. Nothing else needs to change (the Worker code doesn't care, it
just talks to whatever's in D1).

**If you need data from MORE than 30 days ago** (Time Travel's window), and
the daily R2 backup export is turned on (`SETUP.md` §15):

```bash
# List available daily snapshots:
npx wrangler r2 object list wogo-backups --prefix daily/

# Pull one down:
npx wrangler r2 object get wogo-backups/daily/2026-06-01.json --file=./restore.json
```

That file is plain JSON (`{ tables: { routes, routes_bars, date_overrides,
bookings } }`) — for anything beyond "look up an old booking by hand," this
needs a short script to re-`INSERT` rows back into D1; ask and we'll write
one when/if this ever comes up. In practice, Time Travel's 30-day window
covers the overwhelming majority of real "oops" scenarios — the R2 export
exists for extreme cases and long-term archival, not as the everyday
recovery path.

---

## 2. The Worker itself is broken (bad deploy, not a data problem)

**Target: under 5 minutes.**

D1 is completely separate from the Worker's code — rolling the code back
never touches or risks any booking data.

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id-from-the-list-above>
```

If you don't have Wrangler handy: Cloudflare dashboard → **Workers &
Pages** → `wogo-booking-backend` → **Deployments** tab → find the last
good one → **Rollback to this deployment**.

**If you just need to stop bookings entirely while you investigate** (the
cheapest, fastest "make it stop"):
`backend/widget/wogo-calendar.js`, set `WOGO_API = ""`, push to `main`.
Every route page falls straight back to the old Wix "Book now" button —
zero data loss, guests never see an error, and you can take your time
fixing the Worker before flipping it back on.

---

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
3. **UptimeRobot monitors** (`SETUP.md` §14) — same check.

## 3a. The D1 database ALSO got deleted (rare — this is the real worst case)

**Target: under 45 minutes.**

```bash
npx wrangler d1 create wogo-bookings
```
Copy the new `database_id` into `wrangler.toml`, then reload every
migration in order (see `SETUP.md` §3 and §12 for the exact list of
`wrangler d1 execute` commands — nine files total as of this writing).

If you have a recent R2 daily export (§1 above), that recovers the actual
booking rows; otherwise this is a clean-slate database (routes/bars need
re-entering via `/admin` or migration 0002's seed data) — this is exactly
why turning on the R2 export (`SETUP.md` §15) is worth the five minutes it
takes.

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

## 5. The whole GitHub repo is gone

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
| Booking/route/bar/override data | D1 Time Travel | ~30 days, any minute | Yes, always on |
| Same data, longer-term | R2 daily export | 60 days (configurable) | Only once you turn it on (`SETUP.md` §15) |
| Worker code | This Git repo + GitHub | Forever (Git history) | Yes, as long as you `git push` |
| Secrets (API keys, admin token) | Cloudflare's encrypted secret store + your password manager | Forever, but ONLY where you saved them | No — you must save them yourself at setup time |
| Error history | `error_log` D1 table | 90 days | Yes |
| Admin action history | `admin_audit` D1 table | ~13 months | Yes |
