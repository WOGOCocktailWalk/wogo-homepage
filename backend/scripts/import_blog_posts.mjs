/* ==========================================================================
   backend/scripts/import_blog_posts.mjs — one-off import of the 8
   hand-built /blog/<slug>/index.html pages into the new blog_posts table
   (BUILD §21.5), via the admin API (so every normal validation/sanitize/
   audit path runs — this does NOT write to D1 directly).

   What it does, per post folder under /blog/ (excluding _template/ and the
   index.html grid page itself):
     1. Parses title / meta description / category / read time / hook
        (-> excerpt) / hero image+alt / JSON-LD datePublished / the head
        comment's "OLD URL" (if present) straight out of the real file.
     2. Extracts the article BODY (everything between the hook paragraph and
        the generic CTA band — the CTA band/back-link are regenerated fresh
        by the new renderer, not imported) and converts the old
        `<div class="bl-img">img</div><p class="bl-img-cap">cap</p>` image
        pairing into `<figure><img><figcaption>` (the shape the new
        sanitizer/template actually styles).
     3. Builds the Dutch body by walking the SAME extracted chunk and, for
        every `data-i18n="KEY"` element, substituting in NL[KEY] from the
        page's own embedded NL dictionary (evaluated with node:vm — it's
        real executable JS, not hand-parsed) — so EN/NL stay structurally
        identical (same images in the same places), which is exactly what
        the new dual-body template needs.
     4. POSTs to /admin/api/blog as an OWNER, with `status:'published'` and
        `last_published_commit` set to the CURRENT git HEAD — the "already
        live, no commit needed" seed path (src/admin_api.js:handleCreateBlogPost).
        `old_wix_slug` is populated from the head comment when present.

   SPECIAL CASE: blog/summer-cocktail-recipes/ is ALREADY flagged inside its
   own file as duplicate content (near-verbatim copy of
   blog/utrecht-night-out-cocktails/, excluded from the live index/sitemap
   pending an owner decision — see its head comment). It is imported as a
   DRAFT, not published, to match how it already behaves on the live site
   (not linked, not indexed) rather than forcing a "published" status that
   would overstate it.

   Usage (from backend/):
     node scripts/import_blog_posts.mjs --base-url=https://wogo-booking-backend.xxx.workers.dev --admin-token=XXXX
     node scripts/import_blog_posts.mjs --dry-run      (parses + prints, makes no API calls)
   ========================================================================== */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, '..');
const repoRoot = join(backend, '..');
const blogDir = join(repoRoot, 'blog');

// split on the FIRST '=' only — a cookie value legitimately contains '='
// characters of its own (e.g. base64 padding), which .split('=') with no
// limit would otherwise chop into extra pieces and silently truncate.
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const bare = a.replace(/^--/, '');
    const eq = bare.indexOf('=');
    return eq === -1 ? [bare, true] : [bare.slice(0, eq), bare.slice(eq + 1)];
  })
);
const DRY_RUN = !!args['dry-run'];
const BASE_URL = args['base-url'] || process.env.BLOG_IMPORT_BASE_URL;
const ADMIN_TOKEN = args['admin-token'] || process.env.ADMIN_TOKEN;

const DUPLICATE_SLUGS_AS_DRAFT = new Set(['summer-cocktail-recipes']);

function currentGitCommit() {
  try { return execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim(); } catch { return null; }
}

/** `text` is the slice from `startMarker` through (and including) the FIRST
 * `endMarker` after it; `end` is the offset immediately AFTER that
 * endMarker (i.e. "resume reading from here"), not the offset the marker
 * itself starts at — callers that chain off `.end` (body extraction) rely
 * on that "after" semantic to not re-include the marker text itself. */
function extractBetween(html, startMarker, endMarker, { fromIndex = 0 } = {}) {
  const i = html.indexOf(startMarker, fromIndex);
  if (i === -1) return null;
  const j = html.indexOf(endMarker, i + startMarker.length);
  if (j === -1) return null;
  const end = j + endMarker.length;
  return { text: html.slice(i, end), start: i, end };
}

function stripTag(html, tag) {
  return html.replace(new RegExp(`</?${tag}[^>]*>`, 'gi'), '');
}

