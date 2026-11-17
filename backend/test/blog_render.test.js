// test/blog_render.test.js — src/blog_render.js against the REAL generated
// templates in blog/_template/generated/ (made by tools/build-nl.js; not a
// fixture copy — a drift between this test and the actual templates would
// otherwise go unnoticed). Covers: no leftover {{TOKENS}}, noindex only while
// SITE_NOINDEX, valid JSON-LD (with inLanguage), the Dutch page (language,
// canonical, Dutch text baked in, hreflang both ways), NO Dutch page for a post
// without Dutch text, the English page being English-only, the language-menu
// targets, both indexes, the preview <base> tag, the sitemap lines, and that
// the templates bundled into the Worker are the generated files.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  renderPostPage, renderPostPageNl, renderIndexPage, renderIndexPageNl,
  buildSitemapUrlEntry, updateBlogSitemap, hasDutchBody, assetUrl,
} from '../src/blog_render.js';
import {
  BLOG_POST_TEMPLATE, BLOG_POST_TEMPLATE_NL, BLOG_INDEX_TEMPLATE, BLOG_INDEX_TEMPLATE_NL,
} from '../src/blog_templates_data.js';
import { SITE_ASSET_BASE, BLOG_CANONICAL_BASE } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gen = (n) => readFileSync(path.join(__dirname, '../../blog/_template/generated', n), 'utf8');
const POST_EN = gen('post.en.html');
const POST_NL = gen('post.nl.html');
const INDEX_EN = gen('index.en.html');
const INDEX_NL = gen('index.nl.html');

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
const noDutch = (o = {}) => basePost({ title_nl: null, excerpt_nl: null, body_nl: null, cover_alt_nl: null, ...o });

