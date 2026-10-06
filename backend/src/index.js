// src/index.js — entry point. export default { fetch, scheduled }.
// Plain Web-standard fetch handler — no Cloudflare-specific APIs beyond the
// env.DB binding (touched only inside db.js) and the Cron Trigger signature.

import { createRouter } from './router.js';
import * as guestApi from './guest_api.js';
import * as adminApi from './admin_api.js';
import { handleWebhook } from './webhook.js';
import { roleAtLeast } from './auth.js';
import {
  expireHolds, pruneRateEvents, pruneAuthEvents,
  pruneErrorLog, pruneAdminAudit, pruneResolvedFailedEmails,
  pruneResolvedBrevoSyncItems,
} from './db.js';
import { constantTimeEqual, sqliteMinutesAgo } from './logic.js';
import {
  RATE_EVENTS_RETENTION_MINUTES, AUTH_EVENTS_RETENTION_MINUTES,
  ERROR_LOG_RETENTION_MINUTES, ADMIN_AUDIT_RETENTION_MINUTES,
  FAILED_EMAIL_RESOLVED_RETENTION_MINUTES, BREVO_SYNC_RESOLVED_RETENTION_MINUTES,
} from './config.js';
import { adminResponse } from './admin/assets.js';
import { withSecurityHeaders } from './security_headers.js';
import { captureError } from './errors.js';
import { runHealthCheck } from './healthcheck.js';
import { retryFailedEmails } from './email_retry.js';
import { runGdprRetention } from './retention.js';
import { exportBackupToR2 } from './backup.js';
import { retryBrevoSyncQueue } from './brevo_sync.js';
import { sendDailyReviewRequests } from './reviews.js';

// Second, less-frequent cron for daily housekeeping (GDPR retention, R2
// backup export, pruning the long-retention audit/error/email-log tables) —
// see wrangler.toml's `[triggers]` block. The frequent 5-minute trigger stays
// dedicated to what actually needs 5-minute latency (hold expiry, the
// failed-email retry queue's first backoff step, the health check).
const DAILY_CRON = '0 3 * * *';

// Third daily cron, deliberately a SEPARATE time from DAILY_CRON — review
// requests (BUILD §20) need to land in a guest's inbox at a sensible hour,
// not 3am. 09:00 UTC = 10:00 Amsterdam in winter (CET) / 11:00 in summer
// (CEST) — either is a reasonable late-morning send; see wrangler.toml's
// `[triggers]` block.
const REVIEW_CRON = '0 9 * * *';

const router = createRouter();
// Named export, test-only (test/admin_users.test.js walks router.routes() to
// assert every /admin/api/* route has a ROUTE_ROLES entry) — production code
// only ever uses the default export.
export { router };

// -- Guest API ---------------------------------------------------------------
router.get('/api/geo', guestApi.handleGeo);
router.get('/api/routes', guestApi.handleListRoutes);
router.get('/api/availability', guestApi.handleAvailability);
router.get('/api/slots', guestApi.handleSlots);
router.get('/api/booking', guestApi.handleBookingLookup);
router.post('/api/book', guestApi.handleBook);
router.post('/api/giftcard/checkout', guestApi.handleGiftCardCheckout);
router.post('/api/contact', guestApi.handleContact);
router.post('/api/subscribe', guestApi.handleSubscribe);
router.get('/api/subscribe/confirm', guestApi.handleSubscribeConfirm);
router.get('/api/unsubscribe', guestApi.handleUnsubscribe);

// -- Webhook ------------------------------------------------------------------
router.post('/webhooks/stripe', (request, env) => handleWebhook(request, env));

