// src/subscribers.js — orchestration for the newsletter subscriber plumbing
// (migrations/0024, BUILD §17). Ties together local `subscribers` storage
// (db.js), the Brevo CONTACTS API (brevo.js), and the owned HTML emails
// (emails.js) behind a small set of functions that guest_api.js, webhook.js,
// and admin_api.js call without needing to know Brevo's wire shapes.
//
// Reliability contract (BUILD item #7): every Brevo CONTACTS call in this
// file is wrapped so a Brevo outage NEVER turns a successful local write (the
// thing the guest/owner is actually waiting on — the confirmed row, the paid
// booking) into a failed response. A failed Brevo call is queued to
// `brevo_sync_queue` instead of thrown; src/brevo_sync.js's cron-driven
// `retryBrevoSyncQueue` drains it with the same attempts/backoff/give-up-and-
// alert shape src/email_retry.js already uses for transactional email.
//
// Design note on "do" vs. wrapped functions: the `do*` functions below are
// the single implementation of each Brevo write and THROW on failure — both
// the live call sites (wrapped via `withRetryQueue`) and the retry-queue
// drain (`replaySyncItem`, called from src/brevo_sync.js) call the SAME `do*`
// function, so there is exactly one place that builds each Brevo payload.
// `replaySyncItem` deliberately does NOT catch its own errors — letting them
// propagate is what lets brevo_sync.js's loop own the attempts/backoff
// bookkeeping; wrapping again here would double-queue and never give up.

import * as db from './db.js';
import { getContact, upsertContact, updateContact, unsubscribeContact } from './brevo.js';
import { sendWithRetry } from './email_retry.js';
import { renderSubscribeWelcome } from './emails.js';
import { sqliteMinutesFromNow } from './logic.js';
import { BREVO_LIST_ID_SETTING_KEY, BREVO_SYNC_RETRY_BACKOFF_MINUTES } from './config.js';

const brevoDefault = { getContact, upsertContact, updateContact, unsubscribeContact };

/** Opaque random token — used for both confirm_token and unsubscribe_token.
 * crypto.randomUUID() is already used this way throughout the codebase
 * (booking ids, gift card ids); the hyphens are stripped purely so the token
 * reads as one URL-safe chunk in a query string. */
export function generateToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function getBrevoListId(env, deps = {}) {
  const database = deps.database || db;
  const raw = await database.getSetting(env.DB, BREVO_LIST_ID_SETTING_KEY);
  return raw ? Number(raw) : null;
}

/**
 * Builds the Brevo attribute object for a subscriber row. `extra` merges in
 * booking-derived fields (LAST_BOOKING_DATE/LAST_ROUTE/BOOKINGS_COUNT) or a
 * specific `consentSource` override — Brevo's contact-attribute update is a
 * MERGE, not a full replace, so a field omitted here simply leaves whatever
 * Brevo already has untouched (verified against Brevo's own API docs for
 * POST/PUT /contacts) — safe to never re-send BOOKINGS_COUNT on a plain
 * confirm, for instance.
 */
function subscriberAttributes(subscriber, { consentSource, ...extra } = {}) {
  return {
    LANGUAGE: (subscriber.locale || 'en').toUpperCase(),
    CITY_INTEREST: subscriber.city || '',
    SOURCE: subscriber.source || '',
    FIRST_NAME: subscriber.first_name || '',
    CONSENT_AT: String(subscriber.confirmed_at || subscriber.created_at || '').slice(0, 10) || undefined,
    CONSENT_SOURCE: consentSource || subscriber.source || '',
    ...extra,
  };
}

async function queueRetry(database, env, kind, payload) {
  try {
    await database.queueBrevoSync(env.DB, {
      kind,
      payload,
      last_error: null,
      next_attempt_at: sqliteMinutesFromNow(BREVO_SYNC_RETRY_BACKOFF_MINUTES[0]),
    });
  } catch (err) {
    console.error('brevo_sync_queue_write_failed', kind, err);
  }
}