function ldJsonBlocks(html) {
  const re = /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(JSON.parse(m[1]));
  return out;
}
const tokensLeft = (html) => /\{\{[A-Z0-9_]+\}\}/.test(html);
const alternates = (html) => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]);
const langMenuHrefs = (html) => Object.fromEntries([...html.matchAll(/class="w-lang-opt"[^>]*data-lang="(\w+)"[^>]*href="([^"]*)"/g)].map((m) => [m[1], m[2]]));

describe('the templates bundled into the Worker', () => {
  test('are exactly the generated files (run build-nl.js, then build_blog_templates.mjs)', () => {
    assert.equal(BLOG_POST_TEMPLATE, POST_EN);
    assert.equal(BLOG_POST_TEMPLATE_NL, POST_NL);
    assert.equal(BLOG_INDEX_TEMPLATE, INDEX_EN);
    assert.equal(BLOG_INDEX_TEMPLATE_NL, INDEX_NL);
  });
});

describe('hasDutchBody', () => {
  test('needs real Dutch text', () => {
    assert.equal(hasDutchBody(basePost()), true);
    for (const body of [null, '', '   ', '<p></p>', '<p> </p>']) assert.equal(hasDutchBody(basePost({ body_nl: body })), false, String(body));
  });
});

describe('renderPostPage (English)', () => {
  test('leaves no unfilled {{TOKEN}} placeholders, with or without a Dutch twin', () => {
    assert.ok(!tokensLeft(renderPostPage(POST_EN, basePost(), { siteNoindex: true })));
    assert.ok(!tokensLeft(renderPostPage(POST_EN, noDutch(), { siteNoindex: true })));
  });

  test('includes a noindex meta tag when siteNoindex is true, omits it when false', () => {
    assert.ok(renderPostPage(POST_EN, basePost(), { siteNoindex: true }).includes('<meta name="robots" content="noindex">'));
    assert.ok(!renderPostPage(POST_EN, basePost(), { siteNoindex: false }).includes('<meta name="robots" content="noindex">'));
  });

  test('adds a <base> tag only when opts.preview is true', () => {
    const preview = renderPostPage(POST_EN, basePost(), { siteNoindex: true, preview: true });
    assert.ok(preview.includes(`<base href="${SITE_ASSET_BASE}/blog/a-great-post/">`));
    assert.ok(!renderPostPage(POST_EN, basePost(), { siteNoindex: true, preview: false }).includes('<base href='));
  });

  test('both JSON-LD blocks parse as valid JSON, carry the right fields and say inLanguage en', () => {
    const [blogPosting, breadcrumb] = ldJsonBlocks(renderPostPage(POST_EN, basePost(), { siteNoindex: true }));
    assert.equal(blogPosting['@type'], 'BlogPosting');
    assert.equal(blogPosting.inLanguage, 'en');
    assert.equal(blogPosting.headline, 'A Great Post');
    assert.equal(blogPosting.datePublished, '2026-10-01');
    assert.equal(blogPosting.dateModified, '2026-10-05');
    assert.equal(blogPosting.mainEntityOfPage['@id'], `${BLOG_CANONICAL_BASE}/blog/a-great-post/`);
    assert.equal(breadcrumb.itemListElement[2].item, `${BLOG_CANONICAL_BASE}/blog/a-great-post/`);
  });

  test('canonical URL and cover image URL use the right bases (production vs. asset host)', () => {
    const html = renderPostPage(POST_EN, basePost(), { siteNoindex: true });
    assert.ok(html.includes(`<link rel="canonical" href="${BLOG_CANONICAL_BASE}/blog/a-great-post/">`));
    assert.ok(html.includes(`${SITE_ASSET_BASE}/blog/a-great-post/cover.jpg`));
    assert.ok(html.includes(`<meta property="og:image" content="${BLOG_CANONICAL_BASE}/blog/a-great-post/cover.jpg">`));
  });

  test('is English only: no Dutch body, title, summary or hidden Dutch article in the page', () => {
    const html = renderPostPage(POST_EN, basePost(), { siteNoindex: true });
    assert.match(html, /<article class="bl-post wg-reveal"><p>English body<\/p><\/article>/);
    for (const dutch of ['Nederlandse tekst', 'Een geweldige post', 'Korte samenvatting', 'Een omslagfoto']) {
      assert.ok(!html.includes(dutch), dutch + ' leaked into the English page');
    }
    assert.ok(!html.includes('data-lang="nl" hidden'));
    assert.equal((html.match(/<article class="bl-post/g) || []).length, 1);
    assert.match(html, /<html lang="en">/);
  });

  test('never switches itself to Dutch by script (an English address stays English)', () => {
    const html = renderPostPage(POST_EN, basePost(), { siteNoindex: true });
    assert.ok(html.includes("setLang('en');"));
    assert.ok(!html.includes("setLang(saved ||"));
    assert.ok(!html.includes('Anti-flicker for Dutch visitors'));
  });

  test('with a Dutch twin: hreflang en/nl/x-default on both addresses, og:locale:alternate, and the language menu links to the twin', () => {
    const html = renderPostPage(POST_EN, basePost(), { siteNoindex: true });
    assert.deepEqual(alternates(html), [
      ['en', `${BLOG_CANONICAL_BASE}/blog/a-great-post/`],
      ['nl', `${BLOG_CANONICAL_BASE}/nl/blog/a-great-post/`],
      ['x-default', `${BLOG_CANONICAL_BASE}/blog/a-great-post/`],
    ]);
    assert.ok(html.includes('<meta property="og:locale:alternate" content="nl_NL">'));
    assert.deepEqual(langMenuHrefs(html), { en: './', nl: '../../nl/blog/a-great-post/' });
    assert.ok(html.includes('ALT = {"en":"./","nl":"../../nl/blog/a-great-post/"}'));
  });

  test('without Dutch text: no hreflang, no og:locale:alternate; the menu goes to the Dutch blog index, or the Dutch homepage if there is none', () => {
    const html = renderPostPage(POST_EN, noDutch(), { siteNoindex: true });
    assert.deepEqual(alternates(html), []);
    assert.ok(!html.includes('og:locale:alternate'));
    assert.ok(!html.includes('/nl/blog/a-great-post/'));
    assert.deepEqual(langMenuHrefs(html), { en: './', nl: '../../nl/blog/' });
    const noIndexEither = renderPostPage(POST_EN, noDutch(), { siteNoindex: true, nlIndex: false });
    assert.deepEqual(langMenuHrefs(noIndexEither), { en: './', nl: '../../nl/' });
  });

  test('HTML special characters in title/excerpt are escaped, not left raw', () => {
    const html = renderPostPage(POST_EN, basePost({ title_en: 'Tom & Jerry <3' }), { siteNoindex: true });
    assert.ok(html.includes('Tom &amp; Jerry &lt;3'));
    assert.ok(!html.includes('<h1 data-i18n="hero_h1">Tom & Jerry <3</h1>'));
  });

  test('a post with no cover image falls back to the branded placeholder, not a broken src', () => {
    const html = renderPostPage(POST_EN, basePost({ cover_image_path: null }), { siteNoindex: true });
    assert.ok(html.includes(assetUrl('how-it-works/how-it-works-hero.jpg')));
  });
});

describe('renderPostPageNl (the real Dutch page)', () => {
  const html = renderPostPageNl(POST_NL, basePost({ category: 'News' }), { siteNoindex: false });

  test('leaves no unfilled {{TOKEN}} placeholders', () => {
    assert.ok(!tokensLeft(html));
  });

  test('is a Dutch page at its own address: lang nl, self canonical, og:url, og:locale', () => {
    const url = `${BLOG_CANONICAL_BASE}/nl/blog/a-great-post/`;
    assert.match(html, /<html lang="nl">/);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`));
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`));
    assert.ok(html.includes('<meta property="og:locale" content="nl_NL">'));
    assert.ok(html.includes('<meta property="og:locale:alternate" content="en_US">'));
  });

  test('has the Dutch title, summary, category, body, cover text and meta text baked into the HTML', () => {
    assert.ok(html.includes('<title>Een geweldige post | WOGO</title>'));
    assert.ok(html.includes('<meta name="description" content="Korte samenvatting.">'));
    assert.ok(html.includes('<meta property="og:title" content="Een geweldige post">'));
    assert.ok(html.includes('<meta name="twitter:description" content="Korte samenvatting.">'));
    assert.match(html, /<h1 data-i18n="hero_h1">Een geweldige post<\/h1>/);
    assert.match(html, /<div class="w-hero-overline" data-i18n="hero_eyebrow">Nieuws<\/div>/);
    assert.match(html, /<span data-i18n="post_time">6 min lezen<\/span>/);
    assert.match(html, /<article class="bl-post wg-reveal"><p>Nederlandse tekst<\/p><\/article>/);
    assert.ok(html.includes('alt="Een omslagfoto"'));
  });

  test('carries no English post text', () => {
    for (const english of ['English body', 'A Great Post', 'Short excerpt.', 'A cover photo']) {
      assert.ok(!html.includes(english), english + ' leaked into the Dutch page');
    }
  });

  test('hreflang pair en/nl/x-default points at both addresses', () => {
    assert.deepEqual(alternates(html), [
      ['en', `${BLOG_CANONICAL_BASE}/blog/a-great-post/`],
      ['nl', `${BLOG_CANONICAL_BASE}/nl/blog/a-great-post/`],
      ['x-default', `${BLOG_CANONICAL_BASE}/blog/a-great-post/`],
    ]);
  });

  test('language menu: English links to the English twin, Dutch is this page', () => {
    assert.deepEqual(langMenuHrefs(html), { en: '../../../blog/a-great-post/', nl: './' });
  });

  test('structured data says inLanguage nl and uses the Dutch address and text', () => {
    const [blogPosting, breadcrumb] = ldJsonBlocks(html);
    assert.equal(blogPosting.inLanguage, 'nl');
    assert.equal(blogPosting.headline, 'Een geweldige post');
    assert.equal(blogPosting.description, 'Korte samenvatting.');
    assert.equal(blogPosting.mainEntityOfPage['@id'], `${BLOG_CANONICAL_BASE}/nl/blog/a-great-post/`);
    assert.deepEqual(breadcrumb.itemListElement.map((i) => i.item), [
      `${BLOG_CANONICAL_BASE}/nl/`, `${BLOG_CANONICAL_BASE}/nl/blog/`, `${BLOG_CANONICAL_BASE}/nl/blog/a-great-post/`,
    ]);
  });

  test('nav, footer and breadcrumb links go to the /nl/ pages (resolved from the page address)', () => {
    const base = 'https://x.invalid/nl/blog/a-great-post/';
    const resolved = (h) => new URL(h, base).pathname;
    for (const [href, want] of [['../../', '/nl/'], ['../', '/nl/blog/'], ['../../how-it-works/', '/nl/how-it-works/'], ['../../faq/', '/nl/faq/']]) {
      assert.ok(html.includes(`href="${href}"`), href);
      assert.equal(resolved(href), want);
    }
    assert.equal(resolved('../../'), '/nl/');
    assert.equal(resolved('../'), '/nl/blog/');
    // every link that resolves to a page which exists in Dutch must land under /nl/
    for (const m of html.matchAll(/<a [^>]*href="([^"#]*)"/g)) {
      const p = resolved(m[1]);
      if (/^\/(faq|groups|gift-cards|about|contact|how-it-works|privacy|terms|cookies|blog)\/$/.test(p)) assert.fail(`${m[1]} leaves the Dutch pages (-> ${p})`);
    }
  });

  test('uses the same Dutch chrome wording as the Dutch site pages (nav label, language label)', () => {
    const faq = readFileSync(path.join(__dirname, '../../nl/faq/index.html'), 'utf8');
    const label = /data-i18n="foot_gift">([^<]*)</.exec(faq)[1];
    assert.ok(label && html.includes(`data-i18n="foot_gift">${label}<`));
    assert.ok(html.includes('aria-label="Taal wijzigen: NL"'));
  });

  test('noindex mirrors siteNoindex; preview <base> points at the Dutch address', () => {
    assert.ok(renderPostPageNl(POST_NL, basePost(), { siteNoindex: true }).includes('<meta name="robots" content="noindex">'));
    assert.ok(!html.includes('<meta name="robots" content="noindex">'));
    const preview = renderPostPageNl(POST_NL, basePost(), { siteNoindex: true, preview: true });
    assert.ok(preview.includes(`<base href="${SITE_ASSET_BASE}/nl/blog/a-great-post/">`));
    assert.ok(preview.includes("connect-src 'none'"));
  });

  test('a missing Dutch title/summary falls back to English text (the body is what makes the page)', () => {
    const h = renderPostPageNl(POST_NL, basePost({ title_nl: null, excerpt_nl: null }), {});
    assert.ok(h.includes('<title>A Great Post | WOGO</title>'));
  });

  test('escapes special characters and never lets a title break the JSON-LD', () => {
    const h = renderPostPageNl(POST_NL, basePost({ title_nl: 'Tom & "Jerry" </script><b>' }), {});
    assert.ok(h.includes('Tom &amp; &quot;Jerry&quot; &lt;/script&gt;&lt;b&gt;'));
    const blocks = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const b of blocks) { assert.ok(!b.includes('<')); JSON.parse(b); }
  });

  test('a post WITHOUT a Dutch body gets no Dutch page at all', () => {
    assert.equal(renderPostPageNl(POST_NL, noDutch(), {}), null);
    assert.equal(renderPostPageNl(POST_NL, basePost({ body_nl: '<p> </p>' }), {}), null);
  });
});

describe('indexes', () => {
  const posts = [
    basePost({ slug: 'post-a', title_en: 'Post A', title_nl: 'Post A NL' }),
    noDutch({ slug: 'post-b', title_en: 'Post B', cover_image_path: null }),
    basePost({ slug: 'post-c', title_en: 'Post C', title_nl: null }),
  ];

  test('English index: every post, English text only, no unfilled tokens, newest-first as given', () => {
    const html = renderIndexPage(INDEX_EN, posts, { siteNoindex: true });
    assert.ok(!tokensLeft(html));
    assert.equal((html.match(/class="bl-card"/g) || []).length, 3);
    assert.ok(html.indexOf('post-a/') < html.indexOf('post-b/'));
    assert.ok(!html.includes('Post A NL'));
    assert.match(html, /<html lang="en">/);
    assert.ok(html.includes('<title>The WOGO Journal · Cocktail Culture &amp; City Guides | WOGO</title>'));
  });

  test('English index: hreflang pair and menu link to /nl/blog/ when a Dutch index exists, none (menu -> Dutch home) when not', () => {
    const withNl = renderIndexPage(INDEX_EN, posts, {});
    assert.deepEqual(alternates(withNl), [
      ['en', `${BLOG_CANONICAL_BASE}/blog/`], ['nl', `${BLOG_CANONICAL_BASE}/nl/blog/`], ['x-default', `${BLOG_CANONICAL_BASE}/blog/`],
    ]);
    assert.equal(langMenuHrefs(withNl).nl, '../nl/blog/');
    const without = renderIndexPage(INDEX_EN, [posts[1]], {});
    assert.deepEqual(alternates(without), []);
    assert.ok(!without.includes('og:locale:alternate'));
    assert.equal(langMenuHrefs(without).nl, '../nl/');
  });

  test('Dutch index: only the posts that have Dutch text, with Dutch titles, summaries, labels and links', () => {
    const html = renderIndexPageNl(INDEX_NL, posts, {});
    assert.ok(!tokensLeft(html));
    assert.match(html, /<html lang="nl">/);
    assert.equal((html.match(/class="bl-card"/g) || []).length, 2);
    assert.ok(html.includes('href="post-a/"') && html.includes('href="post-c/"') && !html.includes('href="post-b/"'));
    assert.ok(html.includes('<h3>Post A NL</h3>'));
    assert.ok(html.includes('<h3>Post C</h3>'));            // no Dutch title: English one, but the Dutch BODY exists
    assert.ok(html.includes('Korte samenvatting.') && html.includes('min lezen') && html.includes('Stadsgids'));
    assert.ok(!html.includes('Post B'));
    assert.ok(html.includes(`<link rel="canonical" href="${BLOG_CANONICAL_BASE}/nl/blog/">`));
    assert.deepEqual(alternates(html), [
      ['en', `${BLOG_CANONICAL_BASE}/blog/`], ['nl', `${BLOG_CANONICAL_BASE}/nl/blog/`], ['x-default', `${BLOG_CANONICAL_BASE}/blog/`],
    ]);
    assert.ok(html.includes('<title>Het WOGO Journal · cocktailcultuur &amp; stadsgidsen | WOGO</title>'));
  });

  test('Dutch index: JSON-LD lists only the Dutch posts, at their Dutch addresses, inLanguage nl', () => {
    const html = renderIndexPageNl(INDEX_NL, posts, {});
    const blog = ldJsonBlocks(html).find((b) => b['@type'] === 'Blog');
    assert.equal(blog.inLanguage, 'nl');
    assert.deepEqual(blog.blogPost.map((p) => p.url), [`${BLOG_CANONICAL_BASE}/nl/blog/post-a/`, `${BLOG_CANONICAL_BASE}/nl/blog/post-c/`]);
    const en = ldJsonBlocks(renderIndexPage(INDEX_EN, posts, {})).find((b) => b['@type'] === 'Blog');
    assert.equal(en.blogPost.length, 3);
    assert.equal(en.blogPost[0].url, `${BLOG_CANONICAL_BASE}/blog/post-a/`);
  });

  test('no Dutch index when no post has Dutch text; an empty list renders an empty English grid, not an error', () => {
    assert.equal(renderIndexPageNl(INDEX_NL, [posts[1]], {}), null);
    assert.equal(renderIndexPageNl(INDEX_NL, [], {}), null);
    const html = renderIndexPage(INDEX_EN, [], { siteNoindex: true });
    assert.ok(!tokensLeft(html));
    assert.equal((html.match(/class="bl-card"/g) || []).length, 0);
  });

  test('noindex mirrors siteNoindex on both indexes', () => {
    assert.ok(renderIndexPage(INDEX_EN, posts, { siteNoindex: true }).includes('noindex'));
    assert.ok(renderIndexPageNl(INDEX_NL, posts, { siteNoindex: true }).includes('noindex'));
    assert.ok(!renderIndexPage(INDEX_EN, posts, { siteNoindex: false }).includes('<meta name="robots" content="noindex">'));
  });
});

describe('sitemap lines', () => {
  const B = BLOG_CANONICAL_BASE;
  const BASE = `<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n\n  <url>\n    <loc>${B}/faq/</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n  <url>\n    <loc>${B}/blog/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n  <url>\n    <loc>${B}/blog/old-post/</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>\n</urlset>\n`;
  const count = (xml, s) => xml.split(s).length - 1;

  test('buildSitemapUrlEntry keeps the file\'s shape (loc/changefreq/priority, no lastmod)', () => {
    const entry = buildSitemapUrlEntry(basePost({ slug: 'my-post' }));
    assert.ok(entry.includes(`<loc>${B}/blog/my-post/</loc>`));
    assert.ok(entry.includes('<changefreq>monthly</changefreq>') && entry.includes('<priority>0.5</priority>'));
    assert.ok(!entry.includes('<lastmod>'));
  });

  test('publishing a post WITH Dutch text adds both lines with hreflang pairs, and the Dutch index lines', () => {
    const xml = updateBlogSitemap(BASE, { post: basePost(), add: true, nlIndex: true });
    for (const loc of [`${B}/blog/a-great-post/`, `${B}/nl/blog/a-great-post/`]) assert.equal(count(xml, `<loc>${loc}</loc>`), 1, loc);
    const nlBlock = /<url>\s*<loc>[^<]*\/nl\/blog\/a-great-post\/<\/loc>[\s\S]*?<\/url>/.exec(xml)[0];
    assert.ok(nlBlock.includes(`<xhtml:link rel="alternate" hreflang="en" href="${B}/blog/a-great-post/"/>`));
    assert.ok(nlBlock.includes(`<xhtml:link rel="alternate" hreflang="nl" href="${B}/nl/blog/a-great-post/"/>`));
    assert.ok(nlBlock.includes(`<xhtml:link rel="alternate" hreflang="x-default" href="${B}/blog/a-great-post/"/>`));
    assert.ok(!xml.includes('<lastmod>'));
    // index: English line gains the pair, Dutch index line appears
    assert.equal(count(xml, `<loc>${B}/nl/blog/</loc>`), 1);
    const idx = /<url>\s*<loc>[^<]*\/blog\/<\/loc>[\s\S]*?<\/url>/.exec(xml)[0];
    assert.ok(idx.includes(`hreflang="nl" href="${B}/nl/blog/"`));
    // the pre-existing English-only post line is untouched (no alternates)
    const old = /<url>\s*<loc>[^<]*old-post\/<\/loc>[\s\S]*?<\/url>/.exec(xml)[0];
    assert.ok(!old.includes('xhtml:link'));
  });

  test('a post WITHOUT Dutch text gets one plain line, no Dutch line, no hreflang', () => {
    const xml = updateBlogSitemap(BASE, { post: noDutch(), add: true, nlIndex: false });
    assert.equal(count(xml, `<loc>${B}/blog/a-great-post/</loc>`), 1);
    assert.equal(count(xml, '/nl/blog/'), 0);
    assert.equal(count(xml, 'xhtml:link'), 0);
  });

  test('is idempotent: publishing the same post twice changes nothing the second time', () => {
    const once = updateBlogSitemap(BASE, { post: basePost(), add: true, nlIndex: true });
    assert.equal(updateBlogSitemap(once, { post: basePost(), add: true, nlIndex: true }), once);
  });

  test('a post that loses its Dutch text loses its Dutch line, and the index pair goes when no Dutch post is left', () => {
    const once = updateBlogSitemap(BASE, { post: basePost(), add: true, nlIndex: true });
    const xml = updateBlogSitemap(once, { post: noDutch(), add: true, nlIndex: false });
    assert.equal(count(xml, '/nl/blog/'), 0);
    assert.equal(count(xml, 'xhtml:link'), 0);
    assert.equal(count(xml, `<loc>${B}/blog/a-great-post/</loc>`), 1);
  });

  test('unpublishing removes both lines; the rest of the file survives; removing again is a no-op', () => {
    const once = updateBlogSitemap(BASE, { post: basePost(), add: true, nlIndex: true });
    const xml = updateBlogSitemap(once, { post: basePost(), add: false, nlIndex: false });
    assert.equal(xml, BASE);
    assert.equal(updateBlogSitemap(xml, { post: basePost(), add: false, nlIndex: false }), BASE);
  });

  test('adds the xhtml namespace when the file lacks it', () => {
    const plain = BASE.replace(' xmlns:xhtml="http://www.w3.org/1999/xhtml"', '');
    assert.ok(updateBlogSitemap(plain, { post: basePost(), add: true, nlIndex: true }).includes('xmlns:xhtml='));
  });
});
