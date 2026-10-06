// src/brevo.js — Brevo transactional email, plain fetch, zero-dependency.
//
// Supports two shapes:
//   * OWNED HTML (Dashboard v2, preferred): { to, subject, htmlContent, sender?, replyTo? }
//     — the Worker renders the branded HTML itself (src/emails.js), so no Brevo
//     dashboard templates need to be built or maintained.
//   * Brevo-hosted template (legacy):       { to, templateId, params }
//
// Whichever is passed, this just POSTs it to Brevo's transactional endpoint.

import { EMAIL_SENDER } from './config.js';

// Named entities that show up in src/emails.js's owned HTML (typographic
// punctuation, the bullet glyph, arrows) — not an exhaustive HTML5 entity
// table, just the ones this codebase actually emits. Numeric entities
// (&#8226; etc.) are decoded separately below via their code point.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', middot: '·', mdash: '—', ndash: '–',
  minus: '−', rarr: '→', larr: '←', hellip: '…',
};

/**
 * Derives a plain-text alternative from one of our own owned HTML emails
 * (src/emails.js). Not a general HTML-to-text library — just enough to give
 * Brevo a readable `text/plain` part: block-level tags become line breaks,
 * `<a href>` links are kept as visible URLs (so a plain-text reader still has
 * something to click/copy), remaining tags are stripped, entities are
 * decoded, and repeated blank lines/spaces are collapsed.
 */
export function htmlToText(html) {
  if (!html) return '';
  let text = String(html);

  // Drop non-content sections outright before any tag stripping: anything in
  // <head>/<style>/<script>, and the hidden inbox-preview div layout()
  // renders in <body> (src/emails.js: `display:none;max-height:0;...`) — its
  // text duplicates the visible heading/intro and has no place in a
  // text/plain body that already reads top to bottom.
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

  // Links: keep both the visible label and the URL — "Label (https://…)" —
  // so a plain-text client still shows a copyable link, not just prose.
  text = text.replace(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
    return href && cleanLabel && !cleanLabel.includes(href) ? `${cleanLabel} (${href})` : (cleanLabel || href);
  });

  // Block-level boundaries become line breaks before their tags are stripped.
  text = text.replace(/<\/(p|div|tr|table|h[1-6]|ul|ol)>/gi, '\n');
  text = text.replace(/<(br|li)\b[^>]*>/gi, '\n');

  // Strip every remaining tag.
  text = text.replace(/<[^>]+>/g, '');

  // Decode entities: named table above, then numeric (&#123; / &#x7B;).
  text = text.replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
  text = text.replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)));

  // Collapse whitespace: trailing spaces per line, 3+ blank lines -> 1.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

// ---------------------------------------------------------------------------
// Brevo CONTACTS API (v3) — folders / lists / attributes / contacts. Separate
// endpoint family from the transactional `smtp/email` send above (different
// base path, different payload shapes), but same zero-dependency `fetch`
// style and same api-key header. Used by:
//   * POST /admin/api/brevo/setup (src/admin_api.js) — idempotently creates
//     the folder/list/attribute model (BUILD item #1).
//   * src/subscribers.js — upserts/patches a contact on confirm, on a
//     booking's opt-in, and on every confirmed booking of an already-
//     subscribed email; removes a contact from the list on unsubscribe.
// Every function here takes `env` (for BREVO_API_KEY) and throws a plain
// Error with the HTTP status + Brevo's error body on a non-2xx response —
// callers decide whether to surface, retry, or queue (src/brevo_sync.js).
// ---------------------------------------------------------------------------

const BREVO_BASE = 'https://api.brevo.com/v3';

