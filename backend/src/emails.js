// src/emails.js
//
// The WOGO transactional emails, as OWNED, branded HTML built right here — not
// as Brevo-dashboard templates. The engine renders these and hands the finished
// HTML to Brevo (`htmlContent`), so:
//   * Maroussia never has to rebuild templates in Brevo's editor,
//   * the brand is controlled in code and version-controlled,
//   * and preview/emails.html renders these SAME functions, so what she previews
//     is byte-for-byte what arrives.
//
// PURE + Workers-safe: string building only, no `env`, no `fetch`, no Node APIs.
// Every render function returns { subject, html }. Guest-facing copy is EN/NL
// (booking.locale). Bar-facing mails (renderBarNotification/Reschedule/
// Cancellation) are also EN/NL, driven by the bar's OWN language
// (routes_bars.locale, migrations/0022 — defaults 'nl', since every bar is
// Dutch today). Owner mails stay EN only — Maroussia reads English.
//
// Design language (2026-08-29 redesign):
//   * Every email opens with the REAL salmon WOGO logo on a dark espresso band,
//     then a CONTAINED marketing poster image (the route's own if we have one,
//     else the universal branded banner) — the brand, up top, in every message.
//   * The GUEST confirmation is built around ONE job: open the route map. The
//     essentials are scannable, the salmon "Open your route map" button is the
//     single dominant, tinted element, and the reference material (what's
//     included / good to know / how it works) sits below as calm, untinted
//     text — no wall of competing cards.
//   * The BAR mail is ruthlessly efficient: allergies flagged loudly ABOVE
//     everything, then that bar's OWN staggered arrival time as a big hero.
//   * The OWNER mail is the whole booking at a glance, arrivals included.
//
// Related: src/webhook.js calls these on a confirmed booking; src/brevo.js
// sends the { subject, html }; test/notes.test.js + test/map_locale.test.js +
// test/currency_timezone.test.js + test/webhook.test.js pin the map button, the
// per-language map, the allergies block ordering, and the currency-aware money.

import { isoWeekday, formatMoney } from './logic.js';
import {
  EMAIL_LOGO_URL, posterUrlFor, SITE_URL, WELCOME_CODE,
  REVIEW_TRUSTPILOT_URL_EN, REVIEW_TRUSTPILOT_URL_NL, REVIEW_GOOGLE_URL,
} from './config.js';

// ---------------------------------------------------------------------------
// Brand tokens (verbatim from the site palette — see src/admin/admin.css)
// ---------------------------------------------------------------------------
const C = {
  espresso: '#3f2b21',
  ink: '#201611',
  brown: '#643e2b',
  brownSoft: '#7e5541',
  blush: '#ffe5d9',
  cream: '#fffaf6',
  page: '#f4e6dc',
  salmon: '#ffaa81',
  salmonDeep: '#f2905c',
  line: '#e7d3c6',
  muted: '#8a6a58',
  amberBg: '#fff4e0',
  amberLine: '#eec489',
  amberEdge: '#e08a00',
  amberInk: '#8a5200',
};

const SENDER_NAME = 'WOGO Cocktail Walk';
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DAYS = {
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  nl: ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'],
};
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  nl: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
};

/** 'YYYY-MM-DD' -> 'Thursday 6 August 2026' (en) / 'donderdag 6 augustus 2026' (nl). */
export function formatLongDate(dateStr, locale = 'en') {
  const lang = locale === 'nl' ? 'nl' : 'en';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  const day = Number(m[3]);
  const monthName = MONTHS[lang][Number(m[2]) - 1];
  const weekday = DAYS[lang][isoWeekday(dateStr) - 1];
  return `${weekday} ${day} ${monthName} ${m[1]}`;
}

function loc(locale) {
  return locale === 'nl' ? 'nl' : 'en';
}

/** 'YYYY-MM-DD' -> '10 October 2026' (en) / '10 oktober 2026' (nl) — the
 * same day/month/year numbers as formatLongDate, just without the weekday.
 * Used in the bar-facing NL subject lines (migrations/0022), which name a
 * short human date rather than the raw ISO string the EN subjects keep
 * (unchanged, for backward compatibility with existing callers/tests). */
function formatShortDate(dateStr, locale = 'en') {
  const lang = locale === 'nl' ? 'nl' : 'en';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  const day = Number(m[3]);
  const monthName = MONTHS[lang][Number(m[2]) - 1];
  return `${day} ${monthName} ${m[1]}`;
}

// ---------------------------------------------------------------------------
// shared layout — table-based, inline styles (email-client safe)
// ---------------------------------------------------------------------------

/** The REAL WOGO logo (salmon mark on transparent). `color` is the text
 * fallback tint shown if the image fails to load (alt text on the dark band). */
function logoImg() {
  return `<img src="${EMAIL_LOGO_URL}" width="120" alt="WOGO" style="display:block;width:120px;max-width:60%;height:auto;margin:0 auto;color:${C.cream};font:800 22px/1 ${FONT};letter-spacing:.22em;">`;
}

/**
 * The branded espresso hero band that tops every email. Real logo + kicker,
 * plus (for internal mails) an optional badge / title / summary chip.
 * @param hero.badge  small salmon pill above the logo (e.g. "NEW BOOKING")
 * @param hero.title  big cream headline (e.g. the route name)
 * @param hero.chip   cream summary pill under the title
 */
function heroBand(hero = {}) {
  const badge = hero.badge
    ? `<div style="margin:0 0 16px;"><span style="display:inline-block;background:${C.salmon};color:${C.espresso};font:800 10px/1 ${FONT};letter-spacing:.18em;text-transform:uppercase;padding:7px 12px;border-radius:999px;">${escapeHtml(hero.badge)}</span></div>`
    : '';
  const title = hero.title
    ? `<div style="margin:16px 0 0;font:800 24px/1.2 ${FONT};color:${C.cream};">${escapeHtml(hero.title)}</div>`
    : '';
  const chip = hero.chip
    ? `<div style="margin:14px 0 0;"><span style="display:inline-block;background:${C.blush};color:${C.brown};font:700 13px/1.3 ${FONT};padding:9px 16px;border-radius:999px;">${escapeHtml(hero.chip)}</span></div>`
    : '';
  return `<tr><td style="background:linear-gradient(135deg,${C.espresso} 0%,${C.ink} 100%);padding:34px 30px 30px;text-align:center;">
    ${badge}
    ${logoImg()}
    <div style="margin-top:10px;font:600 11px/1.4 ${FONT};letter-spacing:.26em;color:rgba(255,245,238,.6);text-transform:uppercase;">Cocktail Walk</div>
    ${title}
    ${chip}
  </td></tr>`;
}

/**
 * The marketing poster, CONTAINED. Tall route posters read as a framed hero at
 * ~240px; the landscape fallback banner reads as a deliberate accent at the
 * same width. Sits on the cream body, just under the espresso band. Never
 * full-bleed — the content below must not be pushed past the fold.
 */
function posterBanner(route) {
  const url = posterUrlFor(route);
  const alt = `WOGO Cocktail Walk${route && route.city ? ' ' + route.city : ''}`;
  return `<tr><td style="background:${C.cream};padding:24px 30px 4px;text-align:center;">
    <img src="${escapeHtml(url)}" width="240" alt="${escapeHtml(alt)}" style="display:block;width:240px;max-width:100%;height:auto;margin:0 auto;border-radius:14px;border:1px solid ${C.line};">
  </td></tr>`;
}

/**
 * @param opts.preheader   hidden inbox-preview line
 * @param opts.hero        { badge?, title?, chip? } for the branded top band
 * @param opts.posterRoute route whose poster shows under the header (omit → none)
 * @param opts.heading     big heading inside the body (personal greeting)
 * @param opts.intro       one-line intro sentence
 * @param opts.contentHtml main body (already-safe HTML)
 * @param opts.footerHtml  optional footer note (already-safe HTML)
 */
function layout(opts) {
  const { preheader = '', hero = {}, posterRoute = null, heading = '', intro = '', contentHtml = '', footerHtml = '' } = opts;
  const poster = posterRoute ? posterBanner(posterRoute) : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(heading || 'WOGO Cocktail Walk')}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${C.cream};border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
      ${heroBand(hero)}
      ${poster}
      <!-- body -->
      <tr><td style="padding:26px 30px 30px;font-family:${FONT};color:${C.espresso};">
        ${heading ? `<h1 style="margin:0 0 8px;font-size:23px;line-height:1.25;font-weight:800;color:${C.ink};">${escapeHtml(heading)}</h1>` : ''}
        ${intro ? `<p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:${C.brown};">${escapeHtml(intro)}</p>` : ''}
        ${contentHtml}
      </td></tr>
      <!-- footer -->
      <tr><td style="padding:20px 30px 26px;border-top:1px solid ${C.line};font-family:${FONT};">
        ${footerHtml || ''}
        <p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:${C.muted};">
          WOGO Amsterdam B.V. · Amsterdam, Netherlands<br>
          <a href="https://www.wogococktailwalk.com" style="color:${C.salmonDeep};text-decoration:none;">wogococktailwalk.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Reusable "booking details" panel (label/value rows). rows = [[label, valueHtml], ...] */
function detailPanel(rows, accent) {
  const body = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:9px 0;font-size:13px;color:${C.muted};width:42%;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:9px 0;font-size:14px;font-weight:700;color:${C.ink};text-align:right;">${value}</td>
      </tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};border:1px solid ${C.line};border-left:4px solid ${accent || C.salmonDeep};border-radius:12px;padding:6px 18px;margin:0 0 22px;">
    ${body}
  </table>`;
}

/** A section heading used inside the body. */
function sectionTitle(text) {
  return `<h2 style="margin:26px 0 10px;font-size:15px;font-weight:800;color:${C.ink};">${escapeHtml(text)}</h2>`;
}

/** A quiet, untinted reference block: small heading + plain bullets. This is
 * the calm alternative to a loud tinted card — used for the guest email's
 * what's-included / good-to-know / how-it-works so nothing competes with the
 * one primary action. */
function quietSection(title, items) {
  const rows = items
    .map(
      (t) => `<tr><td style="padding:5px 0;font-size:14px;line-height:1.55;color:${C.brown};vertical-align:top;">
        <span style="color:${C.salmonDeep};font-weight:800;">&#8226;</span>&nbsp;&nbsp;${escapeHtml(t)}</td></tr>`
    )
    .join('');
  return `<h3 style="margin:0 0 6px;font-size:13px;font-weight:800;letter-spacing:.02em;color:${C.ink};text-transform:uppercase;">${escapeHtml(title)}</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">${rows}</table>`;
}

