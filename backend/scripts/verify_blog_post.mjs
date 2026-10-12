/* ==========================================================================
   backend/scripts/verify_blog_post.mjs — the same checks the site-wide
   pages are held to, run against a rendered blog post (BUILD §21.3).

   Renders ONE sample post through src/blog_render.js + the real template
   (or, with --slug=<slug>, a post read from a fixture JSON file passed via
   --fixture=<path>), opens it in headless Chrome via puppeteer-core, and
   checks:
     1. No inline-script parse/runtime errors (pageerror + console 'error').
     2. The shared NAV/FOOTER/CONSENT/ANALYTICS blocks are byte-identical to
        an existing, real blog post at the SAME folder depth and page TYPE
        (blog/utrecht-night-out-cocktails/index.html) — route pages were
        tried first and rejected as the reference: their nav CTA target
        legitimately differs by page type (route pages link their own
        in-page #routes anchor; content/blog pages link the homepage's
        #cities), so hashing against one would never pass. Within one page
        TYPE, the blocks ARE byte-identical — confirmed against two
        existing posts before picking this rule.
     3. No horizontal overflow at 390px (mobile) and 1440px (desktop).

   Usage (from backend/):
     node scripts/verify_blog_post.mjs
     node scripts/verify_blog_post.mjs --fixture=/path/to/post.json
   Exits non-zero on any failure.
   ========================================================================== */
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { renderPostPage } from '../src/blog_render.js';
import { SITE_NOINDEX } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, '..');
const repoRoot = join(backend, '..');

// split on the FIRST '=' only (a path can legitimately contain '=' — not
// common, but splitting without a limit would silently truncate it).
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const bare = a.replace(/^--/, '');
    const eq = bare.indexOf('=');
    return eq === -1 ? [bare, true] : [bare.slice(0, eq), bare.slice(eq + 1)];
  })
);

const SAMPLE_POST = {
  id: 'blogpost_verify',
  slug: 'verify-sample-post',
  category: 'City guide',
  title_en: 'Verification Sample Post',
  title_nl: 'Verificatie voorbeeldpost',
  excerpt_en: 'A sample excerpt used only to verify the renderer and the shared page chrome.',
  excerpt_nl: 'Een voorbeeldtekst, alleen gebruikt om de renderer en de gedeelde pagina-opmaak te controleren.',
  body_en: '<p>Sample English body.</p><h2>A heading</h2><p>More text with a <a href="https://www.wogococktailwalk.com/rotterdam/" rel="noopener">link</a>.</p>',
  body_nl: '<p>Voorbeeld Nederlandse tekst.</p>',
  cover_image_path: 'how-it-works/how-it-works-hero.jpg',
  cover_alt_en: 'Friends on a cocktail walk',
  cover_alt_nl: 'Vrienden op een cocktailwandeling',
  read_minutes: 4,
  published_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-01 10:00:00',
  created_at: '2026-10-01 10:00:00',
};

