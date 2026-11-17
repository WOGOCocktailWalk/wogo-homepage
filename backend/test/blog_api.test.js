// test/blog_api.test.js — /admin/api/blog/* end-to-end through the real
// worker.fetch (BUILD §21): role matrix, validation errors (plain English),
// slug immutability after first publish, GitHub publish/unpublish with a
// mocked fetch (ONE commit per publish via the Git Data API, a refused ref
// move retried once), asset upload validation, and the owner-only "seed as published"
// import path.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { makeGithubFetchMock } from './github_mock.js';
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

describe('publish / unpublish — one commit through the GitHub Git Data API', () => {
  async function createReadyPost(env, cookie, overrides = {}) {
    const slug = overrides.slug || 'ready-post';
    const res = await worker.fetch(req('POST', '/admin/api/blog', { cookie, body: readyPostBody(overrides) }), env, CTX);
    const { post } = await res.json();
    await db.updateBlogPost(testDb, post.id, { cover_image_path: `blog/${slug}/cover.jpg` });
    return db.getBlogPost(testDb, post.id);
  }
  const staff = () => cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
  const publish = (env, cookie, post, body = {}) => worker.fetch(req('POST', `/admin/api/blog/${post.id}/publish`, { cookie, body }), env, CTX);
  const unpublish = (env, cookie, post) => worker.fetch(req('POST', `/admin/api/blog/${post.id}/unpublish`, { cookie, body: {} }), env, CTX);
  const SITEMAP = '<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n  <url>\n    <loc>https://www.wogococktailwalk.com/blog/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n</urlset>\n';
  const DUTCH = { title_nl: 'Een klaar bericht', excerpt_nl: 'Korte tekst', body_nl: '<p>Hier is de Nederlandse tekst</p>' };
  const sitemapLocs = () => [...gh.text('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace('https://www.wogococktailwalk.com', ''));

  test('publish of a post WITHOUT Dutch text: English page + English index + sitemap line in ONE commit, no Dutch files', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const base = gh.commitCount();
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie);

    const res = await publish(env, cookie, post);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.post.status, 'published');
    assert.ok(j.post.published_at);
    assert.equal(j.post.last_published_commit, gh.head());
    assert.equal(j.commit_sha, gh.head());

    assert.equal(gh.commitCount() - base, 1, 'one commit for the whole publish');
    assert.deepEqual([...gh.files.keys()].sort(), ['blog/index.html', 'blog/ready-post/index.html', 'sitemap.xml']);
    assert.ok(!gh.files.has('nl/blog/ready-post/index.html') && !gh.files.has('nl/blog/index.html'));
    // Site is live (SITE_NOINDEX false since 17 Nov 2026): sitemap gets the post, without Dutch lines
    assert.equal(SITE_NOINDEX, false);
    assert.deepEqual(sitemapLocs(), ['/blog/', '/blog/ready-post/']);
    assert.ok(!gh.text('blog/ready-post/index.html').includes('rel="alternate"'));
    assert.equal((await db.getBlogPost(testDb, post.id)).status, 'published');
  });

  test('publish of a post WITH Dutch text also commits the Dutch page, the Dutch index and the hreflang sitemap lines — still ONE commit', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const base = gh.commitCount();
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie, DUTCH);

    assert.equal((await publish(env, cookie, post)).status, 200);
    assert.equal(gh.commitCount() - base, 1);
    assert.deepEqual([...gh.files.keys()].sort(), ['blog/index.html', 'blog/ready-post/index.html', 'nl/blog/index.html', 'nl/blog/ready-post/index.html', 'sitemap.xml']);
    const nl = gh.text('nl/blog/ready-post/index.html');
    assert.match(nl, /<html lang="nl">/);
    assert.ok(nl.includes('Hier is de Nederlandse tekst') && nl.includes('<title>Een klaar bericht | WOGO</title>'));
    assert.ok(!nl.includes('Body text'));
    const en = gh.text('blog/ready-post/index.html');
    assert.ok(en.includes('<link rel="alternate" hreflang="nl" href="https://www.wogococktailwalk.com/nl/blog/ready-post/">'));
    assert.ok(!en.includes('Hier is de Nederlandse tekst'));
    assert.ok(gh.text('nl/blog/index.html').includes('href="ready-post/"'));
    assert.deepEqual(sitemapLocs(), ['/blog/', '/nl/blog/', '/blog/ready-post/', '/nl/blog/ready-post/']);
  });

  test('a post that LOSES its Dutch text on re-publish gets its Dutch page, Dutch index and Dutch sitemap lines removed', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie, DUTCH);
    await publish(env, cookie, post);
    assert.ok(gh.files.has('nl/blog/ready-post/index.html'));

    await db.updateBlogPost(testDb, post.id, { body_nl: null });
    const before = gh.commitCount();
    assert.equal((await publish(env, cookie, post)).status, 200);
    assert.equal(gh.commitCount() - before, 1);
    assert.ok(!gh.files.has('nl/blog/ready-post/index.html'));
    assert.ok(!gh.files.has('nl/blog/index.html'));
    assert.deepEqual(sitemapLocs(), ['/blog/', '/blog/ready-post/']);
    assert.ok(!gh.text('blog/ready-post/index.html').includes('rel="alternate"'));
  });

  test('the Dutch index lists only posts with Dutch text; the English index lists all', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const a = await createReadyPost(env, cookie, { slug: 'post-with-nl', ...DUTCH });
    const b = await createReadyPost(env, cookie, { slug: 'post-english-only' });
    await publish(env, cookie, a);
    await publish(env, cookie, b);
    const en = gh.text('blog/index.html');
    const nl = gh.text('nl/blog/index.html');
    assert.ok(en.includes('href="post-with-nl/"') && en.includes('href="post-english-only/"'));
    assert.ok(nl.includes('href="post-with-nl/"') && !nl.includes('post-english-only'));
    assert.ok(!gh.files.has('nl/blog/post-english-only/index.html'));
  });

  test('re-publishing with nothing changed makes no commit and keeps published_at and last_published_commit', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie, DUTCH);
    const first = await (await publish(env, cookie, post)).json();
    const commits = gh.commitCount();
    const second = await (await publish(env, cookie, post)).json();
    assert.equal(gh.commitCount(), commits, 'no empty commit');
    assert.equal(second.post.published_at, first.post.published_at);
    assert.equal(second.post.last_published_commit, first.post.last_published_commit);
  });

  test('re-publishing after an edit does not move published_at, but DOES update last_published_commit', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie);
    const first = await (await publish(env, cookie, post)).json();
    await db.updateBlogPost(testDb, post.id, { body_en: '<p>Edited</p>' });
    const second = await (await publish(env, cookie, post)).json();
    assert.equal(second.post.published_at, first.post.published_at);
    assert.notEqual(second.post.last_published_commit, first.post.last_published_commit);
    assert.ok(gh.text('blog/ready-post/index.html').includes('Edited'));
  });

  test('if another commit lands on the branch meanwhile (ref move refused), the publish is rebuilt on top of it and succeeds', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie);
    gh.forceRefConflictOnce();
    const res = await publish(env, cookie, post);
    assert.equal(res.status, 200);
    assert.ok(gh.files.has('blog/ready-post/index.html'));
    assert.equal(gh.calls.filter((c) => c.method === 'PATCH').length, 2);
  });

  test('a failed GitHub write leaves the post a draft in D1 (nothing is marked live that is not)', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie);
    const failing = gh.fetchMock;
    let patches = 0;
    global.fetch = async (url, opts = {}) => {
      if (opts.method === 'PATCH') { patches += 1; return new Response('{"message":"boom"}', { status: 500 }); }
      return failing(url, opts);
    };
    const res = await publish(env, cookie, post);
    assert.ok(res.status >= 500);
    assert.equal(patches, 1);
    assert.equal((await db.getBlogPost(testDb, post.id)).status, 'draft');
    assert.equal(gh.files.size, 0);
  });

  test('unpublish removes the English AND the Dutch page, both index cards and the sitemap lines in ONE commit, and flips status back to draft', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie, DUTCH);
    await publish(env, cookie, post);
    assert.ok(gh.files.has('blog/ready-post/index.html') && gh.files.has('nl/blog/ready-post/index.html'));

    const before = gh.commitCount();
    const unpubRes = await unpublish(env, cookie, post);
    assert.equal(unpubRes.status, 200);
    assert.equal(gh.commitCount() - before, 1);
    const j = await unpubRes.json();
    assert.equal(j.post.status, 'draft');
    assert.ok(!gh.files.has('blog/ready-post/index.html'));
    assert.ok(!gh.files.has('nl/blog/ready-post/index.html'));
    assert.ok(!gh.files.has('nl/blog/index.html'), 'no Dutch posts left: no Dutch index');
    assert.ok(!gh.text('blog/index.html').includes('ready-post'));
    assert.deepEqual(sitemapLocs(), ['/blog/']);
    // published_at/last_published_commit are kept as history, not cleared.
    assert.ok(j.post.published_at);
    assert.ok(j.post.last_published_commit);
  });

  test('unpublishing one post keeps the Dutch index for the other Dutch posts', async () => {
    gh.seed('sitemap.xml', SITEMAP);
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const a = await createReadyPost(env, cookie, { slug: 'nl-one', ...DUTCH });
    const b = await createReadyPost(env, cookie, { slug: 'nl-two', ...DUTCH });
    await publish(env, cookie, a);
    await publish(env, cookie, b);
    await unpublish(env, cookie, a);
    assert.ok(gh.files.has('nl/blog/nl-two/index.html') && !gh.files.has('nl/blog/nl-one/index.html'));
    const nlIdx = gh.text('nl/blog/index.html');
    assert.ok(nlIdx.includes('href="nl-two/"') && !nlIdx.includes('nl-one'));
    assert.deepEqual(sitemapLocs(), ['/blog/', '/nl/blog/', '/blog/nl-two/', '/nl/blog/nl-two/']);
  });

  test('unpublishing a post that is not published is rejected', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await staff();
    const post = await createReadyPost(env, cookie);
    assert.equal((await unpublish(env, cookie, post)).status, 400);
  });

  test('a scratch branch is honored end to end (publish never touches main)', async () => {
    gh.createBranch('blog-publish-test');
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'owner', email: 'o@example.com' });
    const post = await createReadyPost(env, cookie, DUTCH);
    const res = await publish(env, cookie, post, { branch: 'blog-publish-test' });
    assert.equal(res.status, 200);
    assert.equal(gh.files.size, 0, 'main untouched');
    assert.ok(gh.filesOn('blog-publish-test').has('nl/blog/ready-post/index.html'));
    assert.ok(gh.calls.filter((c) => c.method === 'PATCH').every((c) => c.url.endsWith('/git/refs/heads/blog-publish-test')));
  });
});