/** Plain bullet list (owner/internal use). */
function bulletList(items, accent) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 6px;">${items
    .map(
      (t) => `<tr><td style="padding:5px 0;font-size:14px;line-height:1.5;color:${C.brown};">
        <span style="color:${accent || C.salmonDeep};font-weight:800;">&#8226;</span>&nbsp;&nbsp;${escapeHtml(t)}</td></tr>`
    )
    .join('')}</table>`;
}

/** The single dominant salmon action button — full-width, unmissable. */
function primaryButton(href, label) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">
    <tr><td align="center" style="border-radius:14px;background:linear-gradient(135deg,${C.salmon} 0%,${C.salmonDeep} 100%);">
      <a href="${escapeHtml(href)}" style="display:block;padding:18px 26px;font-size:17px;font-weight:800;color:${C.espresso};text-decoration:none;text-align:center;letter-spacing:.01em;">${escapeHtml(label)} &rarr;</a>
    </td></tr>
  </table>`;
}

/** A quieter second action, stacked under primaryButton — outlined instead
 * of filled, so two buttons never fight for the reader's eye (used by the
 * review-request mail's "Review on Trustpilot" + "Review on Google" pair). */
function secondaryButton(href, label) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">
    <tr><td align="center" style="border-radius:14px;border:2px solid ${C.salmonDeep};">
      <a href="${escapeHtml(href)}" style="display:block;padding:16px 26px;font-size:16px;font-weight:800;color:${C.salmonDeep};text-decoration:none;text-align:center;letter-spacing:.01em;">${escapeHtml(label)} &rarr;</a>
    </td></tr>
  </table>`;
}

/** Guest free-text (bookings.notes) made safe for HTML: escaped, then the
 * textarea's newlines become <br> so multi-line notes keep their shape. */
function notesToHtml(notes) {
  return escapeHtml(String(notes)).replace(/\r?\n/g, '<br>');
}

const ALLERGIES_LABEL = { en: 'Allergies / notes:', nl: 'Allergieën / opmerkingen:' };

/**
 * The "⚠️ Allergies / notes" callout for the BAR and OWNER emails
 * (migrations/0010). Deliberately loud — amber panel, bold label — because
 * this is where "nut allergy" has to reach the person mixing the drinks.
 * Returns '' when the guest left the field blank: no notes, no block, no
 * empty label anywhere. `lang` (migrations/0022, additive — defaults 'en')
 * only localizes the label; the OWNER call site never passes it, so the
 * owner mail (EN-only) is byte-for-byte unchanged.
 */
function allergiesNotesBlock(notes, lang = 'en') {
  if (!notes || !String(notes).trim()) return '';
  const label = ALLERGIES_LABEL[lang] || ALLERGIES_LABEL.en;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.amberBg};border:1px solid ${C.amberLine};border-left:5px solid ${C.amberEdge};border-radius:12px;margin:0 0 22px;">
    <tr><td style="padding:14px 16px;">
      <div style="font-size:13px;font-weight:800;letter-spacing:.02em;color:${C.amberInk};">&#9888;&#65039; ${label}</div>
      <div style="margin-top:6px;font-size:14.5px;font-weight:700;line-height:1.5;color:${C.ink};">${notesToHtml(notes)}</div>
    </td></tr>
  </table>`;
}

function priceLine(booking, route) {
  const gross = (route.price_cents || 0) * (booking.party || 0);
  const disc = booking.discount_cents || 0;
  const net = Math.max(0, gross - disc);
  // migrations/0011: money is formatted in the ROUTE's own currency (defaults
  // to EUR so every existing NL route's emails are byte-for-byte unchanged).
  const currency = route.currency || 'EUR';
  if (disc > 0) {
    return `<span style="color:${C.muted};text-decoration:line-through;font-weight:600;">${escapeHtml(formatMoney(gross, currency))}</span>
      &nbsp;<span>${escapeHtml(formatMoney(net, currency))}</span>`;
  }
  return escapeHtml(formatMoney(net, currency));
}

// ---------------------------------------------------------------------------
// 1. GUEST confirmation (EN/NL) — the ONE guest email, rebuilt around a single
//    job: open the route map. Essentials → the big salmon map button (the one
//    dominant element) → calm reference material → warm sign-off. Map follows
//    the booking's language (map_url_nl for NL, map_url otherwise).
// ---------------------------------------------------------------------------

const GUEST_STRINGS = {
  en: {
    subject: (r) => `You're booked — ${r.city} Cocktail Walk 🍸`,
    preheader: 'Your tables are reserved. Everything for your night out is inside.',
    chip: (r) => `${r.city} · Self-guided cocktail walk`,
    heading: (n) => `You're booked${n ? ', ' + n : ''}! 🍸`,
    intro: 'Everything is arranged — your tables are held. Here are the essentials, your route map, and a few things worth knowing before you go.',
    labels: { route: 'Experience', date: 'Date', time: 'Start time', party: 'Guests', total: 'Total paid', ref: 'Booking ref', gift: 'Gift card' },
    includedTitle: "What's included",
    included: [
      'A reserved table waiting at every stop on your route',
      'One signature cocktail at each bar, from that bar’s own WOGO menu',
      "A curated walk through the city's most-loved hidden bars",
      'Nothing to organise on the night — just turn up and enjoy',
    ],
    mapTitle: 'Your route map',
    mapIntro: 'Your full itinerary lives here — the bars, the order, and each bar’s own WOGO cocktail menu.',
    mapButton: 'Open your route map',
    mapSave: 'Save this email — it’s the only place your full route lives.',
    goodToKnowTitle: 'Good to know',
    goodToKnow: [
      'Please start on time — the whole evening is built around your start time.',
      'Follow the bars in order, but walk between them at your own pace. Only the start time is fixed.',
      "Not every bar sends a separate confirmation — don't worry, they're all expecting you.",
    ],
    howItWorksTitle: 'How it works',
    howItWorks: [
      "On arrival, tell the staff you're doing the WOGO Cocktail Walk and how many you are.",
      "At each bar, everyone picks one cocktail from that bar's WOGO menu — it's included in your ticket.",
      'Fancy another drink or a bite? Go for it — extras are paid directly at the bar.',
    ],
    notesTitle: 'Your note to us',
    signoff: (city) => `Enjoy ${city} — one cocktail at a time!`,
    guests: (p) => `${p} ${p === 1 ? 'guest' : 'guests'}`,
    footer: 'Questions? Just reply to this email — we read every one.',
  },
  nl: {
    subject: (r) => `Je boeking is bevestigd — ${r.city} Cocktail Walk 🍸`,
    preheader: 'Je tafels staan gereserveerd. Alles voor je avondje uit staat hierin.',
    chip: (r) => `${r.city} · Zelfgeleide cocktail walk`,
    heading: (n) => `Je boeking is bevestigd${n ? ', ' + n : ''}! 🍸`,
    intro: 'Alles is geregeld — je tafels staan klaar. Hier zijn je gegevens, je routekaart en een paar dingen die handig zijn om te weten.',
    labels: { route: 'Ervaring', date: 'Datum', time: 'Starttijd', party: 'Gasten', total: 'Totaal betaald', ref: 'Boekingsnr.', gift: 'Cadeaubon' },
    includedTitle: 'Wat is inbegrepen',
    included: [
      'Een gereserveerde tafel bij elke stop op je route',
      'Eén signature cocktail in elke bar, van het eigen WOGO-menu van die bar',
      'Een uitgekiende wandeling langs de leukste verborgen bars van de stad',
      'Niets te regelen op de avond zelf — kom gewoon langs en geniet',
    ],
    mapTitle: 'Je routekaart',
    mapIntro: 'Je volledige route staat hier — de bars, de volgorde en het eigen WOGO-cocktailmenu van elke bar.',
    mapButton: 'Open je routekaart',
    mapSave: 'Bewaar deze e-mail — dit is de enige plek waar je volledige route staat.',
    goodToKnowTitle: 'Goed om te weten',
    goodToKnow: [
      'Begin op tijd — de hele avond is opgebouwd rond je starttijd.',
      'Volg de bars op volgorde, maar wandel er in je eigen tempo tussen. Alleen de starttijd ligt vast.',
      'Niet elke bar stuurt een aparte bevestiging — geen zorgen, ze verwachten je allemaal.',
    ],
    howItWorksTitle: 'Hoe werkt het?',
    howItWorks: [
      'Zeg bij aankomst tegen het personeel dat je de WOGO Cocktail Walk doet en met hoeveel jullie zijn.',
      'In elke bar kiest iedereen één cocktail van het WOGO-menu van die bar — inbegrepen bij je ticket.',
      "Zin in nog een drankje of een hapje? Doen — extra's reken je direct af bij de bar.",
    ],
    notesTitle: 'Je notitie aan ons',
    signoff: (city) => `Geniet van ${city} — één cocktail per keer!`,
    guests: (p) => `${p} ${p === 1 ? 'gast' : 'gasten'}`,
    footer: 'Vragen? Beantwoord gewoon deze e-mail — we lezen ze allemaal.',
  },
};

export function renderGuestConfirmation(booking, route, opts = {}) {
  const lang = loc(opts.locale || booking.locale);
  const t = GUEST_STRINGS[lang];
  const firstName = booking.name ? String(booking.name).trim().split(/\s+/)[0] : '';

  // Essentials — lean and scannable. Experience name carries the city, so no
  // separate city row; booking ref stays small.
  const rows = [
    [t.labels.route, escapeHtml(route.name)],
    [t.labels.date, escapeHtml(formatLongDate(booking.date, lang))],
    [t.labels.time, escapeHtml(booking.slot)],
    [t.labels.party, escapeHtml(t.guests(booking.party))],
    [t.labels.total, priceLine(booking, route)],
    [t.labels.ref, `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:${C.muted};">${escapeHtml(booking.id)}</span>`],
  ];
  // Gift-card redemption (migrations/0018/0019) — additive row, only when a
  // gift card actually reduced this booking's total; every booking without
  // one renders this exact same `rows` array as before this feature existed.
  if (booking.gift_applied_cents > 0) {
    rows.splice(rows.length - 1, 0, [
      t.labels.gift,
      `${escapeHtml(booking.gift_code || '')} &middot; &minus;${escapeHtml(formatMoney(booking.gift_applied_cents, route.currency || 'EUR'))}`,
    ]);
  }

  // Echo the guest's own allergies/notes back so they know we received it.
  // Omitted entirely when blank — no empty "Your note to us" label.
  const notesSection = booking.notes && String(booking.notes).trim()
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border-radius:12px;margin:0 0 22px;">
      <tr><td style="padding:14px 16px;font-size:13.5px;line-height:1.5;color:${C.brown};">
        <strong style="color:${C.ink};">${escapeHtml(t.notesTitle)}:</strong><br>${notesToHtml(booking.notes)}
      </td></tr>
    </table>`
    : '';

  // THE primary action — the route map — as the one tinted, dominant block in
  // the whole body. The owner makes SEPARATE English and Dutch map PDFs per
  // route (migrations/0012): a Dutch booking gets map_url_nl, falling back to
  // map_url when the Dutch one isn't set; every other locale gets map_url.
  // Rendered only when the chosen URL exists — no map ⇒ no section (and no
  // primary button for that variant, which is correct). Weekday-aware:
  // map_url_by_weekday can send a different map on a specific day (see resolveMapUrl).
  const mapUrl = resolveMapUrl(route, lang, booking.date);
  const mapSection = mapUrl
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border:1px solid ${C.line};border-radius:16px;margin:0 0 8px;">
      <tr><td style="padding:22px 20px;">
        <div style="font-size:17px;font-weight:800;color:${C.ink};margin:0 0 6px;">${escapeHtml(t.mapTitle)}</div>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:${C.brown};">${escapeHtml(t.mapIntro)}</p>
        ${primaryButton(mapUrl, t.mapButton)}
        <p style="margin:6px 0 0;font-size:12.5px;line-height:1.5;color:${C.muted};">${escapeHtml(t.mapSave)}</p>
      </td></tr>
    </table>`
    : '';

  const content = `
    ${detailPanel(rows, C.salmonDeep)}
    ${notesSection}${mapSection}
    <div style="border-top:1px solid ${C.line};margin:26px 0 22px;"></div>
    ${quietSection(t.goodToKnowTitle, t.goodToKnow)}
    ${quietSection(t.howItWorksTitle, t.howItWorks)}
    <p style="margin:8px 0 0;font-size:16px;line-height:1.5;font-weight:800;color:${C.ink};">${escapeHtml(t.signoff(route.city))}</p>`;

  return {
    subject: t.subject(route),
    html: layout({
      preheader: t.preheader,
      hero: { chip: t.chip(route) },
      posterRoute: route,
      heading: t.heading(firstName),
      intro: t.intro,
      contentHtml: content,
      footerHtml: `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.brown};">${escapeHtml(t.footer)}</p>`,
    }),
  };
}