/** Runs `fn` (a `do*` call below); on failure, logs and queues a retry row
 * instead of letting the error reach the caller — the contract every LIVE
 * call site in this file relies on. Never throws. */
async function withRetryQueue(database, env, kind, payload, fn) {
  try {
    await fn();
  } catch (err) {
    console.error('brevo_sync_failed_queuing_retry', kind, err);
    await queueRetry(database, env, kind, payload);
  }
}

// ---------------------------------------------------------------------------
// The three Brevo writes this feature ever makes — each THROWS on failure;
// callers either wrap via withRetryQueue (live path) or let it propagate to
// src/brevo_sync.js's own attempts/backoff loop (retry-drain path).
// ---------------------------------------------------------------------------

/** Upserts a CONFIRMED subscriber into the WOGO list — the double opt-in
 * click, or a plain Wix-import row. No booking-specific attributes. */
async function doSyncConfirmed(env, subscriber, consentSource, deps = {}) {
  const database = deps.database || db;
  const brevo = deps.brevo || brevoDefault;
  const listId = await getBrevoListId(env, { database });
  await brevo.upsertContact(env, {
    email: subscriber.email,
    attributes: subscriberAttributes(subscriber, { consentSource }),
    listIds: listId ? [listId] : undefined,
  });
}

/** Upserts a CONFIRMED subscriber into the WOGO list WITH booking context —
 * the booking-opt-in-checkbox consent act (BUILD item #3's first half).
 * BOOKINGS_COUNT is read-then-incremented off whatever Brevo already has
 * (there is no atomic "increment" verb in the Brevo contacts API). */
async function doSyncBookingOptIn(env, subscriber, booking, route, deps = {}) {
  const database = deps.database || db;
  const brevo = deps.brevo || brevoDefault;
  const listId = await getBrevoListId(env, { database });
  const existing = await brevo.getContact(env, subscriber.email).catch(() => null);
  const bookingsCount = (existing && existing.attributes && Number(existing.attributes.BOOKINGS_COUNT)) || 0;
  await brevo.upsertContact(env, {
    email: subscriber.email,
    attributes: subscriberAttributes(subscriber, {
      consentSource: 'booking',
      LAST_BOOKING_DATE: booking.date,
      LAST_ROUTE: route.name,
      BOOKINGS_COUNT: bookingsCount + 1,
    }),
    listIds: listId ? [listId] : undefined,
  });
}

/** Patches LAST_BOOKING_DATE/LAST_ROUTE/BOOKINGS_COUNT on an email that is
 * ALREADY a Brevo contact — never creates one (BUILD item #3's second half:
 * "don't create contacts without consent"). A no-op (not an error) when the
 * email isn't a Brevo contact at all. */
async function doSyncBookingAttributesIfExists(env, email, routeName, date, deps = {}) {
  const brevo = deps.brevo || brevoDefault;
  const existing = await brevo.getContact(env, email).catch((err) => {
    if (err && err.status === 404) return null;
    throw err;
  });
  if (!existing) return; // correctly never created
  const bookingsCount = (existing.attributes && Number(existing.attributes.BOOKINGS_COUNT)) || 0;
  await brevo.updateContact(env, email, {
    attributes: { LAST_BOOKING_DATE: date, LAST_ROUTE: routeName, BOOKINGS_COUNT: bookingsCount + 1 },
  });
}

async function doUnsubscribe(env, email, deps = {}) {
  const database = deps.database || db;
  const brevo = deps.brevo || brevoDefault;
  const listId = await getBrevoListId(env, { database });
  await brevo.unsubscribeContact(env, email, listId || undefined);
}

// ---------------------------------------------------------------------------
// Live call sites — each never throws (withRetryQueue absorbs the Brevo call;
// the local D1 write the guest/owner is waiting on has already happened by
// the time any of these run).
// ---------------------------------------------------------------------------

