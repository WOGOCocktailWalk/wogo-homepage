// src/config.js — non-secret constants. Nothing here is sensitive; safe to commit.

// STAGING: points at the live GitHub Pages site so the whole booking flow
// (Stripe success/cancel redirect, confirmation page) works before the Wix
// cutover. AT CUTOVER: change back to 'https://www.wogococktailwalk.com'.
export const SITE_URL = 'https://wogococktailwalk.github.io/wogo-homepage';

// Echoed back as Access-Control-Allow-Origin ONLY if the request Origin matches
// one of these exactly, or matches the localhost dev pattern below.
export const ALLOWED_ORIGINS = [
  'https://www.wogococktailwalk.com',
  'https://wogococktailwalk.com',
  'https://wogococktailwalk.github.io',
];

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // dev convenience: http://localhost:PORT or http://127.0.0.1:PORT
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

// Email templates live in src/emails.js as owned HTML (sent via Brevo's
// htmlContent path) — nothing is created in the Brevo dashboard. See SETUP §5.

export const OWNER_ALERT_EMAIL = 'info@wogoamsterdam.com';

// Owner/internal "new booking" notification recipient (Dashboard v2 §8.4).
// Every confirmed booking — web or manual — sends a copy here.
export const OWNER_NOTIFY_EMAIL = 'info@wogoamsterdam.com';

// From-address for all owned-HTML transactional mail (src/emails.js). Must be a
// verified sender in the Brevo account. Not secret.
export const EMAIL_SENDER = { email: 'info@wogoamsterdam.com', name: 'WOGO Cocktail Walk' };

// --- Hosted image assets for the branded emails --------------------------
// One base URL for every image an email references (logo, banner, city
// posters). Today this is the live GitHub Pages site (images resolve NOW,
// before the Wix cutover). AT CUTOVER: change this ONE line to
// 'https://www.wogococktailwalk.com' and move the /email/ + /maps/ folders to
// the real domain — see OWNER-SECURITY-TODO.md. A broken <img> shows a torn
// placeholder, so these MUST point at a host that is actually serving them.
export const SITE_ASSET_BASE = 'https://wogococktailwalk.github.io/wogo-homepage';

// The real WOGO logo (salmon mark on transparent — reads on the dark hero) and
// the universal branded banner photo (email-safe JPG; used when a route has no
// poster of its own yet).
export const EMAIL_LOGO_URL = `${SITE_ASSET_BASE}/email/logo-salmon.png`;
export const EMAIL_BANNER_URL = `${SITE_ASSET_BASE}/email/banner.jpg`;

// Per-route marketing poster (the branded "COCKTAIL WALK — TICKETS INCLUDE"
// image). Keyed by route id; a route not listed here falls back to
// EMAIL_BANNER_URL so no email is ever bare. Add a city's poster by exporting
// it to /email/poster-<city>.jpg and adding the line here (later: an editable
// poster_url column, mirroring map_url).
export const POSTER_BY_ROUTE = {
  amsterdam: `${SITE_ASSET_BASE}/email/poster-amsterdam.jpg`,
  utrecht: `${SITE_ASSET_BASE}/email/poster-utrecht.jpg`,
  groningen: `${SITE_ASSET_BASE}/email/poster-groningen.jpg`,
  delft: `${SITE_ASSET_BASE}/email/poster-delft.jpg`,
  'rotterdam-premium-gin': `${SITE_ASSET_BASE}/email/poster-rotterdam-premium.jpg`,
  // Still to add (kept on the branded fallback banner until their posters arrive):
  //   rotterdam-witte-de-with (Route 1), rotterdam-hidden-gems (Route 2)
};

/** The poster image for a route: its own if we have one, else the branded banner. */
export function posterUrlFor(route) {
  return (route && (route.poster_url || POSTER_BY_ROUTE[route.id])) || EMAIL_BANNER_URL;
}

// Public — already present in the site's client-side Meta Pixel snippet.
export const META_PIXEL_ID = '652971109400692';

export const DEFAULT_CAPACITY = 10;
export const DEFAULT_MAX_PARTY = 6;

export const HOLD_MINUTES = 15;
export const STRIPE_EXPIRES_MINUTES = 30; // Stripe's minimum for Checkout Session expires_at
export const BOOKING_HORIZON_DAYS = 90;
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export const ADMIN_SESSION_MAX_AGE_SECONDS = 43200; // 12h

// --- Abuse-protection limits (SPEC.md §15, migrations/0005) ------------------
// Seat-hold abuse: a scripted attacker must not be able to lock all seats with
// free 15-minute holds. Layered caps — all D1-backed (Workers isolates share
// no memory), all deliberately loose enough that a real guest never sees them.
export const MAX_ACTIVE_HOLDS_PER_EMAIL = 2;   // live (unexpired) holds per email
export const MAX_ACTIVE_HOLDS_PER_IP = 2;      // live (unexpired) holds per IP
export const HOLD_ATTEMPTS_PER_WINDOW = 5;     // POST /api/book attempts per IP...
export const HOLD_ATTEMPT_WINDOW_MINUTES = 10; // ...per sliding window of this many minutes

