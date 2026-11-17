// test/security_fixes.test.js — regression tests for the security-audit fixes:
// blog HTML sanitiser (URL scheme allowlist), preview/JSON-LD hardening,
// separate signing key for reminder-unsubscribe tokens, CSV formula
// neutralisation, log masking, and who may choose a blog commit branch.
// Inputs here are deliberately inert (they use alert-free markers); the
// assertions only check what the sanitiser lets through.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { sanitizeBlogHtml, toCsv, maskEmail } from '../src/logic.js';
import { renderPostPage } from '../src/blog_render.js';
import { BLOG_POST_TEMPLATE } from '../src/blog_templates_data.js';
import { computeReminderUnsubscribeToken, verifyReminderUnsubscribeToken } from '../src/reminder_optout.js';
import { hmacSign, b64urlEncode, createSessionCookieValue, getSession, COOKIE_NAME } from '../src/auth.js';
import { makeTestDb } from './sqlite-d1-adapter.js';
import worker from '../src/index.js';
import * as db from '../src/db.js';

const href = (v) => `<a href="${v}">x</a>`;
const stripped = (out) => out === '<a>x</a>';

describe('sanitizeBlogHtml — link/image URL allowlist', () => {
  const blocked = {
    'plain script scheme': 'javascript:void(0)',
    'mixed case': 'JaVaScRiPt:void(0)',
    'decimal entity letter': 'java&#115;cript:void(0)',
    'hex entity letter': 'java&#x73;cript:void(0)',
    'entity without semicolon': 'java&#115cript:void(0)',
    'entity-encoded colon': 'javascript&colon;void(0)',
    'numeric-entity colon': 'javascript&#58;void(0)',
    'entity-encoded tab inside': 'java&Tab;script:void(0)',
    'entity-encoded newline inside': 'java&NewLine;script:void(0)',
    'raw tab inside': 'java\tscript:void(0)',
    'raw newline inside': 'java\nscript:void(0)',
    'leading control chars and spaces': '\u0001\u0002  javascript:void(0)',
    'leading entity-encoded whitespace': '&#32;&#9;javascript:void(0)',
    'zero-width char inside': 'java​script:void(0)',
    'unicode line separator inside': 'java script:void(0)',
    'data scheme': 'data:text/html,hello',
    'vbscript': 'vbscript:x',
    'file scheme': 'file:///etc/hosts',
    'unknown scheme': 'foo-bar:thing',
    'protocol-relative': '//other.example/x',
    'backslash protocol-relative': '\\\\other.example/x',
    'double-escaped entity stays undecoded and unknown': '&amp;#106;avascript:void(0)',
    'empty': '',
    'whitespace only': '   ',
    'percent-encoded scheme': 'javascript%3Avoid(0)',
  };
  for (const [name, value] of Object.entries(blocked)) {
    test(`drops href: ${name}`, () => {
      const out = sanitizeBlogHtml(href(value));
      // Either the attribute is gone, or (percent-encoded case) it is a harmless relative URL.
      assert.ok(!/href="[^"]*(javascript|vbscript|data|file):/i.test(out), out);
      if (name !== 'percent-encoded scheme') assert.ok(stripped(out), out);
    });
  }

  test('drops src with the same bypass classes', () => {
    for (const v of ['java&#115;cript:x', 'data:image/png;base64,AAAA', '//t.example/p.gif', ' \tjavascript:x']) {
      assert.equal(sanitizeBlogHtml(`<img src="${v}" alt="a">`), '<img alt="a" />');
    }
  });

  test('mailto and tel are allowed on links but not as image sources', () => {
    assert.equal(sanitizeBlogHtml(href('mailto:a@b.co')), '<a href="mailto:a@b.co">x</a>');
    assert.equal(sanitizeBlogHtml(href('tel:+31600000000')), '<a href="tel:+31600000000">x</a>');
    assert.equal(sanitizeBlogHtml('<img src="mailto:a@b.co">'), '<img />');
  });

  test('normal links and images survive', () => {
    assert.equal(sanitizeBlogHtml(href('https://www.example.com/a?b=1&amp;c=2')), '<a href="https://www.example.com/a?b=1&amp;c=2">x</a>');
    assert.equal(sanitizeBlogHtml(href('/blog/some-post/')), '<a href="/blog/some-post/">x</a>');
    assert.equal(sanitizeBlogHtml(href('#section')), '<a href="#section">x</a>');
    assert.equal(sanitizeBlogHtml(href('page.html?t=a:b')), '<a href="page.html?t=a:b">x</a>');
    assert.equal(sanitizeBlogHtml('<img src="https://example.com/a.jpg" alt="a">'), '<img src="https://example.com/a.jpg" alt="a" />');
  });

  test('output is canonical: the value written is the decoded value, re-escaped', () => {
    const out = sanitizeBlogHtml('<a href="https://e.example/?a=1&b=2" title="x">t</a>');
    assert.equal(out, '<a href="https://e.example/?a=1&amp;b=2">t</a>');
    const alt = sanitizeBlogHtml('<img src="https://e.example/a.png" alt="&#34; onerror=&#34;x">');
    assert.ok(!alt.includes('" onerror='), alt);
  });

  test('target is limited to _blank/_self; target without rel gets rel=noopener', () => {
    assert.equal(sanitizeBlogHtml('<a href="https://e.example" target="_blank">x</a>'), '<a href="https://e.example" target="_blank" rel="noopener">x</a>');
    assert.equal(sanitizeBlogHtml('<a href="https://e.example" target="evilframe">x</a>'), '<a href="https://e.example">x</a>');
  });

  test('sanitising twice changes nothing (stored bodies can be re-sanitised on read)', () => {
    const inputs = [
      '<p>Hi <a href="https://e.example/?a=1&b=2" target="_blank">l</a> &amp; &lt;b&gt;</p><img src="/blog/x/a.jpg" alt="q&quot;r">',
      href('java&#115;cript:x') + '<script>x</script><p onclick="x">t</p>',
    ];
    for (const i of inputs) {
      const once = sanitizeBlogHtml(i);
      assert.equal(sanitizeBlogHtml(once), once);
    }
  });
});