/** After the double opt-in click confirms a 'pending' row (BUILD item #2). */
export async function syncConfirmedSubscriber(env, subscriber, deps = {}) {
  const database = deps.database || db;
  await withRetryQueue(database, env, 'subscriber_confirm', { subscriber_id: subscriber.id }, () =>
    doSyncConfirmed(env, subscriber, 'double_opt_in', deps)
  );
}

/** A Wix-import row (BUILD item #5) — pre-consented history, straight to
 * 'confirmed', CONSENT_SOURCE='wix_import'. */
export async function syncImportedSubscriber(env, subscriber, deps = {}) {
  const database = deps.database || db;
  await withRetryQueue(database, env, 'subscriber_confirm', { subscriber_id: subscriber.id }, () =>
    doSyncConfirmed(env, subscriber, 'wix_import', deps)
  );
}

/**
 * The whole BUILD item #3 decision tree, called once per CONFIRMED booking
 * from src/webhook.js (Stripe-paid) and src/admin_api.js (manual/phone).
 * `opts.baseUrl` is this Worker's own origin (derived by the caller from its
 * own request — e.g. `new URL(request.url).origin` — never SITE_URL, which
 * is the STATIC site's domain, not this Worker's), used to build the welcome
 * email's unsubscribe link. Never throws.
 */
export async function handleConfirmedBookingOptIn(env, booking, route, opts = {}, deps = {}) {
  const database = deps.database || db;
  const brevoSend = deps.sendTransactional;

  try {
    if (booking.marketing_opt_in) {
      const existingLocal = await database.getSubscriberByEmail(env.DB, booking.email);
      const wasAlreadyConfirmed = !!(existingLocal && existingLocal.status === 'confirmed');
      const firstName = booking.name ? String(booking.name).trim().split(/\s+/)[0] : null;

      const subscriber = await database.upsertConfirmedSubscriber(env.DB, {
        id: existingLocal ? existingLocal.id : `sub_${crypto.randomUUID()}`,
        email: booking.email,
        first_name: firstName,
        locale: booking.locale,
        city: route.city,
        source: 'booking_opt_in',
        unsubscribe_token: existingLocal ? existingLocal.unsubscribe_token : generateToken(),
      });

      await withRetryQueue(
        database, env, 'subscriber_booking_optin',
        { subscriber_id: subscriber.id, route_name: route.name, date: booking.date },
        () => doSyncBookingOptIn(env, subscriber, booking, route, deps)
      );

      // Welcome email (with WELCOME10) only the FIRST time this email becomes
      // a confirmed subscriber — a guest who already has the code from an
      // earlier subscribe/booking shouldn't get a second "welcome" + code
      // reminder on every later booking.
      if (!wasAlreadyConfirmed && opts.baseUrl) {
        const unsubscribeUrl = `${opts.baseUrl}/api/unsubscribe?token=${subscriber.unsubscribe_token}`;
        const mail = renderSubscribeWelcome(subscriber, { unsubscribeUrl });
        await sendWithRetry(
          env,
          { to: subscriber.email, subject: mail.subject, htmlContent: mail.html },
          { database, sendTransactional: brevoSend, kind: 'subscribe_welcome' }
        );
      }
    } else {
      await withRetryQueue(
        database, env, 'booking_attributes',
        { email: booking.email, route_name: route.name, date: booking.date },
        () => doSyncBookingAttributesIfExists(env, booking.email, route.name, booking.date, deps)
      );
    }
  } catch (err) {
    // Belt-and-suspenders: withRetryQueue already absorbs Brevo failures, so
    // this only catches a genuinely unexpected bug in the local D1 write
    // above — still must never bubble into a 500 for a guest who already paid.
    console.error('booking_opt_in_sync_failed', booking.id, err);
  }
}

/** GET /api/unsubscribe — the local row is already flipped by the time this
 * runs (src/guest_api.js); this only mirrors it to Brevo. Never throws. */
export async function syncUnsubscribe(env, email, deps = {}) {
  const database = deps.database || db;
  await withRetryQueue(database, env, 'subscriber_unsubscribe', { email }, () => doUnsubscribe(env, email, deps));
}

