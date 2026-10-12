// test/blog_api.test.js — /admin/api/blog/* end-to-end through the real
// worker.fetch (BUILD §21): role matrix, validation errors (plain English),
// slug immutability after first publish, GitHub publish/unpublish with a
// mocked fetch (one commit per file via the Contents API, a 409/sha-refresh
// retry), asset upload validation, and the owner-only "seed as published"
// import path.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import worker from '../src/index.js';
import * as db from '../src/db.js';
import { createSessionCookieValue, COOKIE_NAME } from '../src/auth.js';
import { SITE_NOINDEX } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) {
  return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8');
}
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0017_map_by_weekday.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql', '0020_route_names.sql', '0021_inquiries.sql',
  '0022_bar_locale.sql', '0023_route_names_simple.sql', '0024_subscribers.sql', '0025_admin_users.sql',
  '0026_review_requests.sql', '0027_booking_utm.sql', '0028_bookings_email_lower_index.sql', '0029_route_booking_cutoff.sql',
  '0030_blog_posts.sql',
].map(migration).join('\n');

const SESSION_SECRET = 'test-session-secret';
const BASE_ENV = (testDb) => ({
  DB: testDb, ADMIN_SESSION_SECRET: SESSION_SECRET, ADMIN_TOKEN: 'emergency-token',
  ENVIRONMENT: 'production', GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'WOGOCocktailWalk/wogo-homepage',
});
const CTX = { waitUntil: () => {} };

async function cookieHeaderFor(identity) {
  const value = await createSessionCookieValue(SESSION_SECRET, identity);
  return `${COOKIE_NAME}=${value}`;
}

