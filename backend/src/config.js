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

// --- Per-email-type imagery (2026-10-14) -----------------------------------
// BEFORE: every guest mail called posterUrlFor(route), so the confirmation,
// both abandoned nudges, the 2-day reminder and the review request all showed
// the IDENTICAL city poster (or the one generic banner.jpg for a route with
// no poster). It read like a template — the owner's words: "i don't like it
// that every mail uses the same picture".
//
// NOW: each email KIND gets its own photograph, chosen to match the moment,
// and prefers one of the guest's OWN city where we have a good one. The
// files live in /email/ as email-safe JPEGs (≤180KB, ≤1200px) prepared from
// photography already on the site — see the table in SPEC.md.
//
// `confirmation` is the deliberate exception: it KEEPS the route poster. It
// is the guest's "ticket" and the single most informative image we have, and
// posterUrlFor() also honours the per-route `routes.poster_url` DB override,
// which this static map cannot. emailImageFor() therefore DELEGATES that
// kind rather than reimplementing the lookup.
//
// Shape: EMAIL_IMAGE_BY_KIND_AND_ROUTE[kind] = { _default, [routeId]: url }.
// Resolution order is exact (kind, route) -> that kind's _default ->
// EMAIL_BANNER_URL, so there is no (kind, route) pair — including a route id
// that does not exist yet — that can resolve to an empty or broken URL.
const IMG = (name) => `${SITE_ASSET_BASE}/email/${name}`;

// The three Rotterdam routes share a city, so they share Rotterdam's photos.
const RTM = ['rotterdam-witte-de-with', 'rotterdam-hidden-gems', 'rotterdam-premium-gin'];
/** Spreads one url across every Rotterdam route id. */
const forRotterdam = (url) => Object.fromEntries(RTM.map((id) => [id, url]));

export const EMAIL_IMAGE_BY_KIND_AND_ROUTE = {
  // Booked, paid, going: the route poster (the "ticket"). Handled by
  // posterUrlFor() in emailImageFor — this entry documents the intent and
  // keeps the kind list complete.
  confirmation: {},

  // "Come join" — warm, social, people visibly enjoying themselves.
  abandoned: {
    _default: IMG('mail-group-toast.jpg'),            // five friends clinking glasses
    ...forRotterdam(IMG('mail-lounge-friends.jpg')),  // red-velvet lounge, mid-conversation
    utrecht: IMG('mail-terrace-sun-utrecht.jpg'),     // sunlit terrace, friends laughing
    amsterdam: IMG('mail-bar-overhead-amsterdam.jpg'),// a buzzing bar from above
    groningen: IMG('mail-gin-bar-friends.jpg'),       // two guys laughing over gin
    delft: IMG('mail-golden-cheers.jpg'),             // two friends toasting in golden light
  },

  // The second (24h) nudge. MUST differ from `abandoned` — the same guest
  // receives both, which is exactly the repetition this change exists to end.
  abandoned_followup: {
    _default: IMG('mail-bar-cheers-warm.jpg'),        // intimate candlelit toast
    ...forRotterdam(IMG('mail-rooftop-cheers.jpg')),  // rooftop cheers over the skyline
  },

  // Two days out: anticipation. Evening light, a drink waiting to be had.
  reminder: {
    _default: IMG('mail-cocktail-bokeh.jpg'),         // cocktail close-up, warm bokeh
    ...forRotterdam(IMG('mail-neon-bar-night.jpg')),  // smiling guest, drinks in hand
    // NOT a copy-paste slip: this exact photograph ships in the site repo
    // twice, as rotterdam/route-1/ AND amsterdam/cocktails-neon-bar-night.jpg.
    // One email-safe copy serves both cities rather than two identical files.
    // Cross-CITY reuse is harmless — an Amsterdam guest never receives
    // Rotterdam's mail. Only repeats WITHIN a city matter (see the test).
    amsterdam: IMG('mail-neon-bar-night.jpg'),
    utrecht: IMG('mail-candlelit-utrecht.jpg'),       // savouring a coupe by candlelight
    delft: IMG('mail-flame-cocktail-delft.jpg'),      // a drink being flamed at the bar
  },

  // The day after: a warm "cheers, thank you".
  review_request: {
    _default: IMG('mail-golden-hour-toast.jpg'),      // golden-hour clink, two glasses
    groningen: IMG('mail-floral-toast.jpg'),          // toast beside a bunch of flowers
  },

  // Moved, not lost: calm and forward-looking. Never festive.
  reschedule: {
    _default: IMG('mail-cocktail-tray-sun.jpg'),      // cocktails on a tray in sunlight
    ...forRotterdam(IMG('mail-skybar-rotterdam.jpg')),// drinks against the Erasmus bridge
    delft: IMG('mail-calm-interior-delft.jpg'),       // quiet, empty, elegant interior
  },

  // Cancelled: quiet and neutral. A celebration photo here would be tone-deaf,
  // so the default is a still life with no people in it at all.
  cancellation: {
    _default: IMG('mail-studio-cocktail.jpg'),        // single cocktail, deep blue studio
    ...forRotterdam(IMG('mail-calm-bar-rotterdam.jpg')), // calm, empty, pale bar room
  },

  // The gift-card and list mails carry no route at all, so these are
  // single-image kinds (the _default is the only entry there can be).
  giftcard_recipient: { _default: IMG('mail-floral-coupes.jpg') },  // flower-garnished coupes being finished
  giftcard_buyer: { _default: IMG('mail-bartender-garnish.jpg') },  // a bartender finishing the drink you bought
  subscribe_confirm: { _default: IMG('mail-dark-bar-pour.jpg') },   // quiet, dark, elegant
  // Shares its photo with `abandoned.delft` on purpose. These are different
  // journeys (newsletter vs. an unfinished booking) and the overlap only
  // shows if one Delft guest both abandons a booking AND joins the list, so
  // it is not worth spending another photo on. The within-a-city rule above
  // is the one that must hold.
  welcome: { _default: IMG('mail-golden-cheers.jpg') },             // golden-light toast
};

