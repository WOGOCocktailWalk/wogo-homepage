/* ==========================================================================
   WOGO Admin — service worker (migrations/0032 PWA/push build).
   Scope: /admin/ (registered that way in admin.js). Embedded into the
   Worker bundle by build.mjs (the same "hand-edited source -> generated
   module" pattern as admin.html/css/js) and served at GET /admin/sw.js by
   src/admin/pwa.js — edit THIS file, then re-run node src/admin/build.mjs
   and redeploy.

   Deliberately minimal and SAFE:
     - caches ONLY the app shell document itself — NEVER an /admin/api/*
       response. A cached booking list could show a sold-out seat as free,
       or a cancelled booking as live — that risk is never worth "the
       dashboard looks the same offline." Every API call is left completely
       untouched by this file (no fetch-event interception at all).
     - `push` is payload-less by design (SPEC.md's notification-system
       section explains why) — this handler's entire job is "wake up, then
       ask the dashboard what's actually new," never to read event.data.
     - `notificationclick` focuses an already-open tab (and hands it the
       deep link via postMessage — a service worker can't rewrite another
       page's location.hash directly) or opens a new one.
   ========================================================================== */

const SHELL_CACHE = 'wogo-admin-shell-v1';
const SHELL_URL = '/admin/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.add(SHELL_URL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // ONLY the shell document itself. Not the manifest, not an icon, and
  // ABOVE ALL not anything under /admin/api/* — those are left to the
  // network exactly as if this service worker weren't installed.
  if (url.pathname !== '/admin/' && url.pathname !== '/admin') return;

  event.respondWith(
    fetch(event.request)
      .then((fresh) => {
        caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, fresh.clone())).catch(() => {});
        return fresh;
      })
      .catch(() => caches.match(SHELL_URL).then((cached) => cached || Response.error()))
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    fetch('/admin/api/notifications/pending', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error('pending fetch failed: ' + res.status);
        return res.json();
      })
      .then((data) => {
        const notifs = (data && data.notifications) || [];
        if (notifs.length === 0) return null;
        // Cap at 3 individual OS notifications — a device that was offline
        // for a while shouldn't surface a wall of alerts at once; the
        // dashboard's own Today view is where the full backlog lives.
        return Promise.all(notifs.slice(0, 3).map((n) =>
          self.registration.showNotification(n.title, {
            body: n.body,
            tag: n.id,
            data: { url: n.url || '/admin/' },
            icon: '/admin/icon-192.png',
            badge: '/admin/icon-192.png',
          })
        ));
      })
      .catch(() =>
        // Session expired, offline, or any other failure — SPEC.md asks
        // explicitly for this fallback rather than failing silently: a
        // generic notification still tells the owner something happened.
        self.registration.showNotification('New activity in WOGO', {
          body: 'Tap to open the dashboard.',
          tag: 'wogo-generic',
          data: { url: '/admin/' },
          icon: '/admin/icon-192.png',
        })
      )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/admin/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'wogo-notification-click', url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
