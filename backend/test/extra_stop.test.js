// test/extra_stop.test.js — migrations/0034: "extra stop" add-ons (a 4th bar
// at the end of the walk, e.g. Rotterdam Route 2 + Patio Bar, Delft +
// Sevenhills). Pins: the opening-hours rule (arrive >= 1.5 h before closing,
// only on listed weekdays) on every server path, the whole-group quantity
// rule, the extra bar being emailed ONLY for bookings that bought it, and the
// 4-bar map replacing the route map in the guest's emails.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import * as realDb from '../src/db.js';
import { toPositional } from '../src/db.js';
import { handleBook, handleListAddons } from '../src/guest_api.js';
import { notifyBars, notifyBarsCancellation } from '../src/webhook.js';
import { renderGuestConfirmation, renderWalkReminder } from '../src/emails.js';
import { addDaysToDateStr, isoWeekday, addonFitsTime, validateAddonHours, computeBarArrivals } from '../src/logic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql',
  '0022_bar_locale.sql', '0025_admin_users.sql', '0027_booking_utm.sql', '0028_bookings_email_lower_index.sql',
  '0029_route_booking_cutoff.sql', '0032_push_notifications.sql', '0033_addons.sql', '0034_addon_extra_stop.sql',
].map(migration).join('\n');

function run(testDb, sql, params = {}) {
  const t = toPositional(sql, params);
  return testDb.prepare(t.sql).bind(...t.values).run();
}

// Fixed calendar dates for the pure rule tests: 2026-11-26 Thu, 27 Fri, 28 Sat.
const THU = '2026-11-26', FRI = '2026-11-27', SAT = '2026-11-28', SUN = '2026-11-29';

// A real future Friday (>= 5 days out) for tests that go through POST /api/book.
function nextFriday() {
  let d = addDaysToDateStr(new Date().toISOString().slice(0, 10), 5);
  while (isoWeekday(d) !== 5) d = addDaysToDateStr(d, 1);
  return d;
}
const BOOK_FRI = nextFriday();

const PATIO = {
  extra_stop_offset_minutes: 180,
  hours: JSON.stringify({ 5: ['18:00', '23:00'], 6: ['18:00', '23:00'] }),
  min_minutes_before_close: 90,
};
const SEVENHILLS = {
  extra_stop_offset_minutes: 180,
  hours: JSON.stringify(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, ['11:00', '23:00']]))),
  min_minutes_before_close: 90,
};

describe('addonFitsTime — the tables agreed with the owner (arrive >= 1.5 h before closing)', () => {
  test('Patio (Fri+Sat 18:00-23:00): only the 18:00 and 18:30 starts, never Thursday', () => {
    for (const day of [FRI, SAT]) {
      assert.equal(addonFitsTime(PATIO, day, '18:00'), true);
      assert.equal(addonFitsTime(PATIO, day, '18:30'), true);
      assert.equal(addonFitsTime(PATIO, day, '19:00'), false);
      assert.equal(addonFitsTime(PATIO, day, '19:30'), false);
      assert.equal(addonFitsTime(PATIO, day, '20:00'), false);
    }
    assert.equal(addonFitsTime(PATIO, THU, '18:00'), false, 'Patio is closed on Thursday');
    assert.equal(addonFitsTime(PATIO, SUN, '18:00'), false);
  });

  test('Sevenhills (daily 11:00-23:00): starts up to 18:00', () => {
    for (const s of ['13:00', '14:00', '15:00', '16:00', '17:00', '18:00']) assert.equal(addonFitsTime(SEVENHILLS, FRI, s), true, s);
    for (const s of ['19:00', '20:00', '21:00']) assert.equal(addonFitsTime(SEVENHILLS, FRI, s), false, s);
    assert.equal(addonFitsTime(SEVENHILLS, THU, '18:00'), true);
  });

  test('arriving before the bar opens is not allowed', () => {
    const a = { extra_stop_offset_minutes: 180, hours: JSON.stringify({ 5: ['20:15', '23:00'] }), min_minutes_before_close: 30 };
    assert.equal(addonFitsTime(a, FRI, '17:00'), false);
    assert.equal(addonFitsTime(a, FRI, '17:30'), true);
  });

  test('a bar closing after midnight works', () => {
    const a = { extra_stop_offset_minutes: 180, hours: JSON.stringify({ 5: ['18:00', '02:00'] }), min_minutes_before_close: 90 };
    assert.equal(addonFitsTime(a, FRI, '21:00'), true);  // arrives 00:00, closes 02:00
    assert.equal(addonFitsTime(a, FRI, '21:30'), true);  // arrives 00:30
    assert.equal(addonFitsTime(a, FRI, '22:00'), false); // arrives 01:00
  });

  test('date window: Patio on Rotterdam only until 31 Dec 2026 — never on walks from 1 January', () => {
    const a = { ...PATIO, available_until: '2026-12-31' };
    assert.equal(addonFitsTime(a, '2026-12-19', '18:00'), true);  // Sat
    assert.equal(addonFitsTime(a, '2027-01-02', '18:00'), false); // Sat, after the window
    const b = { ...PATIO, available_from: '2026-12-01' };
    assert.equal(addonFitsTime(b, FRI, '18:00'), false);
  });

  test('Rotterdam Route 1 (17:00 start) fits Patio on Fri/Sat: arrives 20:00', () => {
    assert.equal(addonFitsTime(PATIO, FRI, '17:00'), true);
    assert.equal(addonFitsTime(PATIO, THU, '17:00'), false);
  });

  test('no hours = no rule (every pre-0034 add-on); unreadable hours = never offered', () => {
    assert.equal(addonFitsTime({ hours: null }, FRI, '21:00'), true);
    assert.equal(addonFitsTime({ hours: 'not json' }, FRI, '18:00'), false);
  });
});