// -- Internal cron fallback (portability, §10) ---------------------------------
router.post('/internal/cron/expire-holds', async (request, env) => {
  const provided = request.headers.get('X-Cron-Secret') || '';
  // Constant-time compare + closed-by-default when the secret isn't configured.
  if (!env.CRON_SECRET || !constantTimeEqual(provided, env.CRON_SECRET)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const result = await expireHolds(env.DB);
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

// -- Admin auth -----------------------------------------------------------------
router.post('/admin/login', adminApi.handleLogin);
router.post('/admin/logout', adminApi.handleLogout);
// Public (pre-login) config the login form needs — today just whether
// Turnstile is on and, if so, its PUBLIC site key (not sensitive, same as a
// reCAPTCHA site key — see src/turnstile.js). Excluded from the session
// guard below like /admin/login and /admin/logout.
router.get('/admin/public-config', adminApi.handlePublicConfig);
// Personal team logins (migrations/0025_admin_users.sql, SPEC.md §18) — both
// public/pre-session, like the two routes above: the login-link REQUEST is
// the self-serve entry point (no session exists yet), and the magic-link
// CLICK carries its own one-time proof (the token itself), not a cookie.
router.post('/admin/login/request', adminApi.handleLoginLinkRequest);
router.get('/admin/login/magic', adminApi.handleLoginLinkMagic);

// -- Admin API (session-guarded, role-guarded — see ROUTE_ROLES below) ----------
router.get('/admin/api/me', adminApi.handleMe);
router.get('/admin/api/users', adminApi.handleListUsers);
router.post('/admin/api/users', adminApi.handleInviteUser);
router.put('/admin/api/users/:id', adminApi.handleUpdateUser);
router.get('/admin/api/analytics', adminApi.handleAnalytics);
router.get('/admin/api/analytics/kpi', adminApi.handleAnalyticsKpi);
router.get('/admin/api/analytics/traffic', adminApi.handleAnalyticsTraffic);
router.get('/admin/api/analytics/highlights', adminApi.handleAnalyticsHighlights);
router.get('/admin/api/analytics/realtime', adminApi.handleAnalyticsRealtime);
router.get('/admin/api/analytics/behavior', adminApi.handleAnalyticsBehavior);
router.get('/admin/api/analytics/marketing', adminApi.handleAnalyticsMarketing);
router.get('/admin/api/bookings', adminApi.handleListBookings);
router.get('/admin/api/bookings.csv', adminApi.handleExportCsv);
router.get('/admin/api/bookings/:id', adminApi.handleGetBooking);
router.get('/admin/api/participants-per-hour', adminApi.handleParticipantsPerHour);
router.get('/admin/api/routes', adminApi.handleListAllRoutes);
router.post('/admin/api/routes', adminApi.handleCreateRoute);
router.put('/admin/api/routes/:id', adminApi.handleUpdateRoute);
router.post('/admin/api/bookings/:id/resend', adminApi.handleResendConfirmation);
router.post('/admin/api/bookings/:id/reschedule', adminApi.handleRescheduleBooking);
router.post('/admin/api/bookings/:id/cancel', adminApi.handleCancelBooking);
router.post('/admin/api/bookings/:id/send-review', adminApi.handleSendReviewRequest);
router.get('/admin/api/routes/:id/bars', adminApi.handleListBars);
router.post('/admin/api/routes/:id/bars', adminApi.handleAddBar);
router.put('/admin/api/routes/:id/bars', adminApi.handleReplaceBars);
router.put('/admin/api/routes/:id/bars/:barId', adminApi.handleUpdateBar);
router.delete('/admin/api/routes/:id/bars/:barId', adminApi.handleDeleteBar);
router.get('/admin/api/date-overrides', adminApi.handleListOverrides);
router.post('/admin/api/date-overrides', adminApi.handleCreateOverride);
router.delete('/admin/api/date-overrides/:id', adminApi.handleDeleteOverride);

// -- Customers (CRM) + manual (phone) booking — Dashboard v2 -----------------
router.get('/admin/api/customers', adminApi.handleListCustomers);
router.get('/admin/api/customers/:email', adminApi.handleGetCustomer);
router.put('/admin/api/customers/:email', adminApi.handleUpdateCustomer);
router.post('/admin/api/bookings/manual', adminApi.handleCreateManualBooking);

// -- Security audit (SPEC.md §15.2) — session-guarded like all /admin/api/* --
router.get('/admin/api/security/login-attempts', adminApi.handleLoginAttempts);

// -- Production hardening (2026-07): dashboard-readable observability -------
router.get('/admin/api/audit-log', adminApi.handleAuditLog);
router.get('/admin/api/error-log', adminApi.handleErrorLog);
router.get('/admin/api/failed-emails', adminApi.handleFailedEmails);
router.get('/admin/api/health', adminApi.handleHealthCheck);

// -- Gift cards (migrations/0018/0019) ---------------------------------------
router.get('/admin/api/gift-cards', adminApi.handleListGiftCards);
router.post('/admin/api/gift-cards/:code/void', adminApi.handleVoidGiftCard);

// -- Contact + group-booking inquiries (migrations/0021) ---------------------
router.get('/admin/api/inquiries', adminApi.handleListInquiries);

// -- Newsletter subscribers (migrations/0024, BUILD §17) ---------------------
router.post('/admin/api/brevo/setup', adminApi.handleBrevoSetup);
router.post('/admin/api/brevo/push-reference-templates', adminApi.handleBrevoPushReferenceTemplates);
router.post('/admin/api/stripe/ensure-welcome-code', adminApi.handleEnsureWelcomeCode);
router.get('/admin/api/subscribers', adminApi.handleListSubscribers);
router.get('/admin/api/subscribers.csv', adminApi.handleSubscribersCsv);
router.post('/admin/api/subscribers/import', adminApi.handleImportSubscribers);
router.get('/admin/api/subscribers/sync-queue', adminApi.handleBrevoSyncQueue);

const ADMIN_API_PREFIX = '/admin/api/';
const PUBLIC_ADMIN_PATHS = new Set([
  '/admin/login', '/admin/logout', '/admin/public-config',
  '/admin/login/request', '/admin/login/magic',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    let response;
    try {
      // CORS preflight for the public guest API only.
      if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
        response = guestApi.handleOptions(request);
      } else if (
        // /admin and /admin/login both serve the SAME single-page app shell —
        // it's not two server-rendered pages, it's one SPA that shows its own
        // login view client-side (src/admin/admin.js: boot() calls an /admin/api/*
        // endpoint and shows the login form on a 401). The shell HTML itself
        // carries no data, so it needs no session check to be served.
        // GET only — POST /admin/login is the actual login API call and must
        // reach the router (adminApi.handleLogin), not this shortcut.
        request.method === 'GET' && (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/login')
      ) {
        response = adminResponse();
      } else {
        // Matched ONCE, up front — both the role check below and the final
        // dispatch need the SAME match (its `pattern` is how ROUTE_ROLES is
        // keyed; see src/router.js/src/admin_api.js:ROUTE_ROLES).
        const match = request.method === 'OPTIONS' ? null : router.match(request.method, pathname);

        // Session + role guard for /admin/api/* (the only part that's
        // actually gated). /admin/login, /admin/logout, /admin/public-config,
        // /admin/login/request and /admin/login/magic are intentionally
        // public (login IS the auth check; logout must work even with a
        // stale/expired cookie; public-config/login-request/login-magic are
        // what the pre-session login page itself needs).
        if (pathname.startsWith('/admin') && !PUBLIC_ADMIN_PATHS.has(pathname)) {
          const isApi = pathname.startsWith(ADMIN_API_PREFIX);
          // resolveSession (src/admin_api.js) wraps auth.js's pure cookie
          // decode with a live admin_users re-check for a personal login, so
          // a disable/role-change takes effect on this very request, not up
          // to 12h later when the cookie would otherwise expire.
          const session = await adminApi.resolveSession(request, env);
          if (!session) {
            if (isApi) {
              response = new Response(JSON.stringify({ error: 'unauthenticated' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              });
            } else {
              response = Response.redirect(`${url.origin}/admin/login`, 302);
            }
          } else {
            // Attach for handlers that need the acting identity — the
            // audit-trail `actor`, handleMe, and the Team-management
            // handlers (invited_by, last-owner guard context). See
            // admin_api.js's `audit()` doc comment for why this is a
            // Request property rather than a 5th handler argument.
            request.adminSession = session;

            if (isApi && ['POST', 'PUT', 'DELETE'].includes(request.method) && request.headers.get('X-Requested-With') !== 'wogo-admin') {
              // CSRF mitigation for state-changing admin API calls (§12.1).
              response = new Response(JSON.stringify({ error: 'forbidden', message: 'missing CSRF header' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
              });
            } else if (isApi && match) {
              // Default-deny: a route missing from ROUTE_ROLES requires
              // 'owner' — the most restrictive role, not the most permissive
              // — so a newly-added endpoint that forgets to register its
              // role fails CLOSED. test/admin_users.test.js asserts every
              // registered /admin/api/* route has an explicit entry, so this
              // default should never actually fire in practice.
              const minRole = adminApi.ROUTE_ROLES[`${match.method} ${match.pattern}`] || 'owner';
              if (!roleAtLeast(session.role, minRole)) {
                response = new Response(JSON.stringify({ error: 'forbidden', message: 'insufficient role' }), {
                  status: 403,
                  headers: { 'Content-Type': 'application/json' },
                });
              }
            }
          }
        }

        if (!response) {
          if (match) {
            response = await match.handler(request, env, match.params, ctx);
          } else {
            response = new Response(JSON.stringify({ error: 'not_found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
      }
    } catch (err) {
      console.error('unhandled_error', err);
      // Never let error reporting itself delay or risk the error response —
      // captureError never throws, but ctx.waitUntil keeps it running past
      // this return without the guest/admin waiting on it.
      ctx.waitUntil(captureError(env, err, { url: pathname, method: request.method }));
      response = new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return withSecurityHeaders(response);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env));
  },
};

/**
 * Consolidated cron entry point — see wrangler.toml's `[triggers]` for the
 * two schedules that call this. Every step is independently safe to re-run
 * (idempotent or purely additive), so a partial failure part-way through
 * just means "the rest catches up on the next tick", never a stuck state.
 * Any exception is captured the same way an unhandled fetch() exception is
 * (src/errors.js) — a crashing cron must not go unnoticed just because
 * nobody's looking at an HTTP response for it.
 */
async function runScheduled(event, env) {
  try {
    // Every trigger fire (currently every 5 minutes): expired-hold sweep
    // (§6.5, correctness does NOT depend on this cadence — see SPEC.md §7.2),
    // security-table retention pruning (§15), the failed-email retry drain
    // (short backoff steps start at 5 minutes — src/config.js), and the
    // cheap self health-check (src/healthcheck.js).
    await expireHolds(env.DB);
    await pruneRateEvents(env.DB, sqliteMinutesAgo(RATE_EVENTS_RETENTION_MINUTES));
    await pruneAuthEvents(env.DB, sqliteMinutesAgo(AUTH_EVENTS_RETENTION_MINUTES));
    await retryFailedEmails(env);
    await retryBrevoSyncQueue(env);
    await runHealthCheck(env);

    if (event.cron === DAILY_CRON) {
      // Once/day: GDPR retention anonymization, the R2 backup export
      // (no-op until env.BACKUP_BUCKET is bound — src/backup.js), and
      // pruning the long-retention audit/error/resolved-email-log tables
      // (no value in pruning these every 5 minutes given their multi-month
      // retention windows).
      await runGdprRetention(env);
      await exportBackupToR2(env);
      await pruneErrorLog(env.DB, sqliteMinutesAgo(ERROR_LOG_RETENTION_MINUTES));
      await pruneAdminAudit(env.DB, sqliteMinutesAgo(ADMIN_AUDIT_RETENTION_MINUTES));
      await pruneResolvedFailedEmails(env.DB, sqliteMinutesAgo(FAILED_EMAIL_RESOLVED_RETENTION_MINUTES));
      await pruneResolvedBrevoSyncItems(env.DB, sqliteMinutesAgo(BREVO_SYNC_RESOLVED_RETENTION_MINUTES));
    }

    if (event.cron === REVIEW_CRON) {
      // Once/day, at a guest-friendly hour (not 3am) — the "how was your
      // walk?" review-request send (migrations/0026, BUILD §20).
      await sendDailyReviewRequests(env);
    }
  } catch (err) {
    console.error('scheduled_error', err);
    await captureError(env, err, { cron: event.cron });
  }
}
