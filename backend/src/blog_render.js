// src/blog_render.js — turns a blog_posts row into the exact static HTML
// files the site serves (BUILD §21). PURE rendering: no fetch, no D1, no
// GitHub calls — this module only ever reads a template string + a plain
// post object and returns a string. admin_api.js is responsible for
// loading the template files (via GitHub, so preview/publish always render
// from the SAME source the live site is built from) and committing the
// output; src/github.js is responsible for the actual writes.
//
// Two renderers:
//   renderPostPage(template, post, opts)   -> one post's full index.html
//   renderIndexPage(template, posts, opts) -> blog/index.html's card grid
//
// Both fill a `{{PLACEHOLDER}}` token scheme against the template files at
// blog/_template/post.html / blog/_template/index.html — built by COPYING a
// real page and swapping only the post-specific content for tokens, so the
// shared NAV/FOOTER/CONSENT/ANALYTICS chrome stays byte-identical to every
// other page on the site (see those files' own head comments).

import { BLOG_CANONICAL_BASE, SITE_ASSET_BASE } from './config.js';

const CATEGORY_NL = {
  'City guide': 'Stadsgids',
  'New route': 'Nieuwe route',
  Explained: 'Uitgelegd',
  Recipes: 'Recepten',
  News: 'Nieuws',
};

/** Fallback cover photo (a real, already-published WOGO frame) for a post
 * that has no cover image uploaded yet — so a draft/preview never shows a
 * broken <img>. Absolute (see module doc comment on why every blog image
 * reference, cover or in-body, is an absolute URL rather than relative). */
const FALLBACK_COVER_PATH = 'how-it-works/how-it-works-hero.jpg';

function escHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Embeds an already-HTML-escaped string inside a double-quoted JS string
 * literal (the foot script's `NL = {...}` dictionary) — escapes backslashes
 * and any (should-already-be-absent, but defensive) literal quote/newline. */
function escJsDoubleQuoted(htmlEscapedValue) {
  return String(htmlEscapedValue)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
}

/** For a value that goes straight into a JS string literal AND is then used
 * as `el.innerHTML = dict[k]` at runtime (the NL dictionary path) — HTML-
 * escape first (so it renders correctly as HTML once assigned), then JS-
 * string-escape the result (so it embeds safely inside the `"..."` literal). */
function toNlDictLiteral(value) {
  return escJsDoubleQuoted(escHtml(value));
}

function categoryLabel(category, lang) {
  if (lang === 'nl') return CATEGORY_NL[category] || category;
  return category;
}

function dateOnly(sqliteDatetime) {
  if (!sqliteDatetime) return '';
  return String(sqliteDatetime).slice(0, 10);
}

/** Absolute URL for a repo-relative asset path (BUILD §21: every blog image
 * reference — cover or in-body — is absolute, never page-relative, so the
 * same value works unchanged in the post page, the index card grid, AND
 * the admin editor's preview iframe). Uses SITE_ASSET_BASE (the functional,
 * cutover-aware host — see config.js), NOT BLOG_CANONICAL_BASE, because this
 * is a resource the browser actually fetches, not a meta/canonical tag. */
export function assetUrl(repoRelativePath) {
  return `${SITE_ASSET_BASE}/${repoRelativePath}`;
}

function fillTemplate(template, map) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (full, key) => {
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      throw new Error(`blog_render: template references {{${key}}} with no value provided`);
    }
    const v = map[key];
    return v == null ? '' : String(v);
  });
}

/**
 * Builds the shared placeholder map both templates can draw from (a post
 * page uses every key; the index page's per-card builder below reuses the
 * same escaping/fallback logic rather than duplicating it).
 */
function postFields(post) {
  const titleEn = post.title_en || '';
  const titleNl = post.title_nl || titleEn; // EN-fallback rule — see migration's doc comment
  const excerptEn = post.excerpt_en || '';
  const excerptNl = post.excerpt_nl || excerptEn;
  const seoTitleEn = post.seo_title_en || titleEn;
  const seoTitleNl = post.seo_title_nl || titleNl;
  const seoDescriptionEn = post.seo_description_en || excerptEn;
  const seoDescriptionNl = post.seo_description_nl || excerptNl;
  const coverPath = post.cover_image_path || FALLBACK_COVER_PATH;
  const coverAltEn = post.cover_alt_en || titleEn;
  const coverAltNl = post.cover_alt_nl || titleNl;
  return {
    titleEn, titleNl, excerptEn, excerptNl, seoTitleEn, seoTitleNl,
    seoDescriptionEn, seoDescriptionNl, coverPath, coverAltEn, coverAltNl,
  };
}

/**
 * Renders one post's complete page. `opts.siteNoindex` (pass
 * config.js:SITE_NOINDEX) controls the robots tag; `opts.preview` renders a
 * `<base>` tag so relative chrome assets (nav logo, favicons, etc.) resolve
 * correctly inside an iframe `srcdoc` (see security_headers.js's doc
 * comment on why `<base>` is preview-only — the committed file keeps the
 * same `../../`-relative convention every other post uses, byte-identical).
 */
