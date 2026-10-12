// test/blog_render.test.js — src/blog_render.js against the REAL template
// files at blog/_template/post.html and blog/_template/index.html (not a
// fixture copy — a drift between this test and the actual templates would
// otherwise go unnoticed). Covers: no leftover {{TOKENS}}, noindex present
// only while SITE_NOINDEX, valid JSON-LD, the EN/NL dual-body toggle
// structure, the NL-dictionary literal escaping, and the preview-only
// <base> tag.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderPostPage, renderIndexPage, buildSitemapUrlEntry, assetUrl } from '../src/blog_render.js';
import { SITE_ASSET_BASE, BLOG_CANONICAL_BASE } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POST_TEMPLATE = readFileSync(path.join(__dirname, '../../blog/_template/post.html'), 'utf8');
const INDEX_TEMPLATE = readFileSync(path.join(__dirname, '../../blog/_template/index.html'), 'utf8');

function basePost(overrides = {}) {
  return {
    id: 'blogpost_1',
    slug: 'a-great-post',
    category: 'City guide',
    title_en: 'A Great Post',
    title_nl: 'Een geweldige post',
    excerpt_en: 'Short excerpt.',
    excerpt_nl: 'Korte samenvatting.',
    body_en: '<p>English body</p>',
    body_nl: '<p>Nederlandse tekst</p>',
    seo_title_en: null,
    seo_title_nl: null,
    seo_description_en: null,
    seo_description_nl: null,
    cover_image_path: 'blog/a-great-post/cover.jpg',
    cover_alt_en: 'A cover photo',
    cover_alt_nl: 'Een omslagfoto',
    read_minutes: 6,
    published_at: '2026-10-01 10:00:00',
    updated_at: '2026-10-05 12:00:00',
    created_at: '2026-10-01 09:00:00',
    ...overrides,
  };
}

function ldJsonBlocks(html) {
  const re = /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(JSON.parse(m[1]));
  return out;
}

describe('renderPostPage', () => {
  test('leaves no unfilled {{TOKEN}} placeholders', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost(), { siteNoindex: true });
    assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(html), 'a token was left unfilled');
  });

  test('includes a noindex meta tag when siteNoindex is true, omits it when false', () => {
    const withNoindex = renderPostPage(POST_TEMPLATE, basePost(), { siteNoindex: true });
    assert.ok(withNoindex.includes('<meta name="robots" content="noindex">'));
    const withoutNoindex = renderPostPage(POST_TEMPLATE, basePost(), { siteNoindex: false });
    assert.ok(!withoutNoindex.includes('<meta name="robots" content="noindex">'));
  });

  test('adds a <base> tag only when opts.preview is true', () => {
    const preview = renderPostPage(POST_TEMPLATE, basePost(), { siteNoindex: true, preview: true });
    assert.ok(preview.includes('<base href='));
    assert.ok(preview.includes(`${SITE_ASSET_BASE}/blog/a-great-post/`));
    const published = renderPostPage(POST_TEMPLATE, basePost(), { siteNoindex: true, preview: false });
    assert.ok(!published.includes('<base href='));
  });

  test('both JSON-LD blocks parse as valid JSON and carry the right fields', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost(), { siteNoindex: true });
    const [blogPosting, breadcrumb] = ldJsonBlocks(html);
    assert.equal(blogPosting['@type'], 'BlogPosting');
    assert.equal(blogPosting.headline, 'A Great Post');
    assert.equal(blogPosting.datePublished, '2026-10-01');
    assert.equal(blogPosting.dateModified, '2026-10-05');
    assert.equal(blogPosting.mainEntityOfPage['@id'], `${BLOG_CANONICAL_BASE}/blog/a-great-post/`);
    assert.equal(breadcrumb['@type'], 'BreadcrumbList');
    assert.equal(breadcrumb.itemListElement[2].item, `${BLOG_CANONICAL_BASE}/blog/a-great-post/`);
  });

  test('canonical URL and cover image URL use the right bases (production vs. asset host)', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost(), { siteNoindex: true });
    assert.ok(html.includes(`<link rel="canonical" href="${BLOG_CANONICAL_BASE}/blog/a-great-post/">`));
    // The actually-fetched <img>/<link preload> use the functional asset host...
    assert.ok(html.includes(`${SITE_ASSET_BASE}/blog/a-great-post/cover.jpg`));
    // ...while the meta/OG/JSON-LD image uses the production domain, matching
    // every hand-built post's existing convention.
    assert.ok(html.includes(`<meta property="og:image" content="${BLOG_CANONICAL_BASE}/blog/a-great-post/cover.jpg">`));
  });

  test('both language bodies are present, EN visible and NL hidden by default', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost(), { siteNoindex: true });
    assert.match(html, /<div class="bl-post-body" data-lang="en">\s*<article class="bl-post wg-reveal"><p>English body<\/p><\/article>/);
    assert.match(html, /<div class="bl-post-body" data-lang="nl" hidden>\s*<article class="bl-post wg-reveal"><p>Nederlandse tekst<\/p><\/article>/);
  });

  test('a missing NL body falls back to the EN body (never a blank NL page)', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost({ body_nl: null }), { siteNoindex: true });
    assert.match(html, /data-lang="nl" hidden>\s*<article class="bl-post wg-reveal"><p>English body<\/p><\/article>/);
  });

  test('a missing NL title/excerpt falls back to EN in the NL dictionary', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost({ title_nl: null, excerpt_nl: null }), { siteNoindex: true });
    assert.ok(html.includes('hero_h1: "A Great Post"'));
  });

  test('HTML special characters in title/excerpt are escaped, not left raw (would break the page)', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost({ title_en: 'Tom & Jerry <3' }), { siteNoindex: true });
    assert.ok(html.includes('Tom &amp; Jerry &lt;3'));
    assert.ok(!html.includes('<h1 data-i18n="hero_h1">Tom & Jerry <3</h1>'));
  });

  test('a double quote in the title cannot break out of the NL dictionary\'s JS string literal', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost({ title_nl: 'Een "geweldige" post' }), { siteNoindex: true });
    // Parseable as JS: build the NL object literal substring and eval-check it's valid JSON-ish via a quick balanced-quote check.
    const m = /crumb_post: "([^\n]*)",/.exec(html);
    assert.ok(m, 'crumb_post line not found');
    assert.ok(m[1].includes('\\"geweldige\\"') || m[1].includes('&quot;'));
  });

  test('category NL mapping is applied in the NL dictionary', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost({ category: 'News' }), { siteNoindex: true });
    assert.ok(html.includes('hero_eyebrow: "Nieuws"'));
    assert.ok(html.includes('data-i18n="hero_eyebrow">News<'));
  });

  test('a post with no cover image falls back to the branded placeholder, not a broken src', () => {
    const html = renderPostPage(POST_TEMPLATE, basePost({ cover_image_path: null }), { siteNoindex: true });
    assert.ok(html.includes(assetUrl('how-it-works/how-it-works-hero.jpg')));
  });
});