// Admin login brute force: per-IP failed-attempt lockout with escalation.
export const LOGIN_FAIL_THRESHOLD = 5;      // fails (since last success) before lockout
export const LOGIN_LOCK_BASE_MINUTES = 15;  // first lockout length; doubles per further fail
export const LOGIN_LOCK_MAX_MINUTES = 240;  // escalation cap (4h)
export const LOGIN_FAIL_WINDOW_MINUTES = 24 * 60; // how far back fails are counted
export const MAX_TOKEN_LENGTH = 256;        // sanity cap on submitted login tokens

// Retention for the two security tables — pruned by the 5-minute cron sweep.
export const RATE_EVENTS_RETENTION_MINUTES = 24 * 60;      // 24h
export const AUTH_EVENTS_RETENTION_MINUTES = 30 * 24 * 60; // 30 days (audit log)

// --- Production hardening (2026-07, SETUP.md "Production hardening" section) ---

// Crash-alert email throttle: at most one "the backend threw" email per this
// many minutes, no matter how many exceptions fire in that window (a crash
// loop must not become an inbox flood). Uses the `settings` table as the
// throttle clock — see src/alerts.js.
export const ERROR_ALERT_THROTTLE_MINUTES = 30;
export const ERROR_LOG_RETENTION_MINUTES = 90 * 24 * 60;      // 90 days

// Admin mutation audit trail — kept longer than the login-attempt audit
// (AUTH_EVENTS_RETENTION_MINUTES above) since it's the accountability record
// for what changed in the booking system, not a brute-force signal that goes
// stale fast.
export const ADMIN_AUDIT_RETENTION_MINUTES = 400 * 24 * 60;   // ~13 months

// Failed-email retry (migrations/0008, src/email_retry.js): a few attempts
// with escalating backoff, then give up and alert the owner. Index i of this
// array is the wait BEFORE attempt i+2 (attempt 1 already happened inline at
// send time; the cron makes attempts 2..MAX).
export const FAILED_EMAIL_MAX_ATTEMPTS = 5;
export const FAILED_EMAIL_RETRY_BACKOFF_MINUTES = [5, 15, 60, 240, 720]; // 5m,15m,1h,4h,12h
export const FAILED_EMAIL_RESOLVED_RETENTION_MINUTES = 30 * 24 * 60; // 30 days after sent/failed_permanent
export const FAILED_EMAIL_ALERT_THROTTLE_MINUTES = 60;

// Health-check cron (src/healthcheck.js) — throttle for "the backend looks
// down" alerts, separate bucket from the crash-alert throttle above so one
// kind of problem can't suppress alerting about the other.
export const HEALTH_CHECK_ALERT_THROTTLE_MINUTES = 60;
// Optional: the Worker's own public base URL (e.g. 'https://api.wogococktailwalk.com'),
// set via a plain (non-secret) `[vars]` entry in wrangler.toml. Empty by
// default — the health check then skips the self-fetch step entirely and
// runs only its in-process checks (D1 reachable, required secrets present).
// Fill in once the backend has a real public route (SETUP.md §14).
export const HEALTH_CHECK_BASE_URL_VAR = 'HEALTH_CHECK_BASE_URL';

// GDPR retention (owner audit item #14): personal fields on terminal bookings
// (confirmed/confirmed_conflict/cancelled/expired — never 'hold', which
// always resolves within HOLD_MINUTES) are anonymized once they're older
// than this many months. Default 24 (owner's stated default).
export const GDPR_RETENTION_MONTHS = 24;

// Daily D1 -> R2 export (src/backup.js): how many days of daily snapshots to
// keep in the bucket before the cron prunes older ones. R2's free tier is
// 10GB storage — at WOGO's volume (a few thousand bookings) this retention
// window costs a rounding error of that.
export const BACKUP_RETENTION_DAYS = 60;

// route slug -> public route page path, used for Stripe cancel_url / Meta event_source_url
export const ROUTE_PATHS = {
  amsterdam: '/amsterdam/',
  utrecht: '/utrecht/',
  groningen: '/groningen/',
  'rotterdam-witte-de-with': '/rotterdam/witte-de-with/',
  'rotterdam-hidden-gems': '/rotterdam/hidden-gems/',
  'rotterdam-premium-gin': '/rotterdam/premium-gin-walk/',
};

export function routePathFor(route) {
  return ROUTE_PATHS[route.id] || '/';
}