/** Evaluates the page's own `var NL = { ... };` object literal as real JS
 * (node:vm, no network/filesystem access in the sandbox) rather than hand-
 * parsing it — these objects use normal JS string escaping (\", unicode,
 * embedded HTML), which a regex-based parser would get wrong in edge cases
 * a real JS engine never does. */
function extractNlDict(html) {
  const m = /var NL = (\{[\s\S]*?\});/.exec(html);
  if (!m) return {};
  const sandbox = {};
  vm.createContext(sandbox);
  return vm.runInContext(`(${m[1]})`, sandbox);
}

/** Finds the enclosing opening tag + matching closing tag for ONE
 * `data-i18n="key"` occurrence, and returns `{ openEnd, closeStart, tag }`
 * (byte offsets into `html`) — assumes the tagged element's own tag name
 * does not nest inside itself (true for every p/h2/h3/li this site's posts
 * actually use). Returns null if the shape doesn't match (caller leaves
 * that element as EN text — a safe, explicit fallback, not a crash). */
function findI18nElement(html, key) {
  const attrIdx = html.indexOf(`data-i18n="${key}"`);
  if (attrIdx === -1) return null;
  const tagStart = html.lastIndexOf('<', attrIdx);
  const tagNameMatch = /^<([a-zA-Z0-9]+)/.exec(html.slice(tagStart));
  if (!tagNameMatch) return null;
  const tag = tagNameMatch[1];
  const openEnd = html.indexOf('>', attrIdx) + 1;
  const closeStart = html.indexOf(`</${tag}>`, openEnd);
  if (closeStart === -1) return null;
  return { tagStart, openEnd, closeStart, closeEnd: closeStart + `</${tag}>`.length, tag };
}

/** Builds the Dutch version of `bodyChunk` by swapping each
 * `data-i18n="key"` element's inner content for `nl[key]`, structure
 * otherwise identical (same images, same paragraph order) — see the module
 * doc comment for why. Untouched (no matching NL key, or a shape
 * findI18nElement can't handle) elements are left as their EN text, which
 * is flagged by the caller via `usedFallbackFor`. */
function buildNlBody(bodyChunk, nl, usedFallbackFor) {
  let out = bodyChunk;
  const keys = [...bodyChunk.matchAll(/data-i18n="([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
  // Process in REVERSE document order so earlier replacements don't shift
  // the byte offsets findI18nElement computes for later ones.
  for (const key of [...new Set(keys)].reverse()) {
    if (!(key in nl)) { usedFallbackFor.push(key); continue; }
    const el = findI18nElement(out, key);
    if (!el) { usedFallbackFor.push(key); continue; }
    out = out.slice(0, el.openEnd) + nl[key] + out.slice(el.closeStart);
  }
  return out;
}

/** `<div class="bl-img ..."><img ... src="X" alt="Y" ...></div>` followed
 * by `<p class="bl-img-cap ...">CAPTION</p>` -> `<figure><img src="X"
 * alt="Y"><figcaption>CAPTION</figcaption></figure>` — the shape the NEW
 * sanitizer/template actually renders with the rounded-corner/caption
 * treatment (src/logic.js:sanitizeBlogHtml's allowlist, blog/_template/
 * post.html's `.bl-post figure/figcaption` rules). */
function convertImageBlocks(html) {
  return html.replace(
    /<div class="bl-img[^"]*"[^>]*>\s*<img([^>]*)>\s*<\/div>\s*<p class="bl-img-cap[^"]*"[^>]*>([\s\S]*?)<\/p>/g,
    (full, imgAttrs, caption) => {
      const src = /\bsrc="([^"]*)"/.exec(imgAttrs);
      const alt = /\balt="([^"]*)"/.exec(imgAttrs);
      return `<figure><img src="${src ? src[1] : ''}" alt="${alt ? alt[1] : ''}"><figcaption>${caption}</figcaption></figure>`;
    }
  );
}

