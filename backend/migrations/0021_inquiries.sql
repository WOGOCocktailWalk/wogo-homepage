-- migrations/0021_inquiries.sql
-- Audit item 9: POST /api/contact backs the site's Contact form ('contact')
-- and Group booking request form ('group') — neither creates a booking hold
-- or touches routes/bookings at all; this is a lead inbox, not a booking
-- flow. src/guest_api.js:handleContact validates + rate-limits, stores one
-- row here, emails info@wogoamsterdam.com (reply-to the guest) via Brevo,
-- and sends the guest a short auto-acknowledgement in their own locale.
--
-- kind: 'contact' | 'group' — which form submitted it (drives the owner
--   notification's subject line and which fields are expected to be filled).
-- city / date / party_size: only meaningful for kind='group' (a guest asking
--   about a group booking in a specific city, on/around a date, for N people)
--   — NULL for a plain 'contact' message.
-- ip_hash: SHA-256 of the submitter's IP (src/guest_api.js, Web Crypto —
--   Workers-safe, no Node crypto per PORTABILITY.md), NOT the raw IP —
--   matches migrations/0005's IP-minimization posture (bookings.ip is even
--   more transient than this). Used only for the rate-limit's own audit
--   trail; never rendered anywhere.
-- status: 'new' (default) | 'read' | 'replied' | 'closed' — owner-managed via
--   the future admin UI (GET /admin/api/inquiries lists 'new' rows today;
--   no PATCH endpoint yet — see SETUP.md).

CREATE TABLE inquiries (
  id          TEXT PRIMARY KEY,               -- 'inq_<uuid>'
  kind        TEXT NOT NULL,                   -- 'contact' | 'group'
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  city        TEXT,                            -- 'group' only
  date        TEXT,                            -- 'group' only, 'YYYY-MM-DD' (free-text-adjacent; not validated against a route calendar)
  party_size  INTEGER,                         -- 'group' only
  message     TEXT NOT NULL,
  locale      TEXT NOT NULL DEFAULT 'en',      -- 'en' | 'nl'
  ip_hash     TEXT,
  status      TEXT NOT NULL DEFAULT 'new',     -- 'new' | 'read' | 'replied' | 'closed'
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_inquiries_created ON inquiries (created_at);
CREATE INDEX idx_inquiries_status ON inquiries (status, created_at);