// ---------------------------------------------------------------------------
// 2. OWNER / internal notification — EN. Every new booking, at a glance.
// ---------------------------------------------------------------------------

export function renderOwnerNotification(booking, route, opts = {}) {
  const arrivals = opts.arrivals || [];
  const discountCents = booking.discount_cents || 0;
  const discountCode = booking.discount_code || null;
  const source = booking.source === 'manual' ? 'Manual (phone booking)' : 'Website';

  const rows = [
    ['Experience', escapeHtml(route.name)],
    ['City', escapeHtml(route.city)],
    ['Date', escapeHtml(formatLongDate(booking.date, 'en'))],
    ['Start time', escapeHtml(booking.slot)],
    ['Party', `${escapeHtml(String(booking.party))} ${booking.party === 1 ? 'guest' : 'guests'}`],
    ['Revenue', priceLine(booking, route)],
    ['Source', escapeHtml(source)],
  ];
  if (discountCents > 0 || discountCode) {
    // Discount is always in the Checkout Session's own currency, i.e. the route's.
    rows.push([
      'Discount',
      `<span style="color:${C.salmonDeep};font-weight:800;">${escapeHtml(discountCode || 'code')}</span> &middot; &minus;${escapeHtml(formatMoney(discountCents, route.currency || 'EUR'))}`,
    ]);
  }
  if (booking.payment_status) {
    const label = { paid_invoice: 'Paid on invoice', free: 'Free', comp: 'Comp' }[booking.payment_status] || booking.payment_status;
    rows.push(['Payment', escapeHtml(label)]);
  }
  if (booking.gift_applied_cents > 0) {
    rows.push([
      'Gift card',
      `<span style="color:${C.salmonDeep};font-weight:800;">${escapeHtml(booking.gift_code || '')}</span> &middot; &minus;${escapeHtml(formatMoney(booking.gift_applied_cents, route.currency || 'EUR'))}`,
    ]);
  }

  const customerRows = [
    ['Name', escapeHtml(booking.name)],
    ['Email', `<a href="mailto:${escapeHtml(booking.email)}" style="color:${C.salmonDeep};text-decoration:none;">${escapeHtml(booking.email)}</a>`],
    ['Phone', booking.phone ? escapeHtml(booking.phone) : '&mdash;'],
    ['Language', escapeHtml((booking.locale || 'en').toUpperCase())],
  ];

  const arrivalsHtml = arrivals.length
    ? `${sectionTitle('Bar arrival times')}
       ${detailPanel(arrivals.map((a) => [a.bar_name, `<span style="font-variant-numeric:tabular-nums;">${escapeHtml(a.arrival_time)}</span>`]), C.brownSoft)}`
    : '';

  const content = `
    ${allergiesNotesBlock(booking.notes)}${detailPanel(rows, C.salmonDeep)}
    ${sectionTitle('Customer')}
    ${detailPanel(customerRows, C.brownSoft)}
    ${arrivalsHtml}`;

  return {
    subject: `New booking · ${route.city} ${booking.date} ${booking.slot} · ${booking.party}p`,
    html: layout({
      preheader: `${booking.name} — ${route.name} — ${booking.party} guests`,
      hero: { badge: 'New booking', title: route.name, chip: `${route.city} · ${booking.party} ${booking.party === 1 ? 'guest' : 'guests'}` },
      posterRoute: route,
      heading: 'You got a new booking!',
      intro: `A new ${source.toLowerCase()} booking just came in. Here it is at a glance.`,
      contentHtml: content,
    }),
  };
}

// ---------------------------------------------------------------------------
// 3. BAR notification — EN/NL (migrations/0022: bar.locale). ONE bar, its
//    concrete staggered arrival time. Branded top band, but ruthlessly
//    efficient: allergies flagged loudly ABOVE everything, then this bar's
//    OWN arrival time as a big hero. EN copy is verbatim unchanged from
//    before 0022; NL is the bar's own language, same warm/professional
//    "je/jullie" tone as the guest NL emails, written for bar staff.
// ---------------------------------------------------------------------------

const BAR_NOTIFICATION_STRINGS = {
  en: {
    badge: 'New WOGO reservation',
    heroTitle: (party, time) => `Table for ${party} at ${time}`,
    heading: (barName) => `Hi ${barName},`,
    intro: 'A WOGO Cocktail Walk group is on the way to you. Here is everything you need.',
    preheader: (party, time) => `Hold a table for ${party} at ${time}.`,
    subject: (time, party, date) => `WOGO reservation · ${time} · ${party} guests · ${date}`,
    arrivalLabel: 'Arrival time',
    tableCaption: (party, dateLong) => `Table for ${party} · ${dateLong}`,
    labels: { party: 'Party', route: 'Route', guestName: 'Guest name', guestContact: 'Guest contact' },
    guestWord: (p) => (p === 1 ? 'guest' : 'guests'),
    closing: (party, time) =>
      `Please hold a table for <strong>${party}</strong> at <strong>${time}</strong>. This is part of a WOGO Cocktail Walk — the group moves between bars on a staggered schedule across the evening, so this is <strong>your</strong> arrival time for them. Need to reach the guests? Use the contact details above.`,
  },
  nl: {
    badge: 'Nieuwe WOGO-reservering',
    heroTitle: (party, time) => `Tafel voor ${party} om ${time}`,
    heading: (barName) => `Hoi ${barName},`,
    intro: 'Er komt een WOGO Cocktail Walk groep naar jullie toe. Hier is alles wat je nodig hebt.',
    preheader: (party, time) => `Reserveer een tafel voor ${party} om ${time}.`,
    subject: (time, party, dateShortNl) => `WOGO reservering · ${time} · ${party} gasten · ${dateShortNl}`,
    arrivalLabel: 'Aankomsttijd',
    tableCaption: (party, dateLong) => `Tafel voor ${party} · ${dateLong}`,
    labels: { party: 'Gezelschap', route: 'Route', guestName: 'Naam gast', guestContact: 'Contact gast' },
    guestWord: (p) => (p === 1 ? 'gast' : 'gasten'),
    closing: (party, time) =>
      `Reserveer alsjeblieft een tafel voor <strong>${party}</strong> om <strong>${time}</strong>. Dit is onderdeel van een WOGO Cocktail Walk: de groep bezoekt de bars volgens een vast schema, dus dit is <strong>jullie</strong> aankomsttijd. Wil je de gasten bereiken? Gebruik de contactgegevens hierboven.`,
  },
};

export function renderBarNotification(bar, booking, route) {
  const lang = bar.locale === 'en' ? 'en' : 'nl';
  const t = BAR_NOTIFICATION_STRINGS[lang];

  // Direct guest contact so the bar can reach the group that evening:
  // always the email, plus the phone when the guest left one.
  const guestContact =
    `<a href="mailto:${escapeHtml(booking.email)}" style="color:${C.salmonDeep};text-decoration:none;">${escapeHtml(booking.email)}</a>` +
    (booking.phone ? ` &middot; ${escapeHtml(booking.phone)}` : '');

  // The arrival time is the hero — a big, unmissable number. The label
  // "Arrival time"/"Aankomsttijd" lives here (bar detail label the tests pin).
  const arrivalHero = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border:1px solid ${C.line};border-radius:16px;margin:0 0 22px;">
    <tr><td style="padding:22px 24px;text-align:center;">
      <div style="font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${C.brown};">${escapeHtml(t.arrivalLabel)}</div>
      <div style="margin-top:6px;font-size:46px;line-height:1;font-weight:800;color:${C.salmonDeep};font-variant-numeric:tabular-nums;">${escapeHtml(bar.arrival_time)}</div>
      <div style="margin-top:10px;font-size:14px;font-weight:700;color:${C.ink};">${escapeHtml(t.tableCaption(String(booking.party), formatLongDate(booking.date, lang)))}</div>
    </td></tr>
  </table>`;

  const rows = [
    [t.labels.party, `${escapeHtml(String(booking.party))} ${t.guestWord(booking.party)}`],
    [t.labels.route, escapeHtml(route.name)],
    [t.labels.guestName, escapeHtml(booking.name)],
    [t.labels.guestContact, guestContact],
  ];

  // The allergies/notes block goes FIRST — above even the arrival hero — so
  // bar staff scanning the email can't miss "nut allergy" (the entire reason
  // this field exists). Empty notes ⇒ no block at all.
  const content = `
    ${allergiesNotesBlock(booking.notes, lang)}${arrivalHero}
    ${detailPanel(rows, C.salmonDeep)}
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${C.brown};">
      ${t.closing(escapeHtml(String(booking.party)), escapeHtml(bar.arrival_time))}
    </p>`;

  return {
    // EN subject keeps the raw ISO booking.date, unchanged since before 0022.
    // NL uses a short human date (migrations/0022 — matches the owner's spec,
    // "10 oktober 2026" rather than the raw ISO string).
    subject: lang === 'nl'
      ? t.subject(bar.arrival_time, booking.party, formatShortDate(booking.date, 'nl'))
      : t.subject(bar.arrival_time, booking.party, booking.date),
    html: layout({
      preheader: t.preheader(booking.party, bar.arrival_time),
      // hero.chip is escaped once by heroBand() itself (src/emails.js ~122) —
      // pre-escaping bar.bar_name here would double-escape it (e.g. an
      // apostrophe in "Let's Meat" would render as "Let&#39;s Meat").
      hero: { badge: t.badge, title: t.heroTitle(booking.party, bar.arrival_time), chip: `${bar.bar_name} · ${route.city}` },
      posterRoute: route,
      heading: t.heading(bar.bar_name),
      intro: t.intro,
      contentHtml: content,
    }),
  };
}

// ---------------------------------------------------------------------------
// 4. OWNER conflict alert — EN. Guest paid but the seat was gone (§6.4).
//    Branded logo header to match the family; no marketing poster here — a
//    poster works against what this urgent "act now" alert needs to do.
// ---------------------------------------------------------------------------

export function renderOwnerConflict(booking, route) {
  const rows = [
    ['Booking ref', `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;">${escapeHtml(booking.id)}</span>`],
    ['Experience', escapeHtml(route.name)],
    ['Date', escapeHtml(formatLongDate(booking.date, 'en'))],
    ['Start time', escapeHtml(booking.slot)],
    ['Party', `${escapeHtml(String(booking.party))} guests`],
    ['Guest', `${escapeHtml(booking.name)} &middot; ${escapeHtml(booking.email)}`],
  ];
  const content = `
    ${detailPanel(rows, '#8a3f6b')}
    <p style="margin:0;font-size:14px;line-height:1.55;color:${C.brown};">
      This guest completed payment, but the seat had already been resold in the short window
      after their hold expired. <strong>Action needed:</strong> offer them an alternate slot,
      or refund via the Stripe dashboard.
    </p>`;
  return {
    // Subject is plain text (no HTML entities decoded by a mail client's
    // subject line) — use the real character, not an HTML entity.
    subject: `⚠ Double-booked — ${booking.id}`,
    html: layout({
      preheader: 'A paid booking could not be seated — resolve by hand.',
      hero: { badge: 'Action needed', title: 'Double-booked', chip: `${route.city} · ${booking.date} ${booking.slot}` },
      heading: 'Double-booked — action needed',
      intro: 'A guest paid but their seat was gone. Please resolve this one personally.',
      contentHtml: content,
    }),
  };
}

