// test/missing_pages.test.js — the missing-address log: path cleaning, scanner
// noise, the public beacon endpoint (always 204, rate limited, CORS), storage
// (atomic counts, cap, pruning) and the two dashboard handlers.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, rows, sql } from './data_tools_helpers.js';
import worker, { router } from '../src/index.js';
import { ROUTE_ROLES } from '../src/admin_api.js';
import { normalizeMissingPath, isScannerNoise, handleMissingPageHit, handleListMissingPages, handleForgetMissingPage } from '../src/missing_pages.js';
import { createSessionCookieValue, COOKIE_NAME } from '../src/auth.js';
import * as db from '../src/db.js';
import { MISSING_PAGE_HITS_PER_WINDOW } from '../src/config.js';

const ORIGIN = 'https://www.wogococktailwalk.com';
let testDb, env;
beforeEach(() => { testDb = freshDb(); env = { DB: testDb, ADMIN_SESSION_SECRET: 's3cret', ENVIRONMENT: 'production' }; });

function beacon(path, { origin = ORIGIN, ip = '198.51.100.7', ua = 'Mozilla/5.0 (iPhone)' } = {}) {
  const headers = { 'Content-Type': 'text/plain', 'CF-Connecting-IP': ip, 'User-Agent': ua };
  if (origin) headers.Origin = origin;
  return new Request('https://worker.example.com/api/missing-page', { method: 'POST', headers, body: path });
}
const stored = () => rows(testDb, `SELECT k, v FROM settings WHERE k LIKE 'notfound:%' ORDER BY k`);

describe('normalizeMissingPath', () => {
  test('keeps an ordinary path, lower-cased, without query, hash or trailing slash', () => {
    assert.equal(normalizeMissingPath('/Amsterdam/Old-Route/?utm_source=ig#x'), '/amsterdam/old-route');
    assert.equal(normalizeMissingPath('//nl//boeken///'), '/nl/boeken');
  });
  test('email addresses, long tokens, uuids and long numbers are stripped', () => {
    assert.equal(normalizeMissingPath('/confirm/anna.test@example.com'), '/confirm/[email]');
    assert.equal(normalizeMissingPath('/confirm/anna.test%40example.com'), '/confirm/[email]');
    assert.equal(normalizeMissingPath('/booking/3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b'), '/booking/[token]');
    assert.equal(normalizeMissingPath('/x/a8f3c9d2e1b4f6a7c8d9'), '/x/[token]');
    assert.equal(normalizeMissingPath('/r/Xk39Pq2LmZ8vT1wYrAb4'), '/r/[token]');
    assert.equal(normalizeMissingPath('/call/0612345678'), '/call/[number]');
  });
  test('long real slugs made of words survive', () => {
    assert.equal(normalizeMissingPath('/blog/the-best-cocktail-walk-in-amsterdam-for-hen-parties'), '/blog/the-best-cocktail-walk-in-amsterdam-for-hen-parties');
  });
  test('junk is ignored: relative, control chars, double-encoding, too long/deep, odd characters', () => {
    for (const bad of ['', 'amsterdam', '/a\u0000b', '/a%2520b', '/' + 'a/'.repeat(9), '/' + 'ab-'.repeat(50), '/a b', '/a<script>', '/a\\b', null, undefined, 42, '/%E0%A4%A']) {
      assert.equal(normalizeMissingPath(bad), null, String(bad));
    }
    assert.equal(normalizeMissingPath('/' + 'x'.repeat(400)), null);
  });
  test('scanner noise is ignored', () => {
    for (const p of ['/wp-login.php', '/wp-admin/', '/blog/wp-content/x', '/index.php', '/a.PHP', '/.env', '/.git/config', '/admin', '/admin/login', '/administrator/', '/phpmyadmin/', '/cgi-bin/x', '/backup.sql', '/a/../etc/passwd', '/vendor/phpunit', '/404.html', '/xmlrpc.php']) {
      assert.equal(isScannerNoise(p), true, p);
      assert.equal(normalizeMissingPath(p), null, p);
    }
    assert.equal(isScannerNoise('/amsterdam/old-route'), false);
  });
});

