/* ==========================================================================
   Build step for preview/emails.html — Dashboard v2.

   Renders every branded HTML email template in src/emails.js against
   realistic, self-contained mock data (matching migrations/0002's real
   Amsterdam seed: 3 bars staggered 0 / 75 / 150 minutes) and writes them,
   each inside its own srcdoc <iframe> (so an email's own inline styles never
   leak into the page around it — the same isolation a real inbox gives
   each message), into one static file Maroussia can open via file://.

   This is throwaway preview tooling, not code the Worker ever serves — same
   convention as src/admin/build.mjs. It imports src/emails.js directly (pure
   string-building, zero Workers/env/fetch calls, so it runs fine under plain
   Node) — meaning this file is BYTE-FOR-BYTE what Brevo actually sends;
   there is no separate "preview version" of the templates to drift out of
   sync.

   Run:  node src/emails_preview.mjs   (from the backend/ directory or anywhere)
   ========================================================================== */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderGuestConfirmation,
  renderOwnerNotification,
  renderBarNotification,
  renderOwnerConflict,
  renderGuestReschedule,
  renderBarReschedule,
  renderGuestCancellation,
  renderBarCancellation,
} from './emails.js';
import { computeBarArrivals } from './logic.js';

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, '..');

// ---------------------------------------------------------------------------
// Mock data — the real Amsterdam seed shape (migrations/0002_seed_routes.sql):
// 3 bars staggered 0 / 75 / 150 minutes, price 2995 cents.
// ---------------------------------------------------------------------------

const route = {
  id: 'groningen',
  name: 'WOGO Cocktail Walk Groningen',
  city: 'Groningen',
  price_cents: 2995,
  map_url: 'https://maps.app.goo.gl/example-wogo-amsterdam-route',
  // migrations/0012: separate Dutch map — the NL preview below links this one
  // (an NL booking falls back to map_url only when map_url_nl is empty).
  map_url_nl: 'https://maps.app.goo.gl/example-wogo-amsterdam-route-nl',
};

const seededBars = [
  { ord: 1, bar_name: 'Van de Werf (NDSM wharf)', bar_email: 'vandewerf@example.com', minutes_offset: 0 },
  { ord: 2, bar_name: 'Bar 2 (TBD — set real name/email)', bar_email: 'bookings@wogoamsterdam.com', minutes_offset: 60 },
  { ord: 3, bar_name: 'Bar 3 (TBD — set real name/email)', bar_email: 'bookings@wogoamsterdam.com', minutes_offset: 120 },
];

// A paid web booking, with a promo code applied — exercises the discount
// line in both the guest confirmation and the owner notification.
const webBooking = {
  id: 'b_8f3a2c91',
  route_id: 'amsterdam',
  date: '2026-08-06',
  slot: '18:00',
  party: 3,
  name: 'Anna de Vries',
  email: 'anna@example.com',
  phone: '+31 6 12345678',
  locale: 'en',
  source: 'web',
  payment_status: null,
  discount_code: 'SUMMER10',
  discount_cents: 500,
  // Exercises the "⚠️ Allergies / notes" block (migrations/0010) in the
  // guest echo, the owner notification, and — most importantly — the bar email.
  notes: 'Nut allergy (one guest) — and we are celebrating a birthday!',
};

// A manual (phone) booking marked comped — exercises the owner
// notification's "Manual (phone booking)" + "Comp" payment-status rows.
const manualBooking = {
  id: 'b_manual_a1c4',
  route_id: 'amsterdam',
  date: '2026-08-06',
  slot: '19:00',
  party: 2,
  name: "Bram's birthday",
  email: 'bram@example.com',
  phone: null,
  locale: 'nl',
  source: 'manual',
  payment_status: 'comp',
  discount_code: null,
  discount_cents: 0,
};

const webArrivals = computeBarArrivals(route, seededBars, [], webBooking);
const manualArrivals = computeBarArrivals(route, seededBars, [], manualBooking);

const conflictBooking = {
  ...webBooking,
  id: 'b_conflict_772f',
  name: 'Late Larry',
  email: 'larry@example.com',
};

// ---------------------------------------------------------------------------
// Every template this preview demonstrates, in the order a real booking
// fires them (SPEC.md §8.3 / DASHBOARD-V2-SPEC.md §8).
// ---------------------------------------------------------------------------

