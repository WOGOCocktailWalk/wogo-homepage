// test/bar_locale.test.js — per-bar email language (migrations/0022):
// routes_bars.locale ('nl'/'en', NOT NULL DEFAULT 'nl') drives which
// language renderBarNotification / renderBarReschedule / renderBarCancellation
// (src/emails.js) render in. Every existing bar is Dutch (the default);
// London bars will be seeded/entered with locale='en'.
//
// Coverage:
//   - the migration itself: ADD COLUMN backfills every pre-existing row 'nl'.
//   - db.js: addBar/updateBar/replaceBars store + normalize locale ('en'
//     stays 'en', anything else — including omitted — becomes 'nl').
//   - logic.js:computeBarArrivals threads bar.locale through to the arrivals
//     it returns, defaulting 'nl' for a bar row/override payload that has
//     none.
//   - emails.js: NL render for all three bar templates (subject + body, the
//     owner's exact spec wording), EN unchanged (byte-for-byte the same
//     copy as before 0022), and the default-to-'nl'-when-missing rule.
//   - end to end: webhook.js:notifyBars/notifyBarsReschedule/
//     notifyBarsCancellation send the right language per bar.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import * as db from '../src/db.js';
import { listBars, addBar, updateBar, replaceBars, toPositional } from '../src/db.js';
import { computeBarArrivals } from '../src/logic.js';
import { notifyBars, notifyBarsReschedule, notifyBarsCancellation } from '../src/webhook.js';
import { renderBarNotification, renderBarReschedule, renderBarCancellation } from '../src/emails.js';
import { handleAddBar, handleUpdateBar, handleReplaceBars } from '../src/admin_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0022_bar_locale.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

function exec(db_, sql, params = {}) {
  const t = toPositional(sql, params);
  return db_.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(db_, overrides = {}) {
  const route = {
    id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 10, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["19:00"]',
    slot_capacity: '{}', map_url: null, active: 1,
    ...overrides,
  };
  exec(
    db_,
    `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, map_url, active)
     VALUES (:id, :name, :city, :price_cents, :capacity, :max_party, :open_days, :slots, :slot_capacity, :map_url, :active)`,
    route
  );
  return route;
}

let sqliteDb;
beforeEach(() => {
  sqliteDb = makeTestDb(schemaSql);
  seedRoute(sqliteDb);
});

const realFetch = global.fetch;
beforeEach(() => { global.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 }); });
afterEach(() => { global.fetch = realFetch; });

// ---------------------------------------------------------------------------
// migrations/0022 — backfill
// ---------------------------------------------------------------------------

describe('migrations/0022_bar_locale — backfill', () => {
  test('a bar row inserted before this migration existed (no locale given) backfills to "nl"', async () => {
    // Explicit column list omitting locale, exactly like every routes_bars
    // row written before 0022 existed.
    exec(
      sqliteDb,
      `INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset)
       VALUES (:route_id, :ord, :bar_name, :bar_email, :minutes_offset)`,
      { route_id: 'testroute', ord: 1, bar_name: 'Oud Bar', bar_email: 'oud@example.com', minutes_offset: 0 }
    );
    const bars = await listBars(sqliteDb, 'testroute');
    assert.equal(bars.length, 1);
    assert.equal(bars[0].locale, 'nl');
  });
});

// ---------------------------------------------------------------------------
// db.js — addBar / updateBar / replaceBars normalize + persist locale
// ---------------------------------------------------------------------------

describe('db.js — bar locale CRUD', () => {
  test('addBar defaults to "nl" when locale is omitted', async () => {
    const bar = await addBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'A', bar_email: 'a@example.com' });
    assert.equal(bar.locale, 'nl');
  });

  test('addBar stores "en" when explicitly given', async () => {
    const bar = await addBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'London Bar', bar_email: 'ldn@example.com', locale: 'en' });
    assert.equal(bar.locale, 'en');
  });

  test('addBar normalizes any non-"en" value (typo, garbage) to "nl"', async () => {
    const bar = await addBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'A', bar_email: 'a@example.com', locale: 'fr' });
    assert.equal(bar.locale, 'nl');
  });

  test('updateBar can flip an existing bar from "nl" to "en"', async () => {
    const bar = await addBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'A', bar_email: 'a@example.com' });
    assert.equal(bar.locale, 'nl');
    const updated = await updateBar(sqliteDb, bar.id, { locale: 'en' });
    assert.equal(updated.locale, 'en');
  });

  test('replaceBars threads locale per bar, defaulting "nl" when a bar omits it', async () => {
    const saved = await replaceBars(sqliteDb, 'testroute', [
      { bar_name: 'NL Bar', bar_email: 'nl@example.com', minutes_offset: 0 },
      { bar_name: 'EN Bar', bar_email: 'en@example.com', minutes_offset: 75, locale: 'en' },
    ]);
    assert.deepEqual(saved.map((b) => [b.bar_name, b.locale]), [['NL Bar', 'nl'], ['EN Bar', 'en']]);
  });
});

