// test/reminders.test.js — "your walk is in 2 days" email (migrations/0031,
// src/reminders.js): the daily cron's date math, candidate selection, the
// meeting-point/map wiring, the atomic claim, the reminder opt-out, EN/NL
// rendering, and the accurate reschedule-policy line.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional } from '../src/db.js';
import * as db from '../src/db.js';
import { sendWalkReminderForBooking, sendDailyWalkReminders } from '../src/reminders.js';
import { renderWalkReminder } from '../src/emails.js';
import { todayInTimezone, addDaysToDateStr } from '../src/logic.js';
import { WALK_REMINDER_DAYS_BEFORE } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0017_map_by_weekday.sql',
  '0022_bar_locale.sql', '0025_admin_users.sql', '0026_review_requests.sql', '0029_route_booking_cutoff.sql',
  '0031_abandoned_reminders.sql', '0033_addons.sql',
].map(migration).join('\n');

function run(testDb, sql, params = {}) {
  const t = toPositional(sql, params);
  return testDb.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(testDb, id = 'r1') {
  run(testDb, `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,map_url,active)
                VALUES (:id,'Route One','Amsterdam',3000,10,6,'[1,2,3,4,5,6,7]','["18:00"]','https://maps.example/r1.pdf',1)`, { id });
}

function seedBar(testDb, route_id = 'r1', { ord = 1, bar_name = 'Door 74', bar_email = 'bar@example.com', minutes_offset = 0 } = {}) {
  run(testDb, `INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset) VALUES (:route_id, :ord, :bar_name, :bar_email, :minutes_offset)`,
    { route_id, ord, bar_name, bar_email, minutes_offset });
}

function seedBooking(testDb, { id, route_id = 'r1', date, slot = '18:00', party = 2, status = 'confirmed', source = 'web', locale = 'en', reminder_sent_at = null, email = 'guest@example.com', name = 'Guest' }) {
  run(testDb, `INSERT INTO bookings
      (id, route_id, date, slot, party, name, email, phone, locale, marketing_opt_in, status, created_at, source, reminder_sent_at)
     VALUES (:id, :route_id, :date, :slot, :party, :name, :email, NULL, :locale, 0, :status, datetime('now'), :source, :reminder_sent_at)`,
    { id, route_id, date, slot, party, name, email, locale, status, source, reminder_sent_at });
}

let testDb;
const sentEmails = [];
function fakeSendTransactional(env, msg) {
  sentEmails.push(msg);
  return Promise.resolve({ ok: true });
}

beforeEach(() => { testDb = makeTestDb(schemaSql); sentEmails.length = 0; });

// ---------------------------------------------------------------------------
// renderWalkReminder — EN/NL, meeting point, accurate reschedule policy.
// ---------------------------------------------------------------------------

describe('renderWalkReminder', () => {
  const booking = { name: 'Bram', date: '2026-11-20', slot: '18:00', party: 4, locale: 'en' };
  const route = { id: 'amsterdam', name: 'WOGO Amsterdam', city: 'Amsterdam', map_url: 'https://maps.example/x.pdf' };

  test('EN: subject, map button, meeting point, 18+ and the accurate reschedule rule', () => {
    const mail = renderWalkReminder(booking, route, { firstBarName: 'Door 74' });
    assert.match(mail.subject, /Your cocktail walk is in 2 days/);
    assert.match(mail.html, /Door 74/);
    assert.match(mail.html, /18\+/);
    assert.match(mail.html, /One reschedule is allowed with at least 24 hours notice/);
    assert.match(mail.html, /non-refundable and non-transferable/);
    assert.match(mail.html, /maps\.example\/x\.pdf/);
    // Only the START time is stated — never a bar-2/3 arrival rhythm.
    assert.doesNotMatch(mail.html, /bar 2|bar 3|second bar|third bar/i);
  });

  test('NL: subject, warm tone, no em-dashes anywhere (including the map section override)', () => {
    const mail = renderWalkReminder({ ...booking, locale: 'nl' }, route, { firstBarName: 'Door 74' });
    assert.match(mail.subject, /Over 2 dagen loop je je cocktail walk/);
    assert.match(mail.html, /24 uur/);
    assert.doesNotMatch(mail.html, /—/);
  });

  test('falls back to the route name as the meeting point when no bar data is available', () => {
    const mail = renderWalkReminder(booking, route, {});
    assert.match(mail.html, /WOGO Amsterdam/);
  });

  test('carries the unsubscribe link when opts.unsubscribeUrl is passed', () => {
    const mail = renderWalkReminder(booking, route, { unsubscribeUrl: 'https://x.test/api/reminders/unsubscribe?token=abc' });
    assert.match(mail.html, /reminders\/unsubscribe\?token=abc/);
  });
});

// ---------------------------------------------------------------------------
// sendWalkReminderForBooking — the atomic claim + meeting-point resolution.
// ---------------------------------------------------------------------------

describe('sendWalkReminderForBooking', () => {
  test('sends once, resolves the first bar as the meeting point, and the SAME booking is rejected on a second call', async () => {
    seedRoute(testDb);
    seedBar(testDb, 'r1', { bar_name: 'Door 74' });
    seedBooking(testDb, { id: 'b1', date: '2026-11-20', email: 'guest@example.com' });
    const env = { DB: testDb, ADMIN_SESSION_SECRET: 'test-secret' };

    const first = await sendWalkReminderForBooking(env, { ...(await db.getBooking(testDb, 'b1')) }, { sendTransactional: fakeSendTransactional });
    assert.equal(first.sent, true);
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].htmlContent, /Door 74/);

    const second = await sendWalkReminderForBooking(env, { ...(await db.getBooking(testDb, 'b1')) }, { sendTransactional: fakeSendTransactional });
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'already_sent_or_not_confirmed');
    assert.equal(sentEmails.length, 1);
  });

  test('a cancelled booking cannot be claimed', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b2', date: '2026-11-20', status: 'cancelled' });
    const env = { DB: testDb, ADMIN_SESSION_SECRET: 'test-secret' };
    const booking = await db.getBooking(testDb, 'b2');
    const result = await sendWalkReminderForBooking(env, booking, { sendTransactional: fakeSendTransactional });
    assert.equal(result.sent, false);
    assert.equal(sentEmails.length, 0);
  });

  test('an opted-out email never gets the reminder', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b3', date: '2026-11-20', email: 'optout@example.com' });
    await db.recordReminderOptOut(testDb, 'optout@example.com');
    const env = { DB: testDb, ADMIN_SESSION_SECRET: 'test-secret' };
    const booking = await db.getBooking(testDb, 'b3');
    const result = await sendWalkReminderForBooking(env, booking, { sendTransactional: fakeSendTransactional });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'opted_out');
    assert.equal(sentEmails.length, 0);
  });
});