// ---------------------------------------------------------------------------
// 5 & 6. RESCHEDULE + CANCELLATION (guest EN/NL, bar EN). A reschedule keeps
//    the SAME route + price — only the date/time change. A cancellation is the
//    rare exception to the no-cancellation policy, so the tone stays warm and
//    never preachy about the rule. Any refund/exception wording is passed in by
//    the owner per-case (opts.message) — these templates never promise a refund.
// ---------------------------------------------------------------------------

const RESCHEDULE_STRINGS = {
  en: {
    subject: (r) => `Your booking has moved — ${r.city} Cocktail Walk 🍸`,
    preheader: 'New date and time confirmed — here are your updated details.',
    chip: (r) => `${r.city} · Self-guided cocktail walk`,
    heading: (n) => `Your booking has moved${n ? ', ' + n : ''} 🍸`,
    intro: 'No problem — we’ve moved your Cocktail Walk to the new date and time below. Everything else stays exactly the same.',
    wasLabel: 'Previously',
    labels: { route: 'Experience', date: 'New date', time: 'New start time', party: 'Guests', ref: 'Booking ref' },
    signoff: (city) => `See you in ${city} — one cocktail at a time!`,
    footer: 'Didn’t request this change? Just reply to this email and we’ll sort it out.',
  },
  nl: {
    subject: (r) => `Je boeking is verzet — ${r.city} Cocktail Walk 🍸`,
    preheader: 'Nieuwe datum en tijd bevestigd — hier zijn je bijgewerkte gegevens.',
    chip: (r) => `${r.city} · Zelfgeleide cocktail walk`,
    heading: (n) => `Je boeking is verzet${n ? ', ' + n : ''} 🍸`,
    intro: 'Geen probleem — we hebben je Cocktail Walk verzet naar de nieuwe datum en tijd hieronder. De rest blijft precies hetzelfde.',
    wasLabel: 'Voorheen',
    labels: { route: 'Ervaring', date: 'Nieuwe datum', time: 'Nieuwe starttijd', party: 'Gasten', ref: 'Boekingsnr.' },
    signoff: (city) => `Tot in ${city} — één cocktail per keer!`,
    footer: 'Deze wijziging niet aangevraagd? Beantwoord deze e-mail en we lossen het op.',
  },
};

const CANCEL_STRINGS = {
  en: {
    subject: (r) => `Your booking has been cancelled — ${r.city} Cocktail Walk`,
    preheader: 'Confirmation that your Cocktail Walk booking has been cancelled.',
    chip: (r) => `${r.city} · Cocktail walk`,
    heading: 'Your booking has been cancelled',
    intro: 'We’ve cancelled the booking below. We’re sorry we won’t see you this time — we’d love to welcome you on another evening.',
    labels: { route: 'Experience', date: 'Date', time: 'Start time', party: 'Guests', ref: 'Booking ref' },
    footer: 'Questions? Just reply to this email — we read every one.',
  },
  nl: {
    subject: (r) => `Je boeking is geannuleerd — ${r.city} Cocktail Walk`,
    preheader: 'Bevestiging dat je Cocktail Walk-boeking is geannuleerd.',
    chip: (r) => `${r.city} · Cocktail walk`,
    heading: 'Je boeking is geannuleerd',
    intro: 'We hebben onderstaande boeking geannuleerd. Jammer dat het deze keer niet doorgaat — we verwelkomen je graag op een andere avond.',
    labels: { route: 'Ervaring', date: 'Datum', time: 'Starttijd', party: 'Gasten', ref: 'Boekingsnr.' },
    footer: 'Vragen? Beantwoord gewoon deze e-mail — we lezen ze allemaal.',
  },
};

/** The route map for a booking's language AND weekday. A route may set
 * map_url_by_weekday = {"4":{"en":"…","nl":"…"}} (ISO weekday Mon=1..Sun=7) to
 * send a DIFFERENT map on a specific day — e.g. a Thursday line-up with an extra
 * bar (1NUL8). Falls back to the route's normal map_url / map_url_nl. */
function resolveMapUrl(route, lang, dateStr) {
  let byDay = null;
  try { byDay = route.map_url_by_weekday ? JSON.parse(route.map_url_by_weekday) : null; } catch (e) { byDay = null; }
  const day = (byDay && dateStr) ? byDay[String(isoWeekday(dateStr))] : null;
  // If only one language of the day-specific map exists, prefer the OTHER
  // language's SAME-DAY map (correct bars) over the wrong-day default.
  if (day) return lang === 'nl' ? (day.nl || day.en || route.map_url_nl || route.map_url) : (day.en || day.nl || route.map_url);
  return lang === 'nl' ? (route.map_url_nl || route.map_url) : route.map_url;
}

/** The blush route-map card (title + intro + primary button + save note),
 * shared by the confirmation and the reschedule email. Renders only when the
 * route has a map for this language + day (see resolveMapUrl). */
function guestMapSection(gt, route, lang, dateStr) {
  const mapUrl = resolveMapUrl(route, lang, dateStr);
  if (!mapUrl) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border:1px solid ${C.line};border-radius:16px;margin:0 0 8px;">
      <tr><td style="padding:22px 20px;">
        <div style="font-size:17px;font-weight:800;color:${C.ink};margin:0 0 6px;">${escapeHtml(gt.mapTitle)}</div>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:${C.brown};">${escapeHtml(gt.mapIntro)}</p>
        ${primaryButton(mapUrl, gt.mapButton)}
        <p style="margin:6px 0 0;font-size:12.5px;line-height:1.5;color:${C.muted};">${escapeHtml(gt.mapSave)}</p>
      </td></tr>
    </table>`;
}

// --- 5. GUEST reschedule (EN/NL) -------------------------------------------
// booking = the NEW state (new date/slot). opts.previous = { date, slot } is
// the old one, shown struck-through so the guest sees exactly what changed.
export function renderGuestReschedule(booking, route, opts = {}) {
  const lang = loc(opts.locale || booking.locale);
  const t = RESCHEDULE_STRINGS[lang];
  const gt = GUEST_STRINGS[lang];
  const firstName = booking.name ? String(booking.name).trim().split(/\s+/)[0] : '';
  const prev = opts.previous || {};
  const wasLine = (prev.date || prev.slot)
    ? `<p style="margin:0 0 14px;font-size:13.5px;color:${C.muted};"><span style="text-transform:uppercase;letter-spacing:.08em;font-weight:800;font-size:11px;">${escapeHtml(t.wasLabel)}:</span> <span style="text-decoration:line-through;">${escapeHtml(formatLongDate(prev.date || booking.date, lang))}${prev.slot ? ' · ' + escapeHtml(prev.slot) : ''}</span></p>`
    : '';
  const rows = [
    [t.labels.route, escapeHtml(route.name)],
    [t.labels.date, escapeHtml(formatLongDate(booking.date, lang))],
    [t.labels.time, escapeHtml(booking.slot)],
    [t.labels.party, escapeHtml(gt.guests(booking.party))],
    [t.labels.ref, `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:${C.muted};">${escapeHtml(booking.id)}</span>`],
  ];
  const content = `
    ${wasLine}
    ${detailPanel(rows, C.salmonDeep)}
    ${guestMapSection(gt, route, lang, booking.date)}
    <p style="margin:18px 0 0;font-size:16px;line-height:1.5;font-weight:800;color:${C.ink};">${escapeHtml(t.signoff(route.city))}</p>`;
  return {
    subject: t.subject(route),
    html: layout({
      preheader: t.preheader,
      hero: { chip: t.chip(route) },
      posterRoute: route,
      heading: t.heading(firstName),
      intro: t.intro,
      contentHtml: content,
      footerHtml: `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.brown};">${escapeHtml(t.footer)}</p>`,
    }),
  };
}

// --- 5b. BAR reschedule (EN/NL — migrations/0022: bar.locale) --------------
// bar.arrival_time = the NEW arrival time. opts.previous = { date, arrival_time }
// is this bar's OLD slot, so staff know which table to release.

const BAR_RESCHEDULE_STRINGS = {
  en: {
    badge: 'Reservation moved',
    heroTitle: (time) => `New time ${time}`,
    heading: (barName) => `Hi ${barName},`,
    intro: 'A WOGO reservation has been rescheduled. Here is the new arrival time.',
    preheader: (party, time) => `Moved: now hold a table for ${party} at ${time}.`,
    subject: (time, date, party) => `WOGO reservation MOVED · now ${time} · ${date} · ${party} guests`,
    arrivalLabel: 'New arrival time',
    tableCaption: (party, dateLong) => `Table for ${party} · ${dateLong}`,
    labels: { party: 'Party', route: 'Route', guestName: 'Guest name', guestContact: 'Guest contact' },
    guestWord: (p) => (p === 1 ? 'guest' : 'guests'),
    wasLabel: 'Was:',
    wasSuffix: '— please release that table.',
    closing: 'This WOGO reservation has <strong>moved</strong>. Please release the earlier table and hold the new one shown above. Need to reach the guests? Use the contact details above.',
  },
  nl: {
    badge: 'Reservering verplaatst',
    heroTitle: (time) => `Nieuwe tijd ${time}`,
    heading: (barName) => `Hoi ${barName},`,
    intro: 'Een WOGO-reservering is verzet. Hier is de nieuwe aankomsttijd.',
    preheader: (party, time) => `Verplaatst: reserveer nu een tafel voor ${party} om ${time}.`,
    subject: (time, dateShortNl) => `WOGO reservering VERPLAATST · nu ${time} · ${dateShortNl}`,
    arrivalLabel: 'Nieuwe aankomsttijd',
    tableCaption: (party, dateLong) => `Tafel voor ${party} · ${dateLong}`,
    labels: { party: 'Gezelschap', route: 'Route', guestName: 'Naam gast', guestContact: 'Contact gast' },
    guestWord: (p) => (p === 1 ? 'gast' : 'gasten'),
    wasLabel: 'Was:',
    wasSuffix: 'je mag die tafel vrijgeven.',
    closing: 'Deze WOGO-reservering is <strong>verplaatst</strong>. Maak de eerdere tafel vrij en reserveer de nieuwe tafel hierboven. Wil je de gasten bereiken? Gebruik de contactgegevens hierboven.',
  },
};