describe('POST /api/missing-page', () => {
  test('stores only the path with a count and first/last seen; answers 204 with CORS', async () => {
    const res = await handleMissingPageHit(beacon('/Old-Page/?email=a@b.c'), env);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const [r] = stored();
    assert.equal(r.k, 'notfound:/old-page');
    const v = JSON.parse(r.v);
    assert.equal(v.hits, 1);
    assert.match(v.first, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.deepEqual(Object.keys(v).sort(), ['first', 'hits', 'last']);
    // nothing identifying anywhere in the settings row, and no raw IP anywhere
    assert.ok(!JSON.stringify(rows(testDb, 'SELECT * FROM settings')).includes('198.51.100.7'));
    assert.ok(!JSON.stringify(rows(testDb, 'SELECT * FROM rate_events')).includes('198.51.100.7'));
  });

  test('repeat visits count up on the same row', async () => {
    for (let i = 0; i < 3; i += 1) await handleMissingPageHit(beacon('/old-page', { ip: `198.51.100.${i}` }), env);
    assert.equal(stored().length, 1);
    assert.equal(JSON.parse(stored()[0].v).hits, 3);
  });

  test('concurrent hits are all counted (no lost updates)', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => handleMissingPageHit(beacon('/busy', { ip: `203.0.113.${i}` }), env)));
    assert.equal(JSON.parse(stored()[0].v).hits, 8);
  });

  test('scanner noise and junk cause no writes at all (not even a rate event)', async () => {
    for (const p of ['/wp-login.php', '/.env', '/admin', '/x'.repeat(200), '']) {
      assert.equal((await handleMissingPageHit(beacon(p), env)).status, 204);
    }
    assert.equal(rows(testDb, 'SELECT COUNT(*) AS n FROM settings')[0].n, 0);
    assert.equal(rows(testDb, 'SELECT COUNT(*) AS n FROM rate_events')[0].n, 0);
  });

  test('bots, a missing Origin and a foreign Origin store nothing', async () => {
    assert.equal((await handleMissingPageHit(beacon('/a', { ua: 'Googlebot/2.1' }), env)).status, 204);
    assert.equal((await handleMissingPageHit(beacon('/a', { origin: null }), env)).status, 204);
    const foreign = await handleMissingPageHit(beacon('/a', { origin: 'https://evil.example' }), env);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(stored().length, 0);
  });

  test('per-visitor rate limit: extra hits from one IP are dropped, still 204', async () => {
    for (let i = 0; i < MISSING_PAGE_HITS_PER_WINDOW + 5; i += 1) {
      assert.equal((await handleMissingPageHit(beacon('/same-visitor'), env)).status, 204);
    }
    assert.equal(JSON.parse(stored()[0].v).hits, MISSING_PAGE_HITS_PER_WINDOW);
    // another visitor is unaffected
    await handleMissingPageHit(beacon('/same-visitor', { ip: '192.0.2.99' }), env);
    assert.equal(JSON.parse(stored()[0].v).hits, MISSING_PAGE_HITS_PER_WINDOW + 1);
  });

  test('a database failure still answers 204 (the 404 page never sees an error)', async () => {
    const res = await handleMissingPageHit(beacon('/a'), { DB: { prepare() { throw new Error('db down'); } } });
    assert.equal(res.status, 204);
  });

  test('is wired through the real worker, including the CORS preflight', async () => {
    const pre = await worker.fetch(new Request('https://worker.example.com/api/missing-page', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, { waitUntil() {} });
    assert.equal(pre.status, 204);
    const res = await worker.fetch(beacon('/via-worker', { ip: '192.0.2.1' }), env, { waitUntil() {} });
    assert.equal(res.status, 204);
    assert.equal(stored().length, 1);
  });
});