export function parsePost(slug, html) {
  const warnings = [];

  const titleMatch = /<title>([^<]*)<\/title>/.exec(html);
  const titleEn = (titleMatch ? titleMatch[1] : slug).replace(/\s*\|\s*WOGO\s*$/, '').trim();

  const descMatch = /<meta name="description" content="([^"]*)">/.exec(html);
  const seoDescriptionEn = descMatch ? descMatch[1] : '';

  const dateMatch = /"datePublished":"(\d{4}-\d{2}-\d{2})"/.exec(html);
  const publishedAt = dateMatch ? `${dateMatch[1]} 00:00:00` : null;

  const oldUrlMatch = /OLD URL[^:]*:\s*(https?:\/\/\S+)/.exec(html);
  const oldWixSlug = oldUrlMatch ? oldUrlMatch[1] : null;

  const metaBlock = extractBetween(html, '<div class="bl-post-meta', '</div>');
  const catMatch = metaBlock && /data-i18n="post_cat">([^<]*)</.exec(metaBlock.text);
  const category = catMatch ? catMatch[1].trim() : 'City guide';
  const timeMatch = metaBlock && /data-i18n="post_time">(\d+)/.exec(metaBlock.text);
  const readMinutes = timeMatch ? Number(timeMatch[1]) : 5;

  const hookBlock = extractBetween(html, 'class="bl-hook', '</p>');
  const hookTextMatch = /class="bl-hook[^"]*"[^>]*data-i18n="post_hook">([\s\S]*?)<\/p>/.exec(html);
  const excerptEn = hookTextMatch ? hookTextMatch[1].trim() : '';

  const heroImgMatch = /<img class="w-hero-video" src="([^"]*)" alt="([^"]*)"/.exec(html);
  // Two shapes exist across the 8 real posts: an image that lives ELSEWHERE
  // in the repo is referenced '../../some/path.jpg' (repo-root-relative once
  // the '../../' is stripped); an image that lives IN THE POST'S OWN FOLDER
  // (most of them) is referenced with no prefix at all ('acw-bars-hero.jpg')
  // — that one needs 'blog/<slug>/' prepended to become repo-relative,
  // which is what cover_image_path is actually stored as.
  let coverPath = null;
  if (heroImgMatch) {
    const src = heroImgMatch[1];
    coverPath = src.startsWith('../../') ? src.replace(/^(\.\.\/)+/, '') : `blog/${slug}/${src}`;
  }
  const coverAltEn = heroImgMatch ? heroImgMatch[2] : '';

  // Body: from just after the hook paragraph to just before the generic CTA band.
  const bodyStart = hookBlock ? hookBlock.end : (metaBlock ? metaBlock.end : null);
  const ctaIdx = html.indexOf('<div class="bl-cta-band', bodyStart || 0);
  if (bodyStart == null || ctaIdx === -1) warnings.push('could not locate body start/end markers — body may be incomplete');
  let bodyEnRaw = bodyStart != null && ctaIdx !== -1 ? html.slice(bodyStart, ctaIdx) : '';
  // The "close" paragraph (e.g. "The best bar in Rotterdam is the next one
  // on your route.") sits AFTER the CTA band in some posts — append it back
  // if present, so it isn't silently dropped.
  const closeMatch = /<article class="bl-post wg-reveal">\s*<p data-i18n="post_close">([\s\S]*?)<\/p>\s*<\/article>/.exec(html);
  if (closeMatch) bodyEnRaw += `<article class="bl-post wg-reveal"><p data-i18n="post_close">${closeMatch[1]}</p></article>`;

  bodyEnRaw = convertImageBlocks(bodyEnRaw);
  // Drop the width/height/loading/decoding/fetchpriority noise the sanitizer
  // would strip anyway — purely cosmetic, makes the stored HTML cleaner.
  bodyEnRaw = bodyEnRaw.replace(/\s+(width|height|loading|decoding|fetchpriority)="[^"]*"/g, '');

  const nl = extractNlDict(html);
  const nlFallbackKeys = [];
  const bodyNlRaw = buildNlBody(bodyEnRaw, nl, nlFallbackKeys);

  const titleNl = nl.crumb_post || nl.hero_h1 || titleEn;
  const excerptNl = nl.post_hook || excerptEn;

  if (nlFallbackKeys.length) {
    warnings.push(`${nlFallbackKeys.length} body element(s) kept their English text in the Dutch version (no matching/parseable NL key): ${nlFallbackKeys.join(', ')}`);
  }

  return {
    slug,
    category,
    title_en: titleEn,
    title_nl: titleNl,
    excerpt_en: excerptEn,
    excerpt_nl: excerptNl,
    body_en: bodyEnRaw.trim(),
    body_nl: bodyNlRaw.trim(),
    seo_title_en: titleEn,
    seo_description_en: seoDescriptionEn,
    cover_image_path: coverPath,
    cover_alt_en: coverAltEn,
    cover_alt_nl: coverAltEn, // no distinct NL alt exists in the legacy pages either — see module doc comment
    read_minutes: readMinutes,
    published_at: publishedAt,
    old_wix_slug: oldWixSlug,
    warnings,
  };
}

async function apiCall(path, body, cookie) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin', Cookie: cookie },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${json ? json.message : ''}`);
  return json;
}