export function renderBarReschedule(bar, booking, route, opts = {}) {
  const lang = bar.locale === 'en' ? 'en' : 'nl';
  const t = BAR_RESCHEDULE_STRINGS[lang];

  const guestContact =
    `<a href="mailto:${escapeHtml(booking.email)}" style="color:${C.salmonDeep};text-decoration:none;">${escapeHtml(booking.email)}</a>` +
    (booking.phone ? ` &middot; ${escapeHtml(booking.phone)}` : '');
  const prev = opts.previous || {};
  const wasLine = (prev.date || prev.arrival_time)
    ? `<p style="margin:0 0 14px;font-size:13.5px;color:${C.muted};"><strong style="color:${C.ink};">${escapeHtml(t.wasLabel)}</strong> <span style="text-decoration:line-through;">${escapeHtml(formatLongDate(prev.date || booking.date, lang))}${prev.arrival_time ? ' · ' + escapeHtml(prev.arrival_time) : ''}</span> ${escapeHtml(t.wasSuffix)}</p>`
    : '';
  const arrivalHero = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border:1px solid ${C.line};border-radius:16px;margin:0 0 22px;">
    <tr><td style="padding:22px 24px;text-align:center;">
      <div style="font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${C.brown};">${escapeHtml(t.arrivalLabel)}</div>
      <div style="margin-top:6px;font-size:46px;line-height:1;font-weight:800;color:${C.salmonDeep};font-variant-numeric:tabular-nums;">${escapeHtml(bar.arrival_time)}</div>
      <div style="margin-top:10px;font-size:14px;font-weight:700;color:${C.ink};">${escapeHtml(t.tableCaption(String(booking.party), formatLongDate(booking.date, lang)))}</div>
    </td></tr>
  </table>`;
  const rows = [
    [t.labels.party, `${escapeHtml(String(booking.party))} ${t.guestWord(booking.party)}`],
    [t.labels.route, escapeHtml(route.name)],
    [t.labels.guestName, escapeHtml(booking.name)],
    [t.labels.guestContact, guestContact],
  ];
  const content = `
    ${allergiesNotesBlock(booking.notes, lang)}${wasLine}${arrivalHero}
    ${detailPanel(rows, C.salmonDeep)}
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${C.brown};">
      ${t.closing}
    </p>`;
  return {
    // EN subject keeps the raw ISO booking.date + guest count, unchanged
    // since before 0022. NL uses the owner's exact spec: no guest count, a
    // short human date (migrations/0022).
    subject: lang === 'nl'
      ? t.subject(bar.arrival_time, formatShortDate(booking.date, 'nl'))
      : t.subject(bar.arrival_time, booking.date, booking.party),
    html: layout({
      preheader: t.preheader(booking.party, bar.arrival_time),
      // hero.chip is escaped once by heroBand() — see the doc comment above
      // the identical pattern in the bar-arrival email.
      hero: { badge: t.badge, title: t.heroTitle(bar.arrival_time), chip: `${bar.bar_name} · ${route.city}` },
      posterRoute: route,
      heading: t.heading(bar.bar_name),
      intro: t.intro,
      contentHtml: content,
    }),
  };
}

// --- 6. GUEST cancellation (EN/NL) -----------------------------------------
// opts.message (optional): the owner's own note for this case — e.g. refund
// wording for a granted exception. Rendered escaped when present; never assumed.
export function renderGuestCancellation(booking, route, opts = {}) {
  const lang = loc(opts.locale || booking.locale);
  const t = CANCEL_STRINGS[lang];
  const gt = GUEST_STRINGS[lang];
  const rows = [
    [t.labels.route, escapeHtml(route.name)],
    [t.labels.date, escapeHtml(formatLongDate(booking.date, lang))],
    [t.labels.time, escapeHtml(booking.slot)],
    [t.labels.party, escapeHtml(gt.guests(booking.party))],
    [t.labels.ref, `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:${C.muted};">${escapeHtml(booking.id)}</span>`],
  ];
  const noteBox = opts.message && String(opts.message).trim()
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border-radius:12px;margin:0 0 8px;">
      <tr><td style="padding:14px 16px;font-size:13.5px;line-height:1.5;color:${C.brown};">${notesToHtml(opts.message)}</td></tr>
    </table>`
    : '';
  const content = `
    ${detailPanel(rows, '#8a3f6b')}
    ${noteBox}`;
  return {
    subject: t.subject(route),
    html: layout({
      preheader: t.preheader,
      hero: { chip: t.chip(route) },
      posterRoute: route,
      heading: t.heading,
      intro: t.intro,
      contentHtml: content,
      footerHtml: `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.brown};">${escapeHtml(t.footer)}</p>`,
    }),
  };
}

// --- 6b. BAR cancellation (EN/NL — migrations/0022: bar.locale) ------------
// bar.arrival_time = the arrival time of the reservation being released.

const BAR_CANCEL_STRINGS = {
  en: {
    badge: 'Reservation cancelled',
    heroTitle: 'Table released',
    heading: (barName) => `Hi ${barName},`,
    intro: 'A WOGO reservation has been cancelled — here are the details so you can free the table.',
    preheader: (party, time) => `Cancelled: you can release the ${time} table for ${party}.`,
    subject: (date, time, party) => `WOGO reservation CANCELLED · ${date} ${time} · ${party} guests`,
    labels: { date: 'Date', time: 'Time', party: 'Party', guestName: 'Guest name' },
    guestWord: (p) => (p === 1 ? 'guest' : 'guests'),
    closing: 'This WOGO reservation has been <strong>cancelled</strong> — you can release the table above. Nothing else is needed on your side.',
  },
  nl: {
    badge: 'Reservering geannuleerd',
    heroTitle: 'Tafel vrijgegeven',
    heading: (barName) => `Hoi ${barName},`,
    intro: 'Een WOGO-reservering is geannuleerd. Hier zijn de gegevens zodat je de tafel kunt vrijgeven.',
    preheader: (party, time) => `Geannuleerd: je mag de tafel van ${time} voor ${party} vrijgeven.`,
    subject: (dateShortNl, time, party) => `WOGO reservering GEANNULEERD · ${dateShortNl} ${time} · ${party} gasten`,
    labels: { date: 'Datum', time: 'Tijd', party: 'Gezelschap', guestName: 'Naam gast' },
    guestWord: (p) => (p === 1 ? 'gast' : 'gasten'),
    closing: 'Deze WOGO-reservering is <strong>geannuleerd</strong>. Je mag de tafel hierboven vrijgeven. Verder hoef je niets te doen.',
  },
};

export function renderBarCancellation(bar, booking, route) {
  const lang = bar.locale === 'en' ? 'en' : 'nl';
  const t = BAR_CANCEL_STRINGS[lang];

  const rows = [
    [t.labels.date, escapeHtml(formatLongDate(booking.date, lang))],
    [t.labels.time, `<span style="font-variant-numeric:tabular-nums;">${escapeHtml(bar.arrival_time)}</span>`],
    [t.labels.party, `${escapeHtml(String(booking.party))} ${t.guestWord(booking.party)}`],
    [t.labels.guestName, escapeHtml(booking.name)],
  ];
  const content = `
    ${detailPanel(rows, '#8a3f6b')}
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${C.brown};">
      ${t.closing}
    </p>`;
  return {
    // EN subject keeps the raw ISO booking.date, unchanged since before 0022.
    // NL uses a short human date (migrations/0022).
    subject: lang === 'nl'
      ? t.subject(formatShortDate(booking.date, 'nl'), bar.arrival_time, booking.party)
      : t.subject(booking.date, bar.arrival_time, booking.party),
    html: layout({
      preheader: t.preheader(booking.party, bar.arrival_time),
      // hero.chip is escaped once by heroBand() — see the doc comment above
      // the identical pattern in the bar-arrival email.
      hero: { badge: t.badge, title: t.heroTitle, chip: `${bar.bar_name} · ${route.city}` },
      heading: t.heading(bar.bar_name),
      intro: t.intro,
      contentHtml: content,
    }),
  };
}

// ---------------------------------------------------------------------------
// 7, 8 & 9. GIFT CARDS (migrations/0018/0019) — EN/NL.
//   7. RECIPIENT — the actual gift, built around the code + how to use it.
//   8. BUYER     — a short receipt confirming delivery.
//   9. OWNER redemption alert — the rare "balance guard failed" edge case.
// ---------------------------------------------------------------------------

/** Big salmon monospace code block, echoing arrivalHero's "one dominant
 * number" shape from the bar emails — a gift-card code is the one thing this
 * email exists to deliver, so it gets the same visual weight. */