// ---------------------------------------------------------------------------
// admin_api.js — bars CRUD endpoints expose locale (owner dashboard)
// ---------------------------------------------------------------------------

function adminRequest(method, pathname, body) {
  return new Request(`https://api.example.com${pathname}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
  });
}

describe('admin_api.js — bar locale round-trips through the HTTP handlers', () => {
  test('POST (add bar) accepts and returns locale', async () => {
    const env = { DB: sqliteDb };
    const res = await handleAddBar(adminRequest('POST', '/admin/api/routes/testroute/bars', {
      ord: 1, bar_name: 'London Bar', bar_email: 'ldn@example.com', locale: 'en',
    }), env, { id: 'testroute' });
    assert.equal(res.status, 201);
    const { bar } = await res.json();
    assert.equal(bar.locale, 'en');
  });

  test('PATCH (update bar) can change locale alone', async () => {
    const created = await addBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'A', bar_email: 'a@example.com' });
    const env = { DB: sqliteDb };
    const res = await handleUpdateBar(adminRequest('PATCH', `/admin/api/bars/${created.id}`, { locale: 'en' }), env, { barId: created.id });
    const { bar } = await res.json();
    assert.equal(bar.locale, 'en');
  });

  test('PUT (replace bars) accepts a locale per bar in the saved list', async () => {
    const env = { DB: sqliteDb };
    const res = await handleReplaceBars(adminRequest('PUT', '/admin/api/routes/testroute/bars', {
      bars: [{ bar_name: 'EN Bar', bar_email: 'en@example.com', minutes_offset: 0, locale: 'en' }],
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);
    const { bars } = await res.json();
    assert.equal(bars[0].locale, 'en');
  });
});

// ---------------------------------------------------------------------------
// logic.js — computeBarArrivals threads locale through
// ---------------------------------------------------------------------------

describe('computeBarArrivals — locale (migrations/0022)', () => {
  const route = { id: 'testroute', name: 'Test Route', city: 'Testville' };
  const booking = { date: '2026-10-10', slot: '19:00', party: 2 };

  test('carries each bar row\'s own locale through to the arrival', () => {
    const routesBars = [
      { ord: 1, bar_name: 'NL Bar', bar_email: 'nl@example.com', minutes_offset: 0, locale: 'nl' },
      { ord: 2, bar_name: 'EN Bar', bar_email: 'en@example.com', minutes_offset: 75, locale: 'en' },
    ];
    const result = computeBarArrivals(route, routesBars, [], booking);
    assert.deepEqual(result.map((b) => b.locale), ['nl', 'en']);
  });

  test('defaults to "nl" when a bar row has no locale at all', () => {
    const routesBars = [{ ord: 1, bar_name: 'No Locale', bar_email: 'x@example.com', minutes_offset: 0 }];
    const result = computeBarArrivals(route, routesBars, [], booking);
    assert.equal(result[0].locale, 'nl');
  });

  test('an alternate_bars date-override payload (no DB column, no locale) also defaults to "nl"', () => {
    const overrides = [{
      action: 'alternate_bars', date: booking.date,
      payload: JSON.stringify([{ bar_name: 'Alt Bar', bar_email: 'alt@example.com', minutes_offset: 0 }]),
    }];
    const result = computeBarArrivals(route, [], overrides, booking);
    assert.equal(result[0].locale, 'nl');
  });
});

// ---------------------------------------------------------------------------
// emails.js — NL render (owner's exact spec wording), EN unchanged, default
// ---------------------------------------------------------------------------

const route = { id: 'rotterdam-witte-de-with', name: 'Rotterdam Route 1', city: 'Rotterdam', currency: 'EUR' };
const booking = {
  id: 'b_1', date: '2026-10-10', slot: '19:00', party: 2,
  name: 'Anna de Vries', email: 'anna@example.com', phone: '+31611111111', notes: null,
};

describe('renderBarNotification — NL (owner spec wording)', () => {
  const bar = { bar_name: 'De Botanie', bar_email: 'botanie@example.com', arrival_time: '19:00', locale: 'nl' };

  test('subject matches the owner\'s exact spec', () => {
    const { subject } = renderBarNotification(bar, booking, route);
    assert.equal(subject, 'WOGO reservering · 19:00 · 2 gasten · 10 oktober 2026');
  });

  test('heading, hero title, intro, section labels', () => {
    const { html } = renderBarNotification(bar, booking, route);
    assert.ok(html.includes('Hoi De Botanie,'), 'greeting');
    assert.ok(html.includes('Tafel voor 2 om 19:00'), 'hero title');
    assert.ok(html.includes('Er komt een WOGO Cocktail Walk groep naar jullie toe. Hier is alles wat je nodig hebt.'), 'intro');
    assert.ok(html.includes('Aankomsttijd'), 'arrival label');
    assert.ok(html.includes('Gezelschap'), 'party label');
    assert.ok(html.includes('Naam gast'), 'guest name label');
    assert.ok(html.includes('Contact gast'), 'guest contact label');
    assert.ok(html.includes('Reserveer alsjeblieft een tafel voor'), 'closing');
    assert.ok(!html.includes('—'), 'no em-dashes in the Dutch bar copy');
  });

  test('allergies block uses the Dutch label, and renders ABOVE the arrival hero (the "nut allergy must reach the bartender" ordering guard, in NL too)', () => {
    const { html } = renderBarNotification(bar, { ...booking, notes: 'Notenallergie' }, route);
    assert.ok(html.includes('Allergieën / opmerkingen:'));
    assert.ok(html.indexOf('Allergieën / opmerkingen:') < html.indexOf('Aankomsttijd'), 'allergies block must render above the arrival-time hero');
  });
});

describe('renderBarNotification — EN unchanged', () => {
  const bar = { bar_name: "Let's Meat", bar_email: 'letsmeat@example.com', arrival_time: '19:00', locale: 'en' };

  test('subject keeps the raw ISO date, exactly as before 0022', () => {
    const { subject } = renderBarNotification(bar, booking, route);
    assert.equal(subject, "WOGO reservation · 19:00 · 2 guests · 2026-10-10");
  });

  test('English copy untouched', () => {
    const { html } = renderBarNotification(bar, booking, route);
    assert.ok(html.includes("Hi Let&#39;s Meat,"));
    assert.ok(html.includes('Arrival time'));
    assert.ok(html.includes('A WOGO Cocktail Walk group is on the way to you.'));
  });
});

describe('renderBarNotification — defaults to NL when bar.locale is missing', () => {
  test('a bar object with no locale field renders Dutch', () => {
    const bar = { bar_name: 'Legacy Bar', bar_email: 'legacy@example.com', arrival_time: '19:00' };
    const { html, subject } = renderBarNotification(bar, booking, route);
    assert.ok(subject.startsWith('WOGO reservering'));
    assert.ok(html.includes('Hoi Legacy Bar,'));
  });
});

describe('renderBarReschedule — NL (owner spec wording)', () => {
  const bar = { bar_name: 'De Botanie', bar_email: 'botanie@example.com', arrival_time: '18:00', locale: 'nl' };
  const rescheduledBooking = { ...booking, date: '2026-10-08', slot: '18:00' };

  test('subject matches the owner\'s exact spec', () => {
    const { subject } = renderBarReschedule(bar, rescheduledBooking, route, {});
    assert.equal(subject, 'WOGO reservering VERPLAATST · nu 18:00 · 8 oktober 2026');
  });

  test('the "Was:" line uses the given Dutch wording, no em-dash', () => {
    const { html } = renderBarReschedule(bar, rescheduledBooking, route, {
      previous: { date: '2026-10-07', arrival_time: '17:00' },
    });
    assert.ok(html.includes('Was:'));
    assert.ok(html.includes('je mag die tafel vrijgeven.'));
    assert.ok(!html.includes('—'), 'no em-dashes in the Dutch bar copy');
  });

  test('hero badge + heading + new arrival label', () => {
    const { html } = renderBarReschedule(bar, rescheduledBooking, route, {});
    assert.ok(html.includes('Reservering verplaatst'));
    assert.ok(html.includes('Hoi De Botanie,'));
    assert.ok(html.includes('Nieuwe aankomsttijd'));
  });
});

describe('renderBarReschedule — EN unchanged', () => {
  const bar = { bar_name: 'Bar A', bar_email: 'bara@example.com', arrival_time: '18:00', locale: 'en' };
  const rescheduledBooking = { ...booking, date: '2026-10-08', slot: '18:00' };

  test('subject + copy exactly as before 0022', () => {
    const { subject, html } = renderBarReschedule(bar, rescheduledBooking, route, {});
    assert.equal(subject, 'WOGO reservation MOVED · now 18:00 · 2026-10-08 · 2 guests');
    assert.ok(html.includes('New arrival time'));
    assert.ok(html.includes('This WOGO reservation has'));
  });
});

describe('renderBarCancellation — NL (owner spec wording)', () => {
  const bar = { bar_name: 'De Botanie', bar_email: 'botanie@example.com', arrival_time: '19:00', locale: 'nl' };

  test('subject starts with the owner\'s exact Dutch prefix', () => {
    const { subject } = renderBarCancellation(bar, booking, route);
    assert.ok(subject.startsWith('WOGO reservering GEANNULEERD ·'));
    assert.equal(subject, 'WOGO reservering GEANNULEERD · 10 oktober 2026 19:00 · 2 gasten');
  });

  test('hero + heading + labels', () => {
    const { html } = renderBarCancellation(bar, booking, route);
    assert.ok(html.includes('Reservering geannuleerd'));
    assert.ok(html.includes('Tafel vrijgegeven'));
    assert.ok(html.includes('Hoi De Botanie,'));
    assert.ok(html.includes('Datum'));
    assert.ok(html.includes('Gezelschap'));
  });
});

describe('renderBarCancellation — EN unchanged', () => {
  const bar = { bar_name: 'Bar A', bar_email: 'bara@example.com', arrival_time: '19:00', locale: 'en' };

  test('subject + copy exactly as before 0022', () => {
    const { subject, html } = renderBarCancellation(bar, booking, route);
    assert.equal(subject, 'WOGO reservation CANCELLED · 2026-10-10 19:00 · 2 guests');
    assert.ok(html.includes('Table released'));
    assert.ok(html.includes('This WOGO reservation has been'));
  });
});

// ---------------------------------------------------------------------------
// webhook.js — end to end: each bar gets mail in ITS OWN language
// ---------------------------------------------------------------------------

describe('webhook.js — notifyBars/Reschedule/Cancellation send each bar its own language', () => {
  test('notifyBars: an NL bar and an EN bar on the same route each get their own language', async () => {
    await addBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'NL Bar', bar_email: 'nl@example.com', minutes_offset: 0, locale: 'nl' });
    await addBar(sqliteDb, 'testroute', { ord: 2, bar_name: 'EN Bar', bar_email: 'en@example.com', minutes_offset: 75, locale: 'en' });

    const route_ = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };
    const sent = [];
    const booking_ = { route_id: 'testroute', date: '2026-10-10', slot: '19:00', name: 'Anna', email: 'anna@example.com', party: 2 };

    await notifyBars(env, booking_, route_, { database: db, sendTransactional: async (env2, msg) => { sent.push(msg); } });

    const nlMail = sent.find((m) => m.to === 'nl@example.com');
    const enMail = sent.find((m) => m.to === 'en@example.com');
    assert.ok(nlMail.subject.startsWith('WOGO reservering'), 'NL bar gets a Dutch subject');
    assert.ok(enMail.subject.startsWith('WOGO reservation'), 'EN bar gets an English subject');
    assert.ok(nlMail.htmlContent.includes('Hoi NL Bar,'));
    assert.ok(enMail.htmlContent.includes('Hi EN Bar,'));
  });

  test('notifyBarsReschedule respects each bar\'s locale', async () => {
    await addBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'NL Bar', bar_email: 'nl@example.com', minutes_offset: 0, locale: 'nl' });
    const route_ = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };
    const sent = [];
    const newBooking = { route_id: 'testroute', date: '2026-10-11', slot: '19:00', name: 'Anna', email: 'anna@example.com', party: 2 };

    await notifyBarsReschedule(env, newBooking, route_, {
      previous: { date: '2026-10-10', slot: '19:00' },
      database: db,
      sendTransactional: async (env2, msg) => { sent.push(msg); },
    });

    assert.equal(sent.length, 1);
    assert.ok(sent[0].subject.startsWith('WOGO reservering VERPLAATST'));
  });

  test('notifyBarsCancellation respects each bar\'s locale', async () => {
    await addBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'EN Bar', bar_email: 'en@example.com', minutes_offset: 0, locale: 'en' });
    const route_ = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };
    const sent = [];
    const booking_ = { route_id: 'testroute', date: '2026-10-10', slot: '19:00', name: 'Anna', email: 'anna@example.com', party: 2 };

    await notifyBarsCancellation(env, booking_, route_, { database: db, sendTransactional: async (env2, msg) => { sent.push(msg); } });

    assert.equal(sent.length, 1);
    assert.ok(sent[0].subject.startsWith('WOGO reservation CANCELLED'));
  });
});
