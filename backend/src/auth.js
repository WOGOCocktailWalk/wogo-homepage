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

/** Builds a signed session cookie value: "<payload_b64>.<sig_b64>". */
export async function createSessionCookieValue(secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify({ exp: nowSeconds + ADMIN_SESSION_MAX_AGE_SECONDS });
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
 * Verifies the session cookie on the request. Returns true/false — never
 * throws (a malformed cookie is just "not authenticated").
 */
export async function requireSession(request, env) {
  try {
    const cookies = parseCookies(request.headers.get('Cookie'));
    const raw = cookies[COOKIE_NAME];
    if (!raw) return false;
    const dot = raw.lastIndexOf('.');
    if (dot === -1) return false;
    const payloadB64 = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expectedSig = await hmacSign(env.ADMIN_SESSION_SECRET, payloadB64);
    if (!constantTimeEqual(sig, expectedSig)) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** Cheap CSRF mitigation for state-changing admin calls (SPEC.md §12.1). */
export function hasCsrfHeader(request) {
  return request.headers.get('X-Requested-With') === 'wogo-admin';
}

export { COOKIE_NAME };
