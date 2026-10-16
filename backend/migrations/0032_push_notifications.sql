-- migrations/0032_push_notifications.sql
-- Web Push + an in-dashboard notification feed (BUILD: "PWA + real push,
-- replacing the Wix app notification the owner is losing"). Two tables:
--
-- push_subscriptions — one row per BROWSER SUBSCRIPTION (one physical
--   device+browser combination can only ever have one active subscription
--   per origin, by the Push API's own design), scoped to the admin_users
--   row that registered it (migrations/0025) — a push payload-less "tickle"
--   fans out to every row here (src/notifications.js:fanOutPush), filtered
--   by that OWNING user's per-kind preference (stored in the existing
--   `settings` k/v table as `push_prefs:<user_id>` — no new table needed for
--   five booleans, same pattern as the GA4/Brevo settings already there).
--   id          'push_<uuid>'.
--   user_id     REFERENCES admin_users(id) — same "no cascade, users are
--               only ever disabled, never deleted" posture as
--               admin_login_links.user_id (migrations/0025).
--   endpoint    the browser's PushSubscription.endpoint — UNIQUE because
--               re-subscribing the SAME device (token refresh, re-enabling
--               after denying) must UPDATE this row in place
--               (src/db.js:upsertPushSubscription, ON CONFLICT(endpoint)),
--               never pile up duplicate rows pushing the same device twice.
--   p256dh/auth the subscription's own encryption keys (PushSubscriptionKeys)
--               — unused today (this build sends payload-less pushes only,
--               see SPEC.md's notification-system section for why), kept so
--               a FUTURE encrypted-payload push (RFC 8291) needs no new
--               migration, just code that starts reading these columns.
--   user_agent  free text, shown in the Settings "your devices" list so a
--               person can tell "iPhone (Safari)" apart from a stale entry.
--   last_success_at / last_error / failure_count — delivery health, shown in
--               the same Settings list. A subscription is NEVER deleted for
--               repeated non-gone failures (a Brevo-style send hiccup isn't
--               proof the device is gone) — only a 404/410 FROM THE PUSH
--               SERVICE ITSELF (the subscription is provably dead) triggers
--               an automatic delete (src/notifications.js:fanOutPush).
--
-- notifications — the in-dashboard feed AND what a push tickle wakes the
--   service worker to go fetch (GET /admin/api/notifications/pending,
--   session-authenticated, same-origin — see src/admin/sw.js). ONE row per
--   event; `read_at` is a SINGLE shared column, not per-viewer — this is a
--   small team tool, not a multi-tenant inbox (same "doesn't defend against
--   itself" posture as the last-owner guard, migrations/0025's doc comment),
--   so Maroussia reading a notification also clears it for Selin, and vice
--   versa. `user_id IS NULL` means "broadcast to every admin" (every
--   business-event notification this build creates is broadcast — a sale
--   or a problem is everyone's business); a non-NULL `user_id` is used only
--   by the Settings "send me a test notification" button, scoped to the one
--   person who clicked it.
--   kind        'booking_new' | 'booking_cancelled' | 'booking_moved' |
--               'giftcard_sold' | 'enquiry' | 'problem' | 'test' — see
--               src/notifications.js:NOTIFICATION_KIND_PREFERENCE_GROUP for
--               which Settings toggle governs which kind ('test' bypasses
--               every toggle — an explicit single click always gets through).
--   url         the deep link the dashboard opens to on tap, e.g.
--               '/admin/#/bookings/b_123' — src/admin/admin.js's hash router
--               (added alongside this migration) parses it on load/click.
--   booking_id  NOT a foreign key (a cancelled/old booking row is never
--               deleted, but keeping this loose avoids any future booking
--               retention/anonymization pass — migrations/0005's GDPR
--               retention job — tripping a constraint here).
--
-- Pruned nightly alongside the existing audit/error/email-log retention pass
-- (src/index.js's 0 3 * * * cron) — see src/notifications.js:pruneOldNotifications.

CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES admin_users(id),
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_success_at TEXT,
  last_error      TEXT,
  failure_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  url         TEXT,
  booking_id  TEXT,
  user_id     TEXT,                              -- NULL = broadcast to all
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  read_at     TEXT
);

-- Hot query #1: "my unread, newest first" (the bell badge + the SW's pending
-- fetch) — read_at IS NULL is the selective predicate, created_at the sort.
CREATE INDEX idx_notifications_unread ON notifications (read_at, created_at);
-- Hot query #2: a single user's own test-notification rows.
CREATE INDEX idx_notifications_user ON notifications (user_id);
