#!/usr/bin/env node
/* =============================================================================
   build-nl.js — makes the Dutch copy of the website.

   WHAT IT DOES (plain language)
   The site is written in English. Every page carries its own Dutch wording in a
   small dictionary at the foot of the file. This script takes each English page
   and writes a finished Dutch page next to it, under /nl/ — same address with
   /nl/ in front (so /faq/ becomes /nl/faq/). Search engines and AI assistants
   can then read the Dutch text directly, without running any script.

   HOW TO USE IT
     After ANY change to an English page (or to tools/nl-strings.json):

         node tools/build-nl.js            <- rewrites the Dutch pages

     Before you publish, to be sure nothing was forgotten:

         node tools/build-nl.js --check    <- changes nothing; says "OK" or lists
                                              what is out of date (and fails)

     Then commit everything it changed (the nl/ folder, sitemap.xml, the small
     marked blocks in the English pages and redirects-worker/worker.js).

   WHERE THE DUTCH WORDS COME FROM
     1. The Dutch dictionary inside each page (var NL = {...}) — body text.
     2. tools/nl-strings.json — the few texts that have no dictionary entry:
        page titles, descriptions for Google/social, picture descriptions and
        the hidden "structured data". If you change one of those in English, the
        script stops and tells you which Dutch line to add to that file.

   TWO SAFETY STOPS (the script refuses to continue and tells you what to fix)
     - an English title / description / picture text without a Dutch line;
     - a price (EUR amount) that is different in the English text and its Dutch
       line. Note: it cannot judge wording. If you reword an English sentence,
       remember to reword its Dutch line in the same page too.

   THE BLOG
     Blog posts are written by the dashboard (the Worker, backend/src/blog_render.js),
     not by this script. What this script makes for the blog are the four page
     TEMPLATES the Worker fills in, in blog/_template/generated/:
       post.en.html / index.en.html   English (one language only, real language-menu links)
       post.nl.html / index.nl.html   Dutch (same chrome as the Dutch site pages)
     They are built from the hand-edited blog/_template/post.html and index.html
     with the SAME Dutch dictionary and nav/footer wording as every other page.
     After this script, run in backend/:  node scripts/build_blog_templates.mjs
     The finished Dutch posts (nl/blog/...) are committed by the Worker on publish;
     this script leaves them alone, except that it writes the list of them into
     redirects-worker/worker.js (the "nl-blog" block) and checks their sitemap lines.

   WHAT IT NEVER TOUCHES
     London, admin and the thank-you pages. Those stay English-address-only for now.

   OTHER OPTIONS
     --todo     list English texts that still miss a Dutch line in nl-strings.json
     --report   list page text that has no dictionary key at all (stays English)

   No installs needed: plain Node, no packages.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://www.wogococktailwalk.com';
const ARGS = new Set(process.argv.slice(2));
const CHECK = ARGS.has('--check');
const TODO = ARGS.has('--todo');
const REPORT = ARGS.has('--report');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ---------- which pages get a Dutch twin: everything in sitemap.xml except the
   blog (written by the dashboard) and the Dutch pages themselves ---------- */
function listPages() {
  const locs = (read('sitemap.xml').match(/<loc>[^<]+<\/loc>/g) || []).map((s) => s.slice(5, -6).trim());
  const out = [];
  for (const loc of locs) {
    if (!loc.startsWith(ORIGIN + '/')) throw new Error('sitemap.xml: unexpected address ' + loc);
    const p = loc.slice(ORIGIN.length + 1);            // '' for the homepage, else 'faq/'
    if (p.startsWith('nl/') || p === 'blog/' || p.startsWith('blog/')) continue;
    if (p && !p.endsWith('/')) throw new Error('sitemap.xml: address without trailing slash ' + loc);
    if (!exists(p + 'index.html')) throw new Error('sitemap.xml lists ' + loc + ' but ' + p + 'index.html does not exist');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/* ---------- tiny HTML reader (no packages): splits a page into tags, text,
   comments and raw blocks (script/style), remembering where each one sits so
   we can change exactly one spot without disturbing anything else ---------- */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea']);
function tokenize(html) {
  const out = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out.push({ t: 'text', s: i, e: n }); break; }
    if (lt > i) out.push({ t: 'text', s: i, e: lt });
    if (html.startsWith('<!--', lt)) {
      const c = html.indexOf('-->', lt + 4);
      const end = c === -1 ? n : c + 3;
      out.push({ t: 'comment', s: lt, e: end }); i = end; continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const c = html.indexOf('>', lt);
      const end = c === -1 ? n : c + 1;
      out.push({ t: 'decl', s: lt, e: end }); i = end; continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 80));
    if (!m) { out.push({ t: 'text', s: lt, e: lt + 1 }); i = lt + 1; continue; }
    let j = lt + m[0].length;
    const attrs = [];
    let selfClose = false;
    while (j < n) {
      while (j < n && /\s/.test(html[j])) j++;
      if (j >= n) break;
      if (html[j] === '>') { j++; break; }
      if (html[j] === '/') { selfClose = true; j++; continue; }
      selfClose = false;
      const ns = j;
      while (j < n && !/[\s=>]/.test(html[j]) && !(html[j] === '/' && html[j + 1] === '>')) j++;
      const name = html.slice(ns, j).toLowerCase();
      let k = j;
      while (k < n && /\s/.test(html[k])) k++;
      const a = { name, as: ns, ae: j, vs: -1, ve: -1, quote: '', value: null };
      if (html[k] === '=') {
        k++;
        while (k < n && /\s/.test(html[k])) k++;
        if (html[k] === '"' || html[k] === "'") {
          a.quote = html[k];
          a.vs = k + 1;
          a.ve = html.indexOf(a.quote, a.vs);
          if (a.ve === -1) a.ve = n;
          j = Math.min(n, a.ve + 1);
        } else {
          a.vs = k;
          while (k < n && !/[\s>]/.test(html[k])) k++;
          a.ve = k; j = k;
        }
        a.value = html.slice(a.vs, a.ve);
        a.ae = j;
      }
      attrs.push(a);
    }
    const name = m[2].toLowerCase();
    const tok = { t: 'tag', name, close: !!m[1], s: lt, e: j, attrs, selfClose };
    out.push(tok);
    i = j;
    if (!tok.close && RAW.has(name)) {
      const re = new RegExp('</' + name + '\\b', 'i');
      const rest = html.slice(j);
      const c = rest.search(re);
      const end = c === -1 ? n : j + c;
      out.push({ t: 'raw', name, s: j, e: end, open: tok });
      i = end;
    }
  }
  return out;
}
const attr = (tok, name) => { const a = tok.attrs.find((x) => x.name === name); return a ? a : null; };
const attrVal = (tok, name) => { const a = attr(tok, name); return a && a.value != null ? a.value : null; };
/* index of the token that closes the element opened at tokens[k] (-1 = none) */
function closeIndex(tokens, k) {
  const open = tokens[k];
  if (VOID.has(open.name) || open.selfClose) return -1;
  let depth = 0;
  for (let i = k + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t !== 'tag' || t.name !== open.name) continue;
    if (t.close) { if (depth === 0) return i; depth--; } else if (!t.selfClose) depth++;
  }
  return -1;
}
function applyEdits(src, edits) {
  edits.sort((a, b) => a.s - b.s || a.e - b.e);
  let out = '';
  let at = 0;
  for (const ed of edits) {
    if (ed.s < at) throw new Error('internal: overlapping edits at ' + ed.s);
    out += src.slice(at, ed.s) + ed.v;
    at = ed.e;
  }
  return out + src.slice(at);
}

