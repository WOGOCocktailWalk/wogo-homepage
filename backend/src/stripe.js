// src/stripe.js
//
// No SDK — Workers-safe raw `fetch` against Stripe's REST API (form-encoded
// body, exactly how stripe-node does it under the hood). Zero-dependency,
// Node-API-free: only Web-standard fetch + Web Crypto (crypto.subtle).

import { SITE_URL, SITE_ASSET_BASE, STRIPE_EXPIRES_MINUTES, routePathFor, posterUrlFor } from './config.js';

export async function createCheckoutSession(env, booking, route, addons = []) {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('client_reference_id', booking.id);
  body.set('customer_email', booking.email);
  body.set('success_url', `${SITE_URL}/booking-confirmed/?session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url', `${SITE_URL}${routePathFor(route)}`);
  body.set('allow_promotion_codes', 'true');
  // Checkout's own UI language — without this, Stripe defaults to English
  // (or browser-inferred 'auto') even for a Dutch-language booking. Stripe
  // accepts 'nl' | 'en' | ... | 'auto'; booking.locale is already normalized
  // to exactly 'nl' or 'en' by guest_api.js before createHold.
  body.set('locale', booking.locale === 'nl' ? 'nl' : 'en');
  const expiresAt = Math.floor(Date.now() / 1000) + STRIPE_EXPIRES_MINUTES * 60;
  body.set('expires_at', String(expiresAt));
  body.set('metadata[booking_id]', booking.id);
  // Marketing-cookie choice + Meta browser ids, so the webhook can report the
  // Purchase to Meta server-side ONLY for a guest who accepted (src/meta.js).
  if (booking._tracking && booking._tracking.consent) {
    body.set('metadata[meta_consent]', '1');
    if (booking._tracking.fbp) body.set('metadata[fbp]', booking._tracking.fbp);
    if (booking._tracking.fbc) body.set('metadata[fbc]', booking._tracking.fbc);
  }
  body.set('payment_intent_data[metadata][booking_id]', booking.id);
  // No fixed payment_method_types: Stripe then offers every method that is
  // switched ON in the dashboard (Settings > Payment methods) and fits the
  // currency. A hard-coded list made EVERY checkout fail when one method in it
  // (iDEAL, 15 Nov 2026) was not active on the live account.
  body.set('line_items[0][quantity]', String(booking.party));
  // migrations/0011: Checkout charges in the ROUTE's own currency (Stripe
  // wants the ISO code lowercased); defaults to 'eur' so every existing NL
  // route checks out exactly as before this column existed.
  body.set('line_items[0][price_data][currency]', String(route.currency || 'EUR').toLowerCase());
  body.set('line_items[0][price_data][unit_amount]', String(route.price_cents));
  body.set('line_items[0][price_data][product_data][name]', `${route.name} — ${booking.date} ${booking.slot}`);
  // Payment page shows the route poster and a short description (14 Nov 2026).
  body.set(
    'line_items[0][price_data][product_data][description]',
    booking.locale === 'nl'
      ? '3 cocktails in 3 bars, in je eigen tempo. Je routekaart komt per e-mail.'
      : '3 cocktails at 3 bars, at your own pace. Your route map arrives by email.'
  );
  body.set('line_items[0][price_data][product_data][images][0]', posterUrlFor(route));

  // Add-ons (migrations/0033) — each gets its OWN Stripe line item (name,
  // qty, unit price, in the ROUTE's own currency) so the guest's receipt
  // itemises every extra and its OWN VAT rate is visible as a distinct
  // charge, separate from the ticket's. `addons` entries are already
  // server-recomputed-from-the-DB (src/guest_api.js:handleBook) — never the
  // client's own numbers. Product name is locale-aware, matching the same
  // `booking.locale` the Checkout UI language (`locale` field, above) and
  // the guest's eventual confirmation email both use.
  addons.forEach((addon, i) => {
    const idx = i + 1; // line_items[0] is always the ticket
    const name = booking.locale === 'nl' ? addon.name_snapshot_nl : addon.name_snapshot_en;
    body.set(`line_items[${idx}][quantity]`, String(addon.qty));
    body.set(`line_items[${idx}][price_data][currency]`, String(addon.currency || route.currency || 'EUR').toLowerCase());
    body.set(`line_items[${idx}][price_data][unit_amount]`, String(addon.unit_price_cents));
    body.set(`line_items[${idx}][price_data][product_data][name]`, name || 'Extra');
  });

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
  // Stripe's "no-cost orders" docs. VERIFIED 28 Sep 2026 against a real
  // Stripe test-mode key: Checkout shows a €0.00 "Complete order" session and
  // completes it with no payment method collected; the webhook fires
  // normally. No longer an open item.
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
  const print = gift.delivery === 'print' || !gift.recipient_email;
  if (!print) body.set('metadata[recipient_email]', gift.recipient_email);
  body.set('metadata[delivery]', print ? 'print' : 'email');
  body.set('metadata[message]', (gift.message || '').slice(0, 490));
  body.set('metadata[locale]', gift.locale === 'nl' ? 'nl' : 'en');
  body.set('locale', gift.locale === 'nl' ? 'nl' : 'en');
  // No fixed payment_method_types: Stripe then offers every method that is
  // switched ON in the dashboard (Settings > Payment methods) and fits the
  // currency. A hard-coded list made EVERY checkout fail when one method in it
  // (iDEAL, 15 Nov 2026) was not active on the live account.
  body.set('line_items[0][quantity]', '1');
  // WOGO gift cards are EUR-only today (matches every live route) — see
  // BUILD note "gift cards are EUR" / route.currency requirement at redemption.
  body.set('line_items[0][price_data][currency]', 'eur');
  body.set('line_items[0][price_data][unit_amount]', String(gift.amount_cents));
  body.set(
    'line_items[0][price_data][product_data][name]',
    `WOGO Gift Card (€${(gift.amount_cents / 100).toFixed(2).replace('.', ',')})`
  );
  body.set(
    'line_items[0][price_data][product_data][description]',
    gift.locale === 'nl'
      ? (print
        ? 'Te gebruiken voor elke WOGO Cocktail Walk, in elke stad. Je krijgt de cadeaubon zelf per e-mail, als pdf om te printen.'
        : 'Te gebruiken voor elke WOGO Cocktail Walk, in elke stad. De ontvanger krijgt de cadeaubon direct per e-mail.')
      : (print
        ? 'Valid on any WOGO Cocktail Walk, in any city. You get the gift card by email yourself, as a PDF to print.'
        : 'Valid on any WOGO Cocktail Walk, in any city. The recipient gets the gift card by email right away.')
  );
  body.set('line_items[0][price_data][product_data][images][0]', `${SITE_ASSET_BASE}/email/giftcard-thumb.jpg`);

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

// ---------------------------------------------------------------------------
// Welcome code (WELCOME_CODE, src/config.js) — POST /admin/api/stripe/ensure-
// welcome-code (src/admin_api.js). Idempotently creates a 10%-off Stripe
// Promotion Code the subscriber-welcome email can tell guests to enter at
// checkout (`allow_promotion_codes: true` is already set on every booking
// Checkout Session — see createCheckoutSession above — so this code works
// there with zero further wiring).
//
// HONEST LIMITATION, flagged rather than hidden: the task asked for a code
// that is usable "once per customer". Stripe's Promotion Code API has no
// literal "once per redeeming customer, including repeat customers" guard —
// the closest built-in restriction is `restrictions[first_time_transaction]`,
// which limits the code to a Customer's FIRST successful payment, not "once
// each, ever, even on a later purchase" for a customer who has paid before.
// That's a different (narrower) guarantee than "once per customer" literally
// means, so it's applied here as the best available approximation and called
// out explicitly in SETUP.md — if Maroussia wants a stricter per-customer cap
// later, Stripe's own dashboard shows redemption history and the code's
// `max_redemptions` (global, not per-customer) can be lowered by hand.
// ---------------------------------------------------------------------------

/**
 * Looks up an existing Promotion Code by its exact `code` string. Returns the
 * promotion code object, or null if none exists yet.
 */
async function findActivePromotionCodeByCode(env, code) {
  const res = await fetch(`https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(code)}&active=true&limit=1`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`stripe_promotion_code_lookup_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.data && json.data[0]) || null;
}

