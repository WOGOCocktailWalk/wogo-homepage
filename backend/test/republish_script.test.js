// test/republish_script.test.js — scripts/republish_blog_posts.mjs against a fake API (no network).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../scripts/republish_blog_posts.mjs';

const POSTS = [
  { id: 'p2', slug: 'newer', status: 'published', published_at: '2026-10-02 10:00:00', body_nl: '<p>Tekst</p>' },
  { id: 'p1', slug: 'older', status: 'published', published_at: '2026-09-01 10:00:00', body_nl: null },
  { id: 'p3', slug: 'blank-nl', status: 'published', published_at: '2026-09-15 10:00:00', body_nl: '<p> </p>' },
];

function fakeApi({ failFor = null, loginOk = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', path: u.pathname + u.search, body: opts.body, headers: opts.headers });
    if (u.pathname === '/admin/login') return loginOk ? new Response('{}', { status: 200, headers: { 'set-cookie': 'wogo_admin=abc; Path=/; HttpOnly' } }) : new Response('{}', { status: 401 });
    if (u.pathname === '/admin/api/blog') return new Response(JSON.stringify({ posts: POSTS }), { status: 200 });
    const m = /\/admin\/api\/blog\/([^/]+)\/publish$/.exec(u.pathname);
    if (m) return m[1] === failFor ? new Response('{"message":"post needs a cover"}', { status: 400 }) : new Response(JSON.stringify({ commit_sha: 'abcdef1234567' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchImpl };
}
const collect = () => { const lines = []; return { lines, log: (x) => lines.push(x), err: (x) => lines.push('ERR ' + x) }; };
const ENV = { WOGO_ADMIN_TOKEN: 'secret-token', WOGO_ADMIN_URL: 'https://admin.example.test/' };

describe('republish_blog_posts', () => {
  test('--dry-run lists every published post and what it gets, and publishes nothing', async () => {
    const api = fakeApi(); const out = collect();
    const code = await run({ argv: ['--dry-run'], env: ENV, fetchImpl: api.fetchImpl, ...out, sleep: async () => {} });
    assert.equal(code, 0);
    assert.ok(api.calls.every((c) => !/\/publish$/.test(c.path)), 'no publish call');
    const text = out.lines.join('\n');
    assert.match(text, /would publish\s+newer\s+\[EN \+ NL page\]/);
    assert.match(text, /would publish\s+older\s+\[EN page only\]/);
    assert.match(text, /would publish\s+blank-nl\s+\[EN page only\]/);
    assert.match(text, /3 published post\(s\): 1 with Dutch text/);
  });

  test('publishes every post, oldest first, with the CSRF header and the session cookie; the token never leaves the login call', async () => {
    const api = fakeApi(); const out = collect();
    const code = await run({ argv: [], env: ENV, fetchImpl: api.fetchImpl, ...out, sleep: async () => {} });
    assert.equal(code, 0);
    const pubs = api.calls.filter((c) => /\/publish$/.test(c.path));
    assert.deepEqual(pubs.map((c) => c.path.split('/')[4]), ['p1', 'p3', 'p2']);
    for (const c of pubs) { assert.equal(c.headers['X-Requested-With'], 'wogo-admin'); assert.equal(c.headers.Cookie, 'wogo_admin=abc'); assert.equal(c.body, '{}'); }
    assert.equal(api.calls.filter((c) => (c.body || '').includes('secret-token')).length, 1);
    assert.ok(!out.lines.join('\n').includes('secret-token'));
    assert.match(out.lines.at(-1), /Done: 3 published, 0 failed/);
  });

  test('one failing post is reported, the rest still go out, exit code is 1', async () => {
    const api = fakeApi({ failFor: 'p3' }); const out = collect();
    const code = await run({ argv: [], env: ENV, fetchImpl: api.fetchImpl, ...out, sleep: async () => {} });
    assert.equal(code, 1);
    assert.equal(api.calls.filter((c) => /\/publish$/.test(c.path)).length, 3);
    assert.match(out.lines.join('\n'), /FAILED\s+blank-nl: 400 post needs a cover/);
    assert.match(out.lines.at(-1), /2 published, 1 failed/);
  });

  test('--only and --branch are honoured', async () => {
    const api = fakeApi(); const out = collect();
    await run({ argv: ['--only=newer', '--branch=scratch-test'], env: ENV, fetchImpl: api.fetchImpl, ...out, sleep: async () => {} });
    const pubs = api.calls.filter((c) => /\/publish$/.test(c.path));
    assert.equal(pubs.length, 1);
    assert.deepEqual(JSON.parse(pubs[0].body), { branch: 'scratch-test' });
  });

  test('refuses to run without the environment variables, and refuses a token passed as a flag', async () => {
    const api = fakeApi(); const out = collect();
    assert.equal(await run({ argv: [], env: {}, fetchImpl: api.fetchImpl, ...out }), 2);
    assert.equal(await run({ argv: ['--admin-token=x'], env: ENV, fetchImpl: api.fetchImpl, ...out }), 2);
    assert.equal(api.calls.length, 0);
  });

  test('a rejected login stops everything', async () => {
    const api = fakeApi({ loginOk: false }); const out = collect();
    assert.equal(await run({ argv: [], env: ENV, fetchImpl: api.fetchImpl, ...out, sleep: async () => {} }), 1);
    assert.equal(api.calls.length, 1);
  });
});
