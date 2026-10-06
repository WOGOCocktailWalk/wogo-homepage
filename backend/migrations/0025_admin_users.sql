-- migrations/0025_admin_users.sql
-- Personal team logins (owner audit item: "a roles/users table" — anticipated
-- verbatim in migrations/0007_admin_audit.sql's own doc comment). Replaces
-- "everyone shares one ADMIN_TOKEN" with per-person magic-link login, roles,
-- and a per-user audit trail — €0, works on workers.dev today; Cloudflare
-- Access can still be layered in front of all of /admin/* later (see
-- OWNER-SECURITY-TODO.md) as a second, independent layer.
--
-- admin_users — one row per person who can sign in to the dashboard.
--   id         'admuser_<uuid>' (or a fixed seed slug for the two rows below).
--   email      ALWAYS stored lowercased (same convention as subscribers.email).
--   name       display name, shown in the sidebar and the audit log.
--   role       'owner' (everything, incl. user management/settings/CSV
--              exports/Brevo+Stripe setup) | 'staff' (day-to-day booking ops:
--              bookings, manual booking, reschedule/cancel/resend, date
--              overrides, gift card view/void, read-only routes/bars/
--              subscribers/inquiries) | 'viewer' (read-only: bookings list/
--              detail, analytics, subscriber counts). Enforced server-side —
--              see src/admin_api.js's ROUTE_ROLES table.
--   status     'active' | 'disabled'. A disabled user's live session is
--              rejected on their very next admin request (src/admin_api.js:
--              resolveSession re-checks this row on every request for a
--              personal login — NOT cached in the signed cookie), not just on
--              next login.
--   locale     'en' | 'nl' | NULL. The language their login-link/invite email
--              renders in ("locale by user's preference") — NULL falls back
--              to 'nl' (every admin today is Dutch-first), src/emails.js.
--   invited_by email of the owner who invited them, or NULL for the two
--              seeded owner rows below (nobody invited the owner).
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',   -- 'owner' | 'staff' | 'viewer'
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'disabled'
  locale        TEXT,                            -- 'en' | 'nl' | NULL (falls back to 'nl')
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  invited_by    TEXT
);

-- Seed the owner — Maroussia can log in with EITHER address. Fixed ids
-- (not random) so re-applying this file (e.g. a fresh local/test DB) is
-- idempotent; INSERT OR IGNORE so a second apply never trips the UNIQUE(email).
INSERT OR IGNORE INTO admin_users (id, email, name, role, status, locale, created_at)
VALUES ('admuser_owner_info', 'info@wogoamsterdam.com', 'Maroussia', 'owner', 'active', 'nl', datetime('now'));
INSERT OR IGNORE INTO admin_users (id, email, name, role, status, locale, created_at)
VALUES ('admuser_owner_gmail', 'maroussiastyles@gmail.com', 'Maroussia', 'owner', 'active', 'nl', datetime('now'));

-- admin_login_links — one single-use magic-link token per login/invite email
-- sent. token_hash is sha256(raw 32-random-byte token) — the raw token only
-- ever exists in the emailed URL and the requester's in-flight request,
-- never stored (same "store the hash, not the secret" posture as nothing
-- else in this schema needs, but mirrors how a password reset token would be
-- handled — belt-and-suspenders against a DB dump leaking usable tokens).
-- used_at: single-use — src/db.js:consumeLoginLink is ONE atomic guarded
-- UPDATE (token_hash matches AND used_at IS NULL AND not expired), the same
-- "atomic guarded SQL" idiom as redeemGiftCard, so an email client that
-- prefetches links (a real thing — corporate mail scanners do this) can't
-- burn the link before the person clicks it twice, nor let two clicks both
-- succeed.
-- ip_hash: SHA-256 of the requesting IP (never the raw IP — same
-- minimization posture as migrations/0021's inquiries.ip_hash), recorded for
-- security review only, never used as a login guard itself.
CREATE TABLE admin_login_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     TEXT NOT NULL REFERENCES admin_users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  ip_hash     TEXT
);

CREATE INDEX idx_admin_login_links_user ON admin_login_links (user_id);

-- admin_audit (migrations/0007) gains `actor` — the human/system identity
-- behind the mutation, not just the IP. NULL for every row written before
-- this migration (the dashboard's audit view shows those as "token", the
-- same meaning they always had — a single shared ADMIN_TOKEN, no per-user
-- identity existed yet). New rows: the acting admin_user's email, or
-- 'token' for the emergency ADMIN_TOKEN login path (src/admin_api.js's
-- `audit()` helper — see src/index.js's resolveSession/request.adminSession).
ALTER TABLE admin_audit ADD COLUMN actor TEXT;

-- Analytics (BUILD §19) scans bookings by created_at (the "sale date" series)
-- across potentially-wide date ranges; bookings.date (walk date) was already
-- indexed (migrations/0001) but created_at was not.
CREATE INDEX idx_bookings_created ON bookings (created_at);