function codeHero(code, amountLabel) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border:1px solid ${C.line};border-radius:16px;margin:0 0 22px;">
    <tr><td style="padding:22px 24px;text-align:center;">
      <div style="font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${C.brown};">Gift card code</div>
      <div style="margin-top:6px;font-size:30px;line-height:1.25;font-weight:800;color:${C.salmonDeep};font-family:ui-monospace,Menlo,monospace;letter-spacing:.03em;">${escapeHtml(code)}</div>
      <div style="margin-top:10px;font-size:15px;font-weight:700;color:${C.ink};">${escapeHtml(amountLabel)}</div>
    </td></tr>
  </table>`;
}

const GIFT_STRINGS = {
  en: {
    subjectRecipient: (amt) => `You've received a WOGO Gift Card worth ${amt}! 🎁`,
    preheaderRecipient: 'A cocktail walk gift card is waiting for you.',
    chip: 'Gift card',
    headingRecipient: (name) => `You've been gifted a Cocktail Walk${name ? ', ' + name : ''}! 🎁`,
    introRecipient: (buyer) => `${buyer} sent you a WOGO Gift Card — redeemable on any WOGO Cocktail Walk, in any city.`,
    balanceLabel: 'Value',
    howTitle: 'How to use it',
    how: [
      'Pick any WOGO Cocktail Walk, in any city.',
      'At checkout, enter your gift card code in the "Gift card code" field.',
      'The value is deducted from your total automatically — pay only the difference, if any.',
    ],
    bookButton: 'Book your Cocktail Walk',
    messageTitle: 'A message for you',
    footer: 'Questions about your gift card? Just reply to this email.',
    subjectBuyer: (name) => `Your WOGO Gift Card for ${name} is on its way ✅`,
    headingBuyer: 'Your gift card is on its way!',
    introBuyer: (recipient) => `Thanks for the gift! We've emailed the WOGO Gift Card straight to ${recipient}.`,
    rowRecipient: 'Recipient',
    rowAmount: 'Amount',
    rowCode: 'Code',
  },
  nl: {
    subjectRecipient: (amt) => `Je hebt een WOGO Cadeaubon ter waarde van ${amt} ontvangen! 🎁`,
    preheaderRecipient: 'Er wacht een cadeaubon voor een cocktail walk op je.',
    chip: 'Cadeaubon',
    headingRecipient: (name) => `Je hebt een Cocktail Walk cadeau gekregen${name ? ', ' + name : ''}! 🎁`,
    introRecipient: (buyer) => `${buyer} heeft je een WOGO Cadeaubon gestuurd — inwisselbaar voor elke WOGO Cocktail Walk, in elke stad.`,
    balanceLabel: 'Waarde',
    howTitle: 'Zo gebruik je hem',
    how: [
      'Kies een WOGO Cocktail Walk, in een stad naar keuze.',
      'Vul bij het afrekenen je cadeaubon-code in bij het veld "Cadeaubon-code".',
      'De waarde wordt automatisch van je totaal afgetrokken — je betaalt alleen het verschil, als dat er is.',
    ],
    bookButton: 'Boek je Cocktail Walk',
    messageTitle: 'Een bericht voor jou',
    footer: 'Vragen over je cadeaubon? Beantwoord gewoon deze e-mail.',
    subjectBuyer: (name) => `Je WOGO Cadeaubon voor ${name} is onderweg ✅`,
    headingBuyer: 'Je cadeaubon is onderweg!',
    introBuyer: (recipient) => `Bedankt voor het cadeau! We hebben de WOGO Cadeaubon rechtstreeks naar ${recipient} gestuurd.`,
    rowRecipient: 'Ontvanger',
    rowAmount: 'Bedrag',
    rowCode: 'Code',
  },
};

function giftLocale(giftCard, opts) {
  return loc((opts && opts.locale) || (giftCard && giftCard.locale));
}

/** 7. The gift itself — sent to the RECIPIENT once the purchase Checkout
 * Session completes (src/webhook.js:handleGiftCardPurchaseCompleted). */
export function renderGiftCardRecipient(giftCard, opts = {}) {
  const lang = giftLocale(giftCard, opts);
  const t = GIFT_STRINGS[lang];
  const firstName = giftCard.recipient_name ? String(giftCard.recipient_name).trim().split(/\s+/)[0] : '';
  const buyerName = giftCard.buyer_name || (lang === 'nl' ? 'Iemand' : 'Someone');
  const amount = formatMoney(giftCard.balance_cents, giftCard.currency || 'EUR');

  const messageSection = giftCard.message && String(giftCard.message).trim()
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border-radius:12px;margin:0 0 22px;">
        <tr><td style="padding:14px 16px;font-size:14px;line-height:1.55;color:${C.brown};">
          <strong style="color:${C.ink};">${escapeHtml(t.messageTitle)}:</strong><br>${notesToHtml(giftCard.message)}
        </td></tr>
      </table>`
    : '';

  const content = `
    ${codeHero(giftCard.code, `${t.balanceLabel}: ${amount}`)}
    ${messageSection}
    ${primaryButton(`${SITE_URL}/`, t.bookButton)}
    ${quietSection(t.howTitle, t.how)}`;

  return {
    subject: t.subjectRecipient(amount),
    html: layout({
      preheader: t.preheaderRecipient,
      hero: { chip: t.chip },
      heading: t.headingRecipient(firstName),
      intro: t.introRecipient(buyerName),
      contentHtml: content,
      footerHtml: `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.brown};">${escapeHtml(t.footer)}</p>`,
    }),
  };
}

/** 8. A short receipt to the BUYER confirming delivery — no code shown here
 * beyond a small reference line; the recipient's copy is the "real" one. */
export function renderGiftCardBuyer(giftCard, opts = {}) {
  const lang = giftLocale(giftCard, opts);
  const t = GIFT_STRINGS[lang];
  const amount = formatMoney(giftCard.initial_cents, giftCard.currency || 'EUR');
  const recipientLabel = giftCard.recipient_name || giftCard.recipient_email;
  const rows = [
    [t.rowRecipient, escapeHtml(recipientLabel)],
    [t.rowAmount, escapeHtml(amount)],
    [t.rowCode, `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:${C.muted};">${escapeHtml(giftCard.code)}</span>`],
  ];
  const content = `${detailPanel(rows, C.salmonDeep)}`;
  return {
    subject: t.subjectBuyer(recipientLabel),
    html: layout({
      preheader: t.introBuyer(giftCard.recipient_email),
      hero: { chip: t.chip },
      heading: t.headingBuyer,
      intro: t.introBuyer(giftCard.recipient_email),
      contentHtml: content,
    }),
  };
}

/** 9. OWNER alert — the rare case where a paid booking's gift-card deduction
 * couldn't be applied automatically (src/webhook.js:applyGiftCardRedemption).
 * The guest already paid the reduced Stripe amount either way; this is a
 * bookkeeping reconciliation ask, not a guest-facing problem. EN only, same
 * as every other internal/owner mail in this file. */
export function renderGiftCardRedemptionAlert(booking, result) {
  const giftCard = result && result.gift_card;
  const rows = [
    ['Booking ref', `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;">${escapeHtml(booking.id)}</span>`],
    ['Gift code', escapeHtml(booking.gift_code || '')],
    ['Amount that failed', escapeHtml(formatMoney(booking.gift_applied_cents || 0, (giftCard && giftCard.currency) || 'EUR'))],
    ['Current balance', giftCard ? escapeHtml(formatMoney(giftCard.balance_cents, giftCard.currency || 'EUR')) : 'unknown — card not found'],
    ['Reason', escapeHtml((result && result.status) || 'unknown')],
    ['Guest', `${escapeHtml(booking.name)} &middot; ${escapeHtml(booking.email)}`],
  ];
  const content = `
    ${detailPanel(rows, '#8a3f6b')}
    <p style="margin:0;font-size:14px;line-height:1.55;color:${C.brown};">
      This guest's booking was paid and confirmed — their Stripe charge already reflects the
      applied gift-card amount — but the gift card's balance could not be deducted automatically.
      Please reconcile the gift card balance by hand.
    </p>`;
  return {
    // Subject is plain text — see the doc comment on the double-booked
    // subject above.
    subject: `⚠ Gift card redemption needs attention — ${booking.id}`,
    html: layout({
      preheader: 'A paid booking needs its gift card balance reconciled by hand.',
      // hero.chip is escaped once by heroBand() — see the doc comment above
      // the identical pattern in the bar-arrival email, ~line 559.
      hero: { badge: 'Action needed', title: 'Gift card redemption issue', chip: `${booking.date} ${booking.slot}` },
      heading: 'Gift card redemption needs attention',
      intro: 'A guest paid with a gift card discount, but the balance could not be automatically deducted.',
      contentHtml: content,
    }),
  };
}

// ---------------------------------------------------------------------------
// 10 & 11. Contact / group-booking inquiries (migrations/0021, audit item 9)
//   10. OWNER notification — the whole inquiry at a glance; reply-to is set
//       to the guest by the caller (src/guest_api.js), not rendered here.
//   11. GUEST auto-acknowledgement — EN/NL, short: "we got it, 1 working day".
// ---------------------------------------------------------------------------

/** 10. OWNER notification for a new contact/group inquiry. EN only, like
 * every other internal mail in this file. Subject shape matches SETUP.md's
 * documented contract exactly: a 'group' inquiry leads with the trip details
 * (city/date/party — the thing the owner scans for first), a plain 'contact'
 * message leads with who it's from. */
export function renderInquiryOwnerNotification(inquiry) {
  const isGroup = inquiry.kind === 'group';
  const subject = isGroup
    ? `Group booking request · ${inquiry.city || 'unknown city'} · ${inquiry.date || 'no date'} · ${inquiry.party_size != null ? inquiry.party_size + 'p' : '?p'}`
    : `Contact form · ${inquiry.name}`;

  const rows = [
    ['Kind', escapeHtml(isGroup ? 'Group booking request' : 'Contact message')],
    ['Name', escapeHtml(inquiry.name)],
    ['Email', `<a href="mailto:${escapeHtml(inquiry.email)}" style="color:${C.salmonDeep};text-decoration:none;">${escapeHtml(inquiry.email)}</a>`],
  ];
  if (inquiry.phone) rows.push(['Phone', escapeHtml(inquiry.phone)]);
  if (isGroup) {
    if (inquiry.city) rows.push(['City', escapeHtml(inquiry.city)]);
    if (inquiry.date) rows.push(['Date', escapeHtml(inquiry.date)]);
    if (inquiry.party_size != null) rows.push(['Party size', escapeHtml(String(inquiry.party_size))]);
  }
  rows.push(['Language', escapeHtml((inquiry.locale || 'en').toUpperCase())]);

  const content = `
    ${detailPanel(rows, C.salmonDeep)}
    <h2 style="margin:26px 0 10px;font-size:15px;font-weight:800;color:${C.ink};">Message</h2>
    <p style="margin:0 0 22px;font-size:14.5px;line-height:1.6;color:${C.ink};">${notesToHtml(inquiry.message)}</p>
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${C.brown};">
      Reply directly to this email — it goes straight to <strong>${escapeHtml(inquiry.name)}</strong>.
    </p>`;

  return {
    subject,
    html: layout({
      preheader: isGroup
        ? `New group request: ${inquiry.city || ''} · ${inquiry.date || ''}`
        : `New contact message from ${inquiry.name}`,
      hero: {
        badge: isGroup ? 'Group booking request' : 'Contact form',
        title: isGroup ? (inquiry.city || 'New group request') : inquiry.name,
        chip: isGroup && inquiry.party_size != null
          ? `${inquiry.date || 'no date given'} · ${inquiry.party_size} guests`
          : inquiry.email,
      },
      heading: isGroup ? 'New group booking request' : 'New contact message',
      intro: 'Came in through the website form.',
      contentHtml: content,
    }),
  };
}

