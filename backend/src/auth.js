// src/auth.js — admin login check, session cookie sign/verify.
// Web Crypto only (crypto.subtle) — Workers-safe, no Node crypto module.

import { ADMIN_SESSION_MAX_AGE_SECONDS } from './config.js';
import { constantTimeEqual } from './logic.js';

const COOKIE_NAME = 'wogo_admin';

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sigBuffer));
}

/**
 * Constant-time compare of the submitted admin token against env.ADMIN_TOKEN.
 * Delegates to logic.js:constantTimeEqual, which has NO early return on a
 * length mismatch (the loop always runs over the longer string), so neither
 * content nor length differences shift the comparison's timing. An unset/
 * empty expected token always fails — auth can never be "open by default".
 */
export function checkAdminToken(submitted, expected) {
  if (typeof submitted !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  return constantTimeEqual(submitted, expected);
}

/**
 * Builds a signed session cookie value: "<payload_b64>.<sig_b64>".
 *
 * `identity` carries the personal-login fields added for team logins
 * (migrations/0025): `{ uid, role, email }` — `uid`/`email` are `null` and
 * `role` is `'owner'` for the emergency ADMIN_TOKEN login (no admin_users
 * row behind it), or the signed-in admin_users row's id/role/email for a
 * magic-link login. Omitting `identity` entirely (no 2nd arg) still works
 * and produces the OLD payload shape `{exp}` — kept only so existing callers
 * (and any test fixture) that never cared about identity don't have to
 * change; every real call site now passes identity explicitly.
 */
export async function createSessionCookieValue(secret, identity = null, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify({
    exp: nowSeconds + ADMIN_SESSION_MAX_AGE_SECONDS,
    ...(identity ? { uid: identity.uid ?? null, role: identity.role || 'owner', email: identity.email ?? null } : {}),
  });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const sig = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

export function sessionSetCookieHeader(value, secure = true) {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function sessionClearCookieHeader(secure = true) {
  const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

/**
 * Decodes + verifies the session cookie on the request. Returns the decoded
 * identity `{ exp, uid, role, email }`, or `null` — never throws (a
 * malformed/missing/expired cookie is just "not authenticated").
 *
 * Backward compatibility (team logins, migrations/0025): a session cookie
 * minted BEFORE this change carries only `{exp}` — no `uid`/`role`/`email`.
 * Such a payload decodes here as `{ exp, uid: null, role: 'owner', email: null }`
 * — i.e. exactly what the ADMIN_TOKEN emergency login still produces today —
 * so a session that was live when this shipped keeps working as the owner,
 * unchanged, until it naturally expires or the owner logs out. This is a
 * PURE cookie-trust decode: it does NOT look up `admin_users` — a personal
 * login's live status/role (disabled, role changed) is re-checked against
 * the DB on every admin request by `admin_api.js:resolveSession`, which
 * wraps this function. Nothing outside auth.js should trust `getSession`'s
 * `role` for a `uid`-bearing session without that extra check.
 */
export async function getSession(request, env) {
  try {
    const cookies = parseCookies(request.headers.get('Cookie'));
    const raw = cookies[COOKIE_NAME];
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot === -1) return null;
    const payloadB64 = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expectedSig = await hmacSign(env.ADMIN_SESSION_SECRET, payloadB64);
    if (!constantTimeEqual(sig, expectedSig)) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return {
      exp: payload.exp,
      uid: payload.uid ?? null,
      role: payload.role || 'owner', // pre-0025 payload has no `role` — defaults to owner, see doc comment
      email: payload.email ?? null,
    };
  } catch {
    return null;
  }
}

/** Boolean wrapper over getSession — kept for any caller that only needs a
 * yes/no answer and doesn't care about identity. */
export async function requireSession(request, env) {
  return (await getSession(request, env)) !== null;
}

// ---------------------------------------------------------------------------
// Roles (migrations/0025) — 'owner' > 'staff' > 'viewer'. Pure comparison
// helper; the authoritative per-route minimum-role TABLE lives in
// src/admin_api.js (ROUTE_ROLES), enforced centrally in src/index.js so a
// newly-added route can't accidentally ship with no role check at all.
// ---------------------------------------------------------------------------
export const ROLE_RANK = { viewer: 1, staff: 2, owner: 3 };

export function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
}

// ---------------------------------------------------------------------------
// Magic-link login tokens (migrations/0025) — a 32-byte random secret, same
// unguessability class as ADMIN_TOKEN itself. Only the SHA-256 hash is ever
// persisted (admin_login_links.token_hash); the raw token lives only in the
// emailed URL and the clicking browser's one request.
// ---------------------------------------------------------------------------

/** Random 32-byte token, hex-encoded (64 chars) — Web Crypto only, Workers-safe. */
export function generateLoginLinkToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex digest — used to hash login-link tokens before storage and to
 * hash a requester's IP for admin_login_links.ip_hash (never the raw IP,
 * same minimization posture as migrations/0021's inquiries.ip_hash). */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cheap CSRF mitigation for state-changing admin calls (SPEC.md §12.1). */
export function hasCsrfHeader(request) {
  return request.headers.get('X-Requested-With') === 'wogo-admin';
}

export { COOKIE_NAME };