describe('blog page rendering hardening', () => {
  const post = (over = {}) => ({ slug: 's', title_en: 'T', category: 'City guide', excerpt_en: 'e', body_en: '<p>b</p>', read_minutes: 3, ...over });

  test('a title containing a closing script tag cannot break out of the JSON-LD block', () => {
    const html = renderPostPage(BLOG_POST_TEMPLATE, post({ title_en: 'A </script><b>x' }), { siteNoindex: true, preview: false });
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 2);
    for (const b of blocks) {
      assert.ok(!b.includes('<'), 'no raw < inside JSON-LD');
      JSON.parse(b); // still valid JSON
    }
    assert.equal(JSON.parse(blocks[0]).headline, 'A </script><b>x');
  });

  test('a stored body from before a sanitiser fix is cleaned when rendered', () => {
    const html = renderPostPage(BLOG_POST_TEMPLATE, post({ body_en: href('java&#115;cript:x') }), { siteNoindex: true, preview: false });
    assert.ok(!/java(&#115;|s)cript:/i.test(html.slice(html.indexOf('<article'))));
  });

  test('preview adds a tightening CSP (no network, no forms, no nested frames) and hides the cookie banner', () => {
    const html = renderPostPage(BLOG_POST_TEMPLATE, post(), { siteNoindex: true, preview: true });
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(html.includes("form-action 'none'"));
    assert.ok(html.includes("frame-src 'none'"));
    assert.ok(html.includes('#wogoCcBanner{display:none!important}'));
    const live = renderPostPage(BLOG_POST_TEMPLATE, post(), { siteNoindex: true, preview: false });
    assert.ok(!live.includes("connect-src 'none'"));
  });

  test('the dashboard preview frame is sandboxed without allow-same-origin', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/admin/admin.js'), 'utf8');
    const m = /el\("iframe", \{ class: "blog-preview-frame"[^}]*\}/.exec(src);
    assert.ok(m, 'preview iframe not found');
    assert.ok(/sandbox: "allow-scripts"/.test(m[0]));
    assert.ok(!/allow-same-origin|allow-popups|allow-top-navigation|allow-forms/.test(m[0]));
  });
});

describe('reminder-unsubscribe token vs. session cookie (separate keys)', () => {
  const SECRET = 'test-secret-value';
  const ENV = { ADMIN_SESSION_SECRET: SECRET };
  const asCookieRequest = (value) => new Request('https://x.example/admin/api/me', { headers: { Cookie: `${COOKIE_NAME}=${value}` } });

  test('a token minted for an address shaped like a session payload is NOT a valid session', async () => {
    const payload = JSON.stringify({ exp: 9999999999, role: 'owner', email: 'a@b.c' });
    const token = await computeReminderUnsubscribeToken(ENV, payload);
    assert.equal(await getSession(asCookieRequest(token), ENV), null);
  });

  test('real session cookies still work, and are not accepted as unsubscribe tokens', async () => {
    const cookie = await createSessionCookieValue(SECRET, { uid: null, role: 'owner', email: null });
    assert.ok(await getSession(asCookieRequest(cookie), ENV));
    assert.equal(await verifyReminderUnsubscribeToken(ENV, cookie), null);
  });

  test('new tokens round-trip; tokens already sent in old emails (raw-secret signature) still verify', async () => {
    const t = await computeReminderUnsubscribeToken(ENV, 'Guest@Example.com');
    assert.equal(await verifyReminderUnsubscribeToken(ENV, t), 'guest@example.com');
    const payloadB64 = b64urlEncode(new TextEncoder().encode('old@example.com'));
    const legacy = `${payloadB64}.${await hmacSign(SECRET, payloadB64)}`;
    assert.equal(await verifyReminderUnsubscribeToken(ENV, legacy), 'old@example.com');
    assert.equal(await verifyReminderUnsubscribeToken({ ADMIN_SESSION_SECRET: 'other' }, t), null);
  });
});