async function findPromotionCodeByCode(env, code) {
  const res = await fetch(`https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(code)}&limit=1`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`stripe_promotion_code_lookup_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.data && json.data[0]) || null;
}

/** Read-only payout overview for the dashboard: the payout schedule, what
 * is on its way, and the latest payouts. Each part is fetched separately so
 * a key that may not read one of them still returns the others. */
export async function getPayoutOverview(env) {
  const get = async (path) => {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
    if (!res.ok) return { error: res.status };
    return res.json();
  };
  const [account, balance, payouts] = await Promise.all([get('account'), get('balance'), get('payouts?limit=8')]);
  const sum = (list) => (Array.isArray(list) ? list.reduce((a, x) => a + (x.currency === 'eur' ? x.amount : 0), 0) : null);
  return {
    schedule: account && account.settings && account.settings.payouts ? account.settings.payouts.schedule : null,
    payouts_enabled: account ? account.payouts_enabled ?? null : null,
    // Only the bank's name and the last 4 digits — never the full number.
    bank_accounts: account && account.external_accounts && Array.isArray(account.external_accounts.data)
      ? account.external_accounts.data.map((x) => ({ bank: x.bank_name || null, last4: x.last4 || null, currency: x.currency || null, default: !!x.default_for_currency }))
      : null,
    available_cents: balance.error ? null : sum(balance.available),
    pending_cents: balance.error ? null : sum(balance.pending),
    payouts: payouts.error ? null : (payouts.data || []).map((p) => ({
      amount_cents: p.amount, currency: p.currency, status: p.status,
      created: new Date(p.created * 1000).toISOString(),
      arrival_date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
      automatic: p.automatic,
    })),
    errors: { account: account.error || null, balance: balance.error || null, payouts: payouts.error || null },
  };
}

/** Switches an existing promotion code on or off (Stripe allows both ways).
 * Returns { code, id, active } or throws if the code does not exist. */
export async function setPromotionCodeActive(env, code, active) {
  const existing = await findPromotionCodeByCode(env, code);
  if (!existing) throw new Error(`promotion_code_not_found: ${code}`);
  if (existing.active === !!active) return { code: existing.code, id: existing.id, active: existing.active, changed: false };
  const res = await fetch(`https://api.stripe.com/v1/promotion_codes/${existing.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ active: active ? 'true' : 'false' }),
  });
  if (!res.ok) throw new Error(`stripe_promotion_code_update_failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return { code: j.code, id: j.id, active: j.active, changed: true };
}

/**
 * Idempotently ensures a `percentOff`% Promotion Code with the literal string
 * `code` exists, creating the backing Coupon + the Promotion Code if missing.
 * Returns { code, id, created, coupon_id } — `created: false` when it already
 * existed (re-running this endpoint is always safe, same "ensure" contract as
 * src/brevo.js's ensureContactFolder/ensureContactList/ensureContactAttribute).
 * Throws Stripe's own error body on an unexpected API failure (admin_api.js
 * surfaces it as-is rather than masking it behind a generic 502 — the owner
 * needs to see WHY Stripe rejected the create, not just that it failed).
 */
export async function ensureWelcomePromotionCode(env, code, percentOff) {
  const existing = await findActivePromotionCodeByCode(env, code);
  // An earlier version of this code was created "first purchase only". That
  // contradicts what the site promises: the tick box at checkout says "10% off
  // your NEXT walk", and the person ticking it has just made a purchase. Such
  // a restricted code is switched off here and replaced by an unrestricted one
  // with the same letters (same as WELCOME10 always worked on the old Wix site).
  const restricted = existing && existing.restrictions && existing.restrictions.first_time_transaction;
  if (existing && !restricted) return { code: existing.code, id: existing.id, created: false, coupon_id: existing.coupon };
  if (restricted) {
    const off = await fetch(`https://api.stripe.com/v1/promotion_codes/${existing.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ active: 'false' }),
    });
    if (!off.ok) throw new Error(`stripe_promotion_code_deactivate_failed: ${off.status} ${await off.text()}`);
  }

  const couponBody = new URLSearchParams();
  couponBody.set('percent_off', String(percentOff));
  couponBody.set('duration', 'once');
  couponBody.set('name', `WOGO Welcome ${percentOff}%`);
  const couponRes = await fetch('https://api.stripe.com/v1/coupons', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: couponBody,
  });
  if (!couponRes.ok) throw new Error(`stripe_coupon_failed: ${couponRes.status} ${await couponRes.text()}`);
  const coupon = await couponRes.json();

  const promoBody = new URLSearchParams();
  // Stripe API versions from 2025 onward nest the coupon under `promotion`
  // (the flat `coupon` param returns "parameter_unknown" on this account).
  promoBody.set('promotion[type]', 'coupon');
  promoBody.set('promotion[coupon]', coupon.id);
  promoBody.set('code', code);
  const promoRes = await fetch('https://api.stripe.com/v1/promotion_codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: promoBody,
  });
  if (!promoRes.ok) throw new Error(`stripe_promotion_code_failed: ${promoRes.status} ${await promoRes.text()}`);
  const promo = await promoRes.json();

  return { code: promo.code, id: promo.id, created: true, coupon_id: coupon.id };
}