const templates = [
  {
    group: '1. Guest — confirmation (incl. route map)',
    label: 'Guest confirmation (EN) — with route map + promo code applied',
    note: 'The ONE guest email, sent the moment Stripe confirms payment. Now includes the route-map section (button + save note) — the former separate route-map email was merged into it. Note the struck-through original price next to the discounted total.',
    ...renderGuestConfirmation(webBooking, route, { locale: 'en' }),
  },
  {
    group: '1. Guest — confirmation (incl. route map)',
    label: 'Guest confirmation (NL) — manual/phone booking, comped',
    note: 'Same template, Dutch copy — this is what a phone booking the owner marks "Comp" looks like to the guest (still a real confirmation, route map included).',
    ...renderGuestConfirmation(manualBooking, route, { locale: 'nl' }),
  },
  {
    group: '2. Owner — new booking',
    label: 'Owner notification — paid web booking with a discount',
    note: 'Wired into the confirmed-booking flow (src/webhook.js) for every status="confirmed" booking. Shows the discount code + amount, and every bar’s staggered arrival time for this booking’s slot.',
    ...renderOwnerNotification(webBooking, route, { arrivals: webArrivals }),
  },
  {
    group: '2. Owner — new booking',
    label: 'Owner notification — manual/comp phone booking',
    note: 'Manual bookings do NOT trigger this email (the owner is the one creating them) — shown here only so every field renders at least once; see DASHBOARD-V2-SPEC.md §8.',
    ...renderOwnerNotification(manualBooking, route, { arrivals: manualArrivals }),
  },
  {
    group: '3. Bars — staggered arrival',
    label: `Bar notification — ${webArrivals[0].bar_name} (arrives ${webArrivals[0].arrival_time}, +0 min)`,
    note: 'Three separate emails go out per booking, one per bar, each with ONLY that bar’s own arrival time — never the full itinerary. Each now carries the guest’s direct contact (email · phone) so the bar can reach the group that evening.',
    ...renderBarNotification(webArrivals[0], webBooking, route),
  },
  {
    group: '3. Bars — staggered arrival',
    label: `Bar notification — ${webArrivals[1].bar_name} (arrives ${webArrivals[1].arrival_time}, +60 min)`,
    note: '',
    ...renderBarNotification(webArrivals[1], webBooking, route),
  },
  {
    group: '3. Bars — staggered arrival',
    label: `Bar notification — ${webArrivals[2].bar_name} (arrives ${webArrivals[2].arrival_time}, +120 min)`,
    note: 'Same 18:00 booking, third bar — 18:00 → 19:00 → 20:00, exactly the 0/60/120-minute stagger seeded in migrations/0002_seed_routes.sql.',
    ...renderBarNotification(webArrivals[2], webBooking, route),
  },
  {
    group: '4. Owner — conflict alert',
    label: 'Owner conflict alert — the rare double-booked case (SPEC.md §6.4)',
    note: 'Only fires when a guest’s payment lands just after their hold expired and the seat was already resold.',
    ...renderOwnerConflict(conflictBooking, route),
  },
  // --- Reschedule (booking moved) ------------------------------------------
  {
    group: '5. Booking moved (reschedule)',
    label: 'Guest — booking moved (EN)',
    note: 'Sent to the guest when a booking is moved to a new date/time. Shows the old date struck through, the new details, and the route map again. Same route, same price.',
    ...renderGuestReschedule(
      { ...webBooking, date: '2026-09-19', slot: '19:30' },
      route,
      { locale: 'en', previous: { date: '2026-08-06', slot: '18:00' } }
    ),
  },
  {
    group: '5. Booking moved (reschedule)',
    label: 'Guest — booking moved (NL)',
    note: 'Dutch version of the moved-booking confirmation.',
    ...renderGuestReschedule(
      { ...webBooking, locale: 'nl', date: '2026-09-19', slot: '19:30' },
      route,
      { locale: 'nl', previous: { date: '2026-08-06', slot: '18:00' } }
    ),
  },
  {
    group: '5. Booking moved (reschedule)',
    label: `Bar — reservation moved (${webArrivals[1].bar_name})`,
    note: 'One per bar for the new time. Shows the old table to release + the new arrival time as a big hero.',
    ...renderBarReschedule(
      { ...webArrivals[1], arrival_time: '20:30' },
      { ...webBooking, date: '2026-09-19', slot: '19:30' },
      route,
      { previous: { date: '2026-08-06', arrival_time: '19:00' } }
    ),
  },
  // --- Cancellation --------------------------------------------------------
  {
    group: '6. Cancellation',
    label: 'Guest — booking cancelled (EN, with refund note)',
    note: 'Sent when a booking is cancelled (the rare exception to the no-cancellation policy). The refund/exception wording is passed in per-case by the owner — here shown with an example note.',
    ...renderGuestCancellation(webBooking, route, {
      locale: 'en',
      message: 'As a one-time exception, a full refund of your booking has been issued to your original payment method — please allow 5–10 days for it to appear.',
    }),
  },
  {
    group: '6. Cancellation',
    label: 'Guest — booking cancelled (NL, no note)',
    note: 'Dutch version, without an extra note — the plain cancellation confirmation.',
    ...renderGuestCancellation({ ...webBooking, locale: 'nl' }, route, { locale: 'nl' }),
  },
  {
    group: '6. Cancellation',
    label: `Bar — reservation cancelled (${webArrivals[1].bar_name})`,
    note: 'One per bar: release the table, nothing else needed.',
    ...renderBarCancellation(webArrivals[1], webBooking, route),
  },
];

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Stable ids (used for nav <-> panel wiring) — assigned before any HTML that
// references t.id is built below.
templates.forEach((t, i) => { t.id = `tpl-${i}`; });