async function brevoRequest(env, method, path, body) {
  const res = await fetch(`${BREVO_BASE}${path}`, {
    method,
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Brevo returns 204 No Content on several successful writes (e.g. PUT
  // /contacts/{id}) — res.json() would throw on an empty body, so only parse
  // when there's actually content to parse.
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { /* non-JSON body on an error page, etc. */ }
  }
  if (!res.ok) {
    const err = new Error(`brevo_api_failed: ${method} ${path} -> ${res.status} ${text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return { status: res.status, json };
}

/** Brevo contact folders live under /contacts/folders. Lists a page (default
 * limit covers WOGO's tiny account easily — no pagination needed here). */
export async function listContactFolders(env) {
  const { json } = await brevoRequest(env, 'GET', '/contacts/folders?limit=50&offset=0');
  return (json && json.folders) || [];
}

export async function createContactFolder(env, name) {
  const { json } = await brevoRequest(env, 'POST', '/contacts/folders', { name });
  return json; // { id }
}

/** Idempotent: finds a folder by exact name first, creates only if missing.
 * Returns { id, created }. */
export async function ensureContactFolder(env, name) {
  const folders = await listContactFolders(env);
  const existing = folders.find((f) => f.name === name);
  if (existing) return { id: existing.id, created: false };
  const created = await createContactFolder(env, name);
  return { id: created.id, created: true };
}

export async function listContactLists(env) {
  const { json } = await brevoRequest(env, 'GET', '/contacts/lists?limit=50&offset=0');
  return (json && json.lists) || [];
}

export async function createContactList(env, name, folderId) {
  const { json } = await brevoRequest(env, 'POST', '/contacts/lists', { name, folderId });
  return json; // { id }
}

/** Idempotent: finds a list by exact name first (across the account — WOGO's
 * Brevo account is small and single-purpose, so a name match is unambiguous
 * in practice), creates under `folderId` only if missing. Returns
 * { id, created }. */
export async function ensureContactList(env, name, folderId) {
  const lists = await listContactLists(env);
  const existing = lists.find((l) => l.name === name);
  if (existing) return { id: existing.id, created: false };
  const created = await createContactList(env, name, folderId);
  return { id: created.id, created: true };
}

/** Every custom + built-in contact attribute on the account, flattened across
 * Brevo's category groupings ('normal', 'transactional', 'category', ...). */
export async function listContactAttributes(env) {
  const { json } = await brevoRequest(env, 'GET', '/contacts/attributes');
  return (json && json.attributes) || [];
}

export async function createContactAttribute(env, name, type) {
  // Brevo's create-attribute endpoint is keyed by category in the URL path;
  // every attribute this codebase creates is a plain 'normal' contact field
  // (not transactional/category/calculated) — see BREVO_CONTACT_ATTRIBUTES.
  await brevoRequest(env, 'POST', `/contacts/attributes/normal/${encodeURIComponent(name)}`, { type });
}

/** Idempotent: a duplicate attribute name is NOT recreated (Brevo attribute
 * types are immutable once created, and re-POSTing an existing name is
 * rejected) — this just checks first. Returns { name, type, created }. */
export async function ensureContactAttribute(env, name, type) {
  const existing = await listContactAttributes(env);
  const already = existing.some((a) => String(a.name).toUpperCase() === name.toUpperCase());
  if (already) return { name, type, created: false };
  await createContactAttribute(env, name, type);
  return { name, type, created: true };
}

/**
 * Creates-or-updates a contact. `updateEnabled: true` (Brevo's own flag) means
 * an existing contact with this email is updated rather than rejected as a
 * duplicate — the normal shape for every call site here (a guest confirming
 * twice, a booking opt-in on a returning guest, a re-run of a CSV import must
 * all be safe to repeat). Returns { created: boolean } — Brevo answers 201 on
 * a genuinely new contact, 204 (no body) on an update of an existing one.
 */
export async function upsertContact(env, { email, attributes, listIds }) {
  const body = { email, updateEnabled: true };
  if (attributes) body.attributes = attributes;
  if (listIds && listIds.length) body.listIds = listIds;
  const { status } = await brevoRequest(env, 'POST', '/contacts', body);
  return { created: status === 201 };
}

/** Looks up a contact by email. Returns the contact object, or null if no
 * such contact exists (Brevo answers 404) — used by the "only update an
 * ALREADY-subscribed email's booking attributes, never create one from a
 * non-opted-in booking" rule (BUILD item #3, src/subscribers.js). */
export async function getContact(env, email) {
  try {
    const { json } = await brevoRequest(env, 'GET', `/contacts/${encodeURIComponent(email)}`);
    return json;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Patches attributes and/or list membership on an EXISTING contact (no
 * updateEnabled/create semantics — this is a plain PUT, Brevo 404s if the
 * contact doesn't exist, same as getContact above). */
export async function updateContact(env, email, { attributes, listIds, unlinkListIds, emailBlacklisted }) {
  const body = {};
  if (attributes) body.attributes = attributes;
  if (listIds && listIds.length) body.listIds = listIds;
  if (unlinkListIds && unlinkListIds.length) body.unlinkListIds = unlinkListIds;
  if (emailBlacklisted !== undefined) body.emailBlacklisted = emailBlacklisted;
  await brevoRequest(env, 'PUT', `/contacts/${encodeURIComponent(email)}`, body);
}

/** Unsubscribe: blacklists the contact (stops ALL Brevo campaign sends to
 * them, the standard Brevo-side opt-out flag) and removes them from the WOGO
 * list. A contact that doesn't exist in Brevo at all is a silent no-op — an
 * unsubscribe click for someone never successfully synced has nothing to
 * undo there. */
export async function unsubscribeContact(env, email, listId) {
  try {
    await updateContact(env, email, { emailBlacklisted: true, unlinkListIds: listId ? [listId] : undefined });
  } catch (err) {
    if (err.status === 404) return;
    throw err;
  }
}

export async function sendTransactional(env, msg) {
  // TEST-SAFETY: if EMAIL_TEST_REDIRECT is set (a Worker secret used pre-go-live),
  // every recipient is rewritten to that address and the real recipient is shown
  // in the subject, so test bookings can never reach real inboxes/bars/Wix filters.
  // Remove the secret at go-live and real addresses are used again. Keeps prod
  // config (info@…) correct so the test suite stays green.
  const redirect = env && env.EMAIL_TEST_REDIRECT;
  const realTo = msg.to;
  const to = redirect || realTo;

  const payload = { to: [{ email: to }] };

  if (msg.htmlContent) {
    payload.sender = msg.sender || EMAIL_SENDER;
    payload.subject = redirect ? `[TEST → ${realTo}] ${msg.subject}` : msg.subject;
    payload.htmlContent = msg.htmlContent;
    // Every owned-HTML send gets a text/plain alternative — required by most
    // spam filters and screen readers, and the only thing some inboxes show
    // in their preview pane. Caller can pass an explicit textContent to
    // override; otherwise it's derived from the HTML.
    payload.textContent = msg.textContent || htmlToText(msg.htmlContent);
    if (msg.replyTo) payload.replyTo = msg.replyTo;
  } else {
    payload.templateId = msg.templateId;
    payload.params = msg.params;
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`brevo_send_failed: ${res.status} ${await res.text()}`);
}