/* ---------- text helpers ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', rarr: '→', larr: '←', euro: '€', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', times: '×', star: '☆', copy: '©', eacute: 'é', euml: 'ë', iuml: 'ï', ouml: 'ö' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, c) => {
    if (c[0] === '#') return String.fromCodePoint(c[1].toLowerCase() === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENT, c) ? ENT[c] : m;
  });
}
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* visible text of a piece of HTML: tags dropped, entities decoded, spaces tidied */
function plain(htmlPiece) {
  return decodeEntities(String(htmlPiece).replace(/<br\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/[\s ]+/g, ' ').trim();
}
const norm = (s) => plain(s).replace(/[’‘]/g, "'").replace(/[“”]/g, '"').toLowerCase();

/* ---------- read a JavaScript object literal out of a page (the dictionaries) ---------- */
function extractObject(src, marker, from) {
  const at = src.indexOf(marker, from || 0);
  if (at === -1) return null;
  const start = src.indexOf('{', at + marker.length - 1);
  let i = start;
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; }
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      if (i === 0) throw new Error('unterminated comment in dictionary');
    } else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { start, end: i + 1, text: src.slice(start, i + 1) }; }
    i++;
  }
  throw new Error('could not read the object after "' + marker + '"');
}
function evalObject(found, what, page) {
  if (!found) throw new Error((page || '/') + ': could not find ' + what);
  try { return vm.runInNewContext('(' + found.text + ')', Object.create(null), { timeout: 2000 }); }
  catch (e) { throw new Error((page || '/') + ': could not read ' + what + ' — ' + e.message); }
}
function dictionaries(html, page) {
  const NL = evalObject(extractObject(html, 'var NL = {'), 'the Dutch dictionary (var NL = {...})', page);
  const nlAt = html.indexOf('Newsletter sign-up behaviour');
  const ccAt = html.indexOf('WOGO COOKIE CONSENT');
  const T = nlAt === -1 ? null : evalObject(extractObject(html, 'var T = {', nlAt), 'the newsletter texts (var T = {...})', page);
  const I18N = ccAt === -1 ? null : evalObject(extractObject(html, 'var I18N = {', ccAt), 'the cookie banner texts (var I18N = {...})', page);
  return { NL, newsletter: (T && T.nl) || {}, consent: (I18N && I18N.nl) || {} };
}

/* ---------- hand-written Dutch for texts that have no dictionary entry ---------- */
const STRINGS = JSON.parse(read('tools/nl-strings.json'));
const MANUAL = STRINGS.translate || {};
const SAME = new Set(STRINGS.same || []);
const missing = new Map();          // English text -> where it was seen
const usedManual = new Set();
function makeTranslator(page, enToNl) {
  return function tr(en, where) {
    if (en == null) return en;
    const key = String(en);
    if (!/[A-Za-zÀ-ÿ]/.test(key)) return key;                 // nothing to translate (symbols, numbers)
    if (/\{\{[A-Z0-9_]+\}\}/.test(key)) return key;           // blog template placeholder: filled in by the Worker
    const hit = enToNl.get(norm(key));                        // the page's own dictionary wins
    if (hit != null) return hit;
    if (Object.prototype.hasOwnProperty.call(MANUAL, key)) { usedManual.add(key); return MANUAL[key]; }
    if (SAME.has(key)) { usedManual.add(key); return key; }
    if (!missing.has(key)) missing.set(key, []);
    missing.get(key).push((page || '/') + ' · ' + where);
    return key;
  };
}

/* ---------- addresses ---------- */
let PAGES = [];
let PAGESET = new Set();
/* The blog index also exists in both languages (/blog/ and /nl/blog/), but it is
   written by the Worker, so it is not in PAGES. Links to it follow the language. */
const TWIN_EXTRA = new Set(['blog/']);
/* A blog article that the Worker has also published in Dutch (nl/blog/<slug>/): a link
   to it on a Dutch page goes to the Dutch article. Articles without a Dutch version
   keep pointing at the English one. (Only used for links; not part of NL_PAGES.) */
let NL_BLOG_TWINS = null;
const isNlBlogTwin = (p) => {
  if (!NL_BLOG_TWINS) NL_BLOG_TWINS = new Set(nlBlogSlugs().map((slug) => 'blog/' + slug + '/'));
  return NL_BLOG_TWINS.has(p);
};
const isTwinPath = (pathname) => {
  let p = pathname.replace(/index\.html$/, '');
  if (!p.endsWith('/')) p += '/';
  return PAGESET.has(p.slice(1)) || TWIN_EXTRA.has(p.slice(1)) || isNlBlogTwin(p.slice(1));
};
const depthOf = (page) => page.split('/').filter(Boolean).length;
/* A link written on English page `page`, as it must read on that page's Dutch twin
   (which sits one folder deeper). Links to pages that exist in Dutch stay as they
   are — the same relative link then lands on the Dutch twin. Everything else
   (pictures, video, the booking widget, the blog) gets pointed back at the one
   shared copy in the site root. */