export function renderPostPage(template, post, opts = {}) {
  const f = postFields(post);
  const canonicalUrl = `${BLOG_CANONICAL_BASE}/blog/${post.slug}/`;
  const coverSrc = assetUrl(f.coverPath);
  const coverAbsUrl = `${BLOG_CANONICAL_BASE}/${f.coverPath}`;
  const datePublished = dateOnly(post.published_at || post.created_at);
  const dateModified = dateOnly(post.updated_at || post.published_at || post.created_at);

  const jsonLdBlogPosting = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: f.titleEn,
    description: f.seoDescriptionEn,
    image: coverAbsUrl,
    datePublished,
    dateModified,
    author: { '@type': 'Organization', name: 'WOGO' },
    publisher: {
      '@type': 'Organization',
      name: 'WOGO Cocktail Walk',
      logo: { '@type': 'ImageObject', url: `${BLOG_CANONICAL_BASE}/wogo-logo.png` },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  });
  const jsonLdBreadcrumb = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BLOG_CANONICAL_BASE}/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${BLOG_CANONICAL_BASE}/blog/` },
      { '@type': 'ListItem', position: 3, name: f.titleEn, item: canonicalUrl },
    ],
  });

  const map = {
    SEO_TITLE_EN: escHtml(f.seoTitleEn),
    SEO_DESCRIPTION_EN: escHtml(f.seoDescriptionEn),
    CANONICAL_URL: escHtml(canonicalUrl),
    COVER_IMAGE_ABS_URL: escHtml(coverAbsUrl),
    COVER_IMAGE_SRC: escHtml(coverSrc),
    JSONLD_BLOGPOSTING: jsonLdBlogPosting,
    JSONLD_BREADCRUMBLIST: jsonLdBreadcrumb,
    ROBOTS_META_TAG: opts.siteNoindex ? '<meta name="robots" content="noindex">' : '',
    PREVIEW_BASE_TAG: opts.preview ? `<base href="${escHtml(`${SITE_ASSET_BASE}/blog/${post.slug}/`)}">` : '',
    TITLE_EN: escHtml(f.titleEn),
    CATEGORY_EN: escHtml(categoryLabel(post.category, 'en')),
    EXCERPT_EN: escHtml(f.excerptEn),
    COVER_ALT_EN: escHtml(f.coverAltEn),
    READ_MINUTES: String(post.read_minutes || 5),
    BODY_EN: post.body_en || '',
    BODY_NL: post.body_nl || post.body_en || '',
    TITLE_NL: toNlDictLiteral(f.titleNl),
    CATEGORY_NL: toNlDictLiteral(categoryLabel(post.category, 'nl')),
    EXCERPT_NL: toNlDictLiteral(f.excerptNl),
    COVER_ALT_NL: toNlDictLiteral(f.coverAltNl),
  };
  return fillTemplate(template, map);
}

/** One `<a class="bl-card">` block for the index grid, in one language. */
function buildCard(post, lang) {
  const f = postFields(post);
  const title = lang === 'nl' ? f.titleNl : f.titleEn;
  const excerpt = lang === 'nl' ? f.excerptNl : f.excerptEn;
  const alt = lang === 'nl' ? f.coverAltNl : f.coverAltEn;
  const minutesWord = lang === 'nl' ? 'min lezen' : 'min read';
  const coverSrc = assetUrl(f.coverPath);
  return (
    `    <a class="bl-card" href="${escHtml(post.slug)}/">\n` +
    `      <div class="bl-card-img"><img loading="lazy" decoding="async" width="1600" height="900" src="${escHtml(coverSrc)}" alt="${escHtml(alt)}"></div>\n` +
    `      <div class="bl-card-body">\n` +
    `        <span class="bl-cat">${escHtml(categoryLabel(post.category, lang))}</span>\n` +
    `        <h3>${escHtml(title)}</h3>\n` +
    `        <p>${escHtml(excerpt)}</p>\n` +
    `        <span class="bl-meta">${post.read_minutes || 5} ${minutesWord}</span>\n` +
    `      </div>\n` +
    `    </a>`
  );
}

/**
 * Renders blog/index.html's full page from the CURRENT list of published
 * posts (newest first — caller is responsible for that ordering, e.g.
 * `db.js:listBlogPosts` + a sort/filter to `status==='published'`). Always
 * regenerated in full on every publish/unpublish — never hand-edited, never
 * diffed against the previous version.
 */
export function renderIndexPage(template, publishedPosts, opts = {}) {
  const cardsEn = publishedPosts.map((p) => buildCard(p, 'en')).join('\n');
  const cardsNl = publishedPosts.map((p) => buildCard(p, 'nl')).join('\n');
  const jsonLdPosts = publishedPosts
    .map((p) => JSON.stringify({
      '@type': 'BlogPosting',
      headline: p.title_en,
      url: `${BLOG_CANONICAL_BASE}/blog/${p.slug}/`,
    }))
    .join(',');
  const map = {
    ROBOTS_META_TAG: opts.siteNoindex ? '<meta name="robots" content="noindex">' : '',
    BLOG_JSONLD_POSTS: jsonLdPosts,
    BLOG_CARDS_EN: cardsEn,
    BLOG_CARDS_NL: cardsNl,
  };
  return fillTemplate(template, map);
}

/** One `<url>` block for sitemap.xml — only ever added while
 * !config.js:SITE_NOINDEX (see admin_api.js's publish handler). Matches the
 * existing file's exact shape (`<loc>`/`<changefreq>`/`<priority>`, no
 * `<lastmod>` — the file's own header comment says why: "no real
 * publish/update dates exist yet," a stance this keeps rather than
 * overriding unilaterally for just the blog section). */
export function buildSitemapUrlEntry(post) {
  const loc = `${BLOG_CANONICAL_BASE}/blog/${post.slug}/`;
  return `  <url>\n    <loc>${escHtml(loc)}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`;
}

export const _internal = { escHtml, toNlDictLiteral, categoryLabel, assetUrl, postFields, fillTemplate };
