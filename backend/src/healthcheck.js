// src/healthcheck.js — cron self-check (owner audit item #6). Production
// hardening, 2026-07.
//
// Two layers:
//   1. ALWAYS runs: D1 reachable + every secret the Worker needs to function
//      is actually set. This is an in-process check — no knowledge of the
//      Worker's own public URL required — and catches the #1 real-world
//      "silently broken deploy" cause: a missing/typo'd Worker Secret that
//      doesn't throw until a guest happens to hit the exact code path that
//      needs it.
//   2. OPTIONAL: a real HTTP self-fetch of the guest API + admin shell, only
//      when env.HEALTH_CHECK_BASE_URL is set (empty by default — see
//      config.js:HEALTH_CHECK_BASE_URL_VAR and SETUP.md §14). Filling that in
//      is a one-line, zero-risk config.js.prod-bak-style change once the
//      backend has a real public route; until then this layer is a no-op.
//
// External uptime (the OTHER half of "monitoring/uptime") is intentionally
// NOT reimplemented here — a Worker cannot prove ITS OWN public reachability
// to itself (DNS/routing failures are exactly the class of problem a
// self-check can't see). That's UptimeRobot's job; see SETUP.md §14.

import * as db from './db.js';
import { alertOwnerThrottled } from './alerts.js';
import { escapeHtml } from './emails.js';
import { HEALTH_CHECK_ALERT_THROTTLE_MINUTES } from './config.js';

const REQUIRED_SECRETS = ['ADMIN_TOKEN', 'ADMIN_SESSION_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'BREVO_API_KEY'];

export async function runHealthCheck(env, deps = {}) {
  const database = deps.database || db;
  const doFetch = deps.fetch || fetch;
  const problems = [];

  try {
    await database.pingDb(env.DB);
  } catch (err) {
    problems.push(`D1 query failed: ${String(err && err.message ? err.message : err)}`);
  }

  for (const name of REQUIRED_SECRETS) {
    if (!env[name]) problems.push(`missing secret: ${name}`);
  }

  if (env.HEALTH_CHECK_BASE_URL) {
    const base = env.HEALTH_CHECK_BASE_URL.replace(/\/$/, '');
    const targets = [
      { path: '/api/routes', label: 'guest API' },
      { path: '/admin/login', label: 'admin shell' },
    ];
    for (const t of targets) {
      try {
        const res = await doFetch(base + t.path, { method: 'GET' });
        if (!res.ok) problems.push(`${t.label} returned HTTP ${res.status}`);
      } catch (err) {
        problems.push(`${t.label} unreachable: ${String(err && err.message ? err.message : err)}`);
      }
    }
  }

  if (problems.length > 0) {
    await alertOwnerThrottled(
      env, 'health_check', HEALTH_CHECK_ALERT_THROTTLE_MINUTES,
      'WOGO backend health check failed',
      `<pre style="white-space:pre-wrap;font:13px ui-monospace,monospace;">${escapeHtml(problems.join('\n'))}</pre>`,
      { database }
    );
  }

  return { ok: problems.length === 0, problems };
}