/**
 * The hero image for one email KIND, preferring the guest's own city.
 *
 * @param kind  one of the EMAIL_IMAGE_BY_KIND_AND_ROUTE keys
 * @param route the booking's route row (may be null/undefined for the
 *              gift-card and newsletter mails, which have no route)
 * @returns an always-resolvable absolute URL — never '' and never undefined.
 */
export function emailImageFor(kind, route) {
  // The confirmation keeps the route poster, including any per-route
  // routes.poster_url override that only the DB knows about.
  if (kind === 'confirmation') return posterUrlFor(route);
  const byRoute = EMAIL_IMAGE_BY_KIND_AND_ROUTE[kind];
  if (!byRoute) return EMAIL_BANNER_URL;         // unknown kind: branded banner
  const exact = route && route.id ? byRoute[route.id] : null;
  return exact || byRoute._default || EMAIL_BANNER_URL;
}

// Public — already present in the site's client-side Meta Pixel snippet.
export const META_PIXEL_ID = '652971109400692';

export const DEFAULT_CAPACITY = 10;
export const DEFAULT_MAX_PARTY = 6;

// Booking cutoff (audit item 1): a slot whose start time is already within
// this many minutes — or has already passed — is no longer offered as
// bookable (GET /api/slots, GET /api/availability) and is rejected outright
// by POST /api/book (409 slot_passed). Judged against the ROUTE's own
// timezone via logic.js:isSlotPastCutoff, so a guest can't book a 17:00
// Amsterdam slot at 16:30 local time, nor a same-day London slot inside its
// own last hour.
//
// Since migrations/0029, this is only the FALLBACK — each route has its own
// routes.booking_cutoff_minutes (NOT NULL DEFAULT 60, same number as here),
// read as `route.booking_cutoff_minutes ?? SAME_DAY_CUTOFF_MINUTES`
// everywhere this used to be read directly (src/db.js, src/guest_api.js).
// The `??` only ever matters for a hand-built route object (a test fixture
// predating 0029) — a real DB row is never NULL. A route with a longer
// cutoff (e.g. 1440 for 24h) is no longer "same-day" at all — the name is
// kept only because it's the original audit item's constant.
export const SAME_DAY_CUTOFF_MINUTES = 60;

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

