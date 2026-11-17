// src/blog_render.js — turns a blog_posts row into the exact static HTML
// files the site serves (BUILD §21). PURE rendering: no fetch, no D1, no
// GitHub calls — this module only ever reads a template string + a plain
// post object and returns a string. admin_api.js is responsible for
// loading the template files (via GitHub, so preview/publish always render
// from the SAME source the live site is built from) and committing the
// output; src/github.js is responsible for the actual writes.
//
// Renderers (one language per page — English at /blog/..., Dutch at /nl/blog/...):
//   renderPostPage(template, post, opts)       -> blog/<slug>/index.html (English)
//   renderPostPageNl(templateNl, post, opts)   -> nl/blog/<slug>/index.html, or null
//                                                 when the post has no Dutch body
//   renderIndexPage(template, posts, opts)     -> blog/index.html (English)
//   renderIndexPageNl(templateNl, posts, opts) -> nl/blog/index.html, or null when
//                                                 no published post has Dutch text
//   updateBlogSitemap(xml, {post, add, nlIndex}) -> sitemap.xml with the blog lines
//                                                 (and their hreflang pairs) updated
//
// They fill a `{{PLACEHOLDER}}` token scheme against the four GENERATED
// templates in blog/_template/generated/ (made by tools/build-nl.js from the
// hand-edited blog/_template/post.html and index.html, so the shared
// NAV/FOOTER/CONSENT/ANALYTICS chrome — and its Dutch wording — is the very
// same as on every other page of the site). The Dutch templates use the _NL
// twin of each _EN token.

import { BLOG_CANONICAL_BASE, SITE_ASSET_BASE } from './config.js';
import { sanitizeBlogHtml, stripHtmlTags } from './logic.js';

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

/** JSON for a <script type="application/ld+json"> block. Plain JSON.stringify
 * leaves "<" alone, so a title containing a closing script tag would end the
 * block early. Escaping < > & (as \\uXXXX) keeps the JSON identical for
 * parsers while making it impossible to break out of the script element. */