// ---------------------------------------------------------------------------
// sendDailyWalkReminders — candidate selection + DST-safe date math.
// ---------------------------------------------------------------------------

describe('sendDailyWalkReminders', () => {
  test('picks exactly confirmed web/manual bookings exactly WALK_REMINDER_DAYS_BEFORE days out, skipping cancelled/hold/already-sent/wrong-day', async () => {
    seedRoute(testDb);
    const target = addDaysToDateStr(todayInTimezone('Europe/Amsterdam'), WALK_REMINDER_DAYS_BEFORE);
    const wrongDay = addDaysToDateStr(target, 1);

    seedBooking(testDb, { id: 't1', date: target, status: 'confirmed', source: 'web', email: 't1@example.com' });
    seedBooking(testDb, { id: 't2', date: target, status: 'confirmed', source: 'manual', email: 't2@example.com' });
    seedBooking(testDb, { id: 't3', date: target, status: 'cancelled', email: 't3@example.com' });
    seedBooking(testDb, { id: 't4', date: target, status: 'confirmed', reminder_sent_at: '2026-01-01 09:00:00', email: 't4@example.com' });
    seedBooking(testDb, { id: 't5', date: target, status: 'hold', email: 't5@example.com' });
    seedBooking(testDb, { id: 'wrong', date: wrongDay, status: 'confirmed', email: 'wrong@example.com' });

    const result = await sendDailyWalkReminders({ DB: testDb, ADMIN_SESSION_SECRET: 'test-secret' }, { sendTransactional: fakeSendTransactional });
    assert.equal(result.date, target);
    assert.equal(result.candidates, 2); // t1, t2 only
    assert.equal(result.sent, 2);
    const sentTo = sentEmails.map((m) => m.to).sort();
    assert.deepEqual(sentTo, ['t1@example.com', 't2@example.com']);

    const again = await sendDailyWalkReminders({ DB: testDb, ADMIN_SESSION_SECRET: 'test-secret' }, { sendTransactional: fakeSendTransactional });
    assert.equal(again.candidates, 0);
    assert.equal(again.sent, 0);
  });

  test('renders in the booking\'s own locale', async () => {
    seedRoute(testDb);
    const target = addDaysToDateStr(todayInTimezone('Europe/Amsterdam'), WALK_REMINDER_DAYS_BEFORE);
    seedBooking(testDb, { id: 'nl1', date: target, locale: 'nl', email: 'nl1@example.com' });
    await sendDailyWalkReminders({ DB: testDb, ADMIN_SESSION_SECRET: 'test-secret' }, { sendTransactional: fakeSendTransactional });
    assert.match(sentEmails[0].subject, /Over 2 dagen/);
  });
});

// ---------------------------------------------------------------------------
// DST pin — addDaysToDateStr/todayInTimezone are pure calendar-string
// arithmetic with no DST hazard (unlike the abandoned flow's cutoff check,
// which does cross real UTC instants) — pinned anyway across the 25 Oct 2026
// Europe/Amsterdam fall-back date, per the task's explicit ask.
// ---------------------------------------------------------------------------

describe('DST pin — the +2-days date math', () => {
  test('2 days before the fall-back date lands correctly on the other side of it', () => {
    assert.equal(addDaysToDateStr('2026-10-23', 2), '2026-10-25');
    assert.equal(addDaysToDateStr('2026-10-24', 2), '2026-10-26');
  });
});
