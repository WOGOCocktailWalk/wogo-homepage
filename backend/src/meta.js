// src/meta.js — Meta Conversions API (server-side events).
// No-ops safely until env.META_ACCESS_TOKEN is set (`wrangler secret put`).
//
// Two events are sent, each ONLY when the visitor accepted marketing cookies
// (the site passes that choice along with the booking):
//   - InitiateCheckout when a guest continues to payment (POST /api/book)
//   - Purchase when Stripe confirms the payment (webhook)
// Both carry the same event_id as the matching browser pixel event, so Meta
// counts each action once even when both routes arrive.

import { SITE_URL, META_PIXEL_ID, routePathFor } from './config.js';

const clip = (v, n) => (typeof v === 'string' && v.length > 0 && v.length <= n ? v : null);

/** Reads the optional `tracking` object the booking widget sends. Returns a
 * small, validated object; `consent` is true only for an explicit `true`. */
export function readTracking(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    consent: t.consent === true,
    event_id: clip(t.event_id, 80),
    fbp: clip(t.fbp, 200),
    fbc: clip(t.fbc, 400),
  };
}

export async function sendMetaEvent(env, ev) {
  if (!env.META_ACCESS_TOKEN) return { skipped: 'no_token' };
  if (!ev || ev.consent !== true) return { skipped: 'no_consent' };
  const user_data = {};
  if (ev.email) user_data.em = [await sha256Hex(String(ev.email).trim().toLowerCase())];
  if (ev.phone) {
    const digits = String(ev.phone).replace(/\D/g, '');
    if (digits.length >= 7) user_data.ph = [await sha256Hex(digits)];
  }
  if (ev.fbp) user_data.fbp = ev.fbp;
  if (ev.fbc) user_data.fbc = ev.fbc;
  if (ev.ip) user_data.client_ip_address = ev.ip;
  if (ev.ua) user_data.client_user_agent = ev.ua;
  const payload = {
    data: [{
      event_name: ev.event_name,
      event_id: ev.event_id,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: ev.url || SITE_URL,
      user_data,
      custom_data: { currency: ev.currency || 'EUR', value: ev.value },
    }],
  };
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    if (!res.ok) { console.error('meta_capi_failed', res.status, await res.text()); return { ok: false, status: res.status }; }
    return { ok: true };
  } catch (err) {
    console.error('meta_capi_failed', err);
    return { ok: false };
  }
}

/** Guest continued to payment. `tracking` is readTracking()'s output. */
export async function sendInitiateCheckoutEvent(env, booking, route, tracking, request) {
  if (!tracking || !tracking.consent || !tracking.event_id) return { skipped: 'no_consent' };
  return sendMetaEvent(env, {
    consent: true,
    event_name: 'InitiateCheckout',
    event_id: tracking.event_id,
    url: `${SITE_URL}${routePathFor(route)}book/`,
    email: booking.email, phone: booking.phone,
    fbp: tracking.fbp, fbc: tracking.fbc,
    ip: request ? request.headers.get('CF-Connecting-IP') : null,
    ua: request ? request.headers.get('User-Agent') : null,
    currency: route.currency || 'EUR',
    value: (route.price_cents * booking.party) / 100,
  });
}

/** Payment confirmed. `opts` comes from the Stripe session metadata the
 * booking carried along: { consent, fbp, fbc, value_cents }. */
export async function sendPurchaseEvent(env, booking, route, opts = {}) {
  if (!env.META_ACCESS_TOKEN) {
    console.warn('META_ACCESS_TOKEN not set — skipping CAPI Purchase event. See SPEC.md §3.');
    return;
  }
  if (opts.consent !== true) return;
  return sendMetaEvent(env, {
    consent: true,
    event_name: 'Purchase',
    // Shared with the browser pixel's Purchase on booking-confirmed/
    // (eventID = booking.id) so Meta counts the sale once.
    event_id: booking.id,
    url: `${SITE_URL}${routePathFor(route)}`,
    email: booking.email, phone: booking.phone,
    fbp: opts.fbp, fbc: opts.fbc,
    currency: route.currency || 'EUR',
    value: (Number.isInteger(opts.value_cents) ? opts.value_cents : route.price_cents * booking.party) / 100,
  });
}

/** Gift card paid (Stripe webhook). event_id = the Stripe Checkout Session id,
 * shared with the browser pixel's Purchase on gift-confirmed/ (eventID =
 * ?session_id) so Meta counts the sale once. Sent for every gift card, like
 * bookings (owner decision 23 Nov 2026). */
export async function sendGiftCardPurchaseEvent(env, session, giftCard) {
  if (!env.META_ACCESS_TOKEN) return { skipped: 'no_token' };
  const md = (session && session.metadata) || {};
  return sendMetaEvent(env, {
    consent: true,
    event_name: 'Purchase',
    event_id: session.id,
    url: `${SITE_URL}/gift-cards/`,
    email: giftCard.buyer_email || md.buyer_email || session.customer_email || null,
    fbp: clip(md.fbp, 200), fbc: clip(md.fbc, 400),
    currency: (giftCard.currency || 'EUR').toUpperCase(),
    value: (giftCard.initial_cents || 0) / 100,
  });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