async function main() {
  const failures = [];

  const post = args.fixture ? JSON.parse(readFileSync(args.fixture, 'utf8')) : SAMPLE_POST;
  const template = readFileSync(join(repoRoot, 'blog', '_template', 'post.html'), 'utf8');
  const html = renderPostPage(template, post, { siteNoindex: SITE_NOINDEX, preview: false });

  // ---- Check: no leftover template tokens -------------------------------
  if (/\{\{[A-Z0-9_]+\}\}/.test(html)) failures.push('rendered HTML still contains an unfilled {{TOKEN}}');

  // ---- Check: shared-block hash against a real reference post -----------
  const REFERENCE_PATH = join(repoRoot, 'blog', 'utrecht-night-out-cocktails', 'index.html');
  const reference = readFileSync(REFERENCE_PATH, 'utf8');
  const BLOCKS = [
    ['NAV', '<!-- ===== WOGO SHARED NAV v4', '<!-- ===== /WOGO SHARED NAV v4 ===== -->'],
    ['FOOTER', '<!-- ===== WOGO SHARED FOOTER v4', '<!-- ===== /WOGO SHARED FOOTER v4 ===== -->'],
    ['CONSENT', 'WOGO COOKIE CONSENT v1  —  BEGIN', 'WOGO COOKIE CONSENT v1  —  END  (copy to here)  ▲▲▲\n     ============================================================================ -->'],
    ['ANALYTICS', 'WOGO ANALYTICS v1  —  BEGIN', 'WOGO ANALYTICS v1  —  END  (copy to here)  ▲▲▲\n     ============================================================================ -->'],
  ];
  function extractBlock(source, start, end) {
    const i = source.indexOf(start);
    const j = source.indexOf(end, i);
    if (i === -1 || j === -1) return null;
    return source.slice(i, j + end.length);
  }
  function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }
  for (const [name, start, end] of BLOCKS) {
    const ours = extractBlock(html, start, end);
    const theirs = extractBlock(reference, start, end);
    if (!ours || !theirs) { failures.push(`${name} block not found (rendered: ${!!ours}, reference: ${!!theirs})`); continue; }
    if (sha256(ours) !== sha256(theirs)) failures.push(`${name} block hash differs from the reference page (${REFERENCE_PATH})`);
  }

  // ---- Check: valid JSON-LD --------------------------------------------
  const ldMatches = [...html.matchAll(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g)];
  if (ldMatches.length !== 2) failures.push(`expected 2 JSON-LD blocks, found ${ldMatches.length}`);
  for (const m of ldMatches) {
    try { JSON.parse(m[1]); } catch (err) { failures.push(`invalid JSON-LD: ${err.message}`); }
  }

  // ---- Puppeteer: console/page errors + overflow at 390/1440 ------------
  const tmpDir = mkdtempSync(join(tmpdir(), 'wogo-blog-verify-'));
  const tmpFile = join(tmpDir, 'index.html');
  writeFileSync(tmpFile, html);

  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer-core'));
  } catch {
    console.warn('puppeteer-core not available in this environment — skipping the browser checks (template/JSON-LD/hash checks above still ran).');
    report(failures);
    return;
  }

  const executablePath = args.chrome || findChrome();
  if (!executablePath) {
    console.warn('No Chrome executable found — skipping the browser checks.');
    report(failures);
    return;
  }

  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`); });

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewport(viewport);
      await page.goto(`file://${tmpFile}`, { waitUntil: 'networkidle0', timeout: 15000 });
      await new Promise((r) => setTimeout(r, 300)); // let the reveal/entrance scripts settle
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      if (overflow) failures.push(`horizontal overflow at ${viewport.width}px wide`);
    }
    if (consoleErrors.length) failures.push(...consoleErrors.map((e) => `browser error: ${e}`));
  } finally {
    await browser.close();
  }

  report(failures);
}

/** Best-effort auto-detect of a cached "Google Chrome for Testing" binary
 * under ~/.cache/puppeteer (@puppeteer/browsers' default install location) —
 * version directory names change on update, so this walks the tree rather
 * than hardcoding one. Falls back to --chrome=<path> when nothing is found. */
function findChrome() {
  const root = join(process.env.HOME || '', '.cache', 'puppeteer', 'chrome');
  if (!existsSync(root)) return null;
  for (const versionDir of readdirSync(root)) {
    const platformDir = join(root, versionDir);
    let platforms;
    try { platforms = readdirSync(platformDir); } catch { continue; }
    for (const p of platforms) {
      const candidate = join(platformDir, p, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(candidate)) return candidate;
      const linuxCandidate = join(platformDir, p, 'chrome');
      if (existsSync(linuxCandidate)) return linuxCandidate;
    }
  }
  return null;
}

function report(failures) {
  if (failures.length) {
    console.error(`FAILED (${failures.length}):`);
    for (const f of failures) console.error(' - ' + f);
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
