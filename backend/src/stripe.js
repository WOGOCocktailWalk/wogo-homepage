// src/stripe.js
//
// No SDK — Workers-safe raw `fetch` against Stripe's REST API (form-encoded
// body, exactly how stripe-node does it under the hood). Zero-dependency,
// Node-API-free: only Web-standard fetch + Web Crypto (crypto.subtle).

import { SITE_URL, STRIPE_EXPIRES_MINUTES, routePathFor } from './config.js';

export async function createCheckoutSession(env, booking, route) {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('client_reference_id', booking.id);
  body.set('customer_email', booking.email);
  body.set('success_url', `${SITE_URL}/booking-confirmed/?session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url', `${SITE_URL}${routePathFor(route)}`);
  body.set('allow_promotion_codes', 'true');
  const expiresAt = Math.floor(Date.now() / 1000) + STRIPE_EXPIRES_MINUTES * 60;
  body.set('expires_at', String(expiresAt));
  body.set('metadata[booking_id]', booking.id);
  body.set('payment_intent_data[metadata][booking_id]', booking.id);
  ['card', 'ideal', 'klarna'].forEach((t, i) => body.set(`payment_method_types[${i}]`, t));
  body.set('line_items[0][quantity]', String(booking.party));
  // migrations/0011: Checkout charges in the ROUTE's own currency (Stripe
  // wants the ISO code lowercased); defaults to 'eur' so every existing NL
  // route checks out exactly as before this column existed.
  body.set('line_items[0][price_data][currency]', String(route.currency || 'EUR').toLowerCase());
  body.set('line_items[0][price_data][unit_amount]', String(route.price_cents));
  body.set('line_items[0][price_data][product_data][name]', `${route.name} — ${booking.date} ${booking.slot}`);

  // Gift-card redemption (migrations/0018/0019) — SEPARATE mechanism from the
  // marketing `allow_promotion_codes` above: a one-time Stripe coupon for the
  // exact `gift_applied_cents` amount, attached via `discounts`. Stripe
  // rejects a session that sets BOTH `discounts` and `allow_promotion_codes`,
  // so the promo-code field is turned off for this one session only — a
  // booking with no gift card applied (the overwhelming majority) never
  // touches this branch and checks out byte-for-byte as before this feature.
  // A gift card covering the ENTIRE charge (giftApplied === bookingTotal)
  // still goes through this exact path: Stripe supports a €0-total Checkout
  // Session when a 100%-off coupon is applied (no payment method is
  // collected, and `checkout.session.completed` still fires normally) — see
  // Stripe's "no-cost orders" docs. This is the one piece of this feature
  // that hasn't been exercised against a real Stripe test-mode key; verify
  // before go-live.
  const giftApplied = Number(booking.gift_applied_cents) || 0;
  if (giftApplied > 0) {
    body.delete('allow_promotion_codes');
    const coupon = await createGiftCardRedemptionCoupon(env, {
      amountOffCents: giftApplied,
      currency: route.currency || 'EUR',
      giftCode: booking.gift_code,
      bookingId: booking.id,
      redeemBy: expiresAt,
    });
    body.set('discounts[0][coupon]', coupon.id);
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`stripe_checkout_failed: ${res.status}`);
  return res.json(); // { id: 'cs_...', url: 'https://checkout.stripe.com/...' }
}

/**
 * A one-time, single-use Stripe coupon for exactly one booking's gift-card
 * redemption. `max_redemptions: 1` + `redeem_by` (matched to the same
 * Checkout Session's own `expires_at`) mean this coupon id is worthless to
 * anyone who might observe it in transit — it cannot be replayed against a
 * different, unrelated booking. `metadata` carries the gift code + booking id
 * so the coupon is traceable from the Stripe dashboard alone if ever needed;
 * `name` is customer-safe (shown on the guest's receipt).
 */
async function createGiftCardRedemptionCoupon(env, { amountOffCents, currency, giftCode, bookingId, redeemBy }) {
  const body = new URLSearchParams();
  body.set('amount_off', String(amountOffCents));
  body.set('currency', String(currency || 'EUR').toLowerCase());
  body.set('duration', 'once');
  body.set('max_redemptions', '1');
  body.set('name', 'WOGO Gift Card');
  if (redeemBy) body.set('redeem_by', String(redeemBy));
  if (giftCode) body.set('metadata[gift_code]', giftCode);
  if (bookingId) body.set('metadata[booking_id]', bookingId);

  const res = await fetch('https://api.stripe.com/v1/coupons', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`stripe_coupon_failed: ${res.status}`);
  return res.json(); // { id: 'coupon_id', ... }
}

// ---------------------------------------------------------------------------
// Gift-card PURCHASE — a completely separate Checkout Session from a booking:
// mode 'payment', one line item "WOGO Gift Card (€X)", no seats/hold involved.
// Everything the webhook needs to mint the card lives in `metadata` (Stripe
// Checkout has no other place to stash arbitrary buyer/recipient data), read
// back by src/webhook.js's `metadata.type === 'giftcard'` branch.
// ---------------------------------------------------------------------------

export async function createGiftCardCheckoutSession(env, gift) {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('customer_email', gift.buyer_email);
  body.set('success_url', `${SITE_URL}/gift-confirmed/?session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url', `${SITE_URL}/gift-cards/`);
  body.set('expires_at', String(Math.floor(Date.now() / 1000) + STRIPE_EXPIRES_MINUTES * 60));
  body.set('metadata[type]', 'giftcard');
  body.set('metadata[amount_cents]', String(gift.amount_cents));
  body.set('metadata[buyer_name]', gift.buyer_name);
  body.set('metadata[buyer_email]', gift.buyer_email);
  body.set('metadata[recipient_name]', gift.recipient_name);
  body.set('metadata[recipient_email]', gift.recipient_email);
  body.set('metadata[message]', (gift.message || '').slice(0, 490));
  body.set('metadata[locale]', gift.locale === 'nl' ? 'nl' : 'en');
  ['card', 'ideal', 'klarna'].forEach((t, i) => body.set(`payment_method_types[${i}]`, t));
  body.set('line_items[0][quantity]', '1');
  // WOGO gift cards are EUR-only today (matches every live route) — see
  // BUILD note "gift cards are EUR" / route.currency requirement at redemption.
  body.set('line_items[0][price_data][currency]', 'eur');
  body.set('line_items[0][price_data][unit_amount]', String(gift.amount_cents));
  body.set(
    'line_items[0][price_data][product_data][name]',
    `WOGO Gift Card (€${(gift.amount_cents / 100).toFixed(2).replace('.', ',')})`
  );

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`stripe_checkout_failed: ${res.status}`);
  return res.json();
}

/**
 * Verifies a Stripe webhook's Stripe-Signature header using the async Web
 * Crypto pattern (Workers cannot use Node's `crypto` module / stripe-node).
 * `rawBody` MUST be the exact raw request text — never a re-serialized JSON
 * object — since the signature is computed over the exact raw bytes.
 */
export async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader) throw new Error('malformed_signature');
  const parts = Object.fromEntries(sigHeader.split(',').map((kv) => kv.split('=')));
  const timestamp = Number(parts.t);
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) throw new Error('malformed_signature');

  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > toleranceSeconds) throw new Error('signature_too_old');

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signedPayload = `${timestamp}.${rawBody}`;
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computedSig = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (!timingSafeEqualHex(computedSig, expectedSig)) throw new Error('signature_mismatch');
  return true;
}

/** Computes a valid `Stripe-Signature` header value — used only by tests to build a fake signature. */
export async function computeStripeSignatureHeader(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signedPayload = `${timestamp}.${rawBody}`;
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const sig = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${sig}`;
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
