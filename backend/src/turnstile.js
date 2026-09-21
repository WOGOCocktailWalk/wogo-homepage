// src/turnstile.js — Cloudflare Turnstile (free CAPTCHA replacement) for the
// admin login. Production hardening, 2026-07 (owner audit items #1 and #10).
//
// Config-flag gated and INERT until env.TURNSTILE_SECRET_KEY is set as a
// Worker Secret: verifyTurnstile() short-circuits to "ok, skipped" the
// instant that secret is absent, so this ships live with zero behavior
// change until the owner actually creates a Turnstile widget and pastes in
// keys (SETUP.md walks through it). The matching PUBLIC site key is served
// to the browser via GET /admin/public-config (admin_api.js) — a site key is
// meant to be public (like a Google reCAPTCHA site key); only the secret key
// is sensitive.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verifies a Turnstile response token against Cloudflare's siteverify API.
 * Returns { ok: true, skipped: true } when Turnstile isn't configured yet
 * (no env.TURNSTILE_SECRET_KEY) — callers should treat that exactly like a
 * pass. Never throws.
 */
export async function verifyTurnstile(env, token, remoteip, deps = {}) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true, skipped: true };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing_token' };

  const doFetch = deps.fetch || fetch;
  const body = new URLSearchParams();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (remoteip) body.set('remoteip', remoteip);

  try {
    const res = await doFetch(VERIFY_URL, { method: 'POST', body });
    const data = await res.json();
    if (data && data.success) return { ok: true };
    return { ok: false, reason: (data && data['error-codes'] && data['error-codes'].join(',')) || 'verify_failed' };
  } catch (err) {
    console.error('turnstile_verify_request_failed', err);
    return { ok: false, reason: 'verify_request_failed' };
  }
}