const INQUIRY_ACK_STRINGS = {
  en: {
    subject: 'We got your message — WOGO Cocktail Walk',
    heading: (name) => `Thanks${name ? ', ' + name : ''} — we've got it!`,
    intro: "We got your message and we'll reply within 1 working day.",
    body: 'In the meantime, feel free to browse our routes and cities on the website.',
    signoff: 'Talk soon — the WOGO team',
    footer: 'This is an automatic confirmation — no need to reply unless you have more to add.',
  },
  nl: {
    subject: 'We hebben je bericht ontvangen — WOGO Cocktail Walk',
    heading: (name) => `Bedankt${name ? ', ' + name : ''} — we hebben het ontvangen!`,
    intro: 'We hebben je bericht ontvangen en reageren binnen 1 werkdag.',
    body: 'Kijk in de tussentijd gerust rond op onze website voor onze routes en steden.',
    signoff: 'Tot snel — het WOGO-team',
    footer: 'Dit is een automatische bevestiging — je hoeft niet te reageren tenzij je nog iets wilt toevoegen.',
  },
};

/** 11. GUEST auto-acknowledgement, sent immediately after a contact/group
 * form submission (src/guest_api.js:handleContact) — the guest's OWN
 * confirmation that their message arrived, separate from the owner
 * notification above. EN/NL via inquiry.locale, same pattern as every
 * guest-facing mail in this file. */
export function renderInquiryAutoAck(inquiry) {
  const lang = loc(inquiry.locale);
  const t = INQUIRY_ACK_STRINGS[lang];
  const firstName = inquiry.name ? String(inquiry.name).trim().split(/\s+/)[0] : '';

  const content = `
    <p style="margin:0 0 4px;font-size:15px;line-height:1.6;color:${C.brown};">${escapeHtml(t.body)}</p>
    <p style="margin:22px 0 0;font-size:16px;line-height:1.5;font-weight:800;color:${C.ink};">${escapeHtml(t.signoff)}</p>`;

  return {
    subject: t.subject,
    html: layout({
      preheader: t.intro,
      hero: { chip: lang === 'nl' ? 'Bericht ontvangen' : 'Message received' },
      heading: t.heading(firstName),
      intro: t.intro,
      contentHtml: content,
      footerHtml: `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.brown};">${escapeHtml(t.footer)}</p>`,
    }),
  };
}

// ---------------------------------------------------------------------------
// 12 & 13. Newsletter subscribers (migrations/0024, BUILD §17)
//   12. Double opt-in CONFIRMATION — one button, the ONLY job of this email.
//       Deliberately carries NO welcome code — the code only ever arrives
//       once consent is actually confirmed (the WELCOME email below), so a
//       stray/forwarded confirmation link can't leak a discount to someone
//       who never opted in themselves.
//   13. WELCOME — sent once a subscription is CONFIRMED (double opt-in click,
//       OR a booking's own opt-in checkbox, which IS the consent act —
//       src/subscribers.js). Carries WELCOME_CODE and an unsubscribe link in
//       the footer (transactional booking mails never carry one — only this
//       marketing-adjacent mail does, BUILD item #4).
// ---------------------------------------------------------------------------

const SUBSCRIBE_CONFIRM_STRINGS = {
  en: {
    subject: 'Confirm your subscription — WOGO Cocktail Walk',
    preheader: 'One click and you’re on the list.',
    chip: 'Almost there',
    heading: (name) => `Confirm your subscription${name ? ', ' + name : ''}`,
    intro: 'Click below to confirm you’d like to hear from WOGO — new cities, offers, and the occasional good excuse for cocktails.',
    button: 'Confirm your subscription',
    ignore: "Didn't sign up for this? Just ignore this email — nothing happens unless you click the button above.",
  },
  nl: {
    subject: 'Bevestig je inschrijving — WOGO Cocktail Walk',
    preheader: 'Eén klik en je staat op de lijst.',
    chip: 'Bijna klaar',
    heading: (name) => `Bevestig je inschrijving${name ? ', ' + name : ''}`,
    intro: 'Klik hieronder om te bevestigen dat je updates van WOGO wilt ontvangen — nieuwe steden, acties, en af en toe een goed excuus voor cocktails.',
    button: 'Bevestig je inschrijving',
    ignore: 'Heb je je niet aangemeld? Negeer deze e-mail gerust — er gebeurt niets tenzij je op de knop hierboven klikt.',
  },
};

/** 12. Double opt-in confirmation email. `confirmUrl` is the full
 * GET /api/subscribe/confirm?token=... link (built by the caller,
 * src/guest_api.js, not this pure renderer). */
export function renderSubscribeConfirm(subscriber, confirmUrl) {
  const lang = loc(subscriber.locale);
  const t = SUBSCRIBE_CONFIRM_STRINGS[lang];
  const firstName = subscriber.first_name ? String(subscriber.first_name).trim().split(/\s+/)[0] : '';

  const content = `
    ${primaryButton(confirmUrl, t.button)}
    <p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:${C.muted};">${escapeHtml(t.ignore)}</p>`;

  return {
    subject: t.subject,
    html: layout({
      preheader: t.preheader,
      hero: { chip: t.chip },
      heading: t.heading(firstName),
      intro: t.intro,
      contentHtml: content,
    }),
  };
}

const SUBSCRIBE_WELCOME_STRINGS = {
  en: {
    subject: `Welcome to WOGO — here's 10% off`,
    preheader: (code) => `Your code: ${code} — 10% off your next cocktail walk.`,
    chip: `You're on the list`,
    heading: (name) => `Welcome${name ? ', ' + name : ''}!`,
    intro: `You're officially on the list. As a thank you, here's 10% off your next WOGO Cocktail Walk.`,
    codeLabel: 'Your code',
    codeNote: 'Enter it at checkout on any WOGO route.',
    button: 'Book your walk',
    signoff: 'See you out there — the WOGO team',
    footer: `You're receiving this because you subscribed to WOGO Cocktail Walk updates.`,
    unsubscribe: 'Unsubscribe',
  },
  nl: {
    subject: 'Welkom bij WOGO — hier is 10% korting',
    preheader: (code) => `Je code: ${code} — 10% korting op je volgende cocktail walk.`,
    chip: 'Je staat op de lijst',
    heading: (name) => `Welkom${name ? ', ' + name : ''}!`,
    intro: 'Je staat officieel op de lijst. Als bedankje krijg je 10% korting op je volgende WOGO Cocktail Walk.',
    codeLabel: 'Jouw code',
    codeNote: 'Vul deze in bij het afrekenen op elke WOGO-route.',
    button: 'Boek je walk',
    signoff: 'Tot snel — het WOGO-team',
    footer: 'Je ontvangt dit omdat je je hebt ingeschreven voor WOGO Cocktail Walk-updates.',
    unsubscribe: 'Uitschrijven',
  },
};

/** 13. Welcome email + WELCOME10 code. `opts.bookUrl` defaults to the site
 * homepage (there is no single cross-city booking page); `opts.unsubscribeUrl`
 * is the full GET /api/unsubscribe?token=... link — omit only in tests that
 * don't care about the footer link, every real send always has one (every
 * confirmed subscriber row carries an unsubscribe_token). */
export function renderSubscribeWelcome(subscriber, opts = {}) {
  const lang = loc(subscriber.locale);
  const t = SUBSCRIBE_WELCOME_STRINGS[lang];
  const firstName = subscriber.first_name ? String(subscriber.first_name).trim().split(/\s+/)[0] : '';
  const bookUrl = opts.bookUrl || SITE_URL;

  const codeBlock = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border:1px dashed ${C.salmonDeep};border-radius:12px;margin:0 0 22px;">
      <tr><td style="padding:16px;text-align:center;">
        <div style="font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:${C.brown};">${escapeHtml(t.codeLabel)}</div>
        <div style="margin-top:6px;font:800 24px/1.2 ui-monospace,Menlo,monospace;color:${C.ink};letter-spacing:.06em;">${escapeHtml(WELCOME_CODE)}</div>
        <div style="margin-top:6px;font-size:13px;color:${C.brown};">${escapeHtml(t.codeNote)}</div>
      </td></tr>
    </table>`;
  const content = `
    ${codeBlock}
    ${primaryButton(bookUrl, t.button)}
    <p style="margin:22px 0 0;font-size:16px;line-height:1.5;font-weight:800;color:${C.ink};">${escapeHtml(t.signoff)}</p>`;

  const unsubscribeUrl = opts.unsubscribeUrl;
  const footerHtml = `<p style="margin:0;font-size:12px;line-height:1.5;color:${C.muted};">${escapeHtml(t.footer)}${
    unsubscribeUrl
      ? ` &middot; <a href="${escapeHtml(unsubscribeUrl)}" style="color:${C.muted};text-decoration:underline;">${escapeHtml(t.unsubscribe)}</a>`
      : ''
  }</p>`;

  return {
    subject: t.subject,
    html: layout({
      preheader: t.preheader(WELCOME_CODE),
      hero: { chip: t.chip },
      heading: t.heading(firstName),
      intro: t.intro,
      contentHtml: content,
      footerHtml,
    }),
  };
}

// ---------------------------------------------------------------------------
// 14. Admin team login link (migrations/0025_admin_users.sql, BUILD §18).
// ONE template serves both POST /admin/login/request (an existing teammate
// requesting a fresh link) and the owner inviting a brand-new teammate —
// `opts.invite` just swaps the subject/heading/intro to "you've been added"
// phrasing. Locale is the admin_users row's OWN `locale` ('en'/'nl'), falling
// back to 'nl' (every admin today is Dutch-first) — NOT the visitor's
// browser locale, since there's no browser involved yet when this is sent.
// ---------------------------------------------------------------------------

const ADMIN_LOGIN_LINK_STRINGS = {
  en: {
    subject: 'Your WOGO dashboard login link',
    inviteSubject: "You've been added to the WOGO dashboard",
    preheader: 'This link signs you in — valid for 15 minutes, one click only.',
    chip: 'WOGO dashboard',
    heading: (name) => `Hi${name ? ' ' + name : ''} — here's your login link`,
    inviteHeading: (name) => `Welcome to the WOGO dashboard${name ? ', ' + name : ''}`,
    intro: 'Click below to sign in. No password to remember.',
    inviteIntro: "You've been invited to the WOGO Cocktail Walk dashboard. Click below to sign in for the first time.",
    button: 'Log in',
    note: 'This link is valid for 15 minutes and works once. Didn’t request this? Just ignore this email — nothing happens unless you click.',
  },
  nl: {
    subject: 'Je inloglink voor het WOGO dashboard',
    inviteSubject: 'Je bent toegevoegd aan het WOGO dashboard',
    preheader: 'Deze link logt je in — 15 minuten geldig, één keer te gebruiken.',
    chip: 'WOGO dashboard',
    heading: (name) => `Hoi${name ? ' ' + name : ''} — hier is je inloglink`,
    inviteHeading: (name) => `Welkom bij het WOGO dashboard${name ? ', ' + name : ''}`,
    intro: 'Klik hieronder om in te loggen. Geen wachtwoord nodig.',
    inviteIntro: 'Je bent uitgenodigd voor het WOGO Cocktail Walk dashboard. Klik hieronder om voor het eerst in te loggen.',
    button: 'Inloggen',
    note: 'Deze link is 15 minuten geldig en werkt één keer. Heb je dit niet aangevraagd? Negeer deze e-mail gerust — er gebeurt niets tenzij je klikt.',
  },
};

