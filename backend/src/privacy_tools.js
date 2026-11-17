// src/privacy_tools.js — owner-only "export or erase one person's data".
// Storage rules and the field-by-field erase decisions are documented above
// getCustomerData / eraseCustomerData in db.js. This file: validation, the
// plain-words summary and report, the audit trail, and the two handlers.

import * as db from './db.js';
import { hmacSign, sha256Hex, hasCsrfHeader } from './auth.js';

const EMAIL_RE = /^[^\s@"{}<>\\]+@[^\s@"{}<>\\]+\.[^\s@"{}<>\\]+$/;
export const ERASE_CONFIRM_WORD = 'ERASE';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function errorJson(code, message, status, extra = {}) {
  return json({ error: code, message: message || code, ...extra }, status);
}

/** Trimmed, lower-cased, valid, and not one of our own unreachable
 * placeholders. Returns null when unusable. An empty address must never get
 * through: several tables store '' for "no email". */
export function cleanPersonEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  if (email.endsWith('@wogoamsterdam.invalid')) return null;
  return email;
}

/** A stable reference for the audit log that is NOT the address itself:
 * HMAC of the address with the server secret, so it can be recomputed to
 * answer "did we erase this person?" but not reversed by guessing addresses. */
export async function personReference(env, email) {
  const msg = `privacy-audit:v1:${email}`;
  const full = env.ADMIN_SESSION_SECRET ? await hmacSign(env.ADMIN_SESSION_SECRET, msg) : await sha256Hex(msg);
  return full.slice(0, 24);
}

async function auditPrivacy(env, request, action, ref, detail) {
  try {
    const session = request.adminSession;
    await db.insertAdminAudit(env.DB, {
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      action, entity_type: 'privacy', entity_id: ref,
      detail: JSON.stringify(detail), actor: session && session.email ? session.email : 'token',
    });
    return true;
  } catch (err) {
    console.error('admin_audit_write_failed', action, String(err && err.message ? err.message : err));
    return false;
  }
}

function buildSummary(d) {
  const dates = d.bookings.map((b) => b.date).sort();
  const bought = d.giftCards.filter((g) => g.is_buyer).length;
  const received = d.giftCards.filter((g) => g.is_recipient).length;
  const waitlist = d.inquiries.filter((q) => /^\[.{2,40} waitlist\]/i.test(String(q.message || ''))).length;
  return {
    bookings: d.bookings.length,
    first_walk: dates[0] || null,
    last_walk: dates[dates.length - 1] || null,
    upcoming_walks: d.future.map((b) => ({ date: b.date, slot: b.slot, party: b.party, route: b.route_name || b.route_id })),
    gift_cards_total: d.giftCards.length,
    gift_cards_bought: bought,
    gift_cards_received: received,
    gift_cards_with_balance: d.giftCards.filter((g) => g.status === 'active' && g.balance_cents > 0).map((g) => ({ code: g.code, balance_cents: g.balance_cents, currency: g.currency })),
    enquiries: d.inquiries.length - waitlist,
    waiting_list_entries: waitlist,
    newsletter: d.subscriber ? d.subscriber.status : null,
    reminder_opt_out: !!d.reminderOptOut,
    queued_sync_items: d.syncItems.length,
    queued_mail_copies: d.queuedMails.length,
  };
}

function isEmpty(s) {
  return s.bookings + s.gift_cards_total + s.enquiries + s.waiting_list_entries
    + s.queued_sync_items + s.queued_mail_copies === 0 && !s.newsletter && !s.reminder_opt_out;
}