// ---------------------------------------------------------------------------
// Wix CSV import (BUILD item #5) — POST /admin/api/subscribers/import.
// ---------------------------------------------------------------------------

const IMPORT_CHUNK_SIZE = 100;
const IMPORT_CHUNK_DELAY_MS = 1000; // small pause between chunks, per BUILD item #5

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Batch-upserts an already-validated array of { email, first_name?, locale?,
 * city? } rows (admin_api.js validates shape/size before calling this) as
 * confirmed, source='wix_import' subscribers — both locally (D1) and in
 * Brevo, chunked to respect Brevo's rate limits. A per-row Brevo failure
 * queues that one row for retry rather than aborting the whole import; a
 * per-row LOCAL D1 failure (should be rare — only a constraint violation)
 * is recorded in the returned `errors` array and the row is skipped.
 */
export async function importSubscribers(env, rows, deps = {}) {
  const database = deps.database || db;
  let imported = 0;
  let updated = 0;
  let queuedForRetry = 0;
  const errors = [];
  const subscribersToSync = [];

  for (const row of rows) {
    try {
      const email = String(row.email).trim().toLowerCase();
      const existingLocal = await database.getSubscriberByEmail(env.DB, email);
      const subscriber = await database.upsertConfirmedSubscriber(env.DB, {
        id: existingLocal ? existingLocal.id : `sub_${crypto.randomUUID()}`,
        email,
        first_name: row.first_name || null,
        locale: row.locale === 'nl' ? 'nl' : 'en',
        city: row.city || null,
        source: 'wix_import',
        unsubscribe_token: existingLocal ? existingLocal.unsubscribe_token : generateToken(),
      });
      if (existingLocal) updated++; else imported++;
      subscribersToSync.push(subscriber);
    } catch (err) {
      errors.push({ email: row.email, error: String(err && err.message ? err.message : err) });
    }
  }

  for (let i = 0; i < subscribersToSync.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = subscribersToSync.slice(i, i + IMPORT_CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map((s) => doSyncConfirmed(env, s, 'wix_import', deps)));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'rejected') {
        console.error('brevo_sync_failed_queuing_retry', 'subscriber_confirm (import)', chunk[j].email, results[j].reason);
        await queueRetry(database, env, 'subscriber_confirm', { subscriber_id: chunk[j].id });
        queuedForRetry++;
      }
    }
    if (i + IMPORT_CHUNK_SIZE < subscribersToSync.length) await sleep(IMPORT_CHUNK_DELAY_MS);
  }

  return { imported, updated, queued_for_retry: queuedForRetry, errors };
}

// ---------------------------------------------------------------------------
// Retry-queue drain dispatch (src/brevo_sync.js calls this per due row).
// Deliberately does NOT catch its own errors — see the file-level doc comment.
// ---------------------------------------------------------------------------

export async function replaySyncItem(env, kind, payload, deps = {}) {
  const database = deps.database || db;

  if (kind === 'subscriber_confirm' || kind === 'subscriber_booking_optin') {
    const subscriber = await database.getSubscriberById(env.DB, payload.subscriber_id);
    if (!subscriber) return; // row gone (e.g. hand-deleted) — nothing left to sync
    if (kind === 'subscriber_booking_optin' && payload.route_name) {
      await doSyncBookingOptIn(env, subscriber, { date: payload.date }, { name: payload.route_name }, deps);
    } else {
      await doSyncConfirmed(env, subscriber, subscriber.source === 'wix_import' ? 'wix_import' : 'double_opt_in', deps);
    }
    return;
  }
  if (kind === 'booking_attributes') {
    await doSyncBookingAttributesIfExists(env, payload.email, payload.route_name, payload.date, deps);
    return;
  }
  if (kind === 'subscriber_unsubscribe') {
    await doUnsubscribe(env, payload.email, deps);
    return;
  }
  console.warn('unknown_brevo_sync_kind', kind);
}