describe('validateAddonHours', () => {
  test('accepts an object or a JSON string and canonicalizes it', () => {
    assert.deepEqual(validateAddonHours({ 5: ['18:00', '23:00'] }), { ok: true, value: '{"5":["18:00","23:00"]}' });
    assert.deepEqual(validateAddonHours(null), { ok: true, value: null });
  });
  test('rejects bad weekdays and bad times', () => {
    assert.equal(validateAddonHours({ 8: ['18:00', '23:00'] }).ok, false);
    assert.equal(validateAddonHours({ 5: ['6pm', '23:00'] }).ok, false);
    assert.equal(validateAddonHours('Fri 18:00-23:00').ok, false);
  });
});

let db;
beforeEach(() => { db = makeTestDb(schemaSql); });

function seedRoute(overrides = {}) {
  const route = {
    id: 'testroute', name: 'Rotterdam Route 2', city: 'Rotterdam', price_cents: 2995,
    capacity: 50, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00","18:30","19:00"]',
    slot_capacity: '{}', map_url: 'https://x/route-en.pdf', map_url_nl: 'https://x/route-nl.pdf', active: 1, currency: 'EUR', timezone: 'Europe/Amsterdam',
    ...overrides,
  };
  const cols = Object.keys(route);
  run(db, `INSERT INTO routes (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, route);
  return route;
}

async function seedBars() {
  await realDb.addBar(db, 'testroute', { ord: 1, bar_name: 'Bar One', bar_email: 'one@example.com', minutes_offset: 0, locale: 'nl' });
  await realDb.addBar(db, 'testroute', { ord: 2, bar_name: 'Bar Two', bar_email: 'two@example.com', minutes_offset: 60, locale: 'nl' });
  await realDb.addBar(db, 'testroute', { ord: 3, bar_name: 'Bar Three', bar_email: 'three@example.com', minutes_offset: 120, locale: 'nl' });
}

async function seedExtraStop(overrides = {}) {
  return realDb.createAddon(db, 'testroute', {
    name_en: 'Make it 4 bars', name_nl: 'Maak er 4 bars van', price_cents: 900, cost_cents: 500,
    currency: 'EUR', vat_rate: 21, is_food: false, unit: 'whole_group', max_qty_per_booking: 10,
    capacity_per_slot: 12, cutoff_hours: 24, sort_order: 0, active: true,
    extra_stop_name: 'Patio Bar', extra_stop_email: 'patio@example.com', extra_stop_locale: 'nl',
    map_url_en: 'https://x/4bars-en.pdf', map_url_nl: 'https://x/4bars-nl.pdf',
    ...PATIO,
    ...overrides,
  });
}

async function book(body) {
  const realFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ id: 'cs_' + Math.random(), url: 'https://checkout.stripe.com/x' }), { status: 200 });
  try {
    return await handleBook(new Request('https://api.example.com/api/book', {
      method: 'POST',
      body: JSON.stringify({ route_id: 'testroute', date: BOOK_FRI, party: 3, name: 'Anna', email: `anna${Math.random()}@example.com`, locale: 'en', marketing_opt_in: false, ...body }),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.0.0.${Math.floor(Math.random() * 200)}`, Origin: 'http://localhost:8000' },
    }), { DB: db, STRIPE_SECRET_KEY: 'sk_test' });
  } finally {
    global.fetch = realFetch;
  }
}

