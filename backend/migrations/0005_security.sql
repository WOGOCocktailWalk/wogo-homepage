-- migrations/0005_security.sql
-- Security hardening (2026-07): seat-hold abuse protection + admin login
-- brute-force protection. See SPEC.md §15.
--
-- Design notes:
--   * Workers have no shared in-memory state across isolates, so every
--     counter/limiter here is D1-backed by necessity.
--   * bookings.ip is TRANSIENT: it exists only while a row is an active
--     'hold' (it's how "max N active holds per IP" is counted atomically
--     against real rows). db.js clears it the moment the hold resolves —
--     confirm, cancel, or expiry sweep — so no guest IP is retained on a
--     finished booking (GDPR data-minimization).
--   * rate_events rows live ~24h, auth_events rows ~30 days; both are
--     pruned by the same 5-minute cron that sweeps expired holds. Row
--     volume is tiny (one row per booking attempt / login attempt), well
--     inside the D1 free tier.

-- Which IP created a hold — NULL once the hold is no longer active.
ALTER TABLE bookings ADD COLUMN ip TEXT;

-- Partial index: only 'hold' rows are ever looked up by ip, and only they
-- carry one — keeps the index near-empty at rest.
CREATE INDEX idx_bookings_hold_ip ON bookings (ip) WHERE status = 'hold';

-- One row per rate-limited attempt (currently kind='book' — hold creation).
-- Counted over a sliding window; pruned after RATE_EVENTS_RETENTION_MINUTES.
CREATE TABLE rate_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                            -- 'book'
  identity   TEXT NOT NULL,                            -- client IP (CF-Connecting-IP)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_rate_events_lookup ON rate_events (kind, identity, created_at);

-- Admin login attempts, success and failure — drives the per-IP lockout AND
-- doubles as the audit log surfaced at GET /admin/api/security/login-attempts.
CREATE TABLE auth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 0,               -- 0 = failed, 1 = success
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_auth_events_ip ON auth_events (ip, created_at);