// Personal team logins (migrations/0025_admin_users.sql) — magic-link email
// auth, replacing "everyone shares ADMIN_TOKEN". The token itself is a
// 32-byte random secret (unguessable), so these are about containing blast
// radius (a leaked/forwarded email, a mail-scanner prefetch) rather than
// brute-force resistance like §LOGIN_FAIL_THRESHOLD above.
export const LOGIN_LINK_TOKEN_EXPIRY_MINUTES = 15;    // single-use link lifetime
export const LOGIN_LINK_ATTEMPTS_PER_WINDOW = 5;      // POST /admin/login/request attempts...
export const LOGIN_LINK_ATTEMPT_WINDOW_MINUTES = 15;  // ...per sliding window, own buckets per-IP AND per-email
export const ADMIN_EMAIL_MAX_LENGTH = 200;            // sanity cap on a submitted admin email

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

// --- Gift cards (migrations/0018/0019) --------------------------------------
// Purchase amount rules for POST /api/giftcard/checkout: the three page tiers
// (exact cents) OR any custom amount within [MIN, MAX]. Kept here (not
// hardcoded in guest_api.js) so the page's tiers and the server's validation
// can never silently drift.
export const GIFT_CARD_TIERS_CENTS = [3000, 6000, 10000]; // €30 / €60 / €100
export const GIFT_CARD_CUSTOM_MIN_CENTS = 1000;  // €10
export const GIFT_CARD_CUSTOM_MAX_CENTS = 50000; // €500

// --- Bar-fulfilled add-ons (migrations/0033) --------------------------------
// Dashboard-configurable per add-on (see migrations/0033's header comment for
// the full business-model writeup); these are just sanity caps shared by the
// server-side validator (src/guest_api.js) and the admin editor so the two
// can never silently drift — same "one list/number, two readers" pattern as
// the gift-card tiers above.
export const ADDON_DEFAULT_CUTOFF_HOURS = 24;        // admin editor's default for a new row
export const ADDON_DEFAULT_VAT_RATE = 9;             // food is the first real use case (NL 9%)
export const ADDON_DEFAULT_MAX_QTY_PER_BOOKING = 10;
export const ADDON_NAME_MAX_LENGTH = 200;
export const ADDON_DESCRIPTION_MAX_LENGTH = 2000;
export const ADDON_IMAGE_URL_MAX_LENGTH = 1000;
export const ADDON_MAX_QTY_SANITY_CAP = 999;         // hard ceiling, however the owner misconfigures max_qty_per_booking
export const ADDON_MAX_CUTOFF_HOURS = 24 * 30;       // sanity ceiling (30 days' notice)
export const ADDON_LOW_MARGIN_WARNING_CENTS = 100;   // €1 — admin UI WARNS (never blocks) under this
export const ADDON_UNITS = ['per_person', 'per_booking'];

// --- Contact + group-booking inquiries (migrations/0021, POST /api/contact) --
// Field length caps, kept here (not hardcoded in guest_api.js) so the
// contact/group forms and the server's validation can never silently drift —
// same pattern as the gift-card tiers above.
export const CONTACT_NAME_MAX_LENGTH = 200;
export const CONTACT_MESSAGE_MAX_LENGTH = 5000;
export const CONTACT_CITY_MAX_LENGTH = 100;
export const CONTACT_DATE_MAX_LENGTH = 100; // free text ("mid November"), not a strict YYYY-MM-DD
export const CONTACT_PARTY_SIZE_MAX = 500;

// --- Newsletter subscribers (migrations/0024, BUILD §17) --------------------

export const SUBSCRIBE_SOURCES = ['site_footer', 'booking_opt_in', 'wix_import', 'gift_card', 'contact_form'];
export const SUBSCRIBE_NAME_MAX_LENGTH = 200;
export const SUBSCRIBE_CITY_MAX_LENGTH = 100;