function safeJsonLd(obj) {
  return JSON.stringify(obj).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function escHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

/** True when the post has Dutch body text — the one condition for a Dutch page. */
export function hasDutchBody(post) {
  return !!(post && post.body_nl && stripHtmlTags(String(post.body_nl)).trim());
}

/** Builds the field values both languages draw from. */
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

const enPostUrl = (slug) => `${BLOG_CANONICAL_BASE}/blog/${slug}/`;
const nlPostUrl = (slug) => `${BLOG_CANONICAL_BASE}/nl/blog/${slug}/`;

/** The hreflang pair for a page that exists in both languages. */
function altLinkTags(enUrl, nlUrl) {
  return (
    `<link rel="alternate" hreflang="en" href="${escHtml(enUrl)}">\n` +
    `<link rel="alternate" hreflang="nl" href="${escHtml(nlUrl)}">\n` +
    `<link rel="alternate" hreflang="x-default" href="${escHtml(enUrl)}">`
  );
}

const OG_ALTERNATE_NL = '<meta property="og:locale:alternate" content="nl_NL">\n';

function robotsTag(opts) {
  return opts.siteNoindex ? '<meta name="robots" content="noindex">' : '';
}

/** The preview-only head additions (see security_headers.js on why `<base>` is
 * preview-only). `basePath` is where the page will really live. */
function previewHead(opts, basePath) {
  if (!opts.preview) return '';
  // The dashboard shows this inside a sandboxed frame. The meta policy adds
  // a second lock: nothing in the preview may call out, submit a form,
  // nest another frame or load plugins (it intersects with the policy the
  // frame inherits from the dashboard, it can only tighten it).
  return `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">` +
    // A sandboxed frame has no stored consent choice, so keep the cookie banner out of the preview.
    `<style>#wogoCcBanner{display:none!important}</style>` +
    `<base href="${escHtml(`${SITE_ASSET_BASE}/${basePath}`)}">`;
}

/**
 * Renders one post's English page. English only: no Dutch text in it. The
 * language menu links to the Dutch twin when the post has a Dutch body, else to
 * the Dutch blog index (`opts.nlIndex`, default true) or the Dutch homepage;
 * hreflang tags are written only when the twin exists.
 * `opts.siteNoindex` (pass config.js:SITE_NOINDEX) controls the robots tag;
 * `opts.preview` adds the preview-only head tags (see previewHead).
 */
export function renderPostPage(template, post, opts = {}) {
  const f = postFields(post);
  const hasNl = hasDutchBody(post);
  const nlIndex = opts.nlIndex !== false;
  const canonicalUrl = enPostUrl(post.slug);
  const coverSrc = assetUrl(f.coverPath);
  const coverAbsUrl = `${BLOG_CANONICAL_BASE}/${f.coverPath}`;
  const datePublished = dateOnly(post.published_at || post.created_at);
  const dateModified = dateOnly(post.updated_at || post.published_at || post.created_at);

  const jsonLdBlogPosting = safeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    inLanguage: 'en',
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
  const jsonLdBreadcrumb = safeJsonLd({
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
    ROBOTS_META_TAG: robotsTag(opts),
    PREVIEW_BASE_TAG: previewHead(opts, `blog/${post.slug}/`),
    BLOG_ALT_LINKS: hasNl ? altLinkTags(canonicalUrl, nlPostUrl(post.slug)) : '',
    NL_SWITCH_HREF: hasNl ? `../../nl/blog/${post.slug}/` : (nlIndex ? '../../nl/blog/' : '../../nl/'),
    TITLE_EN: escHtml(f.titleEn),
    CATEGORY_EN: escHtml(categoryLabel(post.category, 'en')),
    EXCERPT_EN: escHtml(f.excerptEn),
    COVER_ALT_EN: escHtml(f.coverAltEn),
    READ_MINUTES: String(post.read_minutes || 5),
    // Sanitised again at render time: bodies stored before a sanitizer fix must
    // not reach a page unchecked. Re-running it on clean HTML changes nothing.
    BODY_EN: sanitizeBlogHtml(post.body_en || ''),
  };
  let html = fillTemplate(template, map);
  if (!hasNl) html = html.replace(OG_ALTERNATE_NL, ''); // no Dutch page: do not advertise one
  return html;
}

/**
 * Renders one post's Dutch page (nl/blog/<slug>/index.html), or returns null
 * when the post has no Dutch body — a post without Dutch text gets no Dutch
 * page at all (no English duplicate under /nl/). Same options as renderPostPage.
 */
export function renderPostPageNl(template, post, opts = {}) {
  if (!hasDutchBody(post)) return null;
  const f = postFields(post);
  const canonicalUrl = nlPostUrl(post.slug);
  const coverSrc = assetUrl(f.coverPath);
  const coverAbsUrl = `${BLOG_CANONICAL_BASE}/${f.coverPath}`;
  const datePublished = dateOnly(post.published_at || post.created_at);
  const dateModified = dateOnly(post.updated_at || post.published_at || post.created_at);

  const jsonLdBlogPosting = safeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    inLanguage: 'nl',
    headline: f.titleNl,
    description: f.seoDescriptionNl,
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
  const jsonLdBreadcrumb = safeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BLOG_CANONICAL_BASE}/nl/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${BLOG_CANONICAL_BASE}/nl/blog/` },
      { '@type': 'ListItem', position: 3, name: f.titleNl, item: canonicalUrl },
    ],
  });

  const map = {
    SEO_TITLE_NL: escHtml(f.seoTitleNl),
    SEO_DESCRIPTION_NL: escHtml(f.seoDescriptionNl),
    SLUG: escHtml(post.slug),
    COVER_IMAGE_ABS_URL: escHtml(coverAbsUrl),
    COVER_IMAGE_SRC: escHtml(coverSrc),
    JSONLD_BLOGPOSTING: jsonLdBlogPosting,
    JSONLD_BREADCRUMBLIST: jsonLdBreadcrumb,
    ROBOTS_META_TAG: robotsTag(opts),
    PREVIEW_BASE_TAG: previewHead(opts, `nl/blog/${post.slug}/`),
    TITLE_NL: escHtml(f.titleNl),
    CATEGORY_NL: escHtml(categoryLabel(post.category, 'nl')),
    EXCERPT_NL: escHtml(f.excerptNl),
    COVER_ALT_NL: escHtml(f.coverAltNl),
    READ_MINUTES: String(post.read_minutes || 5),
    BODY_NL: sanitizeBlogHtml(post.body_nl || ''),
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

/** The blog index's own texts (the page has no database row). */
const INDEX_TEXT = {
  en: {
    title: 'The WOGO Journal · Cocktail Culture & City Guides',
    description: 'City guides, cocktail culture and the stories behind every WOGO route — from what a self-guided cocktail walk actually is to where the best bars really hide.',
    ogTitle: 'The WOGO Journal · cocktail culture & city guides',
    ogDescription: 'City guides, cocktail culture and the stories behind every WOGO route.',
    ldName: 'The WOGO Journal',
    ldDescription: "Cocktail culture, city guides and stories from WOGO's self-guided cocktail walks in Amsterdam, Rotterdam, Utrecht and Groningen.",
  },
  nl: {
    title: 'Het WOGO Journal · cocktailcultuur & stadsgidsen',
    description: 'Stadsgidsen, cocktailcultuur en de verhalen achter elke WOGO-route — van wat een zelfgeleide cocktailwandeling eigenlijk is tot waar de beste bars echt verstopt zitten.',
    ogTitle: 'Het WOGO Journal · cocktailcultuur & stadsgidsen',
    ogDescription: 'Stadsgidsen, cocktailcultuur en de verhalen achter elke WOGO-route.',
    ldName: 'Het WOGO Journal',
    ldDescription: 'Cocktailcultuur, stadsgidsen en verhalen over de zelfgeleide cocktailwandelingen van WOGO in Amsterdam, Rotterdam, Utrecht en Groningen.',
  },
};

function indexJsonLd(posts, lang) {
  const t = INDEX_TEXT[lang];
  return safeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    inLanguage: lang,
    name: t.ldName,
    url: lang === 'nl' ? `${BLOG_CANONICAL_BASE}/nl/blog/` : `${BLOG_CANONICAL_BASE}/blog/`,
    description: t.ldDescription,
    publisher: { '@type': 'Organization', name: 'WOGO Cocktail Walk', logo: `${BLOG_CANONICAL_BASE}/wogo-logo.png` },
    blogPost: posts.map((p) => ({
      '@type': 'BlogPosting',
      inLanguage: lang,
      headline: lang === 'nl' ? postFields(p).titleNl : p.title_en,
      url: lang === 'nl' ? nlPostUrl(p.slug) : enPostUrl(p.slug),
    })),
  });
}

/**
 * Renders blog/index.html (English) from the CURRENT list of published posts
 * (newest first — caller is responsible for that ordering). Always regenerated
 * in full on every publish/unpublish — never hand-edited, never diffed.
 * `opts.nlIndex` says whether /nl/blog/ exists (default: some post has Dutch text).
 */
export function renderIndexPage(template, publishedPosts, opts = {}) {
  const nlIndex = opts.nlIndex !== undefined ? !!opts.nlIndex : publishedPosts.some(hasDutchBody);
  const t = INDEX_TEXT.en;
  const map = {
    ROBOTS_META_TAG: robotsTag(opts),
    JSONLD_BLOG: indexJsonLd(publishedPosts, 'en'),
    BLOG_CARDS_EN: publishedPosts.map((p) => buildCard(p, 'en')).join('\n'),
    BLOG_ALT_LINKS: nlIndex ? altLinkTags(`${BLOG_CANONICAL_BASE}/blog/`, `${BLOG_CANONICAL_BASE}/nl/blog/`) : '',
    NL_SWITCH_HREF: nlIndex ? '../nl/blog/' : '../nl/',
    INDEX_TITLE_EN: escHtml(t.title),
    INDEX_DESCRIPTION_EN: escHtml(t.description),
    INDEX_OG_TITLE_EN: escHtml(t.ogTitle),
    INDEX_OG_DESCRIPTION_EN: escHtml(t.ogDescription),
  };
  let html = fillTemplate(template, map);
  if (!nlIndex) html = html.replace(OG_ALTERNATE_NL, '');
  return html;
}

/** nl/blog/index.html: only the posts that have Dutch text. Null when there are none. */
export function renderIndexPageNl(template, publishedPosts, opts = {}) {
  const dutch = publishedPosts.filter(hasDutchBody);
  if (!dutch.length) return null;
  const t = INDEX_TEXT.nl;
  const map = {
    ROBOTS_META_TAG: robotsTag(opts),
    JSONLD_BLOG: indexJsonLd(dutch, 'nl'),
    BLOG_CARDS_NL: dutch.map((p) => buildCard(p, 'nl')).join('\n'),
    INDEX_TITLE_NL: escHtml(t.title),
    INDEX_DESCRIPTION_NL: escHtml(t.description),
    INDEX_OG_TITLE_NL: escHtml(t.ogTitle),
    INDEX_OG_DESCRIPTION_NL: escHtml(t.ogDescription),
  };
  return fillTemplate(template, map);
}

// --- sitemap.xml -----------------------------------------------------------
// The blog lines are written by the Worker; tools/build-nl.js leaves them alone
// (it sets them aside while it rebuilds the page lines) and only checks them.
// The line format is the one build-nl.js writes for every other page.

function smLinks(enUrl, nlUrl) {
  return (
    `    <xhtml:link rel="alternate" hreflang="en" href="${escHtml(enUrl)}"/>\n` +
    `    <xhtml:link rel="alternate" hreflang="nl" href="${escHtml(nlUrl)}"/>\n` +
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${escHtml(enUrl)}"/>\n`
  );
}
function smBlock(loc, links, changefreq, priority) {
  return `  <url>\n    <loc>${escHtml(loc)}</loc>\n${links}    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>\n`;
}
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function smRemove(xml, loc) {
  return xml.replace(new RegExp(`[ \\t]*<url>\\s*<loc>${reEsc(escHtml(loc))}</loc>[\\s\\S]*?</url>\\n?`), '');
}
function smInsertEnd(xml, block) {
  const i = xml.lastIndexOf('</urlset>');
  if (i === -1) return xml;
  const pre = xml.slice(0, i);
  return (pre.endsWith('\n') ? pre : pre + '\n') + block + xml.slice(i);
}

