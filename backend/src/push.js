// src/push.js — Web Push, Web Crypto only (no new runtime dependency).
//
// This file knows how to sign ONE VAPID JWT and send ONE push "tickle" to
// ONE subscription. It touches no D1 and knows nothing about notification
// kinds or preferences — see src/notifications.js for the fan-out/filtering
// layer that calls this per subscription, and SPEC.md's notification-system
// section for why a payload-less push (RFC 8030's plain "wake up" request,
// deliberately NOT RFC 8291's encrypted-payload push) is the right call
// here: this build never needs the push service to carry the notification's
// actual text — the service worker it wakes does one same-origin
// authenticated fetch (GET /admin/api/notifications/pending, the browser
// sends the session cookie automatically on a same-origin SW fetch) to get
// the real content. That trades "one extra network round trip after the
// device wakes" for "no RFC 8291 ECDH/HKDF payload-encryption code to write,
// test, and keep correct" — a clearly good trade for a two-person dashboard
// that isn't trying to ship push payloads a user could be offline for days
// without.

import { b64urlEncode } from './auth.js';
import { VAPID_SUBJECT, VAPID_JWT_TTL_SECONDS, PUSH_TTL_SECONDS, VAPID_PUBLIC_KEY } from './config.js';

function b64urlEncodeJson(obj) {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

/**
 * Signs an ES256 VAPID JWT (RFC 8292) with the Worker's `VAPID_PRIVATE_KEY`
 * secret (a JSON-encoded JWK string — see SETUP.md for how it's generated).
 * `aud` MUST be the push endpoint's own origin (scheme+host, no path) — the
 * push service rejects a JWT whose `aud` doesn't match the endpoint it was
 * presented to. Web Crypto's ECDSA signature for a P-256 key is already the
 * raw (r‖s), 64-byte IEEE P1363 form JWS ES256 requires — no DER conversion
 * needed, unlike most ECDSA libraries.
 */
export async function signVapidJwt(privateKeyJwk, aud, subject = VAPID_SUBJECT, ttlSeconds = VAPID_JWT_TTL_SECONDS, nowSeconds = Math.floor(Date.now() / 1000)) {
  const jwk = typeof privateKeyJwk === 'string' ? JSON.parse(privateKeyJwk) : privateKeyJwk;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = { aud, exp: nowSeconds + ttlSeconds, sub: subject };
  const signingInput = `${b64urlEncodeJson(header)}.${b64urlEncodeJson(payload)}`;
  const sigBuffer = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlEncode(new Uint8Array(sigBuffer))}`;
}

/**
 * Sends one payload-less push to one subscription. Returns a plain result
 * object — NEVER throws on an HTTP-level failure (a 404/410/429/5xx from the
 * push service is an expected, handleable outcome, not an exception); a
 * genuine network error (DNS, timeout) DOES throw, same contract as a bare
 * `fetch()` — the caller (src/notifications.js:fanOutPush) wraps every
 * subscription's send in its own try/catch so one bad device never blocks
 * the rest of the fan-out, and a push failure of any kind never breaks the
 * booking/webhook/inquiry path it's attached to (same "report, don't throw"
 * contract src/email_retry.js:sendWithRetry already gives every email send).
 *
 * `{ ok:false, skipped:true }` when `VAPID_PRIVATE_KEY` isn't configured —
 * the same "config-gated, inert until the secret is set" posture GA4/Brevo
 * already use elsewhere in this codebase, so a fresh deploy before the
 * owner has run the VAPID setup step never throws on a real booking.
 */
export async function sendPushTickle(env, subscription, deps = {}) {
  const doFetch = deps.fetch || fetch;
  if (!env.VAPID_PRIVATE_KEY) return { ok: false, skipped: true };

  const endpointUrl = new URL(subscription.endpoint);
  const aud = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await signVapidJwt(env.VAPID_PRIVATE_KEY, aud);

  // When the caller hands over the notification text AND the device's keys
  // are on file, the text travels INSIDE the push, encrypted for that one
  // device (RFC 8291). The phone can then show it at once, without first
  // calling back to this server — which is what failed silently on iPhone
  // (16 Nov 2026). Without text or keys it stays a bare wake-up, as before.
  let body = null;
  if (deps.payload && subscription.p256dh && subscription.auth) {
    try { body = await encryptPushPayload(JSON.stringify(deps.payload), subscription.p256dh, subscription.auth); }
    catch (err) { console.error('push_encrypt_failed', String(err && err.message ? err.message : err)); body = null; }
  }
  const headers = {
    // RFC 8292's "vapid" auth scheme — accepted by every major push
    // service (FCM-backed Chrome/Edge endpoints AND Mozilla's autopush),
    // unlike the older two-header (Authorization: WebPush + Crypto-Key)
    // form some docs still show.
    Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
    TTL: String(PUSH_TTL_SECONDS),
    Urgency: 'high',
  };
  if (body) {
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
  } else {
    headers['Content-Length'] = '0';
  }
  const res = await doFetch(subscription.endpoint, { method: 'POST', headers, body: body || undefined });

  if (res.status === 404 || res.status === 410) {
    return { ok: false, status: res.status, gone: true };
  }
  return { ok: res.ok, status: res.status };
}


// ---------------------------------------------------------------------------
// RFC 8291 "aes128gcm" message encryption for Web Push, with WebCrypto only.
// ---------------------------------------------------------------------------
function b64uToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** Encrypts `plaintext` (string) for the device whose subscription keys are
 * `p256dhB64u` (its public key) and `authB64u` (its auth secret). Returns the
 * request body bytes. `deps` exists only so a test can fix the randomness. */
export async function encryptPushPayload(plaintext, p256dhB64u, authB64u, deps = {}) {
  const enc = new TextEncoder();
  const uaPublic = b64uToBytes(p256dhB64u);          // 65 bytes, uncompressed P-256 point
  const authSecret = b64uToBytes(authB64u);          // 16 bytes
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const data = enc.encode(plaintext);
  if (data.length > 3000) throw new Error('payload too large');

  const asKeys = deps.keyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = deps.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the data followed by the 0x02 "last record" delimiter.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concatBytes(data, new Uint8Array([2]))));
  const header = concatBytes(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic); // rs = 4096
  return concatBytes(header, cipher);
}
