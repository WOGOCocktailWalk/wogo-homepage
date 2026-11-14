// src/giftcard_pdf.js — the printable gift card PDF attached to the gift card
// emails (owner request 14 Nov 2026).
//
// One A5-landscape page: a pre-rendered branded background (per language,
// built by giftcard-art/render.sh and served from the static site) with the
// card's own code, value, names and message drawn on top. Never throws: any
// failure returns null and the email simply goes out without the attachment.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { SITE_ASSET_BASE } from './config.js';

const PAGE_W = 595.28; // A5 landscape, points
const PAGE_H = 419.53;
const IMG_W = 1588; // background render size in px (giftcard-art/render.sh)
const PX = PAGE_W / IMG_W;
const x = (px) => px * PX;
const y = (px) => PAGE_H - px * PX; // image y runs down, PDF y runs up

const BLUSH = rgb(0xf8 / 255, 0xdd / 255, 0xc2 / 255);
const SOFT = rgb(0xe9 / 255, 0xd3 / 255, 0xc0 / 255);
const INK = rgb(0x2b / 255, 0x1e / 255, 0x16 / 255);

const LABELS = {
  en: { to: 'For', from: 'From', file: 'WOGO-gift-card' },
  nl: { to: 'Voor', from: 'Van', file: 'WOGO-cadeaubon' },
};

export function giftCardBackgroundUrl(lang) {
  return `${SITE_ASSET_BASE}/email/giftcard-pdf-${lang === 'nl' ? 'nl' : 'en'}.jpg`;
}

/** Drops anything the built-in PDF font cannot draw (emoji etc.), so a
 * message like "Happy birthday 🍹" still renders instead of failing. */
function safeText(font, value) {
  const allowed = new Set(font.getCharacterSet());
  return Array.from(String(value || '').replace(/\s+/g, ' '))
    .filter((ch) => allowed.has(ch.codePointAt(0)))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function wrap(font, text, size, maxWidth, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) { line = next; continue; }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, '...');
  }
  return lines;
}

function spaced(page, text, { font, size, color, px, py, tracking }) {
  let cx = x(px);
  for (const ch of text) {
    page.drawText(ch, { x: cx, y: y(py), size, font, color });
    cx += font.widthOfTextAtSize(ch, size) + tracking;
  }
}

/**
 * Builds the PDF. `backgroundJpeg` is the raw bytes of the background image
 * (Uint8Array / ArrayBuffer). Returns a Uint8Array.
 */
export async function buildGiftCardPdf(giftCard, backgroundJpeg) {
  const lang = giftCard.locale === 'nl' ? 'nl' : 'en';
  const t = LABELS[lang];
  const doc = await PDFDocument.create();
  doc.setTitle(lang === 'nl' ? 'WOGO Cadeaubon' : 'WOGO Gift Card');
  doc.setAuthor('WOGO Cocktail Walk');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const bg = await doc.embedJpg(backgroundJpeg);
  page.drawImage(bg, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });

  // Names (left column, between the city line and the code bar).
  const toName = safeText(bold, giftCard.recipient_name).slice(0, 40);
  const fromName = safeText(regular, giftCard.buyer_name).slice(0, 40);
  let cursor = 528;
  if (toName) {
    page.drawText(`${t.to} ${toName}`, { x: x(91), y: y(cursor), size: 15, font: bold, color: BLUSH });
    cursor += 40;
  }
  if (fromName) {
    page.drawText(`${t.from} ${fromName}`, { x: x(91), y: y(cursor), size: 10.5, font: regular, color: SOFT });
    cursor += 40;
  }
  const message = safeText(italic, giftCard.message);
  if (message) {
    const lines = wrap(italic, `"${message}"`, 9.5, x(820), 3);
    lines.forEach((line, i) => {
      page.drawText(line, { x: x(91), y: y(cursor + i * 31), size: 9.5, font: italic, color: SOFT });
    });
  }

  // Code + value, inside the blush bar.
  spaced(page, safeText(bold, giftCard.code), { font: bold, size: 22, color: INK, px: 151, py: 862, tracking: 2.2 });
  const cents = giftCard.initial_cents != null ? giftCard.initial_cents : giftCard.balance_cents;
  const euros = (Number(cents || 0) / 100).toFixed(2).replace('.', lang === 'nl' ? ',' : '.');
  // Euro sign drawn on its own with a little air, some viewers set it too tight.
  const euroSign = String.fromCharCode(0x20ac);
  page.drawText(euroSign, { x: x(1088), y: y(862), size: 22, font: bold, color: INK });
  page.drawText(euros, { x: x(1088) + bold.widthOfTextAtSize(euroSign, 22) + 6, y: y(862), size: 22, font: bold, color: INK });

  return doc.save();
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetches the background, builds the PDF and returns a Brevo attachment
 * ({ name, content }) — or null if anything goes wrong.
 */
export async function giftCardPdfAttachment(giftCard, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  try {
    const lang = giftCard.locale === 'nl' ? 'nl' : 'en';
    const res = await fetchImpl(giftCardBackgroundUrl(lang));
    if (!res.ok) throw new Error(`background ${res.status}`);
    const bytes = await buildGiftCardPdf(giftCard, new Uint8Array(await res.arrayBuffer()));
    return { name: `${LABELS[lang].file}-${giftCard.code}.pdf`, content: toBase64(bytes) };
  } catch (err) {
    console.error('giftcard_pdf_failed', String(err && err.message ? err.message : err));
    return null;
  }
}