/**
 * Brings the blog lines of sitemap.xml in line with one publish/unpublish:
 * this post's English line (+ Dutch line and hreflang pair when it has Dutch
 * text), and the two index lines (/blog/ gets its hreflang pair, and /nl/blog/
 * exists, only while `nlIndex` — i.e. at least one published post has Dutch
 * text). Idempotent in both directions. No <lastmod>, as in the rest of the file.
 */
export function updateBlogSitemap(xml, { post, add, nlIndex }) {
  let out = xml;
  const enLoc = enPostUrl(post.slug);
  const nlLoc = nlPostUrl(post.slug);
  out = smRemove(smRemove(out, enLoc), nlLoc);
  if (add) {
    const dutch = hasDutchBody(post);
    out = smInsertEnd(out, smBlock(enLoc, dutch ? smLinks(enLoc, nlLoc) : '', 'monthly', '0.5'));
    if (dutch) out = smInsertEnd(out, smBlock(nlLoc, smLinks(enLoc, nlLoc), 'monthly', '0.5'));
  }
  const enIdx = `${BLOG_CANONICAL_BASE}/blog/`;
  const nlIdx = `${BLOG_CANONICAL_BASE}/nl/blog/`;
  out = smRemove(out, nlIdx);
  const idxRe = new RegExp(`[ \\t]*<url>\\s*<loc>${reEsc(escHtml(enIdx))}</loc>[\\s\\S]*?</url>\\n?`);
  if (idxRe.test(out)) {
    out = out.replace(idxRe, () =>
      smBlock(enIdx, nlIndex ? smLinks(enIdx, nlIdx) : '', 'weekly', '0.6') +
      (nlIndex ? smBlock(nlIdx, smLinks(enIdx, nlIdx), 'weekly', '0.6') : ''));
  }
  if (!/<urlset\b[^>]*xmlns:xhtml=/.test(out)) {
    out = out.replace(/<urlset\b([^>]*)>/, '<urlset$1 xmlns:xhtml="http://www.w3.org/1999/xhtml">');
  }
  return out;
}

/** One `<url>` block for sitemap.xml (English line of a post, no hreflang) — kept
 * for callers that only add a line; updateBlogSitemap is what the Worker uses. */
export function buildSitemapUrlEntry(post) {
  const loc = enPostUrl(post.slug);
  return `  <url>\n    <loc>${escHtml(loc)}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`;
}

export const _internal = { escHtml, categoryLabel, assetUrl, postFields, fillTemplate, INDEX_TEXT };
