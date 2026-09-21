// src/meta.js — Meta Conversions API (stub). No-ops safely until
// env.META_ACCESS_TOKEN is issued and set via `wrangler secret put`.
// See SPEC.md §3 / §8.5.

import { SITE_URL, META_PIXEL_ID, routePathFor } from './config.js';

export async function sendPurchaseEvent(env, booking, route) {
  if (!env.META_ACCESS_TOKEN) {
    console.warn('META_ACCESS_TOKEN not set — skipping CAPI Purchase event. See SPEC.md §3.');
    return;
  }
  const emailHash = await sha256Hex(booking.email.trim().toLowerCase());
  const payload = {
    data: [{
      event_name: 'Purchase',
      // Shared with the client-side Pixel Purchase fired on booking-confirmed/
      // (eventID = booking.id) so Meta dedupes the browser + server events.
      event_id: booking.id,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: `${SITE_URL}${routePathFor(route)}`,
      user_data: { em: [emailHash] },
      // migrations/0011: report the ROUTE's own currency (defaults to 'EUR',
      // matching every existing NL route unchanged).
      custom_data: { currency: route.currency || 'EUR', value: (route.price_cents * booking.party) / 100 },
    }],
  };
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  if (!res.ok) console.error('meta_capi_failed', res.status, await res.text());
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
