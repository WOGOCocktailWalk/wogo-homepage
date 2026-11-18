// src/missing_pages.js — "which missing addresses do real visitors hit?"
//
// The static site's 404.html forwards visitors to the homepage and, just
// before, fires a tiny beacon to POST /api/missing-page with the missing PATH.
// This file: the public endpoint, the path cleaning, and the two dashboard
// handlers (list, forget). Storage is in db.js (the settings k/v table).
//
// What is stored: the cleaned path, a hit count, first/last seen. Nothing
// else: no query string, no IP, no cookie, no user agent. The per-visitor
// rate limit (existing rate_events table) keeps only a one-way hash of the IP
// for 24 hours, like the contact form's limit does.

import * as db from './db.js';
import { corsHeaders } from './guest_api.js';
import { isAllowedOrigin, MISSING_PAGE_MAX_DISTINCT, MISSING_PAGE_RETENTION_DAYS, MISSING_PAGE_HITS_PER_WINDOW, MISSING_PAGE_WINDOW_MINUTES, MISSING_PAGE_MAX_LENGTH } from './config.js';
import { sha256Hex, hasCsrfHeader } from './auth.js';
import { sqliteMinutesAgo } from './logic.js';
import { audit } from './admin_api.js';

const MAX_RAW_LENGTH = 300;
const MAX_SEGMENTS = 8;

// Probes from vulnerability scanners and bots: not real visitors, never stored.
const SCANNER_SEGMENT_RE = /(^|\/)(wp-[^/]*|wordpress|xmlrpc[^/]*|phpmyadmin|pma|cgi-bin|\.env[^/]*|\.git[^/]*|\.svn|\.hg|\.ht[^/]*|\.aws|\.ssh|\.ds_store|admin|administrator|boaform|actuator|vendor|node_modules|server-status|etc\/passwd|owa|ecp|solr|jenkins)(\/|$)/;
const SCANNER_EXT_RE = /\.(php\d?|phtml|asp|aspx|jsp|jspx|cgi|env|git|sql|bak|old|orig|swp|zip|tar|gz|tgz|rar|7z|ini|ya?ml|log|pl|py|sh|exe|dll)(\/|$)/;
const BOT_UA_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|curl|wget|python|scan/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_CHARS_RE = /^[\p{L}\p{N}\-_.~+()[\]/]*$/u;

/** True for paths that look like a scanner probe (checked on the decoded,
 * lower-cased path). */
export function isScannerNoise(path) {
  const p = String(path || '').toLowerCase();
  return p.includes('..') || SCANNER_SEGMENT_RE.test(p) || SCANNER_EXT_RE.test(p) || p === '/404.html' || p === '/404';
}

function cleanSegment(seg) {
  if (seg.includes('@')) return '[email]';
  if (UUID_RE.test(seg) || /^[0-9a-f]{16,}$/.test(seg)) return '[token]';
  const tokenChars = /^[a-z0-9_=+-]+$/.test(seg);
  const digits = (seg.match(/\d/g) || []).length;
  if (tokenChars && seg.length >= 20 && digits >= 3 && /[a-z]/.test(seg)) return '[token]';
  if (tokenChars && seg.length >= 32 && !seg.includes('-')) return '[token]';
  return seg.replace(/\d{6,}/g, '[number]');
}

/**
 * Turns whatever the browser sent into a safe, comparable path, or null when
 * it should be ignored. Rules: path only (anything from ? or # on is dropped);
 * decoded once; lower-case; slashes collapsed; no trailing slash; an email
 * address becomes [email], long random-looking pieces become [token], runs of
 * 6+ digits become [number]; scanner probes, control characters, odd
 * characters and anything longer than MISSING_PAGE_MAX_LENGTH are ignored.
 * It cannot catch a person's name typed into an address (for example
 * /john-smith); the dashboard lets the owner forget any row.
 */