async function login() {
  const res = await fetch(`${BASE_URL}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login succeeded but no Set-Cookie header was returned');
  return setCookie.split(';')[0];
}

async function main() {
  const commitSha = currentGitCommit();
  const entries = readdirSync(blogDir).filter((name) => {
    if (name === '_template' || name === 'index.html') return false;
    return statSync(join(blogDir, name)).isDirectory();
  });

  let cookie = args.cookie || null;
  if (!DRY_RUN && !cookie) {
    if (!BASE_URL || !ADMIN_TOKEN) {
      console.error('Need --base-url=<worker url> and --admin-token=<ADMIN_TOKEN> (or --cookie=<session cookie>, or --dry-run to just preview parsing).');
      process.exitCode = 1;
      return;
    }
    cookie = await login();
  }

  const results = [];
  for (const slug of entries) {
    const filePath = join(blogDir, slug, 'index.html');
    const html = readFileSync(filePath, 'utf8');
    const parsed = parsePost(slug, html);
    const isDuplicate = DUPLICATE_SLUGS_AS_DRAFT.has(slug);
    const status = isDuplicate ? 'draft' : 'published';

    console.log(`\n=== ${slug} ===`);
    console.log(`  title_en: ${parsed.title_en}`);
    console.log(`  category: ${parsed.category} · read_minutes: ${parsed.read_minutes} · status: ${status}`);
    console.log(`  cover: ${parsed.cover_image_path}`);
    console.log(`  body_en length: ${parsed.body_en.length} chars, body_nl length: ${parsed.body_nl.length} chars`);
    if (isDuplicate) console.log('  NOTE: known duplicate of utrecht-night-out-cocktails (flagged in its own file) — importing as DRAFT, not published.');
    for (const w of parsed.warnings) console.log(`  WARNING: ${w}`);

    if (DRY_RUN) { results.push({ slug, status, warnings: parsed.warnings }); continue; }

    try {
      const data = await apiCall('/admin/api/blog', {
        slug: parsed.slug,
        category: parsed.category,
        title_en: parsed.title_en,
        title_nl: parsed.title_nl,
        excerpt_en: parsed.excerpt_en,
        excerpt_nl: parsed.excerpt_nl,
        body_en: parsed.body_en,
        body_nl: parsed.body_nl,
        seo_title_en: parsed.seo_title_en,
        seo_description_en: parsed.seo_description_en,
        cover_alt_en: parsed.cover_alt_en,
        cover_alt_nl: parsed.cover_alt_nl,
        read_minutes: parsed.read_minutes,
        status,
        published_at: parsed.published_at,
        last_published_commit: status === 'published' ? commitSha : null,
        old_wix_slug: parsed.old_wix_slug,
      }, cookie);
      // cover_image_path isn't on the create payload's validated-field list
      // (see admin_api.js:validateBlogFields) — set it with a follow-up PUT,
      // same two-step shape the dashboard's own cover-upload flow uses.
      if (parsed.cover_image_path) {
        await fetch(`${BASE_URL}/admin/api/blog/${data.post.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin', Cookie: cookie },
          body: JSON.stringify({ cover_image_path: parsed.cover_image_path }),
        });
      }
      console.log(`  -> imported as ${data.post.id}`);
      results.push({ slug, id: data.post.id, status, warnings: parsed.warnings });
    } catch (err) {
      console.error(`  -> FAILED: ${err.message}`);
      results.push({ slug, error: err.message });
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.slug}: ${r.error ? 'FAILED — ' + r.error : (r.id || '(dry run)') + ' (' + r.status + ')'}${r.warnings && r.warnings.length ? ' — ' + r.warnings.length + ' warning(s)' : ''}`);
  }
}

// Guarded so this module can also be `import`ed (e.g. for inspection/tests)
// without immediately running main() against the real filesystem/network.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
