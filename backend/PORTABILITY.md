# Portability — moving off Cloudflare later

This backend is deliberately built from three portable layers, so a future
move away from Cloudflare (if ever needed) touches only a small, named
surface — not a rewrite.

## What's portable as-is
- `src/logic.js` — pure JS, zero platform calls. Runs anywhere JS runs.
- `src/index.js`'s shape — `export default { fetch(request, env, ctx), scheduled(event, env, ctx) }`
  is the WinterCG/Web-standard handler signature also used by Deno Deploy,
  Vercel Edge Functions, Bun, and Val Town. The routing and handler logic in
  `guest_api.js`/`admin_api.js`/`webhook.js` uses only `Request`/`Response`/
  `URL`/`crypto.subtle`/`fetch` — all Web-standard, none Cloudflare-specific.
- `src/stripe.js`, `src/brevo.js`, `src/meta.js` — plain `fetch` calls to
  public REST APIs. Zero Cloudflare dependency.

## What's Cloudflare-specific, and the swap for each
| Cloudflare piece | Where it's used | Swap for another host |
|---|---|---|
| D1 binding (`env.DB`) | Only inside `src/db.js` | D1 is SQLite. `db.js`'s functions are written against the `prepare/bind/run/all/first` shape (same shape the test adapter in `test/sqlite-d1-adapter.js` already implements over `node:sqlite`). Point that exact adapter — or a managed SQLite host like Turso/libSQL, which speaks the same dialect — at `db.js` in production and nothing else changes. A Postgres move would need `db.js` rewritten (different placeholder syntax, no `json_extract` by that name) but the SQL *shape* (single-statement atomic guard clauses) carries over conceptually. |
| D1 parameter binding gotcha | `src/db.js: toPositional()` | **Learned in production (2026-07):** real D1 accepts ONLY positional params (`?`/`?N`) bound variadically — `.bind({ named: 'object' })` throws `D1_TYPE_ERROR`, even though `node:sqlite`, better-sqlite3, and libSQL all happily accept named-object binding. `db.js` therefore keeps named `:token` SQL for readability and translates to positional in one seam (`toPositional`, called only from its private `run`/`all`/`first` helpers); the test adapter enforces the same positional-only strictness so a divergence fails in tests. If you swap in a driver that supports named binding natively, you may delete the translation — but keep the strict adapter semantics matching whatever the production driver actually enforces, or tests will pass code production rejects. |
| Workers Cron Trigger | `wrangler.toml` `[triggers]`, and `scheduled()` in `index.js` | `db.js: expireHolds(db)` is also exposed as `POST /internal/cron/expire-holds` (guarded by `CRON_SECRET`). Any external scheduler (cron-job.org, a GitHub Actions scheduled workflow, another host's native cron) hitting that URL every few minutes reproduces the exact same effect. |
| `wrangler.toml` / `wrangler secret` | Deployment config + secret storage | Config becomes that host's equivalent (e.g. `vercel.json` + Vercel env vars, or a `.env` + host secret manager). No application code references `wrangler.toml` at runtime — it's build/deploy tooling only. |
| Admin dashboard hosting | Served by the Worker itself, as one generated HTML string in `src/admin/assets.js` (built from the editable `admin.html`/`admin.css`/`admin.js` source files by `src/admin/build.mjs`) | Already framework-agnostic — any host that can run a `fetch` handler and return an HTML `Response` serves it identically. This is why v1 deliberately does NOT use Cloudflare's Static Assets binding (which would be Cloudflare-only) in favor of an inline template string. |
| R2 binding (`env.BACKUP_BUCKET`, `src/backup.js`, production hardening 2026-07) | Only inside `src/backup.js`, and only checked/used in `index.js`'s daily cron branch | Config-gated: `exportBackupToR2` no-ops entirely if `env.BACKUP_BUCKET` is undefined, so this seam costs nothing to leave unswapped short-term. To move it: any S3-compatible object store (Backblaze B2, AWS S3 itself) works — swap `bucket.put/list/delete` for that provider's SDK equivalent; the JSON snapshot format itself is plain and provider-agnostic. |
| Turnstile (`env.TURNSTILE_SECRET_KEY`, `src/turnstile.js`, production hardening 2026-07) | Only inside `src/turnstile.js` — a single `fetch` POST to Cloudflare's public `siteverify` REST endpoint, nothing SDK-bound | Config-gated the same way as R2 above (inert with no key set). To swap: any CAPTCHA-alternative with a server-side "verify this token" REST endpoint (hCaptcha, reCAPTCHA) is a same-shaped `fetch` call — replace the URL + response-field names in `verifyTurnstile`, everything else (the admin-login call site, the throttled-lockout interplay) is unchanged. |

## What would NOT move
Nothing is Cloudflare-only at the business-logic level. The entire "can this
booking be made without overbooking" guarantee lives in portable SQL
(SPEC.md §6) and portable JS (`logic.js`) — the platform only supplies
the HTTP entrypoint, the SQLite engine, and the clock that fires the sweep.

## One implementation note beyond SPEC.md
`hold_expires` timestamps are written and compared using a SQLite-matching
`'YYYY-MM-DD HH:MM:SS'` string format (see the comment block at the top of
`src/logic.js`), not `Date.prototype.toISOString()`'s `'...T...Z'` shape.
Mixing the two formats breaks plain SQL string comparison (`hold_expires >
datetime('now')`) for same-calendar-day timestamps, because `'T'` sorts
after `' '` regardless of the actual time — which would make holds
effectively never expire on their own creation day. `logic.js` exports
`toSqliteDatetime`/`computeHoldExpiry`/`nowSqlite` as the single source of
truth for this format; if this backend ever moves to a database engine with
a different native "now" format, that's the one seam to re-check.