describe('CSV formula neutralisation and log masking', () => {
  test('text cells starting with = + - @ are prefixed; numbers and phone numbers are untouched', () => {
    const csv = toCsv([{ a: '=HYPERLINK("x")', b: '@SUM(1)', c: '-cmd', d: '+31 6 1234 5678', e: 12, f: '-5', g: '+cmd|x', h: 'plain' }], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const row = csv.split('\r\n')[1];
    assert.ok(row.startsWith(`"'=HYPERLINK(""x"")",'@SUM(1),'-cmd,+31 6 1234 5678,12,-5,'+cmd|x,plain`), row);
  });

  test('maskEmail hides the mailbox name inside free text and objects', () => {
    assert.equal(maskEmail('jane.doe@example.com'), 'j***@example.com');
    assert.equal(maskEmail('failed for jane.doe@example.com: 550'), 'failed for j***@example.com: 550');
    assert.ok(!maskEmail({ email: 'jane.doe@example.com' }).includes('jane.doe'));
    assert.equal(maskEmail(null), '');
  });
});

// --- who may choose a blog commit branch -----------------------------------

const migration = (n) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), `../migrations/${n}`), 'utf8');
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql', '0005_security.sql',
  '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql', '0009_webhook_processing_status.sql',
  '0010_booking_notes.sql', '0011_currency_timezone.sql', '0012_map_url_nl.sql', '0014_weekday_capacity.sql',
  '0015_weekday_bars.sql', '0017_map_by_weekday.sql', '0018_gift_cards.sql', '0019_gift_card_redemptions.sql',
  '0020_route_names.sql', '0021_inquiries.sql', '0022_bar_locale.sql', '0023_route_names_simple.sql',
  '0024_subscribers.sql', '0025_admin_users.sql', '0026_review_requests.sql', '0027_booking_utm.sql',
  '0028_bookings_email_lower_index.sql', '0029_route_booking_cutoff.sql', '0030_blog_posts.sql',
].map(migration).join('\n');
const SECRET = 'test-session-secret';
const CTX = { waitUntil: () => {} };
let testDb; let realFetch; let putBranches;
beforeEach(() => {
  testDb = makeTestDb(schemaSql);
  putBranches = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'PUT') { putBranches.push(JSON.parse(opts.body).branch); return new Response(JSON.stringify({ content: { sha: 's' }, commit: { sha: 'c' } }), { status: 200 }); }
    if (method === 'DELETE') return new Response(JSON.stringify({ commit: { sha: 'c' } }), { status: 200 });
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
});
afterEach(() => { global.fetch = realFetch; });

const env = () => ({ DB: testDb, ADMIN_SESSION_SECRET: SECRET, ADMIN_TOKEN: 't', ENVIRONMENT: 'production', GITHUB_TOKEN: 'x', GITHUB_REPO: 'o/r' });
const cookieFor = async (role) => `${COOKIE_NAME}=${await createSessionCookieValue(SECRET, { uid: null, role, email: `${role}@example.com` })}`;
const call = (method, p, cookie, body) => worker.fetch(new Request(`https://api.example.com${p}`, {
  method, headers: { Cookie: cookie, 'X-Requested-With': 'wogo-admin', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}), env(), CTX);

async function readyPost(cookie) {
  const res = await call('POST', '/admin/api/blog', cookie, { slug: 'post-one', category: 'City guide', title_en: 'T', body_en: '<p>b</p>', cover_alt_en: 'alt' });
  const j = await res.json();
  assert.equal(res.status, 201, JSON.stringify(j));
  const { post } = j;
  await db.updateBlogPost(testDb, post.id, { cover_image_path: 'blog/post-one/cover.jpg' });
  return post;
}

describe('blog commit branch', () => {
  test('staff cannot redirect a commit to another branch; the default branch is used', async () => {
    const c = await cookieFor('staff');
    const post = await readyPost(c);
    const res = await call('POST', `/admin/api/blog/${post.id}/publish`, c, { branch: 'attacker-branch' });
    assert.equal(res.status, 200);
    assert.ok(putBranches.length > 0);
    assert.ok(putBranches.every((b) => b === 'main'), JSON.stringify(putBranches));
  });

  test('the owner can still use a scratch branch; a malformed branch name is refused', async () => {
    const c = await cookieFor('owner');
    const post = await readyPost(c);
    const ok = await call('POST', `/admin/api/blog/${post.id}/publish`, c, { branch: 'blog-publish-test' });
    assert.equal(ok.status, 200);
    assert.ok(putBranches.every((b) => b === 'blog-publish-test'));
    putBranches.length = 0;
    for (const bad of ['../main', 'a b', 'x..y', 'ends/', '-lead', 'a;b']) {
      const r = await call('POST', `/admin/api/blog/${post.id}/publish`, c, { branch: bad });
      assert.equal(r.status, 400, bad);
    }
    assert.equal(putBranches.length, 0);
  });
});