// How long a 'pending' confirm_token stays valid, judged against the row's
// created_at (reset every time a new token is issued — see db.js:
// reissueSubscriberToken). Re-submitting POST /api/subscribe for a still-
// pending email always issues a fresh token + resets this clock, so a guest
// is never permanently locked out by an expired first attempt.
export const CONFIRM_TOKEN_EXPIRY_HOURS = 48;

// Welcome code sent once a subscriber confirms (double opt-in) or opts in at
// booking time. A plain constant so the email copy, the Stripe promotion-code
// creation endpoint (POST /admin/api/stripe/ensure-welcome-code), and any
// future reference to it can never drift onto different strings.
export const WELCOME_CODE = 'WELCOME10';
export const WELCOME_DISCOUNT_PERCENT = 10;

// Brevo contact model (POST /admin/api/brevo/setup) — the folder/list names
// and the full custom-attribute set this codebase creates programmatically so
// nothing has to be clicked together by hand in the Brevo UI.
export const BREVO_FOLDER_NAME = 'WOGO';
export const BREVO_LIST_NAME = 'WOGO subscribers';
export const BREVO_CONTACT_ATTRIBUTES = [
  { name: 'LANGUAGE', type: 'text' },
  { name: 'CITY_INTEREST', type: 'text' },
  { name: 'SOURCE', type: 'text' },
  { name: 'FIRST_NAME', type: 'text' },
  { name: 'LAST_BOOKING_DATE', type: 'date' },
  { name: 'LAST_ROUTE', type: 'text' },
  { name: 'BOOKINGS_COUNT', type: 'float' },
  { name: 'CONSENT_AT', type: 'date' },
  { name: 'CONSENT_SOURCE', type: 'text' },
];
// settings (k/v) table key where the created-or-found Brevo list id is stored
// (db.js:getSetting/setSetting — the same generic settings table the owner
// alert throttles already reuse).
export const BREVO_LIST_ID_SETTING_KEY = 'brevo_list_id';

// brevo_sync_queue retry (BUILD item #7) — same shape as the failed_email
// retry constants above, separate numbers so the two queues can never
// accidentally share a clock.
export const BREVO_SYNC_MAX_ATTEMPTS = 5;
export const BREVO_SYNC_RETRY_BACKOFF_MINUTES = [5, 15, 60, 240, 720]; // 5m,15m,1h,4h,12h
export const BREVO_SYNC_RESOLVED_RETENTION_MINUTES = 30 * 24 * 60; // 30 days
export const BREVO_SYNC_ALERT_THROTTLE_MINUTES = 60;

// route slug -> public route page path, used for Stripe cancel_url / Meta event_source_url
export const ROUTE_PATHS = {
  amsterdam: '/amsterdam/',
  utrecht: '/utrecht/',
  groningen: '/groningen/',
  delft: '/delft/',
  'rotterdam-witte-de-with': '/rotterdam/route-1/',
  'rotterdam-hidden-gems': '/rotterdam/route-2/',
  'rotterdam-premium-gin': '/rotterdam/route-3-premium/',
};

export function routePathFor(route) {
  return ROUTE_PATHS[route.id] || '/';
}

// --- Review requests (migrations/0026_review_requests.sql, BUILD §20) ------
// "Review op Google" is reserved but INERT until the owner supplies her real
// g.page/Google review link — an empty string means src/emails.js simply
// omits that second button rather than linking somewhere wrong.
export const REVIEW_TRUSTPILOT_URL_EN = 'https://www.trustpilot.com/evaluate/wogoamsterdam.com';
export const REVIEW_TRUSTPILOT_URL_NL = 'https://nl.trustpilot.com/evaluate/wogoamsterdam.com';
// WOGO's Google Business Profile write-a-review deep link. Place ID resolved
// 13 Oct 2026 from the live Maps listing ("WOGO", Tour agency, 4.4★) — Google
// asks the guest to sign in first, then drops them straight on the star form.
export const REVIEW_GOOGLE_URL = 'https://search.google.com/local/writereview?placeid=ChIJ1wXRBqXvxUcRbYfPMEY-eVg';

