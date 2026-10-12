// src/security_headers.js — sets defense-in-depth headers on EVERY response
// this Worker returns (owner audit item #9). Applied once, at the single
// wrap point in index.js's fetch(), so no individual handler has to
// remember to set these.
//
// Deliberately additive-only: uses Headers.has() so it never clobbers a
// header a handler already set on purpose (Set-Cookie, Content-Disposition,
// Access-Control-Allow-*, Retry-After, etc.).
//
// The static site (Cloudflare Pages/GitHub Pages) gets its OWN copy of these
// via Cloudflare Transform Rules at cutover — see CLOUDFLARE-SETUP.md. This
// module only covers responses THIS Worker generates (the JSON API, the
// Stripe webhook ack, and the /admin SPA shell).

const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Locks down every powerful browser feature this backend never needs.
  // interest-cohort=() opts out of FLoC/Topics on the off chance a browser
  // ever treats a same-origin API response as document-like.
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  // Workers only ever serve over HTTPS, so this is safe unconditionally;
  // 2 years + subdomains, matching what CLOUDFLARE-SETUP.md sets at the zone
  // level for the static site (kept in sync deliberately).
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

// JSON API / webhook responses are never rendered as a document — lock the
// CSP all the way down. frame-ancestors 'none' backstops X-Frame-Options for
// browsers that only honor CSP.
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

// The /admin SPA ships its CSS/JS INLINED into one HTML document (see
// src/admin/build.mjs) — there is no nonce plumbing today, so script-src/
// style-src need 'unsafe-inline'. Everything else stays locked down: no
// external scripts, no framing, fetches only back to same-origin /admin/api.
//
// img-src additionally allows the site's own two image hosts (BUILD §21,
// Blog) — the Blog editor's "Preview EN/NL" panel is an <iframe> whose
// content is set via `.srcdoc` (no response headers of its own); per the
// CSP spec a local-scheme document like that inherits the EMBEDDING
// document's policy, i.e. THIS one. A rendered post's <img> tags point at
// the real site (staging: wogococktailwalk.github.io; production:
// www.wogococktailwalk.com / wogococktailwalk.com — same pair
// config.js:ALLOWED_ORIGINS already trusts), so without this the preview
// would render with every image broken. A <meta> CSP inside the srcdoc
// itself could NOT fix this instead — multiple active policies intersect
// (AND), they don't override each other, so only widening the policy
// actually enforced on the embedding document works.
const ADMIN_HTML_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https://www.wogococktailwalk.com https://wogococktailwalk.com https://wogococktailwalk.github.io; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

/**
 * Returns a NEW Response with security headers added on top of `response`'s
 * existing headers/body/status (Response bodies can only be read once, so a
 * fresh Response wrapping the same body stream is the correct way to add
 * headers post-hoc — this never touches or re-reads the body itself).
 */
export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(COMMON_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (!headers.has('Content-Security-Policy')) {
    const isHtml = (headers.get('Content-Type') || '').includes('text/html');
    headers.set('Content-Security-Policy', isHtml ? ADMIN_HTML_CSP : API_CSP);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