const groups = [...new Set(templates.map((t) => t.group))];

const navHtml = groups
  .map((g) => {
    const items = templates
      .filter((t) => t.group === g)
      .map(
        (t, gi) => `<button class="wp-navitem" data-id="${escapeHtml(t.id)}" type="button">
          <span class="wp-navitem-label">${escapeHtml(t.label)}</span>
          <span class="wp-navitem-subject">${escapeHtml(t.subject)}</span>
        </button>`
      )
      .join('');
    return `<div class="wp-navgroup"><h2>${escapeHtml(g)}</h2>${items}</div>`;
  })
  .join('');

const panelsHtml = templates
  .map(
    (t, i) => `<section class="wp-panel" data-id="${escapeHtml(t.id)}" ${i === 0 ? '' : 'hidden'}>
      <header class="wp-panel-head">
        <div>
          <h1>${escapeHtml(t.label)}</h1>
          <p class="wp-subject">Subject: <strong>${escapeHtml(t.subject)}</strong></p>
          ${t.note ? `<p class="wp-note">${escapeHtml(t.note)}</p>` : ''}
        </div>
      </header>
      <div class="wp-frame-wrap">
        <iframe class="wp-frame" title="${escapeHtml(t.label)}" srcdoc="${escapeHtml(t.html)}"></iframe>
      </div>
    </section>`
  )
  .join('');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>WOGO — email templates preview</title>
<style>
  :root{
    --espresso:#3f2b21; --ink:#201611; --brown:#643e2b; --brownSoft:#7e5541;
    --blush:#ffe5d9; --cream:#fffaf6; --page:#f4e6dc; --salmon:#ffaa81;
    --salmonDeep:#f2905c; --line:#e7d3c6; --muted:#8a6a58;
  }
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--page);color:var(--ink);}
  .wp-shell{display:grid;grid-template-columns:300px 1fr;min-height:100vh;}
  .wp-sidebar{background:linear-gradient(180deg,var(--espresso),var(--ink));color:#fff;padding:22px 16px;overflow-y:auto;}
  .wp-sidebar h1{font-size:14px;letter-spacing:.18em;text-transform:uppercase;margin:0 0 4px;color:var(--salmon);}
  .wp-sidebar .wp-tagline{font-size:12px;color:rgba(255,245,238,.65);margin:0 0 20px;line-height:1.5;}
  .wp-navgroup h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,245,238,.55);margin:18px 4px 8px;}
  .wp-navitem{display:block;width:100%;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:9px 11px;margin-bottom:6px;color:#fff;cursor:pointer;}
  .wp-navitem:hover{background:rgba(255,170,129,.14);border-color:rgba(255,170,129,.4);}
  .wp-navitem.active{background:rgba(255,170,129,.22);border-color:var(--salmon);}
  .wp-navitem-label{display:block;font-size:12.5px;font-weight:700;}
  .wp-navitem-subject{display:block;font-size:11px;color:rgba(255,245,238,.55);margin-top:2px;}
  .wp-main{padding:26px 32px;overflow-y:auto;}
  .wp-panel-head h1{font-size:18px;margin:0 0 4px;}
  .wp-subject{font-size:13px;color:var(--brown);margin:0 0 6px;}
  .wp-note{font-size:12.5px;color:var(--muted);max-width:640px;line-height:1.5;margin:0 0 18px;}
  .wp-frame-wrap{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#ddd;height:calc(100vh - 200px);min-height:520px;}
  .wp-frame{width:100%;height:100%;border:0;background:#fff;}
  @media (max-width: 860px){
    .wp-shell{grid-template-columns:1fr;}
    .wp-sidebar{position:sticky;top:0;z-index:2;max-height:40vh;}
  }
</style>
</head>
<body>
<div class="wp-shell">
  <nav class="wp-sidebar">
    <h1>WOGO emails</h1>
    <p class="wp-tagline">Every transactional template, rendered from the exact same src/emails.js functions Brevo receives. Amsterdam seed data, 3 bars staggered 0 / 75 / 150 min.</p>
    ${navHtml}
  </nav>
  <main class="wp-main">
    ${panelsHtml}
  </main>
</div>
<script>
  (function () {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.wp-navitem'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('.wp-panel'));
    function show(id) {
      panels.forEach(function (p) { p.hidden = p.getAttribute('data-id') !== id; });
      buttons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-id') === id); });
    }
    buttons.forEach(function (b) {
      b.addEventListener('click', function () { show(b.getAttribute('data-id')); });
    });
    if (buttons[0]) { buttons[0].classList.add('active'); }
  })();
</script>
</body>
</html>
`;

writeFileSync(join(backend, 'preview', 'emails.html'), page);
console.log('emails preview built → preview/emails.html');
console.log('templates: ' + templates.length);