describe('server paths respect the hours rule and the whole-group rule', () => {
  test('createAddon keeps unit whole_group and every extra-stop field', async () => {
    seedRoute();
    const a = await seedExtraStop();
    assert.equal(a.unit, 'whole_group');
    assert.equal(a.extra_stop_email, 'patio@example.com');
    assert.equal(a.extra_stop_offset_minutes, 180);
    const u = await realDb.updateAddon(db, a.id, { unit: 'whole_group', min_minutes_before_close: 60 });
    assert.equal(u.unit, 'whole_group');
    assert.equal(u.min_minutes_before_close, 60);
  });

  test('GET /api/addons only offers the extra stop at slots that fit', async () => {
    seedRoute();
    await seedExtraStop();
    const at = async (slot) => (await (await handleListAddons(new Request(`https://api.example.com/api/addons?route=testroute&date=${BOOK_FRI}&slot=${slot}`), { DB: db })).json()).addons;
    assert.equal((await at('18:00')).length, 1);
    assert.equal((await at('18:30')).length, 1);
    assert.equal((await at('19:00')).length, 0);
  });

  test('POST /api/book: whole group OK, a partial quantity is rejected, a non-fitting slot is rejected', async () => {
    seedRoute();
    const a = await seedExtraStop();
    const ok = await book({ slot: '18:00', addons: [{ addon_id: a.id, qty: 3 }] });
    assert.equal(ok.status, 200);
    const partial = await book({ slot: '18:00', addons: [{ addon_id: a.id, qty: 1 }] });
    assert.equal(partial.status, 400);
    const late = await book({ slot: '19:00', addons: [{ addon_id: a.id, qty: 3 }] });
    assert.equal(late.status, 400);
    assert.equal((await late.json()).error, 'addon_not_found');
  });

  test('checkAddonsFitSlot refuses a move to a time the extra bar cannot take', async () => {
    seedRoute();
    const a = await seedExtraStop();
    const res = await book({ slot: '18:00', addons: [{ addon_id: a.id, qty: 3 }] });
    const { booking_id } = await res.json();
    const ok = await realDb.checkAddonsFitSlot(db, booking_id, 'testroute', BOOK_FRI, '18:30', 'Europe/Amsterdam');
    assert.deepEqual(ok, []);
    const bad = await realDb.checkAddonsFitSlot(db, booking_id, 'testroute', BOOK_FRI, '19:00', 'Europe/Amsterdam');
    assert.equal(bad.length, 1);
    assert.equal(bad[0].reason, 'hours');
  });
});

