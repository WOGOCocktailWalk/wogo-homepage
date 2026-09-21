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
// (booking.locale); internal (owner/bar) mails are EN only.
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
import { EMAIL_LOGO_URL, posterUrlFor } from './config.js';

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

/** Guest free-text (bookings.notes) made safe for HTML: escaped, then the
 * textarea's newlines become <br> so multi-line notes keep their shape. */
function notesToHtml(notes) {
  return escapeHtml(String(notes)).replace(/\r?\n/g, '<br>');
}

/**
 * The "⚠️ Allergies / notes" callout for the BAR and OWNER emails
 * (migrations/0010). Deliberately loud — amber panel, bold label — because
 * this is where "nut allergy" has to reach the person mixing the drinks.
 * Returns '' when the guest left the field blank: no notes, no block, no
 * empty label anywhere.
 */
function allergiesNotesBlock(notes) {
  if (!notes || !String(notes).trim()) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.amberBg};border:1px solid ${C.amberLine};border-left:5px solid ${C.amberEdge};border-radius:12px;margin:0 0 22px;">
    <tr><td style="padding:14px 16px;">
      <div style="font-size:13px;font-weight:800;letter-spacing:.02em;color:${C.amberInk};">&#9888;&#65039; Allergies / notes:</div>
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
    labels: { route: 'Experience', date: 'Date', time: 'Start time', party: 'Guests', total: 'Total paid', ref: 'Booking ref' },
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
    labels: { route: 'Ervaring', date: 'Datum', time: 'Starttijd', party: 'Gasten', total: 'Totaal betaald', ref: 'Boekingsnr.' },
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
// 3. BAR notification — EN. ONE bar, its concrete staggered arrival time.
//    Branded top band, but ruthlessly efficient: allergies flagged loudly
//    ABOVE everything, then this bar's OWN arrival time as a big hero.
// ---------------------------------------------------------------------------