/** `user` is an admin_users row ({email, name, locale}); `magicUrl` is the
 * full GET /admin/login/magic?token=... link (built by the caller,
 * src/admin_api.js, not this pure renderer). `opts.invite` = true for the
 * owner's "invite a teammate" flow. */
export function renderAdminLoginLink(user, magicUrl, opts = {}) {
  const lang = loc(user.locale);
  const t = ADMIN_LOGIN_LINK_STRINGS[lang];
  const firstName = user.name ? String(user.name).trim().split(/\s+/)[0] : '';

  const content = `
    ${primaryButton(magicUrl, t.button)}
    <p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:${C.muted};">${escapeHtml(t.note)}</p>`;

  return {
    subject: opts.invite ? t.inviteSubject : t.subject,
    html: layout({
      preheader: t.preheader,
      hero: { chip: t.chip },
      heading: opts.invite ? t.inviteHeading(firstName) : t.heading(firstName),
      intro: opts.invite ? t.inviteIntro : t.intro,
      contentHtml: content,
    }),
  };
}

// ---------------------------------------------------------------------------
// 15. Review request (migrations/0026_review_requests.sql, BUILD §20) — sent
// once per booking, the day after the walk (src/reviews.js). Transactional,
// one-off: NO unsubscribe link (this isn't a marketing send the subscribers
// plumbing governs — see emails.js's own file-level note on owner mails vs.
// guest mails). "Review op Google" only appears when REVIEW_GOOGLE_URL
// (src/config.js) is non-empty — it starts empty until the owner supplies
// her real g.page link, and an empty/wrong link is worse than one button.
// ---------------------------------------------------------------------------

const REVIEW_REQUEST_STRINGS = {
  en: {
    subject: 'How was your WOGO Cocktail Walk? 🍸',
    preheader: 'Two minutes of your time means a lot to a small team.',
    chip: 'Thank you',
    heading: (name) => `Thanks for walking with us${name ? ', ' + name : ''}!`,
    intro: (routeName) => `We hope ${routeName} was a great night out. If you have a moment, a quick review helps other people discover WOGO — it really does mean a lot to us.`,
    trustpilotButton: 'Review on Trustpilot',
    googleButton: 'Review on Google',
    somethingWrong: "Something wasn't quite right? Just reply to this email — we read everything.",
  },
  nl: {
    subject: 'Hoe was je WOGO Cocktail Walk? 🍸',
    preheader: 'Twee minuten van je tijd betekent veel voor een klein team.',
    chip: 'Dankjewel',
    heading: (name) => `Bedankt dat je met ons mee liep${name ? ', ' + name : ''}!`,
    intro: (routeName) => `We hopen dat ${routeName} een top avond was. Heb je een momentje, dan helpt een review ons enorm — andere mensen vinden WOGO erdoor, en het betekent echt veel voor ons.`,
    trustpilotButton: 'Review op Trustpilot',
    googleButton: 'Review op Google',
    somethingWrong: 'Was er iets niet helemaal goed? Antwoord gewoon op deze mail — we lezen alles.',
  },
};

/** `booking.locale` picks EN/NL; `route.name` is used in the intro line as-is
 * (already the clean display name per migrations/0023). */
export function renderReviewRequest(booking, route) {
  const lang = loc(booking.locale);
  const t = REVIEW_REQUEST_STRINGS[lang];
  const firstName = booking.name ? String(booking.name).trim().split(/\s+/)[0] : '';
  const trustpilotUrl = lang === 'nl' ? REVIEW_TRUSTPILOT_URL_NL : REVIEW_TRUSTPILOT_URL_EN;

  const content = `
    ${primaryButton(trustpilotUrl, t.trustpilotButton)}
    ${REVIEW_GOOGLE_URL ? secondaryButton(REVIEW_GOOGLE_URL, t.googleButton) : ''}
    <p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:${C.muted};">${escapeHtml(t.somethingWrong)}</p>`;

  return {
    subject: t.subject,
    html: layout({
      preheader: t.preheader,
      hero: { chip: t.chip },
      posterRoute: route,
      heading: t.heading(firstName),
      intro: t.intro(route.name),
      contentHtml: content,
    }),
  };
}

// ---------------------------------------------------------------------------
// Reference-copy fixtures (BUILD §19's Brevo reference-copy pass,
// POST /admin/api/brevo/push-reference-templates). Realistic SAMPLE data —
// never real guest/bar/booking rows — fed through the SAME render functions
// above, so a reference template in Brevo is always byte-for-byte what a
// real send would look like, never a hand-maintained second copy that can
// drift from the real templates. Kept in THIS file (not admin_api.js/
// brevo.js) because it's the one place that already knows every render
// function's exact argument shape.
// ---------------------------------------------------------------------------

const REF_ROUTE = {
  id: 'amsterdam', name: 'WOGO Amsterdam', city: 'Amsterdam',
  price_cents: 3495, currency: 'EUR', map_url: `${SITE_URL}/maps/amsterdam.pdf`,
};
const REF_ROUTE_ROTTERDAM = { id: 'rotterdam-hidden-gems', name: 'Rotterdam Hidden Gems', city: 'Rotterdam', price_cents: 3495, currency: 'EUR' };

const REF_BOOKING = {
  id: 'b_ref_0001', route_id: REF_ROUTE.id, date: '2026-11-14', slot: '18:00', party: 4,
  name: 'Sophie de Vries', email: 'sophie.devries@example.com', phone: '+31 6 12345678',
  locale: 'en', notes: null, discount_code: null, discount_cents: 0, gift_applied_cents: 0, gift_code: null,
};
const REF_BOOKING_GIFT = { ...REF_BOOKING, id: 'b_ref_0002', locale: 'nl', gift_code: 'WOGO-7F3K-9QRT', gift_applied_cents: 2000 };

const REF_BAR = { ord: 1, bar_name: 'Door 74', bar_email: 'reservations@example.com', arrival_time: '18:15', locale: 'nl' };
const REF_BAR_EN = { ...REF_BAR, locale: 'en' };

const REF_GIFT_CARD = {
  code: 'WOGO-7F3K-9QRT', initial_cents: 6000, balance_cents: 6000, currency: 'EUR', locale: 'en',
  buyer_name: 'Mark Jansen', buyer_email: 'mark.jansen@example.com',
  recipient_name: 'Lotte Bakker', recipient_email: 'lotte.bakker@example.com',
  message: 'Happy birthday! Thought this would be more fun than socks.',
};
const REF_GIFT_CARD_NL = { ...REF_GIFT_CARD, locale: 'nl', recipient_name: 'Lotte Bakker' };

const REF_INQUIRY_CONTACT = { kind: 'contact', name: 'Emma Visser', email: 'emma.visser@example.com', phone: null, message: 'Hi, do you also run private walks for a hen party of 12?', locale: 'en' };

const REF_SUBSCRIBER = { email: 'anna.smit@example.com', first_name: 'Anna', locale: 'en' };
const REF_SUBSCRIBER_NL = { ...REF_SUBSCRIBER, locale: 'nl' };

const REF_ADMIN_USER = { email: 'selin@wogoamsterdam.com', name: 'Selin', locale: 'nl' };

/**
 * Renders every transactional template with realistic sample data, named
 * for Brevo as `"[REFERENCE] <name> (EN|NL) — copy only, editing here
 * changes nothing"`. Returns `[{ name, subject, html }, ...]` — ready for
 * `src/admin_api.js:handleBrevoPushReferenceTemplates` to upsert one by one
 * via `brevo.js:upsertTransactionalTemplate`.
 */
export function buildReferenceTemplateSet() {
  const name = (base, lang) => `[REFERENCE] ${base} (${lang}) — copy only, editing here changes nothing`;
  const entries = [];
  const push = (base, lang, rendered) => entries.push({ name: name(base, lang), subject: rendered.subject, html: rendered.html });

  push('Guest confirmation', 'EN', renderGuestConfirmation(REF_BOOKING, REF_ROUTE));
  push('Guest confirmation — with gift card', 'NL', renderGuestConfirmation(REF_BOOKING_GIFT, REF_ROUTE));
  push('Owner notification', 'EN', renderOwnerNotification(REF_BOOKING, REF_ROUTE, { arrivals: [{ bar_name: REF_BAR.bar_name, arrival_time: REF_BAR.arrival_time }] }));
  push('Bar notification', 'NL', renderBarNotification(REF_BAR, REF_BOOKING, REF_ROUTE));
  push('Bar notification', 'EN', renderBarNotification(REF_BAR_EN, REF_BOOKING, REF_ROUTE));
  push('Bar reschedule', 'NL', renderBarReschedule(REF_BAR, REF_BOOKING, REF_ROUTE, { previous: { date: '2026-11-12', arrival_time: '19:00' } }));
  push('Bar cancellation', 'NL', renderBarCancellation(REF_BAR, REF_BOOKING, REF_ROUTE));
  push('Guest reschedule', 'EN', renderGuestReschedule(REF_BOOKING, REF_ROUTE, { previous: { date: '2026-11-12', slot: '19:00' } }));
  push('Guest cancellation', 'EN', renderGuestCancellation(REF_BOOKING, REF_ROUTE));
  push('Gift card recipient', 'EN', renderGiftCardRecipient(REF_GIFT_CARD));
  push('Gift card recipient', 'NL', renderGiftCardRecipient(REF_GIFT_CARD_NL));
  push('Gift card buyer', 'EN', renderGiftCardBuyer(REF_GIFT_CARD));
  push('Subscribe confirm', 'EN', renderSubscribeConfirm(REF_SUBSCRIBER, `${SITE_URL}/api/subscribe/confirm?token=reference-sample-token`));
  push('Subscribe confirm', 'NL', renderSubscribeConfirm(REF_SUBSCRIBER_NL, `${SITE_URL}/api/subscribe/confirm?token=reference-sample-token`));
  push('Welcome', 'EN', renderSubscribeWelcome(REF_SUBSCRIBER, { unsubscribeUrl: `${SITE_URL}/api/unsubscribe?token=reference-sample-token` }));
  push('Welcome', 'NL', renderSubscribeWelcome(REF_SUBSCRIBER_NL, { unsubscribeUrl: `${SITE_URL}/api/unsubscribe?token=reference-sample-token` }));
  push('Contact acknowledgement', 'EN', renderInquiryAutoAck(REF_INQUIRY_CONTACT));
  push('Inquiry owner mail', 'EN', renderInquiryOwnerNotification(REF_INQUIRY_CONTACT));
  push('Magic-link login', 'NL', renderAdminLoginLink(REF_ADMIN_USER, 'https://wogo-booking-backend.example.workers.dev/admin/login/magic?token=reference-sample-token'));
  push('Review request', 'EN', renderReviewRequest(REF_BOOKING, REF_ROUTE_ROTTERDAM));
  push('Review request', 'NL', renderReviewRequest({ ...REF_BOOKING, locale: 'nl' }, REF_ROUTE_ROTTERDAM));

  return entries;
}

export { SENDER_NAME };