describe('preview of the Dutch page', () => {
  async function ownerAndPost(overrides = {}) {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const res = await worker.fetch(req('POST', '/admin/api/blog', { cookie, body: readyPostBody(overrides) }), env, CTX);
    const { post } = await res.json();
    return { env, cookie, post };
  }
  const preview = (env, cookie, post, body) => worker.fetch(req('POST', `/admin/api/blog/${post.id}/preview`, { cookie, body }), env, CTX).then((r) => r.json());

  test('Preview NL is the real Dutch page (lang nl, Dutch text, canonical under /nl/blog/), with unsaved overrides', async () => {
    const { env, cookie, post } = await ownerAndPost({ body_nl: '<p>Opgeslagen tekst</p>' });
    const j = await preview(env, cookie, post, { lang: 'nl', overrides: { body_nl: '<p>Nog niet opgeslagen</p>', title_nl: 'Nieuwe titel' } });
    assert.equal(j.lang, 'nl');
    assert.equal(j.exists, true);
    assert.match(j.html, /<html lang="nl">/);
    assert.ok(j.html.includes('Nog niet opgeslagen') && j.html.includes('Nieuwe titel'));
    assert.ok(!j.html.includes('Opgeslagen tekst'));
    assert.ok(j.html.includes('rel="canonical" href="https://www.wogococktailwalk.com/nl/blog/ready-post/"'));
    assert.ok(j.html.includes('<base href="https://www.wogococktailwalk.com/nl/blog/ready-post/">'));
  });

  test('Preview NL of a post with no Dutch text says there will be no Dutch page, instead of showing English', async () => {
    const { env, cookie, post } = await ownerAndPost();
    const j = await preview(env, cookie, post, { lang: 'nl' });
    assert.equal(j.exists, false);
    assert.match(j.html, /no Dutch page/i);
    assert.ok(!j.html.includes('Body text'));
  });

  test('Preview EN is the English page and ignores the Dutch text', async () => {
    const { env, cookie, post } = await ownerAndPost({ body_nl: '<p>Nederlandse tekst</p>' });
    const j = await preview(env, cookie, post, { lang: 'en' });
    assert.equal(j.exists, true);
    assert.match(j.html, /<html lang="en">/);
    assert.ok(!j.html.includes('Nederlandse tekst'));
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

// ---------------------------------------------------------------------------
// "Publish later" (17 Nov 2026) — a planned post goes live by itself
// ---------------------------------------------------------------------------
import { publishDueBlogPosts } from '../src/admin_api.js';

describe('blog — publish later', () => {
  async function createReady(env, cookie, slug = 'planned-post') {
    const res = await worker.fetch(req('POST', '/admin/api/blog', { cookie, body: readyPostBody({ slug }) }), env, CTX);
    const { post } = await res.json();
    await db.updateBlogPost(testDb, post.id, { cover_image_path: `blog/${slug}/cover.jpg` });
    return db.getBlogPost(testDb, post.id);
  }
  const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

  test('planning stores the moment, shows it in the list, and nothing is published before that moment', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReady(env, cookie);
    const when = inHours(24);

    const res = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/schedule`, { cookie, body: { publish_at: when } }), env, CTX);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).post.scheduled_at, when);

    const list = await (await worker.fetch(req('GET', '/admin/api/blog', { cookie }), env, CTX)).json();
    assert.equal(list.posts.find((p) => p.id === post.id).scheduled_at, when);

    const callsBefore = gh.calls.length;
    const report = await publishDueBlogPosts(env);
    assert.deepEqual(report.published, []);
    assert.equal(gh.calls.length, callsBefore);
    assert.equal((await db.getBlogPost(testDb, post.id)).status, 'draft');
  });

  test('once the moment has passed the timer publishes the post and clears the planning', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReady(env, cookie);
    const when = inHours(1);
    await worker.fetch(req('POST', `/admin/api/blog/${post.id}/schedule`, { cookie, body: { publish_at: when } }), env, CTX);

    const report = await publishDueBlogPosts(env, Date.parse(when) + 60 * 1000);
    assert.deepEqual(report.published, [post.id]);
    const stored = await db.getBlogPost(testDb, post.id);
    assert.equal(stored.status, 'published');
    assert.ok(gh.files.has('blog/planned-post/index.html'));
    assert.equal(await db.getSetting(testDb, 'blog_schedule:' + post.id), null);

    // A second tick must not publish it again.
    const again = await publishDueBlogPosts(env, Date.parse(when) + 10 * 60 * 1000);
    assert.deepEqual(again.published, []);
  });

  test('a moment in the past, a missing date, and an unfinished post are all refused', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReady(env, cookie);
    const past = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/schedule`, { cookie, body: { publish_at: inHours(-1) } }), env, CTX);
    assert.equal(past.status, 400);
    const none = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/schedule`, { cookie, body: {} }), env, CTX);
    assert.equal(none.status, 400);

    const bare = await (await worker.fetch(req('POST', '/admin/api/blog', { cookie, body: readyPostBody({ slug: 'no-cover' }) }), env, CTX)).json();
    const notReady = await worker.fetch(req('POST', `/admin/api/blog/${bare.post.id}/schedule`, { cookie, body: { publish_at: inHours(5) } }), env, CTX);
    assert.equal(notReady.status, 400);
    assert.equal((await notReady.json()).error, 'not_ready');
  });

  test('cancelling the planning makes it a plain draft again; a viewer may not plan', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = await createReady(env, cookie);
    const when = inHours(2);
    await worker.fetch(req('POST', `/admin/api/blog/${post.id}/schedule`, { cookie, body: { publish_at: when } }), env, CTX);
    const del = await worker.fetch(req('DELETE', `/admin/api/blog/${post.id}/schedule`, { cookie }), env, CTX);
    assert.equal(del.status, 200);
    const report = await publishDueBlogPosts(env, Date.parse(when) + 60 * 1000);
    assert.deepEqual(report.published, []);
    assert.equal((await db.getBlogPost(testDb, post.id)).status, 'draft');

    const viewer = await cookieHeaderFor({ uid: null, role: 'viewer', email: 'v@example.com' });
    const denied = await worker.fetch(req('POST', `/admin/api/blog/${post.id}/schedule`, { cookie: viewer, body: { publish_at: inHours(3) } }), env, CTX);
    assert.equal(denied.status, 403);
  });
});

// ---------------------------------------------------------------------------
// Waiting list by hand (17 Nov 2026) — lives here because this file already
// has the admin-session + database set-up these tests need.
// ---------------------------------------------------------------------------
describe('waiting list — add by hand', () => {
  test('a phone-only guest is added, shows up in the list as a waitlist row, and nothing is sent', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const before = gh.calls.length;
    const res = await worker.fetch(req('POST', '/admin/api/waitlist', { cookie, body: {
      name: '', phone: '+31 6 00000000', city: 'Utrecht', date: 'Sat 31 Jan 2027', party_size: 4, note: 'asked via WhatsApp',
    } }), env, CTX);
    assert.equal(res.status, 201);
    const { inquiry } = await res.json();
    assert.equal(inquiry.name, 'Name unknown');
    assert.equal(inquiry.email, '');
    assert.equal(inquiry.phone, '+31 6 00000000');
    assert.equal(inquiry.party_size, 4);
    assert.match(inquiry.message, /^\[Utrecht waitlist\]/);
    assert.match(inquiry.message, /asked via WhatsApp/);
    assert.equal(gh.calls.length, before); // no outgoing request of any kind (no mail, no push)

    const list = await (await worker.fetch(req('GET', '/admin/api/inquiries', { cookie }), env, CTX)).json();
    assert.equal(list.inquiries.length, 1);
  });

  test('needs a way to reach the guest, a city, and a sensible email / guest count', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const post = (body) => worker.fetch(req('POST', '/admin/api/waitlist', { cookie, body }), env, CTX);
    assert.equal((await post({ name: 'A', city: 'Utrecht' })).status, 400);
    assert.equal((await post({ name: 'A', phone: '06', city: '' })).status, 400);
    assert.equal((await post({ name: 'A', email: 'not-an-email', city: 'Utrecht' })).status, 400);
    assert.equal((await post({ name: 'A', phone: '06', city: 'Utrecht', party_size: 'many' })).status, 400);
    assert.equal((await post({ name: 'A', email: 'A@Example.com', city: 'Utrecht' })).status, 201);
  });

  test('marking as told, and removing — but never an ordinary contact message; viewers may do neither', async () => {
    const env = BASE_ENV(testDb);
    const cookie = await cookieHeaderFor({ uid: null, role: 'staff', email: 's@example.com' });
    const { inquiry } = await (await worker.fetch(req('POST', '/admin/api/waitlist', { cookie, body: { name: 'Roos', phone: '06', city: 'Utrecht' } }), env, CTX)).json();

    const told = await worker.fetch(req('POST', `/admin/api/inquiries/${inquiry.id}/status`, { cookie, body: { status: 'closed' } }), env, CTX);
    assert.equal((await told.json()).inquiry.status, 'closed');
    assert.equal((await worker.fetch(req('POST', `/admin/api/inquiries/${inquiry.id}/status`, { cookie, body: { status: 'nonsense' } }), env, CTX)).status, 400);

    const contact = await db.createInquiry(testDb, { id: 'inq_plain', kind: 'contact', name: 'X', email: 'x@example.com', message: 'Just a question' });
    assert.equal((await worker.fetch(req('DELETE', `/admin/api/inquiries/${contact.id}`, { cookie }), env, CTX)).status, 400);
    assert.ok(await db.getInquiry(testDb, 'inq_plain'));

    const viewer = await cookieHeaderFor({ uid: null, role: 'viewer', email: 'v@example.com' });
    assert.equal((await worker.fetch(req('DELETE', `/admin/api/inquiries/${inquiry.id}`, { cookie: viewer }), env, CTX)).status, 403);
    assert.equal((await worker.fetch(req('POST', '/admin/api/waitlist', { cookie: viewer, body: { name: 'A', phone: '06', city: 'Utrecht' } }), env, CTX)).status, 403);

    assert.equal((await worker.fetch(req('DELETE', `/admin/api/inquiries/${inquiry.id}`, { cookie }), env, CTX)).status, 200);
    assert.equal(await db.getInquiry(testDb, inquiry.id), null);
  });
});