// --- Analytics (BUILD §19, GET /admin/api/analytics) ------------------------
// A wide-open date range would scan an unbounded number of booking rows (and
// an unbounded JS array in logic.js:buildBookingAnalytics) — cap it. 400 days
// covers "this year" + slack with room to spare; a real owner-facing report
// never needs more in one call.
export const ANALYTICS_MAX_RANGE_DAYS = 400;

// --- Blog (migrations/0030_blog_posts.sql, BUILD §21) ------------------------

// Site-wide launch gate (SETUP.md "cutover" list): the ENTIRE static site
// still ships `<meta name="robots" content="noindex">` on every page until
// the real domain goes live (see every existing page's head comment,
// `blog/best-cocktail-bars-in-rotterdam/index.html` included). The blog
// renderer (src/blog_render.js) and the publish endpoint mirror that SAME
// rule for posts it generates: while this is `true`, every rendered post
// carries `noindex` and is never added to sitemap.xml, regardless of its own
// `status`. FLIP THIS TO `false` AT CUTOVER (the one line SETUP.md points
// at) — every post already marked 'published' then needs one real
// re-publish (or a one-off re-render pass) to pick up the change, since
// noindex/sitemap membership is baked into the committed HTML/XML at publish
// time, not computed at request time (the files are static).
export const SITE_NOINDEX = true;

// The dashboard's fixed category chips (BUILD §21.4) — validated server-side
// on every blog_posts write so a typo'd category can't silently create a
// new, uncategorized bucket. Adding a category later is a one-line change
// here, no migration needed (the column is plain TEXT).
export const BLOG_CATEGORIES = ['City guide', 'New route', 'Explained', 'Recipes', 'News'];

// Slug shape (BUILD §21.2) — lowercase letters/digits/hyphens, 3-80 chars,
// immutable after a post's first publish — lives in src/logic.js as
// `BLOG_SLUG_RE`/`validateBlogSlug` (a pure, zero-import module) rather than
// here, so there is exactly ONE definition instead of two that could drift.

// Asset upload limits (BUILD §21's "multipart image upload ≤ 2.5MB, jpg/png/
// webp") — kept here, not hardcoded in admin_api.js, so the dashboard's own
// client-side pre-check (admin.js) and the server's real guard can never
// silently drift, same pattern as GIFT_CARD_TIERS_CENTS etc. above.
export const BLOG_ASSET_MAX_BYTES = 2.5 * 1024 * 1024;
export const BLOG_ASSET_ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Field length caps — same "kept in config.js so client and server can't
// drift" pattern as CONTACT_NAME_MAX_LENGTH etc. above.
export const BLOG_TITLE_MAX_LENGTH = 200;
export const BLOG_EXCERPT_MAX_LENGTH = 400;
export const BLOG_SEO_TITLE_MAX_LENGTH = 70;
export const BLOG_SEO_DESCRIPTION_MAX_LENGTH = 160;
export const BLOG_ALT_MAX_LENGTH = 160;
export const BLOG_BODY_MAX_LENGTH = 50000; // sanity cap, well above any real post

// The real, production domain — used ONLY in meta/OG/canonical/JSON-LD tags
// on a rendered blog post (src/blog_render.js), matching the convention
// every hand-built page already follows (e.g. every existing /blog/*/
// post's <meta property="og:image"> already points at
// www.wogococktailwalk.com, not SITE_ASSET_BASE, even though that domain
// isn't live yet — the site-wide noindex is what covers for that until
// cutover). NEVER used for an actual fetched resource (<img src>, <link
// preload>) — those use SITE_ASSET_BASE below, which resolves RIGHT NOW.
export const BLOG_CANONICAL_BASE = 'https://www.wogococktailwalk.com';

// GitHub Contents API (src/github.js) — the publish/unpublish/asset-upload
// write path to the static site's repo. `GITHUB_TOKEN` (repo scope) and
// `GITHUB_REPO` ("owner/repo", e.g. 'WOGOCocktailWalk/wogo-homepage') are
// both Worker SECRETS (`wrangler secret put ...`), never written here — see
// SETUP.md. This constant is just the stable, non-secret API host.
export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_COMMIT_BRANCH_DEFAULT = 'main';
export const GITHUB_COMMIT_AUTHOR = { name: 'WOGO Admin', email: 'info@wogoamsterdam.com' };