function nlUrl(raw, page) {
  const t = raw.trim();
  if (t.includes('{{')) return raw;                           // blog template placeholder
  if (!t || t[0] === '#' || t.startsWith('//') || /^(data|mailto|tel|javascript|sms|whatsapp|blob|about):/i.test(t)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    if (!t.startsWith(ORIGIN + '/')) return raw;
    const u = new URL(t);
    if (u.pathname.startsWith('/nl/') || !isTwinPath(u.pathname) || !u.pathname.endsWith('/')) return raw;
    return raw.replace(t, ORIGIN + '/nl' + u.pathname + u.search + u.hash);
  }
  const base = 'https://x.invalid/' + page;
  let u;
  try { u = new URL(t, base); } catch (e) { return raw; }
  if (u.origin !== 'https://x.invalid') return raw;
  if (isTwinPath(u.pathname) && (u.pathname.endsWith('/') || u.pathname.endsWith('/index.html'))) {
    return t[0] === '/' ? raw.replace(t, '/nl' + t) : raw;
  }
  if (t[0] === '/') return raw;                               // root-absolute, already right
  const fixed = '../'.repeat(depthOf(page) + 1) + decodeURI(u.pathname.slice(1)) + u.search + u.hash;
  return raw.replace(t, fixed);
}
const URL_ATTRS = new Set(['href', 'src', 'poster', 'action', 'xlink:href', 'formaction']);
const cssUrls = (css, page) => css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (m, q, u) => 'url(' + q + nlUrl(u, page) + q + ')');
function srcsetUrls(v, page) {
  return v.split(',').map((part) => {
    const m = /^(\s*)(\S+)(.*)$/s.exec(part);
    return m ? m[1] + nlUrl(m[2], page) + m[3] : part;
  }).join(',');
}


/* =============================================================================
   The generated blocks. They are fenced with marker comments so the script can
   find and refresh them; never edit between the markers by hand.
   ========================================================================== */
const M_ALT = ['<!-- i18n-alt:start (made by tools/build-nl.js; do not edit) -->', '<!-- i18n-alt:end -->'];
const M_SW = ['<!-- i18n-switch:start (made by tools/build-nl.js; do not edit) -->', '<!-- i18n-switch:end -->'];
const MENU_RE = /(<ul class="w-lang-menu" role="listbox" aria-label=")([^"]*)(">)([\s\S]*?)(<\/ul>)/;
const LANG_LABEL = { en: 'English', nl: 'Nederlands' };

const enAbs = (page) => ORIGIN + '/' + page;
const nlAbs = (page) => ORIGIN + '/nl/' + page;
/* the same page in the other language, as a relative link from `here` */
function altHrefs(page, here, opts) {
  const d = depthOf(page);
  if (here === 'en') return { en: './', nl: (opts && opts.nlHref) || '../'.repeat(d) + 'nl/' + page };
  return { en: '../'.repeat(d + 1) + page, nl: './' };
}
function altBlock(page, opts) {
  if (opts && opts.altToken) return M_ALT[0] + '\n' + opts.altToken + '\n' + M_ALT[1];
  return M_ALT[0] + '\n' +
    '<link rel="alternate" hreflang="en" href="' + enAbs(page) + '">\n' +
    '<link rel="alternate" hreflang="nl" href="' + nlAbs(page) + '">\n' +
    '<link rel="alternate" hreflang="x-default" href="' + enAbs(page) + '">\n' +
    M_ALT[1];
}
function menuItems(page, here, opts) {
  const alt = altHrefs(page, here, opts);
  return ['en', 'nl'].map((l) =>
    '<li role="presentation"><a class="w-lang-opt" role="option" tabindex="-1" data-lang="' + l + '" hreflang="' + l + '" lang="' + l + '" href="' + alt[l] + '" aria-selected="' + (l === here) + '"><span class="w-lang-opt-code" aria-hidden="true">' + l.toUpperCase() + '</span>' + LANG_LABEL[l] + '</a></li>'
  ).join('');
}
/* The little script that turns the language menu into real links, and keeps a
   Dutch reader on Dutch addresses. Same code on every page; only the first
   lines (which page am I, where is my twin) differ. */
function switchBlock(page, here, opts) {
  const alt = altHrefs(page, here, opts);
  const toRoot = '../'.repeat(depthOf(page)) || './';
  const cfg = here === 'en'
    ? 'var HERE = "en", ALT = ' + JSON.stringify(alt) + ', TO_ROOT = ' + JSON.stringify(toRoot) + ',\n      NL_PAGES = ' + JSON.stringify(PAGES.concat([...TWIN_EXTRA])) + ';'
    : 'var HERE = "nl", ALT = ' + JSON.stringify(alt) + ', TO_ROOT = "", NL_PAGES = [];';
  return M_SW[0] + `
<style>.w-lang-menu li{list-style:none;margin:0;padding:0}.w-lang-menu a.w-lang-opt{color:var(--wogo-ink);text-decoration:none}</style>
<script>
/* Language menu = real links between the English and the Dutch address of this
   page (/faq/ <-> /nl/faq/). The choice is remembered (localStorage "wogoLang",
   as before). Nothing here ever redirects on its own: a page only changes
   address when the visitor clicks. */
(function () {
  "use strict";
  ${cfg}
  var LABEL = { en: "English", nl: "Nederlands" };
  function remember(l) { try { localStorage.setItem("wogoLang", l); } catch (e) {} }
  function shown() { return (document.documentElement.lang || "en").toLowerCase().indexOf("nl") === 0 ? "nl" : "en"; }
  Array.prototype.forEach.call(document.querySelectorAll(".w-lang"), function (w) {
    var btn = w.querySelector(".w-lang-btn"), menu = w.querySelector(".w-lang-menu");
    if (!btn || !menu) return;
    var now = shown();
    menu.innerHTML = ["en", "nl"].map(function (l) {
      return '<li role="presentation"><a class="w-lang-opt" role="option" tabindex="-1" data-lang="' + l + '" hreflang="' + l + '" lang="' + l + '" href="' + ALT[l] + '" aria-selected="' + (l === now) + '"><span class="w-lang-opt-code" aria-hidden="true">' + l.toUpperCase() + '</span>' + LABEL[l] + '</a></li>';
    }).join("");
    var opts = Array.prototype.slice.call(menu.querySelectorAll(".w-lang-opt"));
    function close(refocus) { w.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); if (refocus) { try { btn.focus(); } catch (e) {} } }
    opts.forEach(function (o, i) {
      o.addEventListener("click", function (e) {
        var l = o.getAttribute("data-lang");
        remember(l);
        if (l === HERE) {
          /* Already on this language's address. Only an English address that is
             being shown in Dutch (browser language) needs a fresh load. */
          e.preventDefault();
          if (shown() !== l) { window.location.reload(); } else { close(true); }
          return;
        }
        /* Go to the twin page, keeping the campaign tags and the place on the page. */
        try {
          var u = new URL(o.href, window.location.href);
          new URLSearchParams(window.location.search).forEach(function (v, k) { if (!u.searchParams.has(k)) u.searchParams.set(k, v); });
          if (window.location.hash && !u.hash) u.hash = window.location.hash;
          o.href = u.toString();
        } catch (err) {}
      });
      o.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") { e.preventDefault(); (opts[i + 1] || opts[0]).focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); (opts[i - 1] || opts[opts.length - 1]).focus(); }
        else if (e.key === "Home") { e.preventDefault(); opts[0].focus(); }
        else if (e.key === "End") { e.preventDefault(); opts[opts.length - 1].focus(); }
        else if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); o.click(); }
        else if (e.key === "Escape") { e.preventDefault(); close(true); }
      });
    });
  });
  /* An English address can still be SHOWN in Dutch (Dutch browser, or Dutch
     chosen earlier). From there, every link to a page that exists in Dutch
     goes to the Dutch address, so the visitor continues on real Dutch pages. */
  if (HERE === "en") {
    var root = new URL(TO_ROOT, window.location.href).pathname;
    document.addEventListener("click", function (ev) {
      try {
        if (shown() !== "nl" || ev.defaultPrevented) return;
        var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
        if (!a || a.classList.contains("w-lang-opt") || a.hasAttribute("download")) return;
        var raw = a.getAttribute("href") || "";
        if (!raw || raw.charAt(0) === "#" || /^(mailto:|tel:|javascript:)/i.test(raw)) return;
        var u = new URL(a.href, window.location.href);
        if (u.origin !== window.location.origin || u.pathname === window.location.pathname) return;
        if (u.pathname.indexOf(root) !== 0) return;
        var rel = u.pathname.slice(root.length).replace(/index\\.html$/, "");
        if (NL_PAGES.indexOf(rel) === -1) return;
        u.pathname = root + "nl/" + rel;
        a.href = u.toString();
      } catch (e) {}
    }, true);
  }
})();
</script>
` + M_SW[1];
}

/* remove every generated block, giving back the hand-written page */
function stripGenerated(html) {
  const cut = (s, [a, b]) => {
    for (;;) {
      const i = s.indexOf(a);
      if (i === -1) return s;
      const j = s.indexOf(b, i);
      if (j === -1) throw new Error('generated block start without end marker');
      let end = j + b.length;
      if (s[end] === '\n') end++;
      s = s.slice(0, i) + s.slice(end);
    }
  };
  let out = cut(cut(html, M_ALT), M_SW);
  out = out.replace(MENU_RE, (m, a, label, c, inner, e) => a + label + c + e);
  return out;
}
/* add the generated blocks for one language version of a page */
function decorate(html, page, here, opts) {
  let out = html;
  const canon = /<link rel="canonical" href="[^"]*">\n?/.exec(out);
  if (!canon) throw new Error((page || '/') + ': no canonical link found');
  const at = canon.index + canon[0].length;
  out = out.slice(0, at) + (canon[0].endsWith('\n') ? '' : '\n') + altBlock(page, opts) + '\n' + out.slice(at);
  if (!MENU_RE.test(out)) throw new Error((page || '/') + ': language menu (<ul class="w-lang-menu">) not found');
  out = out.replace(MENU_RE, (m, a, label, c, inner, e) => a + label + c + menuItems(page, here, opts) + e);
  const body = out.lastIndexOf('</body>');
  if (body === -1) throw new Error((page || '/') + ': no </body>');
  out = out.slice(0, body) + switchBlock(page, here, opts) + '\n' + out.slice(body);
  return out;
}

