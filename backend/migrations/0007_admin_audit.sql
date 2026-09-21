-- migrations/0007_admin_audit.sql
-- Production-readiness hardening (2026-07): who/what/when for every admin
-- MUTATION (booking edit/resend, route create/update, bar CRUD, date-override
-- CRUD, customer edit, manual booking, CSV export) — src/admin_api.js's new
-- `audit()` helper writes one row per call, after the mutation succeeds.
-- Read back via GET /admin/api/audit-log (session-guarded, like every other
-- /admin/api/* route).
--
-- There is only ONE admin identity today (a single shared ADMIN_TOKEN — see
-- SPEC.md §12.1/§15.2), so `actor` is the requesting IP, not a user id; the
-- moment a roles/users table exists (left as a clean seam, per the owner's
-- own audit item #3) this table gains an `actor_id` column and nothing else
-- about it needs to change.
--
-- `detail` is a small JSON blob of what changed — deliberately NOT a full
-- before/after row dump, to keep this table lean and avoid duplicating guest
-- PII beyond what's useful for "who touched this and when".

CREATE TABLE admin_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ip          TEXT,                    -- CF-Connecting-IP of the admin request
  action      TEXT NOT NULL,           -- e.g. 'route.create', 'booking.resend_confirmation'
  entity_type TEXT,                    -- 'route' | 'bar' | 'date_override' | 'customer' | 'booking' | NULL
  entity_id   TEXT,                    -- the affected row's id/slug/email, as text
  detail      TEXT                     -- small JSON blob, action-specific
);

CREATE INDEX idx_admin_audit_created ON admin_audit (created_at);
CREATE INDEX idx_admin_audit_entity  ON admin_audit (entity_type, entity_id);
