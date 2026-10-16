// src/admin/pwa.js — manifest / service worker / icon Responses for the
// installable admin dashboard (migrations/0032 PWA/push build). Hand-
// written glue: ADMIN_SW_JS comes from the generated src/admin/assets.js
// (built from the hand-edited src/admin/sw.js — see build.mjs), the icon
// bytes from the generated src/admin/icons_data.js (built from the
// repo-root icon-192.png/icon-512.png/apple-touch-icon.png — see
// scripts/build_admin_icons.mjs). Routes registered in src/index.js, and
// all five exact paths are in that file's PUBLIC_ADMIN_PATHS — these are
// static, non-sensitive assets a browser (or a Service-Worker-script
// fetch, which must never be redirected) needs BEFORE assuming a session
// exists.

import { ADMIN_SW_JS } from './assets.js';
import { ADMIN_ICON_192_B64, ADMIN_ICON_512_B64, ADMIN_APPLE_TOUCH_ICON_B64 } from './icons_data.js';

const MANIFEST = {
  name: 'WOGO Dashboard',
  short_name: 'WOGO',
  description: 'The WOGO Cocktail Walk booking control room.',
  start_url: '/admin/',
  scope: '/admin/',
  display: 'standalone',
  background_color: '#f4e6dc', // --page-bg (admin.css) — the splash-screen background while the app loads
  theme_color: '#3f2b21',      // --espresso (admin.css) — matches the sidebar, used for the OS status bar
  icons: [
    { src: '/admin/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/admin/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};

export function manifestResponse() {
  return new Response(JSON.stringify(MANIFEST), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

/**
 * A Service-Worker script response must never redirect and must be served
 * with a CSP that doesn't block the worker's OWN same-origin fetches — the
 * generic withSecurityHeaders() wrap in index.js would otherwise stamp the
 * default API_CSP (`default-src 'none'`) on this response (it isn't
 * text/html), which — because a Service Worker inherits CSP from its own
 * script response — would silently break `push`'s same-origin fetch to
 * /admin/api/notifications/pending. Setting Content-Security-Policy here
 * short-circuits that (withSecurityHeaders only fills in a header that
 * isn't already set). See test/notifications.test.js's dedicated assertion
 * on this exact header.
 */
export function serviceWorkerResponse() {
  return new Response(ADMIN_SW_JS, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/admin/',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; object-src 'none'",
    },
  });
}

const ICONS = {
  icon192: ADMIN_ICON_192_B64,
  icon512: ADMIN_ICON_512_B64,
  appleTouchIcon: ADMIN_APPLE_TOUCH_ICON_B64,
};

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** `name` is one of 'icon192' | 'icon512' | 'appleTouchIcon'. Long cache —
 * these bytes only change when scripts/build_admin_icons.mjs is re-run and
 * the Worker redeployed, never at request time. */
export function iconResponse(name) {
  const b64 = ICONS[name];
  if (!b64) return new Response('not_found', { status: 404 });
  return new Response(base64ToBytes(b64), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  });
}