describe('storage: cap and pruning', () => {
  test('the number of distinct paths is capped; known paths keep counting at the cap', async () => {
    assert.equal(await db.recordMissingPageHit(testDb, '/a', 2), 'counted');
    assert.equal(await db.recordMissingPageHit(testDb, '/b', 2), 'counted');
    assert.equal(await db.recordMissingPageHit(testDb, '/c', 2), 'full');
    assert.equal(await db.recordMissingPageHit(testDb, '/a', 2), 'counted');
    const list = await db.listMissingPages(testDb);
    assert.deepEqual(list.map((r) => [r.path, r.hits]), [['/a', 2], ['/b', 1]]);
  });

  test('the cap only counts missing-page rows, not other settings', async () => {
    sql(testDb, `INSERT INTO settings (k, v) VALUES ('blog_schedule:1', 'x'), ('push_prefs:2', 'y')`);
    assert.equal(await db.recordMissingPageHit(testDb, '/a', 1), 'counted');
  });

  test('prune forgets paths not seen for 90 days and leaves everything else alone', async () => {
    await db.recordMissingPageHit(testDb, '/old', 50);
    await db.recordMissingPageHit(testDb, '/new', 50);
    sql(testDb, `UPDATE settings SET v = json_set(v, '$.last', datetime('now', '-91 days')) WHERE k = 'notfound:/old'`);
    sql(testDb, `INSERT INTO settings (k, v) VALUES ('blog_schedule:1', 'x')`);
    const { sqliteMinutesAgo } = await import('../src/logic.js');
    assert.equal(await db.pruneMissingPages(testDb, sqliteMinutesAgo(90 * 24 * 60)), 1);
    assert.deepEqual((await db.listMissingPages(testDb)).map((r) => r.path), ['/new']);
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM settings WHERE k = 'blog_schedule:1'`)[0].n, 1);
  });
});

describe('dashboard: list and forget', () => {
  async function adminReq(method, path, body, role = 'staff') {
    const value = await createSessionCookieValue('s3cret', { uid: null, role, email: 'x@example.com' });
    const headers = { Cookie: `${COOKIE_NAME}=${value}` };
    if (method !== 'GET') headers['X-Requested-With'] = 'wogo-admin';
    return worker.fetch(new Request('https://worker.example.com' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  }

  test('both routes have an explicit role entry (staff)', () => {
    assert.equal(ROUTE_ROLES['GET /admin/api/missing-pages'], 'staff');
    assert.equal(ROUTE_ROLES['POST /admin/api/missing-pages/forget'], 'staff');
    assert.ok(router.match('GET', '/admin/api/missing-pages'));
  });

  test('lists path, hits and last seen, most visited first', async () => {
    await db.recordMissingPageHit(testDb, '/rare', 50);
    await db.recordMissingPageHit(testDb, '/popular', 50);
    await db.recordMissingPageHit(testDb, '/popular', 50);
    const body = await (await handleListMissingPages(new Request('https://x/'), env)).json();
    assert.deepEqual(body.pages.map((p) => [p.path, p.hits]), [['/popular', 2], ['/rare', 1]]);
    assert.ok(body.pages[0].last_seen);
    assert.equal(body.forget_after_days, 90);
  });

  test('forget removes exactly that row, is audited, and cannot reach other settings', async () => {
    await db.recordMissingPageHit(testDb, '/gone', 50);
    await db.recordMissingPageHit(testDb, '/stays', 50);
    sql(testDb, `INSERT INTO settings (k, v) VALUES ('blog_schedule:1', 'x')`);
    let res = await adminReq('POST', '/admin/api/missing-pages/forget', { path: '/gone' });
    assert.equal(res.status, 200);
    assert.deepEqual((await db.listMissingPages(testDb)).map((r) => r.path), ['/stays']);
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'missing_page.forget'`)[0].n, 1);
    res = await adminReq('POST', '/admin/api/missing-pages/forget', { path: '/gone' });
    assert.equal(res.status, 404);
    res = await adminReq('POST', '/admin/api/missing-pages/forget', { path: 'blog_schedule:1' });
    assert.equal(res.status, 400);
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM settings WHERE k = 'blog_schedule:1'`)[0].n, 1);
  });

  test('a viewer cannot list or forget; a missing CSRF header is refused', async () => {
    assert.equal((await adminReq('GET', '/admin/api/missing-pages', null, 'viewer')).status, 403);
    assert.equal((await adminReq('POST', '/admin/api/missing-pages/forget', { path: '/a' }, 'viewer')).status, 403);
    const direct = await handleForgetMissingPage(new Request('https://x/', { method: 'POST', body: '{"path":"/a"}' }), env);
    assert.equal(direct.status, 403);
  });
});