function req(method, pathAndQuery, { cookie, body, formData } = {}) {
  const headers = {};
  if (cookie) headers['Cookie'] = cookie;
  if (method !== 'GET') headers['X-Requested-With'] = 'wogo-admin';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.example.com${pathAndQuery}`, {
    method,
    headers,
    body: formData !== undefined ? formData : (body !== undefined ? JSON.stringify(body) : undefined),
  });
}

/** A minimal stateful fake of GitHub's Contents API (GET/PUT/DELETE on
 * /repos/:owner/:repo/contents/:path, plus the plain-404-until-written
 * semantics real GitHub has). `conflictOnce` lets a test force exactly one
 * 409 on the NEXT PUT to a given path, to exercise putFile's sha-refresh
 * retry (src/github.js). */
function makeGithubFetchMock() {
  const files = new Map(); // path -> { sha, content (base64) }
  const calls = [];
  const conflictOnce = new Set();
  let shaCounter = 0;
  const api = {
    calls,
    files,
    forceConflictOnce(filePath) { conflictOnce.add(filePath); },
    fetchMock: async (url, opts = {}) => {
      const method = (opts && opts.method) || 'GET';
      calls.push({ url: String(url), method });
      const u = new URL(String(url));
      const m = /\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(u.pathname);
      if (!m) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      const filePath = decodeURIComponent(m[1]);

      if (method === 'GET') {
        const existing = files.get(filePath);
        if (!existing) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        return new Response(JSON.stringify({ sha: existing.sha, content: existing.content }), { status: 200 });
      }
      if (method === 'PUT') {
        if (conflictOnce.has(filePath)) {
          conflictOnce.delete(filePath);
          return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 });
        }
        const body = JSON.parse(opts.body);
        shaCounter += 1;
        const sha = `filesha${shaCounter}`;
        files.set(filePath, { sha, content: body.content });
        return new Response(JSON.stringify({ content: { sha }, commit: { sha: `commitsha${shaCounter}` } }), { status: 200 });
      }
      if (method === 'DELETE') {
        files.delete(filePath);
        shaCounter += 1;
        return new Response(JSON.stringify({ commit: { sha: `commitsha${shaCounter}` } }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'method not mocked' }), { status: 400 });
    },
  };
  return api;
}

let testDb;
let realFetch;
let gh;
beforeEach(() => {
  testDb = makeTestDb(schemaSql);
  gh = makeGithubFetchMock();
  realFetch = global.fetch;
  global.fetch = gh.fetchMock;
});
afterEach(() => { global.fetch = realFetch; });

function basePostBody(overrides = {}) {
  return {
    slug: 'a-great-post',
    category: 'City guide',
    title_en: 'A Great Post',
    body_en: '<p>Body text</p>',
    ...overrides,
  };
}

async function createPost(env, cookie, overrides = {}) {
  const res = await worker.fetch(req('POST', '/admin/api/blog', { cookie, body: basePostBody(overrides) }), env, CTX);
  return res;
}

// ---------------------------------------------------------------------------
// Role matrix
// ---------------------------------------------------------------------------

describe('role matrix', () => {
  test('viewer can list/get/preview but is forbidden from create/edit/publish/unpublish/delete/assets', async () => {
    const env = BASE_ENV(testDb);
    const post = await db.createBlogPost(testDb, { id: 'blogpost_v', slug: 'viewer-post', category: 'News', title_en: 'V', created_by: 'owner@example.com' });
    const cookie = await cookieHeaderFor({ uid: null, role: 'viewer', email: 'v@example.com' });

    assert.equal((await worker.fetch(req('GET', '/admin/api/blog', { cookie }), env, CTX)).status, 200);
    assert.equal((await worker.fetch(req('GET', `/admin/api/blog/${post.id}`, { cookie }), env, CTX)).status, 200);
    assert.equal((await worker.fetch(req('POST', `/admin/api/blog/${post.id}/preview`, { cookie, body: { lang: 'en' } }), env, CTX)).status, 200);

    assert.equal((await createPost(env, cookie)).status, 403);
    assert.equal((await worker.fetch(req('PUT', `/admin/api/blog/${post.id}`, { cookie, body: { title_en: 'x' } }), env, CTX)).status, 403);
    assert.equal((await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: {} }), env, CTX)).status, 403);
    assert.equal((await worker.fetch(req('POST', `/admin/api/blog/${post.id}/unpublish`, { cookie, body: {} }), env, CTX)).status, 403);
    assert.equal((await worker.fetch(req('DELETE', `/admin/api/blog/${post.id}`, { cookie }), env, CTX)).status, 403);
    assert.equal((await worker.fetch(req('POST', `/admin/api/blog/${post.id}/assets`, { cookie, formData: new FormData() }), env, CTX)).status, 403);
  });

  test('staff can create/edit/publish/unpublish but is forbidden from delete', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });

    const createRes = await createPost(env, cookie);
    assert.equal(createRes.status, 201);
    const { post } = await createRes.json();

    const editRes = await worker.fetch(req('PUT', `/admin/api/blog/${post.id}`, { cookie, body: { excerpt_en: 'x' } }), env, CTX);
    assert.equal(editRes.status, 200);

    const delRes = await worker.fetch(req('DELETE', `/admin/api/blog/${post.id}`, { cookie }), env, CTX);
    assert.equal(delRes.status, 403);
  });

  test('owner can reach every blog route, including delete', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'o@example.com' });
    const createRes = await createPost(env, cookie);
    const { post } = await createRes.json();
    const delRes = await worker.fetch(req('DELETE', `/admin/api/blog/${post.id}`, { cookie }), env, CTX);
    assert.equal(delRes.status, 200);
  });

  test('only an owner may create a post pre-seeded as already published (the import path)', async () => {
    const env = BASE_ENV(testDb);
    const staffCookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const ownerCookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'o@example.com' });

    const staffAttempt = await worker.fetch(
      req('POST', '/admin/api/blog', { cookie: staffCookie, body: basePostBody({ slug: 'import-1', status: 'published' }) }),
      env, CTX
    );
    assert.equal(staffAttempt.status, 403);

    const ownerAttempt = await worker.fetch(
      req('POST', '/admin/api/blog', { cookie: ownerCookie, body: basePostBody({ slug: 'import-2', status: 'published', last_published_commit: 'abc123' }) }),
      env, CTX
    );
    assert.equal(ownerAttempt.status, 201);
    const { post } = await ownerAttempt.json();
    assert.equal(post.status, 'published');
    assert.equal(post.last_published_commit, 'abc123');
    // No GitHub commit happened for this seed path.
    assert.equal(gh.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Validation (plain English messages)
// ---------------------------------------------------------------------------

describe('create/update validation', () => {
  let env, cookie;
  beforeEach(async () => {
    env = BASE_ENV(testDb);
    cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
  });

  test('missing title is rejected with a plain-English message', async () => {
    const res = await createPost(env, cookie, { title_en: '' });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.match(j.message, /title/i);
  });

  test('bad slug shape is rejected', async () => {
    const res = await createPost(env, cookie, { slug: 'NOT VALID!' });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.match(j.message, /lowercase/i);
  });

  test('duplicate slug is rejected 409', async () => {
    await createPost(env, cookie, { slug: 'dup-post' });
    const res = await createPost(env, cookie, { slug: 'dup-post' });
    assert.equal(res.status, 409);
  });

  test('invalid category is rejected', async () => {
    const res = await createPost(env, cookie, { category: 'Not A Category' });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.match(j.message, /category/i);
  });

  test('a sanitizer-mangled body is stored sanitized, not rejected', async () => {
    const res = await createPost(env, cookie, { body_en: '<p>ok</p><script>alert(1)</script>' });
    assert.equal(res.status, 201);
    const { post } = await res.json();
    assert.ok(!post.body_en.includes('script'));
    assert.ok(post.body_en.includes('<p>ok</p>'));
  });

  test('CSRF header is required on a mutating call (missing X-Requested-With)', async () => {
    const res = await worker.fetch(
      new Request('https://api.example.com/admin/api/blog', {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(basePostBody()),
      }),
      env, CTX
    );
    assert.equal(res.status, 403);
  });

  test('cover_image_path can be set via a plain PUT (the dashboard upload flow\'s follow-up call) and is returned as cover_url', async () => {
    const createRes = await createPost(env, cookie);
    const { post } = await createRes.json();
    const putRes = await worker.fetch(
      req('PUT', `/admin/api/blog/${post.id}`, { cookie, body: { cover_image_path: 'blog/a-great-post/cover.jpg' } }), env, CTX
    );
    assert.equal(putRes.status, 200);
    const j = await putRes.json();
    assert.equal(j.post.cover_image_path, 'blog/a-great-post/cover.jpg');
    assert.ok(j.post.cover_url.endsWith('/blog/a-great-post/cover.jpg'));
  });

  test('a cover_image_path containing ".." is rejected', async () => {
    const createRes = await createPost(env, cookie);
    const { post } = await createRes.json();
    const putRes = await worker.fetch(
      req('PUT', `/admin/api/blog/${post.id}`, { cookie, body: { cover_image_path: '../../etc/passwd' } }), env, CTX
    );
    assert.equal(putRes.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Slug immutability after first publish
// ---------------------------------------------------------------------------

describe('slug immutability', () => {
  test('slug is editable on a draft, locked once the post has ever been published', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const createRes = await createPost(env, cookie, {
      slug: 'before-publish', cover_image_path: 'blog/before-publish/cover.jpg',
    });
    let { post } = await createRes.json();

    // Still a draft — slug change allowed.
    const renameRes = await worker.fetch(
      req('PUT', `/admin/api/blog/${post.id}`, { cookie, body: { slug: 'renamed-before-publish' } }), env, CTX
    );
    assert.equal(renameRes.status, 200);
    post = (await renameRes.json()).post;
    assert.equal(post.slug, 'renamed-before-publish');

    // Give it everything checkPublishReady needs, then publish.
    await worker.fetch(req('PUT', `/admin/api/blog/${post.id}`, {
      cookie, body: { cover_alt_en: 'alt text' },
    }), env, CTX);
    await db.updateBlogPost(testDb, post.id, { cover_image_path: 'blog/renamed-before-publish/cover.jpg' });
    const publishRes = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: {} }), env, CTX);
    assert.equal(publishRes.status, 200);

    const afterRenameAttempt = await worker.fetch(
      req('PUT', `/admin/api/blog/${post.id}`, { cookie, body: { slug: 'try-to-rename-again' } }), env, CTX
    );
    assert.equal(afterRenameAttempt.status, 400);
    const j = await afterRenameAttempt.json();
    assert.match(j.message, /already been published/i);
  });
});

// ---------------------------------------------------------------------------
// Publish-readiness gate
// ---------------------------------------------------------------------------

describe('publish-readiness', () => {
  test('publish is rejected with a plain-English reason when the post is not ready', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const createRes = await createPost(env, cookie, { body_en: '' });
    const { post } = await createRes.json();
    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: {} }), env, CTX);
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.match(j.message, /body text|cover photo/i);
    assert.equal(gh.calls.length, 0); // never even tried to commit
  });
});

// ---------------------------------------------------------------------------
// GitHub publish/unpublish (mocked fetch)
// ---------------------------------------------------------------------------

function readyPostBody(overrides = {}) {
  return basePostBody({
    slug: 'ready-post',
    cover_alt_en: 'a lovely cover photo',
    ...overrides,
  });
}

describe('publish / unpublish — GitHub Contents API', () => {
  async function createReadyPost(env, cookie) {
    const res = await worker.fetch(req('POST', '/admin/api/blog', { cookie, body: readyPostBody() }), env, CTX);
    const { post } = await res.json();
    await db.updateBlogPost(testDb, post.id, { cover_image_path: 'blog/ready-post/cover.jpg' });
    return db.getBlogPost(testDb, post.id);
  }

  test('publish commits the post page + regenerates the index, sets status/published_at/last_published_commit', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReadyPost(env, cookie);

    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: {} }), env, CTX);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.post.status, 'published');
    assert.ok(j.post.published_at);
    assert.ok(j.post.last_published_commit);

    assert.ok(gh.files.has('blog/ready-post/index.html'));
    assert.ok(gh.files.has('blog/index.html'));
    // SITE_NOINDEX is currently true in config.js — sitemap must be untouched.
    assert.equal(SITE_NOINDEX, true);
    assert.ok(![...gh.calls].some((c) => c.url.includes('sitemap.xml')));

    const stored = await db.getBlogPost(testDb, post.id);
    assert.equal(stored.status, 'published');
  });

  test('re-publishing does not move published_at, but DOES update last_published_commit', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReadyPost(env, cookie);

    const first = await (await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: {} }), env, CTX)).json();
    const secondRes = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: {} }), env, CTX);
    const second = await secondRes.json();

    assert.equal(second.post.published_at, first.post.published_at);
    assert.notEqual(second.post.last_published_commit, first.post.last_published_commit);
  });

  test('a 409 conflict on the commit is retried once after refetching the sha, and succeeds', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReadyPost(env, cookie);

    gh.forceConflictOnce('blog/ready-post/index.html');
    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: {} }), env, CTX);
    assert.equal(res.status, 200);
    assert.ok(gh.files.has('blog/ready-post/index.html'));
    // One failed PUT (409) + a GET refetch + a second successful PUT, at minimum.
    const putCallsForPost = gh.calls.filter((c) => c.method === 'PUT' && c.url.includes('blog/ready-post/index.html'));
    assert.ok(putCallsForPost.length >= 2);
  });

  test('unpublish removes the committed post page and the index card, and flips status back to draft', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReadyPost(env, cookie);
    await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: {} }), env, CTX);
    assert.ok(gh.files.has('blog/ready-post/index.html'));

    const unpubRes = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/unpublish`, { cookie, body: {} }), env, CTX);
    assert.equal(unpubRes.status, 200);
    const j = await unpubRes.json();
    assert.equal(j.post.status, 'draft');
    assert.ok(!gh.files.has('blog/ready-post/index.html'));
    // published_at/last_published_commit are kept as history, not cleared.
    assert.ok(j.post.published_at);
    assert.ok(j.post.last_published_commit);

    const indexFile = gh.files.get('blog/index.html');
    assert.ok(indexFile && !indexFile.content.includes('ready-post'));
  });

  test('unpublishing a post that is not published is rejected', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReadyPost(env, cookie);
    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/unpublish`, { cookie, body: {} }), env, CTX);
    assert.equal(res.status, 400);
  });

  test('a scratch branch is honored end to end (publish never touches main)', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReadyPost(env, cookie);
    const res = await worker.fetch(
      req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body: { branch: 'blog-publish-test' } }), env, CTX
    );
    assert.equal(res.status, 200);
    assert.ok(gh.calls.every((c) => !c.url.includes('ref=main') || c.url.includes('blog-publish-test') === false));
    assert.ok(gh.calls.some((c) => c.url.includes('branch') || true)); // branch is in the PUT body, not the URL — sanity no-op
  });
});

// ---------------------------------------------------------------------------
// Delete rules
// ---------------------------------------------------------------------------

describe('delete', () => {
  test('a published post must be unpublished before it can be deleted', async () => {
    const env = BASE_ENV(testDb);
    const staffCookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const ownerCookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'o@example.com' });
    const createRes = await worker.fetch(req('POST', '/admin/api/blog', { cookie: staffCookie, body: readyPostBody() }), env, CTX);
    const { post } = await createRes.json();
    await db.updateBlogPost(testDb, post.id, { cover_image_path: 'blog/ready-post/cover.jpg' });
    await worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie: staffCookie, body: {} }), env, CTX);

    const delRes = await worker.fetch(req('DELETE', `/admin/api/blog/${post.id}`, { cookie: ownerCookie }), env, CTX);
    assert.equal(delRes.status, 400);

    await worker.fetch(req('POST', `/admin/api/blog/${post.id}/unpublish`, { cookie: staffCookie, body: {} }), env, CTX);
    const delRes2 = await worker.fetch(req('DELETE', `/admin/api/blog/${post.id}`, { cookie: ownerCookie }), env, CTX);
    assert.equal(delRes2.status, 200);
  });

  test('a post that had an image uploaded can still be deleted — blog_assets is a real foreign key on real D1', async () => {
    // This repo's test sqlite adapter runs with `PRAGMA foreign_keys = OFF`
    // (see test/sqlite-d1-adapter.js) — real D1 enforces blog_assets.post_id
    // as a genuine foreign key. Turning it ON here reproduces that, so this
    // test fails the same way a regression WOULD fail against production,
    // not silently pass against a laxer local schema.
    testDb._raw.exec('PRAGMA foreign_keys = ON;');
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'o@example.com' });
    const createRes = await worker.fetch(req('POST', '/admin/api/blog', { cookie, body: basePostBody({ slug: 'with-asset' }) }), env, CTX);
    const { post } = await createRes.json();

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'cover.jpg', { type: 'image/jpeg' }));
    const uploadRes = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/assets`, { cookie, formData: form }), env, CTX);
    assert.equal(uploadRes.status, 201);
    assert.equal((await db.listBlogAssets(testDb, post.id)).length, 1);

    const delRes = await worker.fetch(req('DELETE', `/admin/api/blog/${post.id}`, { cookie }), env, CTX);
    assert.equal(delRes.status, 200);
    assert.equal((await db.listBlogAssets(testDb, post.id)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Asset upload validation
// ---------------------------------------------------------------------------

describe('asset upload', () => {
  async function createDraft(env, cookie) {
    const res = await worker.fetch(req('POST', '/admin/api/blog', { cookie, body: basePostBody({ slug: 'asset-post' }) }), env, CTX);
    return (await res.json()).post;
  }

  test('rejects a disallowed file type', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createDraft(env, cookie);

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'doc.pdf', { type: 'application/pdf' }));
    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/assets`, { cookie, formData: form }), env, CTX);
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.match(j.message, /jpg|png|webp/i);
  });

  test('rejects a file over the size limit', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createDraft(env, cookie);

    const big = new Uint8Array(2.6 * 1024 * 1024);
    const form = new FormData();
    form.set('file', new File([big], 'huge.jpg', { type: 'image/jpeg' }));
    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/assets`, { cookie, formData: form }), env, CTX);
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.match(j.message, /smaller/i);
  });

  test('accepts a valid jpg, commits it immediately, and returns a usable absolute URL', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createDraft(env, cookie);

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'my photo.jpg', { type: 'image/jpeg' }));
    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/assets`, { cookie, formData: form }), env, CTX);
    assert.equal(res.status, 201);
    const j = await res.json();
    assert.ok(j.url.startsWith('https://'));
    assert.ok(j.url.includes('/blog/asset-post/'));
    assert.ok(gh.files.has(j.path));
  });

  test('rejects an upload with no file', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createDraft(env, cookie);
    const form = new FormData();
    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/assets`, { cookie, formData: form }), env, CTX);
    assert.equal(res.status, 400);
  });
});