describe('renderIndexPage', () => {
  const posts = [
    basePost({ slug: 'post-a', title_en: 'Post A', title_nl: 'Post A NL' }),
    basePost({ slug: 'post-b', title_en: 'Post B', title_nl: null, cover_image_path: null }),
  ];

  test('leaves no unfilled {{TOKEN}} placeholders', () => {
    const html = renderIndexPage(INDEX_TEMPLATE, posts, { siteNoindex: true });
    assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(html));
  });

  test('renders one card per post, per language, newest-first order preserved from input', () => {
    const html = renderIndexPage(INDEX_TEMPLATE, posts, { siteNoindex: true });
    const enBlock = html.split('data-lang="nl"')[0];
    assert.ok(enBlock.includes('href="post-a/"'));
    assert.ok(enBlock.includes('href="post-b/"'));
    assert.ok(enBlock.indexOf('post-a/') < enBlock.indexOf('post-b/'));
  });

  test('an empty post list renders an empty grid, not an error', () => {
    const html = renderIndexPage(INDEX_TEMPLATE, [], { siteNoindex: true });
    assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(html));
    assert.equal((html.match(/class="bl-card"/g) || []).length, 0);
  });

  test('the Blog JSON-LD array has one valid entry per post', () => {
    const html = renderIndexPage(INDEX_TEMPLATE, posts, { siteNoindex: true });
    const m = /"blogPost":\[([\s\S]*?)\]\}/.exec(html);
    assert.ok(m);
    const arr = JSON.parse(`[${m[1]}]`);
    assert.equal(arr.length, 2);
    assert.equal(arr[0].headline, 'Post A');
  });

  test('noindex mirrors siteNoindex the same way the post page does', () => {
    const withNoindex = renderIndexPage(INDEX_TEMPLATE, posts, { siteNoindex: true });
    assert.ok(withNoindex.includes('<meta name="robots" content="noindex">'));
    const withoutNoindex = renderIndexPage(INDEX_TEMPLATE, posts, { siteNoindex: false });
    assert.ok(!withoutNoindex.includes('<meta name="robots" content="noindex">'));
  });
});

describe('buildSitemapUrlEntry', () => {
  test('matches sitemap.xml\'s existing shape (loc/changefreq/priority, no lastmod)', () => {
    const entry = buildSitemapUrlEntry(basePost({ slug: 'my-post' }));
    assert.ok(entry.includes(`<loc>${BLOG_CANONICAL_BASE}/blog/my-post/</loc>`));
    assert.ok(entry.includes('<changefreq>monthly</changefreq>'));
    assert.ok(entry.includes('<priority>0.5</priority>'));
    assert.ok(!entry.includes('<lastmod>'));
  });
});
