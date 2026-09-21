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
  body.set('expires_at', String(Math.floor(Date.now() / 1000) + STRIPE_EXPIRES_MINUTES * 60));
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