export function normalizeMissingPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RAW_LENGTH) return null;
  let p = raw.trim().split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch { return null; }
  if (/[\u0000-\u001f\u007f\\%]/.test(p)) return null; // control chars, backslash, double-encoding
  p = p.toLowerCase().replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) return null;
  if (isScannerNoise(p)) return null;
  const segments = p.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  const cleaned = '/' + segments.map(cleanSegment).join('/');
  if (cleaned.length > MISSING_PAGE_MAX_LENGTH || !ALLOWED_CHARS_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * POST /api/missing-page (public). Body: the missing path as plain text
 * (text/plain, so the browser sends it without a preflight). ALWAYS answers
 * 204: ignored, rate-limited and failed hits look identical, and the 404 page
 * never waits on or reacts to the answer.
 */
export async function handleMissingPageHit(request, env) {
  const done = (status = 204) => new Response(null, { status, headers: corsHeaders(request) });
  try {
    const origin = request.headers.get('Origin');
    if (!origin) return done();
    if (!isAllowedOrigin(origin)) return done(403);
    if (BOT_UA_RE.test(request.headers.get('User-Agent') || '')) return done();
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > 1024) return done();

    const path = normalizeMissingPath((await request.text()).slice(0, MAX_RAW_LENGTH + 1));
    if (!path) return done(); // noise or junk: no writes at all

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const identity = (await sha256Hex(`missing-page|${ip}`)).slice(0, 32);
    await db.recordRateEvent(env.DB, 'missing_page', identity);
    const n = await db.countRateEventsSince(env.DB, 'missing_page', identity, sqliteMinutesAgo(MISSING_PAGE_WINDOW_MINUTES));
    if (n > MISSING_PAGE_HITS_PER_WINDOW) return done();

    await db.recordMissingPageHit(env.DB, path, MISSING_PAGE_MAX_DISTINCT);
  } catch (err) {
    console.error('missing_page_hit_failed', String(err && err.message ? err.message : err));
  }
  return done();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** GET /admin/api/missing-pages (staff+) */
export async function handleListMissingPages(request, env) {
  const pages = await db.listMissingPages(env.DB, MISSING_PAGE_MAX_DISTINCT);
  return json({ pages, max_pages: MISSING_PAGE_MAX_DISTINCT, forget_after_days: MISSING_PAGE_RETENTION_DAYS });
}

/** POST /admin/api/missing-pages/forget (staff+) body {path}. The path is
 * taken as given (it is the stored, already-cleaned form); the settings key is
 * built in db.js from a fixed prefix, so no other setting can be reached. */
export async function handleForgetMissingPage(request, env) {
  if (!hasCsrfHeader(request)) return json({ error: 'forbidden', message: 'missing CSRF header' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request', message: 'invalid JSON' }, 400); }
  const path = body && typeof body.path === 'string' ? body.path : '';
  if (!path.startsWith('/') || path.length > MAX_RAW_LENGTH) return json({ error: 'bad_request', message: 'that is not an address on the site' }, 400);
  const existed = await db.deleteMissingPage(env.DB, path);
  if (!existed) return json({ error: 'not_found', message: 'that address is already gone from the list' }, 404);
  await audit(env, request, 'missing_page.forget', 'missing_page', path, null);
  return json({ ok: true });
}


// ---------------------------------------------------------------------------
// Article view counter (18 Nov 2026). Wix showed how often each blog article
// was opened; this does the same for the new blog: every article page sends
// its own slug once when it is opened. No cookies, no IP stored, nothing that
// identifies the reader. One visitor counts once per article per half hour.
// Stored in the generic settings table as `blogview:<slug>` = {views, wix},
// where `wix` is the count carried over from Wix on 18 Nov 2026.
// ---------------------------------------------------------------------------
const BLOG_VIEW_SLUG_RE = /^[a-z0-9-]{3,80}$/;
const BLOG_VIEW_REPEAT_MINUTES = 30;

export async function handleBlogViewHit(request, env) {
  const done = (status = 204) => new Response(null, { status, headers: corsHeaders(request) });
  try {
    const origin = request.headers.get('Origin');
    if (!origin) return done();
    if (!isAllowedOrigin(origin)) return done(403);
    if (BOT_UA_RE.test(request.headers.get('User-Agent') || '')) return done();
    const slug = (await request.text()).slice(0, 100).trim().toLowerCase();
    if (!BLOG_VIEW_SLUG_RE.test(slug)) return done();
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const identity = (await sha256Hex(`blog-view|${slug}|${ip}`)).slice(0, 32);
    await db.recordRateEvent(env.DB, 'blog_view', identity);
    const n = await db.countRateEventsSince(env.DB, 'blog_view', identity, sqliteMinutesAgo(BLOG_VIEW_REPEAT_MINUTES));
    if (n > 1) return done(); // same reader, same article, within half an hour
    await db.recordBlogView(env.DB, slug);
  } catch (err) {
    console.error('blog_view_hit_failed', String(err && err.message ? err.message : err));
  }
  return done();
}