// --- UTM / source capture on bookings (migrations/0027, BUILD §19 Marketing
// pass) ------------------------------------------------------------------
// Captured client-side by the widget (window.__wogoCarry, falling back to
// this page's own location.search) and POSTed as part of /api/book. The
// length cap AND the "Direct / unknown" grouping label both live in
// logic.js (UTM_FIELD_MAX_LENGTH / DIRECT_SOURCE_LABEL, next to the pure
// validateUtmFields/buildHighlightsSales functions they bound) rather than
// here, so the one pure module and its own constants can never drift apart
// the way a cross-file duplicate could.

// --- Abandoned-booking reminders (migrations/0031, src/abandoned.js) -------
// A 'hold'/'expired' booking with a real email that never became confirmed.
// Sent at most twice: one "still free" nudge ~1h after the hold was created,
// one follow-up ~24h after — both only if the guest still hasn't booked (see
// src/abandoned.js's blocking-booking check) and the slot still has seats.
// The lower bound of each window is exact ("at least this old"); the upper
// bound (ABANDONED_WINDOW_MAX_MINUTES) is a safety backstop so a cron outage
// lasting days doesn't suddenly fire a pile of stale nudges once it recovers.
export const ABANDONED_FIRST_EMAIL_MIN_MINUTES = 60;        // send the 1st mail once the hold is at least this old
export const ABANDONED_FOLLOWUP_MIN_MINUTES = 24 * 60;      // send the follow-up once the hold is at least this old
export const ABANDONED_WINDOW_MAX_MINUTES = 48 * 60;        // never consider a hold older than this (stale safety cap)
// Owner policy default: NO discount in either abandoned-booking email. Kept
// as a named constant (not a bare '' inline in emails.js) so turning one on
// later is a one-line change here — when empty, src/emails.js renders no
// discount block at all, never an empty/broken one.
export const ABANDONED_DISCOUNT_CODE = '';

// --- Walk reminder, 2 days before (migrations/0031, src/reminders.js) ------
export const WALK_REMINDER_DAYS_BEFORE = 2;

// REMOVED 2026-10-14 — `THANKYOU_CODE`, the discount constant for the
// post-review thank-you mail. That whole flow is gone (no system ever learns
// that a review was left, so it required the owner to spot one and press a
// button by hand). See src/emails.js §18 and src/admin_api.js.

// --- Reminder opt-out (migrations/0031) -------------------------------------
// A one-click unsubscribe shared by all three flows above (NOT the marketing
// `subscribers` list — see migrations/0031's own comment on why these are
// deliberately separate tables). The token is self-contained (no DB lookup
// needed to find "which email is this"): see src/reminder_optout.js.
export const REMINDER_UNSUBSCRIBE_PATH = '/api/reminders/unsubscribe';

// The Worker's own public base URL — needed by cron-triggered sends (the
// abandoned-booking sweep, the walk-reminder cron) to build the reminder-
// unsubscribe link; unlike every admin-login/subscribe link elsewhere in
// this codebase, there is no incoming `request` to read an origin off
// inside a scheduled() run. Prefers env.HEALTH_CHECK_BASE_URL — SETUP.md
// §14's existing "the Worker's own public base URL" var, already exactly
// this value once the owner sets it — falling back to this constant, the
// real workers.dev URL `widget/wogo-calendar.js`'s WOGO_API currently points
// at. Update BOTH if the Worker's URL ever changes (custom domain, rename).
export const WORKER_BASE_URL_FALLBACK = 'https://wogo-booking-backend.purple-glitter-720e.workers.dev';
export function workerBaseUrl(env) {
  return (env && env.HEALTH_CHECK_BASE_URL) ? env.HEALTH_CHECK_BASE_URL.replace(/\/$/, '') : WORKER_BASE_URL_FALLBACK;
}