/** POST /admin/api/privacy/export (owner) body {email} -> { summary, export } */
export async function handlePrivacyExport(request, env) {
  if (!hasCsrfHeader(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try { body = await request.json(); } catch { return errorJson('bad_request', 'invalid JSON', 400); }
  const email = cleanPersonEmail(body && body.email);
  if (!email) return errorJson('bad_request', 'please enter a full, valid email address', 400);
  const d = await db.getCustomerData(env.DB, email);
  const summary = buildSummary(d);
  const ref = await personReference(env, email);
  await auditPrivacy(env, request, 'privacy.export', ref, { bookings: summary.bookings });
  const file = {
    exported_at: new Date().toISOString(),
    email,
    note: 'Everything the WOGO booking system stores about this email address. One-time secret tokens are left out. Data held at Stripe, Brevo, Gmail and in backups is not in this file.',
    summary,
    bookings: d.bookings,
    gift_cards: d.giftCards.map(({ is_buyer, is_recipient, ...g }) => ({ ...g, role: [is_buyer ? 'buyer' : null, is_recipient ? 'recipient' : null].filter(Boolean) })),
    gift_card_redemptions: d.redemptions,
    enquiries_and_waiting_list: d.inquiries,
    newsletter_subscription: d.subscriber,
    reminder_opt_out: d.reminderOptOut,
    queued_email_sync_items: d.syncItems,
    queued_email_copies: d.queuedMails,
  };
  return json({ email, reference: ref, empty: isEmpty(summary), summary, export: file });
}

const KEPT_NOTES = [
  'Date, route, group size and amounts of the bookings stay (anonymous), because tax law requires the financial record.',
  'The gift card codes and balances stay and keep working.',
  'The "no reminder emails" choice for this address, if there was one, is kept so it is still respected if they ever book again. Tell us if you want it removed too.',
  'Older lines in the dashboard activity log that mention this address are not changed. They delete themselves after about 13 months.',
  'Dashboard notifications and the error log are not changed. They delete themselves after 180 and 90 days.',
  'Anything saved under a different email address, or with only a phone number or a name (for example a waiting-list entry without an email) is not found by this tool.',
];
const MANUAL_STEPS = [
  'Stripe: search for this email address under Customers and Payments, and delete the customer if there is one. Payments stay as accounting records.',
  'Brevo: search for this email address under Contacts and delete the contact. Do this even if they never subscribed, because booking emails go through Brevo.',
  'Gmail inbox: search for the address and delete the conversations you no longer need.',
  'Backups: the nightly backups still hold the old data and delete themselves after 60 days. If a backup older than today is ever restored, erase this person again.',
  'Facebook/Instagram ads and Google Analytics only receive a scrambled version of the email. Nothing to do unless the person asks.',
  'Reply to the person within one month and confirm what was erased.',
];

/** POST /admin/api/privacy/erase (owner) body {email, confirm:'ERASE', include_future?:true} */
export async function handlePrivacyErase(request, env) {
  if (!hasCsrfHeader(request)) return errorJson('forbidden', 'missing CSRF header', 403);
  let body;
  try { body = await request.json(); } catch { return errorJson('bad_request', 'invalid JSON', 400); }
  const email = cleanPersonEmail(body && body.email);
  if (!email) return errorJson('bad_request', 'please enter a full, valid email address', 400);
  if (!body || body.confirm !== ERASE_CONFIRM_WORD) {
    return errorJson('confirmation_required', `type ${ERASE_CONFIRM_WORD} to confirm`, 400);
  }
  const before = buildSummary(await db.getCustomerData(env.DB, email));
  const result = await db.eraseCustomerData(env.DB, email, { includeFuture: body.include_future === true });
  if (result.blocked) {
    return errorJson('future_bookings', 'This person has a walk that has not happened yet. Erasing is blocked unless you confirm that too.', 409, {
      upcoming_walks: result.blocked.map((b) => ({ date: b.date, slot: b.slot, party: b.party, route: b.route_name || b.route_id })),
    });
  }
  const done = result.done;
  const ref = await personReference(env, email);
  const audited = await auditPrivacy(env, request, 'privacy.erase', ref, { ...done, included_upcoming_walks: body.include_future === true && before.upcoming_walks.length > 0 });
  return json({
    ok: true,
    reference: ref,
    audit_logged: audited,
    done: {
      bookings_anonymised: done.bookings_anonymised,
      gift_cards_cleaned: before.gift_cards_total,
      enquiries_and_waiting_list_deleted: done.inquiries_deleted,
      newsletter_subscription_deleted: done.subscribers_deleted,
      queued_sync_items_deleted: done.sync_items_deleted,
      queued_mail_copies_deleted: done.queued_mails_deleted,
    },
    gift_cards_with_balance: before.gift_cards_with_balance,
    kept: KEPT_NOTES,
    do_by_hand: MANUAL_STEPS,
  });
}