describe('the extra bar is emailed only for bookings that bought it', () => {
  const route = { id: 'testroute', name: 'Rotterdam Route 2', city: 'Rotterdam', timezone: 'Europe/Amsterdam', currency: 'EUR' };
  const booking = { id: 'b_x', route_id: 'testroute', date: FRI, slot: '18:00', party: 3, name: 'Anna', email: 'anna@example.com', phone: null, locale: 'en', notes: null, addon_notes: null };

  test('with the extra stop: 4 bar emails, the 4th at +3 h, with no price or add-on block in it', async () => {
    seedRoute();
    await seedBars();
    const a = await seedExtraStop();
    run(db, `INSERT INTO bookings (id, route_id, date, slot, party, name, email, status, source, locale) VALUES ('b_x','testroute',:d,'18:00',3,'Anna','anna@example.com','confirmed','web','en')`, { d: FRI });
    await realDb.createBookingAddon(db, { booking_id: 'b_x', addon_id: a.id, qty: 3, unit_price_cents: 900, unit_cost_cents: 500, currency: 'EUR', vat_rate: 21, name_snapshot_en: a.name_en, name_snapshot_nl: a.name_nl, route_id: 'testroute', date: FRI, slot: '18:00' });
    const lines = await realDb.getAddonsForBooking(db, 'b_x');

    const emails = [];
    const arrivals = await notifyBars({ DB: db }, booking, route, {
      database: realDb, computeBarArrivals, addons: lines,
      sendTransactional: async (env, msg) => { emails.push(msg); },
    });
    assert.equal(emails.length, 4);
    const patio = emails.find((m) => m.to === 'patio@example.com');
    assert.ok(patio, 'the extra bar must be emailed');
    assert.equal(arrivals.find((x) => x.bar_email === 'patio@example.com').arrival_time, '21:00');
    assert.match(patio.htmlContent, /21:00/);
    assert.doesNotMatch(patio.htmlContent, /9,00|9\.00|€\s?9/, 'no price in the bar email');
    for (const other of emails.filter((m) => m.to !== 'patio@example.com')) {
      assert.doesNotMatch(other.htmlContent, /Patio Bar|4 bars/i, 'the 3 route bars never see the extra stop');
    }

    // Cancellation reaches the extra bar too (fetches the add-ons itself).
    const cancelMails = [];
    await notifyBarsCancellation({ DB: db }, booking, route, { database: realDb, sendTransactional: async (env, msg) => { cancelMails.push(msg); } });
    assert.ok(cancelMails.some((m) => m.to === 'patio@example.com'));
  });

  test('without the extra stop: only the 3 route bars, exactly as before', async () => {
    seedRoute();
    await seedBars();
    await seedExtraStop();
    const emails = [];
    await notifyBars({ DB: db }, booking, route, {
      database: realDb, computeBarArrivals, addons: [],
      sendTransactional: async (env, msg) => { emails.push(msg); },
    });
    assert.deepEqual(emails.map((m) => m.to).sort(), ['one@example.com', 'three@example.com', 'two@example.com']);
  });
});

describe('4-bar map', () => {
  const route = { id: 'testroute', name: 'Rotterdam Route 2', city: 'Rotterdam', currency: 'EUR', map_url: 'https://x/route-en.pdf', map_url_nl: 'https://x/route-nl.pdf' };
  const booking = { id: 'b_1', date: FRI, slot: '18:00', party: 3, name: 'Anna', locale: 'en' };
  const line = { qty: 3, name_snapshot_en: 'Make it 4 bars', name_snapshot_nl: 'Maak er 4 bars van', unit_price_cents: 900, currency: 'EUR', map_url_en: 'https://x/4bars-en.pdf', map_url_nl: 'https://x/4bars-nl.pdf' };

  test('a guest with the extra stop gets the 4-bar map (both languages), not the route map', () => {
    const mail = renderGuestConfirmation(booking, route, { locale: 'en', addons: [line] });
    assert.match(mail.html, /4bars-en\.pdf/);
    assert.match(mail.html, /4bars-nl\.pdf/);
    assert.doesNotMatch(mail.html, /route-en\.pdf/);
    const rem = renderWalkReminder({ ...booking, locale: 'nl' }, route, { addons: [line] });
    assert.match(rem.html, /4bars-nl\.pdf/);
  });

  test('a guest without it still gets the normal route map', () => {
    const mail = renderGuestConfirmation(booking, route, { locale: 'en', addons: [] });
    assert.match(mail.html, /route-en\.pdf/);
    assert.doesNotMatch(mail.html, /4bars/);
  });
});

describe('paid total includes extras', () => {
  test('guest confirmation total = tickets + add-ons (3 x 29,95 + 3 x 9,00 = 116,85)', () => {
    const route = { id: 'r', name: 'Rotterdam Route 2', city: 'Rotterdam', currency: 'EUR', price_cents: 2995 };
    const booking = { id: 'b_1', date: '2026-11-27', slot: '18:00', party: 3, name: 'Anna', locale: 'nl' };
    const line = { qty: 3, name_snapshot_en: 'Make it 4 bars', name_snapshot_nl: 'Maak er 4 bars van', unit_price_cents: 900, currency: 'EUR' };
    assert.match(renderGuestConfirmation(booking, route, { locale: 'nl', addons: [line] }).html, /116,85/);
    assert.match(renderGuestConfirmation(booking, route, { locale: 'nl', addons: [] }).html, /89,85/);
  });
});
