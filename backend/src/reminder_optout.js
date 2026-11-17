// src/reminder_optout.js — the one-click opt-out shared by the abandoned-
// booking emails (migrations/0031, src/abandoned.js) and the walk reminder
// (src/reminders.js). Deliberately NOT the marketing `subscribers` plumbing
// (migrations/0024) — see migrations/0031's own comment for why.
//
// The token is SELF-CONTAINED: "<b64url(lowercased email)>.<hmac>" — the
// same "<payload_b64>.<sig_b64>" shape auth.js's session cookie already
// uses, reusing its exact hmacSign/b64urlEncode/b64urlDecode helpers. No DB
// lookup is needed to find "whose token is this" (unlike the subscribers
// table's random opaque confirm_token/unsubscribe_token, which MUST be
// looked up since nothing else identifies the row) — a forged/tampered
// token simply fails the HMAC check.

import { hmacSign, b64urlEncode, b64urlDecode } from './auth.js';
import { constantTimeEqual } from './logic.js';

// Domain separation: this token must never be valid under the key that signs
// admin session cookies. The signing key is derived from the shared secret
// with a context label, so a token minted here can not double as a cookie.
// Tokens already sent in earlier emails were signed with the raw secret; they
// stay accepted for VERIFY only (nothing new is ever signed that way), so
// existing unsubscribe links keep working.
async function reminderKey(env) {
  return hmacSign(env.ADMIN_SESSION_SECRET, 'wogo:reminder-unsub:v1');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Builds the full unsubscribe URL for one booking email — embedded ready-
 * made in the abandoned/reminder emails, same as every other one-click link
 * in this codebase (the guest never builds this themselves). */
export async function buildReminderUnsubscribeUrl(env, baseUrl, email) {
  const token = await computeReminderUnsubscribeToken(env, email);
  return `${baseUrl}/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`;
}

export async function computeReminderUnsubscribeToken(env, email) {
  const normalized = normalizeEmail(email);
  const payloadB64 = b64urlEncode(new TextEncoder().encode(normalized));
  const sig = await hmacSign(await reminderKey(env), payloadB64);
  return `${payloadB64}.${sig}`;
}

/** Decodes + verifies a token from the query string. Returns the normalized
 * email on success, or `null` on any failure (malformed, tampered, wrong
 * secret) — never throws, same "untrusted input, fail closed" posture as
 * auth.js:getSession. */
export async function verifyReminderUnsubscribeToken(env, token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = await hmacSign(await reminderKey(env), payloadB64);
    const legacySig = await hmacSign(env.ADMIN_SESSION_SECRET, payloadB64);
    const okNew = constantTimeEqual(sig, expectedSig);
    const okLegacy = constantTimeEqual(sig, legacySig);
    if (!okNew && !okLegacy) return null;
    const email = new TextDecoder().decode(b64urlDecode(payloadB64));
    // Only something shaped like a mailbox is ever accepted; a signed blob of
    // any other kind (for example a session cookie) is not an opt-out token.
    if (!email || !/^[^\s@"{}<>\\]+@[^\s@"{}<>\\]+$/.test(email)) return null;
    return email;
  } catch {
    return null;
  }
}
