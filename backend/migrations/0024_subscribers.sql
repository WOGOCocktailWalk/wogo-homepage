-- migrations/0024_subscribers.sql
-- Newsletter subscriber plumbing (SPEC.md §17 "Subscribers"). Two tables:
--
-- 1. `subscribers` — one row per email WOGO has ever tried to add to the
--    newsletter, from ANY source. GDPR double opt-in for the self-serve forms
--    (site footer, contact form): a row starts 'pending' and only becomes
--    'confirmed' once the guest clicks the link in their confirmation email
--    (src/guest_api.js:handleSubscribeConfirm). A booking's own marketing
--    opt-in checkbox IS the consent act (owner requirement #3) — those rows
--    go straight to 'confirmed', no email round-trip. A Wix CSV import
--    (owner requirement #5) is pre-consented history, also straight to
--    'confirmed'. Gift-card BUYERS are never subscribed (no consent given) —
--    see src/webhook.js's giftcard branch, which never touches this table.
--
-- confirm_token: random opaque token (src/subscribers.js:generateToken), set
--   on every transition INTO 'pending' (new signup, or a re-signup after
--   unsubscribing) and left in place afterwards — a stale token for an
--   already-confirmed/unsubscribed row simply won't match the row's CURRENT
--   token once it's been regenerated, so an old confirmation link naturally
--   stops working without needing to be explicitly nulled out. Expiry is
--   judged by `created_at` (reset on every re-issue) vs CONFIRM_TOKEN_EXPIRY_HOURS
--   (src/config.js) — see src/guest_api.js:handleSubscribeConfirm.
-- unsubscribe_token: random opaque token, generated ONCE at row creation and
--   never rotated — it must keep working for the lifetime of every email
--   that was ever sent carrying it (the welcome email's footer link).
-- status: 'pending' | 'confirmed' | 'unsubscribed'.
-- source: which form/flow created this row — 'site_footer' (newsletter
--   signup box) | 'booking_opt_in' (the booking widget's checkbox) |
--   'wix_import' (historical CSV import) | 'gift_card' (reserved — gift card
--   buyers are NOT currently subscribed, see above; kept as a valid source
--   value in case a future "subscribe at gift-card checkout" checkbox is
--   added) | 'contact_form' (reserved for a future contact-form opt-in
--   checkbox — the contact form itself does not yet offer one).
-- ip_hash: SHA-256 of the submitter's IP (same minimization posture as
--   migrations/0021's inquiries.ip_hash) — never the raw IP.

CREATE TABLE subscribers (
  id                 TEXT PRIMARY KEY,                -- 'sub_<uuid>'
  email              TEXT NOT NULL UNIQUE,             -- always stored lowercased
  first_name         TEXT,
  locale             TEXT NOT NULL DEFAULT 'en',       -- 'en' | 'nl'
  city               TEXT,
  source             TEXT NOT NULL,                     -- see above
  status             TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'confirmed' | 'unsubscribed'
  confirm_token      TEXT,
  unsubscribe_token  TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at       TEXT,
  unsubscribed_at    TEXT,
  ip_hash            TEXT
);

CREATE INDEX idx_subscribers_status ON subscribers (status);
CREATE INDEX idx_subscribers_source ON subscribers (source);
CREATE INDEX idx_subscribers_confirm_token ON subscribers (confirm_token);
CREATE INDEX idx_subscribers_unsubscribe_token ON subscribers (unsubscribe_token);

-- 2. `brevo_sync_queue` — the "Brevo is down" safety net (BUILD item #7). This
--    codebase already has one retry-queue pattern for outbound email
--    (migrations/0008's failed_email + src/email_retry.js); this mirrors that
--    exact shape for outbound Brevo CONTACT API calls (upsert/attribute-patch/
--    unsubscribe), which are a completely different Brevo endpoint family
--    from the transactional-email send failed_email already covers. Chosen
--    over, e.g., re-deriving "what Brevo state should this subscriber be in"
--    from scratch on every cron tick: queuing the exact failed call (kind +
--    JSON payload) is simpler to reason about and reuses the proven
--    attempts/backoff/give-up-and-alert shape verbatim (src/brevo_sync.js).
--    A row here does NOT mean the local `subscribers`/`bookings` write
--    failed — that already succeeded; only the Brevo mirror is playing catch-up.
--
-- kind: 'subscriber_confirm'       — payload {subscriber_id}: upsert + add to
--         the WOGO list, full attribute set (after double opt-in confirm).
--       'subscriber_booking_optin' — payload {subscriber_id}: upsert + add to
--         the list with CONSENT_SOURCE='booking' (a booking's opt-in box).
--       'subscriber_unsubscribe'   — payload {email}: blacklist + remove from list.
--       'booking_attributes'       — payload {email, route_name, date}: patch
--         LAST_BOOKING_DATE/LAST_ROUTE/BOOKINGS_COUNT on an EXISTING Brevo
--         contact only (never creates one — see src/subscribers.js).
CREATE TABLE brevo_sync_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,                       -- JSON, shape depends on kind
  attempts        INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending',      -- 'pending' | 'done' | 'failed_permanent'
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_brevo_sync_queue_due ON brevo_sync_queue (status, next_attempt_at);