/**
 * Idempotently ensures ONE discount code carried over from Wix exists as a
 * Stripe Promotion Code with the same literal string. `spec`:
 *   { code, percent_off | amount_off_cents, max_redemptions?, expires_at? (unix s), name? }
 * Each code gets its own Coupon (simple, and deleting one never affects
 * another). Returns { code, created }. Wix rules Stripe cannot express
 * (once per customer, one route only) are NOT carried over.
 */
export async function ensureImportedPromotionCode(env, spec) {
  const existing = await findPromotionCodeByCode(env, spec.code);
  if (existing) return { code: existing.code, id: existing.id, created: false };

  const couponBody = new URLSearchParams();
  if (spec.percent_off) couponBody.set('percent_off', String(spec.percent_off));
  else {
    couponBody.set('amount_off', String(spec.amount_off_cents));
    couponBody.set('currency', 'eur');
  }
  couponBody.set('duration', 'once');
  couponBody.set('name', String(spec.name || spec.code).slice(0, 40));
  couponBody.set('metadata[source]', 'wix_import');
  const couponRes = await fetch('https://api.stripe.com/v1/coupons', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: couponBody,
  });
  if (!couponRes.ok) throw new Error(`stripe_coupon_failed: ${couponRes.status} ${await couponRes.text()}`);
  const coupon = await couponRes.json();

  const promoBody = new URLSearchParams();
  promoBody.set('promotion[type]', 'coupon');
  promoBody.set('promotion[coupon]', coupon.id);
  promoBody.set('code', spec.code);
  if (spec.max_redemptions) promoBody.set('max_redemptions', String(spec.max_redemptions));
  if (spec.expires_at) promoBody.set('expires_at', String(spec.expires_at));
  if (spec.first_time_only) promoBody.set('restrictions[first_time_transaction]', 'true');
  promoBody.set('metadata[source]', spec.source || 'wix_import');
  const promoRes = await fetch('https://api.stripe.com/v1/promotion_codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: promoBody,
  });
  if (!promoRes.ok) throw new Error(`stripe_promotion_code_failed: ${promoRes.status} ${await promoRes.text()}`);
  const promo = await promoRes.json();
  return { code: promo.code, id: promo.id, created: true };
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