// --- Web Push (migrations/0032_push_notifications.sql) ---------------------
// PWA-installable dashboard + real push, replacing the Wix app notification
// the owner is losing at cutover. Web Crypto only, no new runtime deps.
//
// VAPID_PUBLIC_KEY is NOT sensitive — the browser hands it straight back to
// Apple/Google/Mozilla's push service on every subscribe call (same
// "public by design" class as TURNSTILE_SITE_KEY), so it's a plain
// committed constant, not a secret. Generated once (SETUP.md has the exact
// command) as a real P-256 keypair; the matching PRIVATE half lives ONLY in
// the `VAPID_PRIVATE_KEY` Worker secret (a JWK string) — never in this file,
// never logged, never in a report. Rotating the keypair means regenerating
// BOTH halves together (a mismatched pair fails every push silently) and
// every existing browser subscription goes stale (SETUP.md's rotation
// section) — that's also exactly what happens if the dashboard's domain
// ever changes at cutover, since a PushSubscription is scoped to the origin
// that created it (see MIGRATION-PLAYBOOK.md's cutover list).
export const VAPID_PUBLIC_KEY = 'BHOHSWISk9LD-VTpFAaWhezzPrh4VkaqRuuDPWLDjy2LqeI6QgTK1u71hUbkNjrDzxGSlpg09q2FDwjFfOdSuFo';
// RFC 8292 requires a contact — a push service may use this to reach the
// sender if it needs to (e.g. "you're sending too much"), never shown to a
// guest or device owner.
export const VAPID_SUBJECT = 'mailto:info@wogoamsterdam.com';
// VAPID JWTs are capped at 24h by RFC 8292; a fresh one is signed on every
// send (Web Crypto signing is cheap), so this just needs to comfortably
// outlive one HTTP round trip to the push service.
export const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60; // 12h
// Web Push Protocol (RFC 8030) TTL header — how long the push SERVICE should
// hold the tickle if the device is offline. A notification this build sends
// is time-sensitive ("a sale just happened") — not worth re-delivering after
// an hour, so this is short on purpose rather than the protocol max (4 weeks).
export const PUSH_TTL_SECONDS = 60 * 60; // 1h

// Preference groups shown as toggles in the dashboard's Notifications
// settings card — kept here (not hardcoded in admin_api.js / admin.js) so
// the server-side filter and the client-side UI can never silently drift,
// same "one list, two readers" pattern as GIFT_CARD_TIERS_CENTS etc. above.
// `booking_cancelled` AND `booking_moved` share the `cancellation` group —
// the owner asked for 5 toggles, not 6, so "a booking changed" is one
// switch covering both ways a confirmed booking can change after the fact.
// `test` deliberately has NO group — the Settings "send me a test
// notification" button always delivers, regardless of what's toggled off,
// so a person can always verify a device still works.
export const NOTIFICATION_PREFERENCE_GROUPS = [
  { key: 'new_booking', label: 'New booking' },
  { key: 'cancellation', label: 'Cancelled or moved booking' },
  { key: 'gift_card', label: 'Gift card sold' },
  { key: 'enquiry', label: 'Contact / group enquiry' },
  { key: 'problems', label: 'Something went wrong' },
];
export const NOTIFICATION_KIND_PREFERENCE_GROUP = {
  booking_new: 'new_booking',
  booking_cancelled: 'cancellation',
  booking_moved: 'cancellation',
  giftcard_sold: 'gift_card',
  enquiry: 'enquiry',
  problem: 'problems',
  test: null,
};
export const NOTIFICATION_DEFAULT_PREFERENCES = {
  new_booking: true, cancellation: true, gift_card: true, enquiry: true, problems: true,
};

// Retention for the notifications feed (pruned in the existing 0 3 * * *
// daily cron, src/notifications.js:pruneOldNotifications) — a READ
// notification is low-value after a couple of weeks (the owner has already
// seen it); an UNREAD one is kept much longer on the theory that "nobody's
// looked at this yet" shouldn't silently vanish.
export const NOTIFICATION_READ_RETENTION_MINUTES = 14 * 24 * 60;   // 14 days
export const NOTIFICATION_RETENTION_MINUTES = 180 * 24 * 60;       // 180 days, read or not
