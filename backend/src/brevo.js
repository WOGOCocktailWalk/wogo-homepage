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