export function renderBarNotification(bar, booking, route) {
  // Direct guest contact so the bar can reach the group that evening:
  // always the email, plus the phone when the guest left one.
  const guestContact =
    `<a href="mailto:${escapeHtml(booking.email)}" style="color:${C.salmonDeep};text-decoration:none;">${escapeHtml(booking.email)}</a>` +
    (booking.phone ? ` &middot; ${escapeHtml(booking.phone)}` : '');

  // The arrival time is the hero — a big, unmissable number. The label
  // "Arrival time" lives here (bar detail label the tests pin).
  const arrivalHero = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border:1px solid ${C.line};border-radius:16px;margin:0 0 22px;">
    <tr><td style="padding:22px 24px;text-align:center;">
      <div style="font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${C.brown};">Arrival time</div>
      <div style="margin-top:6px;font-size:46px;line-height:1;font-weight:800;color:${C.salmonDeep};font-variant-numeric:tabular-nums;">${escapeHtml(bar.arrival_time)}</div>
      <div style="margin-top:10px;font-size:14px;font-weight:700;color:${C.ink};">Table for ${escapeHtml(String(booking.party))} · ${escapeHtml(formatLongDate(booking.date, 'en'))}</div>
    </td></tr>
  </table>`;

  const rows = [
    ['Party', `${escapeHtml(String(booking.party))} ${booking.party === 1 ? 'guest' : 'guests'}`],
    ['Route', escapeHtml(route.name)],
    ['Guest name', escapeHtml(booking.name)],
    ['Guest contact', guestContact],
  ];

  // The allergies/notes block goes FIRST — above even the arrival hero — so
  // bar staff scanning the email can't miss "nut allergy" (the entire reason
  // this field exists). Empty notes ⇒ no block at all.
  const content = `
    ${allergiesNotesBlock(booking.notes)}${arrivalHero}
    ${detailPanel(rows, C.salmonDeep)}
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${C.brown};">
      Please hold a table for <strong>${escapeHtml(String(booking.party))}</strong> at
      <strong>${escapeHtml(bar.arrival_time)}</strong>. This is part of a WOGO Cocktail Walk —
      the group moves between bars on a staggered schedule across the evening, so this is
      <strong>your</strong> arrival time for them. Need to reach the guests? Use the contact
      details above.
    </p>`;

  return {
    subject: `WOGO reservation · ${bar.arrival_time} · ${booking.party} guests · ${booking.date}`,
    html: layout({
      preheader: `Hold a table for ${booking.party} at ${bar.arrival_time}.`,
      hero: { badge: 'New WOGO reservation', title: `Table for ${booking.party} at ${bar.arrival_time}`, chip: `${escapeHtml(bar.bar_name)} · ${route.city}` },
      posterRoute: route,
      heading: `Hi ${bar.bar_name},`,
      intro: 'A WOGO Cocktail Walk group is on the way to you. Here is everything you need.',
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
    subject: `&#9888; Double-booked — ${booking.id}`,
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

// --- 5b. BAR reschedule (EN) -----------------------------------------------
// bar.arrival_time = the NEW arrival time. opts.previous = { date, arrival_time }
// is this bar's OLD slot, so staff know which table to release.
export function renderBarReschedule(bar, booking, route, opts = {}) {
  const guestContact =
    `<a href="mailto:${escapeHtml(booking.email)}" style="color:${C.salmonDeep};text-decoration:none;">${escapeHtml(booking.email)}</a>` +
    (booking.phone ? ` &middot; ${escapeHtml(booking.phone)}` : '');
  const prev = opts.previous || {};
  const wasLine = (prev.date || prev.arrival_time)
    ? `<p style="margin:0 0 14px;font-size:13.5px;color:${C.muted};"><strong style="color:${C.ink};">Was:</strong> <span style="text-decoration:line-through;">${escapeHtml(formatLongDate(prev.date || booking.date, 'en'))}${prev.arrival_time ? ' · ' + escapeHtml(prev.arrival_time) : ''}</span> — please release that table.</p>`
    : '';
  const arrivalHero = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.blush};border:1px solid ${C.line};border-radius:16px;margin:0 0 22px;">
    <tr><td style="padding:22px 24px;text-align:center;">
      <div style="font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${C.brown};">New arrival time</div>
      <div style="margin-top:6px;font-size:46px;line-height:1;font-weight:800;color:${C.salmonDeep};font-variant-numeric:tabular-nums;">${escapeHtml(bar.arrival_time)}</div>
      <div style="margin-top:10px;font-size:14px;font-weight:700;color:${C.ink};">Table for ${escapeHtml(String(booking.party))} · ${escapeHtml(formatLongDate(booking.date, 'en'))}</div>
    </td></tr>
  </table>`;
  const rows = [
    ['Party', `${escapeHtml(String(booking.party))} ${booking.party === 1 ? 'guest' : 'guests'}`],
    ['Route', escapeHtml(route.name)],
    ['Guest name', escapeHtml(booking.name)],
    ['Guest contact', guestContact],
  ];
  const content = `
    ${allergiesNotesBlock(booking.notes)}${wasLine}${arrivalHero}
    ${detailPanel(rows, C.salmonDeep)}
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${C.brown};">
      This WOGO reservation has <strong>moved</strong>. Please release the earlier table and
      hold the new one shown above. Need to reach the guests? Use the contact details above.
    </p>`;
  return {
    subject: `WOGO reservation MOVED · now ${bar.arrival_time} · ${booking.date} · ${booking.party} guests`,
    html: layout({
      preheader: `Moved: now hold a table for ${booking.party} at ${bar.arrival_time}.`,
      hero: { badge: 'Reservation moved', title: `New time ${bar.arrival_time}`, chip: `${escapeHtml(bar.bar_name)} · ${route.city}` },
      posterRoute: route,
      heading: `Hi ${bar.bar_name},`,
      intro: 'A WOGO reservation has been rescheduled. Here is the new arrival time.',
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

// --- 6b. BAR cancellation (EN) ---------------------------------------------
// bar.arrival_time = the arrival time of the reservation being released.
export function renderBarCancellation(bar, booking, route) {
  const rows = [
    ['Date', escapeHtml(formatLongDate(booking.date, 'en'))],
    ['Time', `<span style="font-variant-numeric:tabular-nums;">${escapeHtml(bar.arrival_time)}</span>`],
    ['Party', `${escapeHtml(String(booking.party))} ${booking.party === 1 ? 'guest' : 'guests'}`],
    ['Guest name', escapeHtml(booking.name)],
  ];
  const content = `
    ${detailPanel(rows, '#8a3f6b')}
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${C.brown};">
      This WOGO reservation has been <strong>cancelled</strong> — you can release the table
      above. Nothing else is needed on your side.
    </p>`;
  return {
    subject: `WOGO reservation CANCELLED · ${booking.date} ${bar.arrival_time} · ${booking.party} guests`,
    html: layout({
      preheader: `Cancelled: you can release the ${bar.arrival_time} table for ${booking.party}.`,
      hero: { badge: 'Reservation cancelled', title: 'Table released', chip: `${escapeHtml(bar.bar_name)} · ${route.city}` },
      heading: `Hi ${bar.bar_name},`,
      intro: 'A WOGO reservation has been cancelled — here are the details so you can free the table.',
      contentHtml: content,
    }),
  };
}

export { SENDER_NAME };