/* =============================================================================
   English page -> Dutch page
   ========================================================================== */
const LD_TEXT = new Set(['name', 'description', 'text', 'headline', 'alternateName', 'alternativeHeadline', 'caption', 'slogan', 'disambiguatingDescription', 'abstract']);
const LD_URL = new Set(['url', 'item', '@id', 'mainEntityOfPage']);
const LD_KEEP_URL_TYPES = new Set(['Organization', 'WebSite', 'Brand', 'Person', 'ImageObject']);   // the company itself: one address, not per language
const LD_LANG_TYPES = new Set(['WebPage', 'FAQPage', 'AboutPage', 'ContactPage', 'CollectionPage', 'ItemPage', 'CheckoutPage', 'ProfilePage', 'QAPage', 'Article', 'BlogPosting', 'NewsArticle', 'HowTo', 'CreativeWork']);
function nlAbsUrl(v) {
  if (typeof v !== 'string' || !v.startsWith(ORIGIN + '/')) return v;
  let u;
  try { u = new URL(v); } catch (e) { return v; }
  if (u.pathname.startsWith('/nl/') || /\.[a-z0-9]{2,5}$/i.test(u.pathname) || !isTwinPath(u.pathname)) return v;
  return ORIGIN + '/nl' + u.pathname + (u.pathname.endsWith('/') ? '' : '/') + u.search + u.hash;
}
function ldWalk(node, tr, keepUrl, top) {
  if (Array.isArray(node)) return node.map((n) => ldWalk(n, tr, keepUrl, top));
  if (!node || typeof node !== 'object') return node;
  const types = [].concat(node['@type'] || []);
  const keep = keepUrl || types.some((t) => LD_KEEP_URL_TYPES.has(t));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'inLanguage') continue;
    if (k === '@graph') { out[k] = ldWalk(v, tr, keep, true); continue; }
    if (typeof v === 'string') {
      if (LD_TEXT.has(k)) out[k] = tr(v, 'structured data "' + k + '"');
      else if (LD_URL.has(k) && !keep) out[k] = nlAbsUrl(v);
      else out[k] = v;
    } else out[k] = ldWalk(v, tr, keep, false);
    if (k === '@type' && top && types.some((t) => LD_LANG_TYPES.has(t))) out.inLanguage = 'nl';
  }
  return out;
}
function ldToDutch(jsonText, tr, page) {
  if (jsonText.includes('{{')) return null;            // blog template placeholder: the Worker writes this block
  let data;
  try { data = JSON.parse(jsonText); } catch (e) { throw new Error((page || '/') + ': structured data is not valid JSON — ' + e.message); }
  const out = ldWalk(data, tr, false, true);
  return '\n' + JSON.stringify(out).replace(/<\//g, '<\\/') + '\n';
}

const PATCHES = [
  { what: 'the anti-flicker script in <head> (Dutch is already in the page, nothing to hide)', count: 1,
    re: /(?:<!-- Anti-flicker for Dutch visitors:(?:(?!-->)[\s\S])*-->\s*)?<script>\s*\(function\(\)\{try\{\s*var s=localStorage\.getItem\('wogoLang'\);[\s\S]*?<\/script>\n?/g,
    to: '' },
  { what: 'the start-up language choice (a Dutch address is always Dutch)', count: 1,
    re: /setLang\(saved \|\| \(auto \? 'nl' : 'en'\)\);/g,
    to: "setLang('nl');   /* Dutch address: always Dutch (made by tools/build-nl.js) */" },
  { what: 'the saved-language lookups in the newsletter and cookie blocks', count: 2,
    re: /try \{ var s = localStorage\.getItem\("wogoLang"\); if \(s === "nl" \|\| s === "en"\) return s; \} catch \(e\) \{\}\n?/g,
    to: '/* Dutch address: the page language decides (made by tools/build-nl.js) */\n' },
];

let SITE_NL = null;      // Dutch wording shared across pages, used when one page's own dictionary lacks a key
function buildSiteDict(sources) {
  const all = new Map();
  for (const { page, html } of sources) {
    const { NL } = dictionaries(html, page);
    for (const [k, v] of Object.entries(NL)) {
      if (typeof v !== 'string') continue;
      if (!all.has(k)) all.set(k, new Set());
      all.get(k).add(v);
    }
  }
  SITE_NL = {};
  for (const [k, set] of all) if (set.size === 1) SITE_NL[k] = [...set][0];
}

const reportLines = [];
const priceIssues = [];
const euros = (text) => (text.match(/€\s?\d+(?:[.,]\d{1,2})?/g) || []).map((x) => x.replace(/\s/g, '').replace('.', ',')).sort().join(' ');
function toDutch(base, page, opts) {
  opts = opts || {};
  const tag = page || '/';
  const dict = dictionaries(base, page);
  const borrowed = [];
  const NLGET = (k) => {
    if (dict.NL[k] != null) return dict.NL[k];
    if (opts.noBorrow && opts.noBorrow.has(k)) return null;
    if (SITE_NL && SITE_NL[k] != null) { borrowed.push(k); return SITE_NL[k]; }
    return null;
  };
  const HTML_SPECS = [
    { attr: 'data-i18n', get: NLGET, text: false },
    { attr: 'data-nl', get: (k) => dict.newsletter[k], text: false },
    { attr: 'data-cc', get: (k) => dict.consent[k], text: true },
  ];
  const ATTR_SPECS = [
    { attr: 'data-i18n-ph', get: NLGET, set: 'placeholder' },
    { attr: 'data-nl-ph', get: (k) => dict.newsletter[k], set: 'placeholder' },
    { attr: 'data-cc-aria', get: (k) => dict.consent[k], set: 'aria-label' },
  ];

  /* --- 1. what does each English phrase on this page read like in Dutch --- */
  let tokens = tokenize(base);
  const enToNl = new Map();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t !== 'tag' || t.close) continue;
    for (const spec of HTML_SPECS) {
      const key = attrVal(t, spec.attr);
      if (key == null) continue;
      const val = spec.get(key);
      const c = closeIndex(tokens, k);
      if (val == null || c === -1) continue;
      const enHtml = base.slice(t.e, tokens[c].s);
      const en = norm(enHtml);
      if (en && !enToNl.has(en)) enToNl.set(en, spec.text ? val : plain(val));
      /* price guard: the same euro amounts must appear in the English text and its Dutch line */
      if (euros(plain(enHtml)) !== euros(plain(val))) priceIssues.push(tag + ' · ' + spec.attr + '="' + key + '"\n      English: ' + plain(enHtml).slice(0, 160) + '\n      Dutch:   ' + plain(val).slice(0, 160));
    }
  }
  const tr = makeTranslator(page, enToNl);

  /* --- 2. body: put the Dutch wording into the page --- */
  const edits = [];
  const noKey = [];
  const setAttr = (t, name, value) => {
    const a = attr(t, name);
    if (a && a.vs !== -1) edits.push({ s: a.vs, e: a.ve, v: escAttr(value) });
    else if (a) edits.push({ s: a.as, e: a.ae, v: name + '="' + escAttr(value) + '"' });
    else { const end = t.selfClose ? base.lastIndexOf('/', t.e - 1) : t.e - 1; edits.push({ s: end, e: end, v: ' ' + name + '="' + escAttr(value) + '"' }); }
  };
  const untranslatedText = [];
  let inBody = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'text') {
      /* loose text without a dictionary key (e.g. "Skip to content"): Dutch from nl-strings.json if listed there */
      const rawText = base.slice(t.s, t.e);
      const core = rawText.trim();
      const en = decodeEntities(core);
      if (inBody && core && Object.prototype.hasOwnProperty.call(MANUAL, en)) {
        usedManual.add(en);
        const at = t.s + rawText.indexOf(core);
        edits.push({ s: at, e: at + core.length, v: escText(MANUAL[en]) });
      } else if (inBody && /[A-Za-z]{2}/.test(core)) untranslatedText.push(plain(core));
      continue;
    }
    if (t.t !== 'tag' || t.close) continue;
    if (t.name === 'body') inBody = true;
    if (t.name === 'title' || t.name === 'html' || t.name === 'head') continue;
    const done = new Set();
    for (const spec of ATTR_SPECS) {
      const key = attrVal(t, spec.attr);
      if (key == null) continue;
      const val = spec.get(key);
      if (val == null) { noKey.push(spec.attr + '=' + key); continue; }
      setAttr(t, spec.set, val); done.add(spec.set);
    }
    const cls = ' ' + (attrVal(t, 'class') || '') + ' ';
    if (cls.includes(' w-lang-btn ')) { setAttr(t, 'aria-label', 'Taal wijzigen: NL'); done.add('aria-label'); }
    for (const name of ['alt', 'aria-label', 'title', 'placeholder']) {
      if (done.has(name)) continue;
      const v = attrVal(t, name);
      if (v == null || !v.trim()) continue;
      const en = decodeEntities(v);
      const nl = tr(en, name + ' text');
      if (nl !== en) setAttr(t, name, nl);
    }
    if (cls.includes(' w-lang-code ')) {
      const c = closeIndex(tokens, k);
      if (c !== -1) { edits.push({ s: t.e, e: tokens[c].s, v: 'NL' }); k = c; continue; }
    }
    for (const spec of HTML_SPECS) {
      const key = attrVal(t, spec.attr);
      if (key == null) continue;
      const val = spec.get(key);
      if (val == null) { noKey.push(spec.attr + '=' + key); break; }
      const c = closeIndex(tokens, k);
      if (c === -1) throw new Error(tag + ': <' + t.name + ' ' + spec.attr + '="' + key + '"> is never closed');
      edits.push({ s: t.e, e: tokens[c].s, v: spec.text ? escText(val) : val });
      k = c;
      break;
    }
  }
  let out = applyEdits(base, edits);

  /* --- 3. head: language, title, descriptions, addresses, structured data --- */
  tokens = tokenize(out);
  const e2 = [];
  let sawLang = false, sawTitle = false, sawCanon = false, sawDesc = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t !== 'tag' || t.close) continue;
    if (t.name === 'body') break;
    const set = (name, value) => { const a = attr(t, name); if (!a || a.vs === -1) throw new Error(tag + ': <' + t.name + '> has no ' + name); e2.push({ s: a.vs, e: a.ve, v: escAttr(value) }); };
    if (t.name === 'html') { set('lang', 'nl'); sawLang = true; }
    else if (t.name === 'title') {
      const c = closeIndex(tokens, k);
      const en = decodeEntities(out.slice(t.e, tokens[c].s)).trim();
      e2.push({ s: t.e, e: tokens[c].s, v: escText(tr(en, 'page title')) }); sawTitle = true;
    } else if (t.name === 'link' && attrVal(t, 'rel') === 'canonical') { set('href', nlAbs(page)); sawCanon = true; }
    else if (t.name === 'meta') {
      const key = attrVal(t, 'property') || attrVal(t, 'name') || '';
      const content = attrVal(t, 'content');
      if (content == null) continue;
      if (key === 'og:url') set('content', nlAbs(page));
      else if (key === 'og:locale') set('content', 'nl_NL');
      else if (key === 'og:locale:alternate') set('content', 'en_US');
      else if (['description', 'og:title', 'og:description', 'twitter:title', 'twitter:description', 'og:image:alt', 'twitter:image:alt', 'og:site_name', 'application-name', 'apple-mobile-web-app-title'].includes(key)) {
        set('content', tr(decodeEntities(content), key === 'description' ? 'description for Google' : key));
        if (key === 'description') sawDesc = true;
      }
    } else if (t.name === 'script' && /ld\+json/i.test(attrVal(t, 'type') || '')) {
      const rawTok = tokens[k + 1];
      if (rawTok && rawTok.t === 'raw') { const ld = ldToDutch(out.slice(rawTok.s, rawTok.e), tr, page); if (ld != null) e2.push({ s: rawTok.s, e: rawTok.e, v: ld }); }
    }
  }
  if (!sawLang || !sawTitle || !sawCanon || !sawDesc) throw new Error(tag + ': head is missing one of <html lang>, <title>, canonical, meta description');
  out = applyEdits(out, e2);

  /* --- 4. addresses: the Dutch page sits one folder deeper --- */
  tokens = tokenize(out);
  const e3 = [];
  const badRefs = [];
  const checkRef = (orig, fixed) => {
    if (orig === fixed) return;
    const u = new URL(orig.trim(), 'https://x.invalid/' + page);
    let rel = decodeURI(u.pathname.slice(1));
    if (rel.endsWith('/') || rel === '') rel += 'index.html';
    if (!exists(rel)) badRefs.push(orig);
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'raw' && t.name === 'style') { e3.push({ s: t.s, e: t.e, v: cssUrls(out.slice(t.s, t.e), page) }); continue; }
    if (t.t === 'raw' && t.name === 'script') {
      if (/ld\+json/i.test(attrVal(t.open, 'type') || '')) continue;
      let js = out.slice(t.s, t.e);
      /* links written inside script text, e.g. href=\"../blog/\" in a dictionary line */
      js = js.replace(/(?<![\w-])(href|src|poster|action)=(\\?["'])([^"'\\<>]+)\2/g, (m, a, q, u) => { const f = nlUrl(u, page); checkRef(u, f); return a + '=' + q + f + q; });
      /* a bare file name handed to the browser, e.g. v.src = 'hero-mobile.mp4' */
      js = js.replace(/(["'])((?:\.\.\/)*[\w\-./]+\.(?:jpe?g|png|webp|avif|gif|svg|mp4|webm|pdf|css|js|json|ico|woff2?))\1/g, (m, q, u) => {
        const abs = new URL(u, 'https://x.invalid/' + page);
        if (!exists(decodeURI(abs.pathname.slice(1)))) return m;          // not a file of ours: leave the text alone
        return q + nlUrl(u, page) + q;
      });
      e3.push({ s: t.s, e: t.e, v: js });
      continue;
    }
    if (t.t !== 'tag' || t.close) continue;
    for (const a of t.attrs) {
      if (a.vs === -1) continue;
      if (t.name === 'link' && (attrVal(t, 'rel') === 'canonical' || attrVal(t, 'rel') === 'alternate')) continue;
      let v = a.value;
      if (URL_ATTRS.has(a.name)) { const dec = decodeEntities(v); const f = nlUrl(dec, page); checkRef(dec, f); if (f !== dec) v = escAttr(f).replace(/&quot;/g, a.quote === "'" ? '"' : '&quot;'); }
      else if (a.name === 'srcset' || a.name === 'imagesrcset') v = srcsetUrls(v, page);
      else if (a.name === 'style' && v.includes('url(')) v = cssUrls(v, page);
      if (v !== a.value) e3.push({ s: a.vs, e: a.ve, v });
    }
  }
  out = applyEdits(out, e3);
  if (badRefs.length) throw new Error(tag + ': these links point at files that do not exist: ' + [...new Set(badRefs)].join(', '));

  /* --- 5. script: a Dutch address is always Dutch --- */
  for (const p of PATCHES) {
    const found = (out.match(p.re) || []).length;
    if (found !== p.count) throw new Error(tag + ': expected ' + p.count + '× ' + p.what + ' but found ' + found + '. The page script changed; tools/build-nl.js (PATCHES) needs a matching update.');
    out = out.replace(p.re, p.to);
  }

  out = decorate(out, page, 'nl');
  out = out.replace(/<!DOCTYPE html>\n?/i, (m) => m + '<!-- MADE BY tools/build-nl.js from ' + (opts.label || '/' + page + 'index.html') + ' — do not edit this file; edit the English page (or tools/nl-strings.json) and run: node tools/build-nl.js -->\n');

  if (REPORT) {
    const uniq = [...new Set(untranslatedText)];
    reportLines.push({ page: tag, noKey: [...new Set(noKey)], borrowed: [...new Set(borrowed)], loose: uniq });
  }
  return { html: out, noKey: [...new Set(noKey)], borrowed: [...new Set(borrowed)] };
}

/* =============================================================================
   sitemap.xml and the redirect helper
   ========================================================================== */
/* The blog lines of sitemap.xml (/blog/... and /nl/blog/...) belong to the Worker
   (backend/src/blog_render.js writes them on publish/unpublish). This script never
   edits them: they are set aside while the page lines are rebuilt, then put back. */
const BLOG_URL_RE = /[ \t]*<url>\s*<loc>https:\/\/www\.wogococktailwalk\.com\/(?:nl\/)?blog\/[^<]*<\/loc>[\s\S]*?<\/url>\n/g;
function buildSitemap(xml) {
  const kept = [];
  let out = xml.replace(BLOG_URL_RE, (m) => { kept.push(m); return '@@BLOG' + (kept.length - 1) + '@@\n'; });
  /* start clean: drop what an earlier run added */
  out = out.replace(/[ \t]*<xhtml:link\b[^>]*\/>\n/g, '');
  out = out.replace(/[ \t]*<url>\s*<loc>https:\/\/www\.wogococktailwalk\.com\/nl\/[\s\S]*?<\/url>\n/g, '');
  out = out.replace(/<urlset\b[^>]*>/, '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');
  const links = (page, pad) =>
    pad + '<xhtml:link rel="alternate" hreflang="en" href="' + enAbs(page) + '"/>\n' +
    pad + '<xhtml:link rel="alternate" hreflang="nl" href="' + nlAbs(page) + '"/>\n' +
    pad + '<xhtml:link rel="alternate" hreflang="x-default" href="' + enAbs(page) + '"/>\n';
  let seen = 0;
  out = out.replace(/([ \t]*)<url>\n([ \t]*)<loc>([^<]+)<\/loc>\n([\s\S]*?)[ \t]*<\/url>\n/g, (m, ind, pad, loc, rest) => {
    const page = loc.slice(ORIGIN.length + 1);
    if (!loc.startsWith(ORIGIN + '/') || !PAGES.includes(page)) return m;
    seen++;
    const block = (address) => ind + '<url>\n' + pad + '<loc>' + address + '</loc>\n' + links(page, pad) + rest + ind + '</url>\n';
    return block(enAbs(page)) + block(nlAbs(page));
  });
  if (seen !== PAGES.length) throw new Error('sitemap.xml: expected to find ' + PAGES.length + ' page entries, found ' + seen + ' (unusual layout?)');
  return out.replace(/@@BLOG(\d+)@@\n/g, (m, i) => kept[Number(i)]);
}
/* sanity check of the Worker-written blog lines: every Dutch blog address in the
   sitemap must have its page, and its English twin line must point at it */
function blogSitemapProblems(xml) {
  const problems = [];
  const blocks = xml.match(BLOG_URL_RE) || [];
  const loc = (b) => /<loc>([^<]+)<\/loc>/.exec(b)[1];
  const nlSlugs = blocks.map(loc).filter((l) => /\/nl\/blog\/[^/]+\/$/.test(l)).map((l) => /\/nl\/blog\/([^/]+)\/$/.exec(l)[1]);
  for (const slug of nlSlugs) {
    if (!exists('nl/blog/' + slug + '/index.html')) problems.push('sitemap.xml lists /nl/blog/' + slug + '/ but nl/blog/' + slug + '/index.html does not exist');
    const en = blocks.find((b) => loc(b) === ORIGIN + '/blog/' + slug + '/');
    if (!en || !en.includes('hreflang="nl"')) problems.push('sitemap.xml: /blog/' + slug + '/ has no hreflang line for its Dutch page');
  }
  return problems;
}
/* the Dutch blog pages the Worker has committed: the redirect helper needs to know them */
function nlBlogSlugs() {
  const dir = path.join(ROOT, 'nl/blog');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isDirectory() && exists('nl/blog/' + f.name + '/index.html')).map((f) => f.name).sort();
}
const M_WK = ['// nl-pages:start (made by tools/build-nl.js; do not edit)', '// nl-pages:end'];
const M_BL = ['// nl-blog:start (made by tools/build-nl.js; do not edit)', '// nl-blog:end'];
function buildWorker(js) {
  const i = js.indexOf(M_WK[0]);
  const j = js.indexOf(M_WK[1]);
  if (i === -1 || j === -1) throw new Error('redirects-worker/worker.js: the nl-pages markers are missing');
  const list = PAGES.map((p) => JSON.stringify('/' + p)).join(', ');
  let out = js.slice(0, i) + M_WK[0] + '\nconst NL_PAGES = new Set([' + list + ']);\n' + js.slice(j);
  const a = out.indexOf(M_BL[0]);
  const b = out.indexOf(M_BL[1]);
  if (a === -1 || b === -1) throw new Error('redirects-worker/worker.js: the nl-blog markers are missing');
  const slugs = nlBlogSlugs().map((x) => JSON.stringify(x)).join(', ');
  return out.slice(0, a) + M_BL[0] + '\nconst NL_BLOG = new Set([' + slugs + ']);\nconst NL_BLOG_INDEX = ' + exists('nl/blog/index.html') + ';\n' + out.slice(b);
}

/* =============================================================================
   The blog page templates (what the Worker fills in on publish)
   ========================================================================== */
const BLOG_DIR = 'blog/_template/generated/';
/* the same patches as PATCHES, but the English template becomes English-only */
const PATCHES_EN = [
  { what: 'the anti-flicker script in <head> (English blog pages stay English)', count: 1, re: PATCHES[0].re, to: '' },
  { what: 'the start-up language choice (an English blog address is always English)', count: 1,
    re: /setLang\(saved \|\| \(auto \? 'nl' : 'en'\)\);/g,
    to: "setLang('en');   /* English blog address: always English (made by tools/build-nl.js) */" },
  { what: 'the saved-language lookups in the newsletter and cookie blocks', count: 2, re: PATCHES[2].re,
    to: '/* English blog address: the page language decides (made by tools/build-nl.js) */\n' },
];
function blogTemplates() {
  const out = new Map();
  const nlTokens = (html) => html.replace(/\{\{([A-Z0-9_]+)_EN\}\}/g, '{{$1_NL}}');
  const noBorrow = new Set(['hero_h1', 'hero_sub', 'hero_eyebrow', 'post_cat', 'post_hook', 'crumb_post']);
  for (const [name, page, label] of [['post', 'blog/{{SLUG}}/', 'blog/_template/post.html'], ['index', 'blog/', 'blog/_template/index.html']]) {
    const base = stripGenerated(read(label));
    let en = decorate(base, page, 'en', { nlHref: '{{NL_SWITCH_HREF}}', altToken: '{{BLOG_ALT_LINKS}}' });
    for (const p of PATCHES_EN) {
      const found = (en.match(p.re) || []).length;
      if (found !== p.count) throw new Error(label + ': expected ' + p.count + '× ' + p.what + ' but found ' + found + '. The page script changed; tools/build-nl.js (PATCHES_EN) needs a matching update.');
      en = en.replace(p.re, p.to);
    }
    out.set(BLOG_DIR + name + '.en.html', en);
    const nl = toDutch(nlTokens(base), page, { label: label + ' (blog template)', noBorrow });
    out.set(BLOG_DIR + name + '.nl.html', nl.html);
  }
  return out;
}

/* =============================================================================
   main
   ========================================================================== */
function main() {
  PAGES = listPages();
  PAGESET = new Set(PAGES);
  const want = new Map();          // file -> content it should have
  const sources = PAGES.map((page) => ({ page, html: stripGenerated(read(page + 'index.html')) }));
  buildSiteDict(sources);
  const notes = [];
  for (const { page, html } of sources) {
    want.set(page + 'index.html', decorate(html, page, 'en'));
    const nl = toDutch(html, page);
    want.set('nl/' + page + 'index.html', nl.html);
    if (nl.noKey.length) notes.push((page || '/') + ': no Dutch for ' + nl.noKey.join(', ') + ' (left as written)');
    if (nl.borrowed.length) notes.push((page || '/') + ': Dutch for ' + nl.borrowed.join(', ') + ' taken from other pages (missing in this page\'s own dictionary)');
  }
  for (const [rel, content] of blogTemplates()) want.set(rel, content);
  want.set('sitemap.xml', buildSitemap(read('sitemap.xml')));
  want.set('redirects-worker/worker.js', buildWorker(read('redirects-worker/worker.js')));

  if (priceIssues.length) {
    console.error('\nThe PRICE differs between the English text and its Dutch line. Correct the Dutch line');
    console.error('in that page\'s dictionary (var NL = {...} near the foot of the English page), then run again:\n');
    for (const x of [...new Set(priceIssues)]) console.error('  • ' + x);
    process.exit(1);
  }
  if (TODO || missing.size) {
    if (missing.size) {
      console.error('\nThese English texts have no Dutch yet. Add each one to tools/nl-strings.json');
      console.error('(under "translate", or under "same" if the Dutch is identical), then run again:\n');
      const obj = {};
      for (const [en, where] of missing) { obj[en] = ''; console.error('  • ' + JSON.stringify(en) + '\n      seen on: ' + [...new Set(where)].slice(0, 4).join(' | ')); }
      if (TODO) console.log(JSON.stringify(obj, null, 2));
      process.exit(1);
    }
    console.log('Nothing is missing a Dutch text.');
    if (TODO) return;
  }
  const unused = Object.keys(MANUAL).concat([...SAME]).filter((k) => !usedManual.has(k));

  /* files under nl/ that no longer have an English source */
  const stale = [];
  const walk = (dir) => { for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { const rel = dir + '/' + f.name; if (rel === 'nl/blog') continue; /* written by the Worker */ if (f.isDirectory()) walk(rel); else if (!want.has(rel)) stale.push(rel); } };
  if (exists('nl')) walk('nl');

  const changed = [];
  for (const [rel, content] of want) {
    const now = exists(rel) ? read(rel) : null;
    if (now !== content) changed.push(rel);
  }
  if (REPORT) {
    /* text that sits in a page without any dictionary key: it reads the same on
       the Dutch page. Mostly names; anything English here needs a key + Dutch. */
    const loose = new Map();
    for (const r of reportLines) for (const t of r.loose) { if (!loose.has(t)) loose.set(t, []); loose.get(t).push(r.page); }
    console.log('Text without a dictionary key (same on the English and the Dutch page):');
    for (const [t, where] of [...loose].sort((x, y) => y[1].length - x[1].length)) console.log('  [' + where.length + ' page' + (where.length > 1 ? 's' : '') + '] ' + t.slice(0, 140) + (where.length <= 2 ? '   <- ' + where.join(', ') : ''));
    for (const r of reportLines) {
      if (r.noKey.length) console.log(r.page + ': keys without Dutch anywhere: ' + r.noKey.join(', '));
      if (r.borrowed.length) console.log(r.page + ': Dutch borrowed from other pages: ' + r.borrowed.join(', '));
    }
    return;
  }
  if (CHECK) {
    const blogProblems = blogSitemapProblems(read('sitemap.xml'));
    for (const x of blogProblems) console.error('  blog sitemap: ' + x);
    if (!changed.length && !stale.length && !blogProblems.length) { console.log('OK — ' + PAGES.length + ' Dutch pages, sitemap.xml and the redirect list are all up to date.'); return; }
    console.error('OUT OF DATE — run "node tools/build-nl.js" and commit the result:');
    for (const f of changed) console.error('  needs rebuilding: ' + f);
    for (const f of stale) console.error('  left over (no English page any more): ' + f);
    process.exit(1);
  }
  for (const rel of changed) {
    fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, rel), want.get(rel));
  }
  for (const rel of stale) fs.unlinkSync(path.join(ROOT, rel));
  console.log('Dutch pages: ' + PAGES.length + ' · files rewritten: ' + changed.length + (stale.length ? ' · removed: ' + stale.length : ''));
  for (const n of notes) console.log('  note — ' + n);
  if (unused.length) console.log('  note — ' + unused.length + ' line(s) in tools/nl-strings.json are no longer used: ' + unused.slice(0, 8).map((s) => JSON.stringify(s.slice(0, 40))).join(', ') + (unused.length > 8 ? ' …' : ''));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('build-nl: ' + e.message); process.exit(1); }
} else {
  module.exports = { tokenize, plain, norm, listPages, toDutch, stripGenerated, decorate, buildSitemap, dictionaries };
}
