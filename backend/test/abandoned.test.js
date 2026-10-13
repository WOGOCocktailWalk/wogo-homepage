// test/abandoned.test.js — abandoned-booking reminders (migrations/0031,
// src/abandoned.js): candidate selection (1h/24h windows), the "already
// booked"/confirmed_conflict exclusion, the seats-left/cutoff gate, the
// atomic claim, one-mail-per-guest dedupe + sibling suppression, the
// reminder opt-out, EN/NL rendering, and the no-discount-when-empty default.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { toPositional } from '../src/db.js';
import * as db from '../src/db.js';
import { sendAbandonedSweep, dedupeByEmailNewestFirst } from '../src/abandoned.js';
import { renderAbandonedBooking, renderAbandonedFollowup } from '../src/emails.js';
import { ABANDONED_DISCOUNT_CODE } from '../src/config.js';
import { isSlotPastCutoff, zonedDateTimeToUtc } from '../src/logic.js';
import { computeReminderUnsubscribeToken } from '../src/reminder_optout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0012_map_url_nl.sql', '0014_weekday_capacity.sql', '0015_weekday_bars.sql', '0022_bar_locale.sql',
  '0025_admin_users.sql', '0026_review_requests.sql', '0029_route_booking_cutoff.sql',
  '0031_abandoned_reminders.sql',
].map(migration).join('\n');

function run(testDb, sql, params = {}) {
  const t = toPositional(sql, params);
  return testDb.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(testDb, { id = 'r1', capacity = 10 } = {}) {
  run(testDb, `INSERT INTO routes (id,name,city,price_cents,capacity,max_party,open_days,slots,active)
                VALUES (:id,'Route One','Amsterdam',3000,:capacity,6,'[1,2,3,4,5,6,7]','["18:00"]',1)`, { id, capacity });
}

const FAR_FUTURE_DATE = '2099-06-15'; // always "in the future" relative to any real test run

function seedBooking(testDb, {
  id, route_id = 'r1', date = FAR_FUTURE_DATE, slot = '18:00', party = 2,
  name = 'Guest', email = 'guest@example.com', locale = 'en',
  status = 'hold', source = 'web', offsetMinutes = -90,
  abandoned_sent_at = null, abandoned_followup_sent_at = null,
}) {
  run(
    testDb,
    `INSERT INTO bookings
       (id, route_id, date, slot, party, name, email, phone, locale, marketing_opt_in, status, created_at, source, abandoned_sent_at, abandoned_followup_sent_at)
     VALUES
       (:id, :route_id, :date, :slot, :party, :name, :email, NULL, :locale, 0, :status, datetime('now', :offset), :source, :abandoned_sent_at, :abandoned_followup_sent_at)`,
    {
      id, route_id, date, slot, party, name, email, locale, status, source,
      offset: `${offsetMinutes} minutes`,
      abandoned_sent_at, abandoned_followup_sent_at,
    }
  );
}

let testDb;
const sentEmails = [];
function fakeSendTransactional(env, msg) {
  sentEmails.push(msg);
  return Promise.resolve({ ok: true });
}

beforeEach(() => { testDb = makeTestDb(schemaSql); sentEmails.length = 0; });

const ENV = () => ({ DB: testDb, ADMIN_SESSION_SECRET: 'test-secret' });

// ---------------------------------------------------------------------------
// renderAbandonedBooking / renderAbandonedFollowup — EN/NL rendering,
// "still free" language (never "reserved"/"held"), no discount by default.
// ---------------------------------------------------------------------------

describe('renderAbandonedBooking / renderAbandonedFollowup', () => {
  const booking = { name: 'Anna', date: '2026-11-14', slot: '18:00', party: 3, locale: 'en' };
  const route = { id: 'amsterdam', name: 'WOGO Amsterdam', city: 'Amsterdam', price_cents: 2995, currency: 'EUR' };

  test('EN first nudge: correct subject, never says reserved/held', () => {
    const mail = renderAbandonedBooking(booking, route);
    assert.match(mail.subject, /Your WOGO table in Amsterdam is still free/);
    assert.doesNotMatch(mail.html, /reserved/i);
    assert.doesNotMatch(mail.html, /held for you/i);
    assert.match(mail.html, /Already booked/i);
  });

  test('NL first nudge: correct subject, warm je/jij tone, no em-dashes', () => {
    const mail = renderAbandonedBooking({ ...booking, locale: 'nl' }, route);
    assert.match(mail.subject, /Je WOGO tafel in Amsterdam is nog vrij/);
    assert.doesNotMatch(mail.html, /—/, 'NL copy must contain no em-dashes');
    assert.doesNotMatch(mail.html, /gereserveerd/i);
  });

  test('EN follow-up: correct subject', () => {
    const mail = renderAbandonedFollowup(booking, route);
    assert.match(mail.subject, /Still thinking about Amsterdam\?/);
  });

  test('NL follow-up: correct subject, no em-dashes', () => {
    const mail = renderAbandonedFollowup({ ...booking, locale: 'nl' }, route);
    assert.match(mail.subject, /Twijfel je nog over Amsterdam\?/);
    assert.doesNotMatch(mail.html, /—/);
  });

  test('no discount block when ABANDONED_DISCOUNT_CODE is empty (the owner default)', () => {
    assert.equal(ABANDONED_DISCOUNT_CODE, '', 'sanity: default must be empty');
    const mail = renderAbandonedBooking(booking, route);
    assert.doesNotMatch(mail.html, /Use this code/i);
  });

  test('carries the unsubscribe link when opts.unsubscribeUrl is passed', () => {
    const mail = renderAbandonedBooking(booking, route, { unsubscribeUrl: 'https://x.test/api/reminders/unsubscribe?token=abc' });
    assert.match(mail.html, /reminders\/unsubscribe\?token=abc/);
  });
});

// ---------------------------------------------------------------------------
// dedupeByEmailNewestFirst — pure helper.
// ---------------------------------------------------------------------------

describe('dedupeByEmailNewestFirst', () => {
  test('keeps only the first (newest) row per lowercased email', () => {
    const rows = [
      { id: 'a', email: 'Guest@Example.com' },
      { id: 'b', email: 'guest@example.com' },
      { id: 'c', email: 'other@example.com' },
    ];
    const out = dedupeByEmailNewestFirst(rows);
    assert.deepEqual(out.map((r) => r.id), ['a', 'c']);
  });
});

// ---------------------------------------------------------------------------
// sendAbandonedSweep — the full candidate selection + atomic claim.
// ---------------------------------------------------------------------------

describe('sendAbandonedSweep — first-email stage', () => {
  test('sends the 1h nudge for a genuinely abandoned hold', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b1', offsetMinutes: -90, email: 'b1@example.com' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 1);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, 'b1@example.com');
  });

  test('skips a hold younger than the 1h minimum', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b2', offsetMinutes: -10, email: 'b2@example.com' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.candidates, 0);
    assert.equal(sentEmails.length, 0);
  });

  test('skips a hold older than the 48h safety cap (stale)', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b3', offsetMinutes: -(49 * 60), email: 'b3@example.com' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.candidates, 0);
  });

  test('skips a manual (phone) booking — never an abandoned online checkout', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b4', offsetMinutes: -90, email: 'b4@example.com', source: 'manual' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.candidates, 0);
  });

  test('skips a booking with no email', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b5', offsetMinutes: -90, email: '' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.candidates, 0);
  });

  test('idempotent claim: a second sweep tick sends nothing more for the same row', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b6', offsetMinutes: -90, email: 'b6@example.com' });
    await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    const again = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(again.first.candidates, 0);
    assert.equal(sentEmails.length, 1);
  });

  test('a CONFIRMED booking for the exact same route+date+slot blocks the nudge', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b7', offsetMinutes: -90, email: 'b7@example.com', status: 'hold' });
    seedBooking(testDb, { id: 'b7-confirmed', offsetMinutes: -5, email: 'b7@example.com', status: 'confirmed' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 0);
    assert.equal(sentEmails.length, 0);
  });

  test('a CONFIRMED_CONFLICT booking for the same email also blocks the nudge (they paid, do not nag)', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b8', offsetMinutes: -90, email: 'b8@example.com', status: 'hold' });
    seedBooking(testDb, { id: 'b8-conflict', offsetMinutes: -5, email: 'b8@example.com', status: 'confirmed_conflict' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 0);
  });

  test('a confirmed booking for a DIFFERENT route, created AFTER the abandoned attempt, also blocks it', async () => {
    seedRoute(testDb, { id: 'r1' });
    seedRoute(testDb, { id: 'r2' });
    seedBooking(testDb, { id: 'b9', route_id: 'r1', offsetMinutes: -90, email: 'b9@example.com', status: 'hold' });
    seedBooking(testDb, { id: 'b9-other', route_id: 'r2', offsetMinutes: -5, email: 'b9@example.com', status: 'confirmed' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 0, 'they already came back and booked something else — do not nag');
  });

  test('a confirmed booking created BEFORE the abandoned attempt does NOT block it (they booked, then separately abandoned a second one)', async () => {
    seedRoute(testDb, { id: 'r1' });
    seedRoute(testDb, { id: 'r2' });
    seedBooking(testDb, { id: 'b10-prior', route_id: 'r2', offsetMinutes: -200, email: 'b10@example.com', status: 'confirmed' });
    seedBooking(testDb, { id: 'b10', route_id: 'r1', offsetMinutes: -90, email: 'b10@example.com', status: 'hold' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 1);
  });

  test('the sold-out slot (no seats left) is never nudged', async () => {
    seedRoute(testDb, { id: 'r1', capacity: 2 });
    // Fill the slot with a confirmed booking taking all the seats.
    seedBooking(testDb, { id: 'filler', route_id: 'r1', offsetMinutes: -5, party: 2, email: 'filler@example.com', status: 'confirmed' });
    seedBooking(testDb, { id: 'b11', route_id: 'r1', offsetMinutes: -90, party: 1, email: 'b11@example.com', status: 'hold' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 0);
  });

  test('a route that was deactivated after the hold was created is never nudged', async () => {
    seedRoute(testDb, { id: 'r1' });
    seedBooking(testDb, { id: 'b12', route_id: 'r1', offsetMinutes: -90, email: 'b12@example.com' });
    run(testDb, `UPDATE routes SET active = 0 WHERE id = 'r1'`);
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 0);
  });

  test('an opted-out email never gets the nudge', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'b13', offsetMinutes: -90, email: 'optedout@example.com' });
    await db.recordReminderOptOut(testDb, 'optedout@example.com');
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 0);
  });

  test('THREE hold rows from the SAME guest inside the window produce exactly ONE mail, and a second tick sends zero more', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'dup1', offsetMinutes: -120, email: 'dup@example.com' });
    seedBooking(testDb, { id: 'dup2', offsetMinutes: -100, email: 'DUP@Example.com' });
    seedBooking(testDb, { id: 'dup3', offsetMinutes: -70, email: 'dup@example.com' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 1, 'one guest, one mail, no matter how many hold rows they left behind');
    assert.equal(sentEmails.length, 1);

    const again = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(again.first.candidates, 0, 'the sibling rows were stamped too, not just the one that was emailed');
  });

  test('renders in the booking\'s own locale', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'nl1', offsetMinutes: -90, email: 'nl1@example.com', locale: 'nl' });
    await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.match(sentEmails[0].subject, /nog vrij/);
  });
});

describe('sendAbandonedSweep — follow-up stage', () => {
  test('sends the ~24h follow-up only after the first was already sent', async () => {
    seedRoute(testDb);
    seedBooking(testDb, {
      id: 'f1', offsetMinutes: -(25 * 60), email: 'f1@example.com',
      abandoned_sent_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.followup.sent, 1);
    assert.match(sentEmails[0].subject, /Still thinking about/);
  });

  test('does NOT send a follow-up if the first nudge was never sent (abandoned_sent_at IS NULL)', async () => {
    seedRoute(testDb);
    seedBooking(testDb, { id: 'f2', offsetMinutes: -(25 * 60), email: 'f2@example.com' });
    // This booking is a candidate for the FIRST stage (abandoned_sent_at IS
    // NULL), not the follow-up stage — confirms the two stages don't overlap.
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.first.sent, 1);
    assert.equal(result.followup.sent, 0);
  });

  test('a booking already booked since the first nudge is skipped at follow-up time too', async () => {
    seedRoute(testDb, { id: 'r1' });
    seedBooking(testDb, {
      id: 'f3', route_id: 'r1', offsetMinutes: -(25 * 60), email: 'f3@example.com',
      abandoned_sent_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    });
    seedBooking(testDb, { id: 'f3-confirmed', route_id: 'r1', offsetMinutes: -5, email: 'f3@example.com', status: 'confirmed' });
    const result = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(result.followup.sent, 0);
  });

  test('idempotent: a second tick never re-sends the follow-up', async () => {
    seedRoute(testDb);
    seedBooking(testDb, {
      id: 'f4', offsetMinutes: -(25 * 60), email: 'f4@example.com',
      abandoned_sent_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    });
    await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    const again = await sendAbandonedSweep(ENV(), { sendTransactional: fakeSendTransactional });
    assert.equal(again.followup.sent, 0);
    assert.equal(sentEmails.length, 1);
  });
});

// ---------------------------------------------------------------------------
// DST pin — the abandoned flow's "still bookable" gate (checkStillBookable,
// src/abandoned.js) is entirely dependent on db.js:getSlotsWithSeatsLeft,
// which zeroes seats_left via logic.js:isSlotPastCutoff/zonedDateTimeToUtc.
// Pinned here (not just in test/logic.test.js) because this flow's
// correctness depends on it directly: a DST miscalculation would either
// wrongly nudge a guest about a slot that already passed, or wrongly
// withhold a nudge for a slot that's genuinely still open. 25 Oct 2026 is
// the Europe/Amsterdam CEST -> CET fall-back date.
// ---------------------------------------------------------------------------

describe('DST pin — the cutoff check this flow relies on', () => {
  test('a slot the evening of the fall-back date resolves to the correct UTC instant on both sides of the transition', () => {
    // 18:00 local on 25 Oct 2026 is AFTER the 03:00->02:00 fall-back, so it's
    // UTC+1 (CET) that evening: 18:00 CET = 17:00 UTC.
    const utc = zonedDateTimeToUtc('2026-10-25', '18:00', 'Europe/Amsterdam');
    assert.equal(utc.toISOString(), '2026-10-25T17:00:00.000Z');
  });

  test('a 1h cutoff correctly judges "past" relative to that same DST-correct instant', () => {
    const justBefore = new Date('2026-10-25T15:30:00.000Z'); // 90 min before slot start
    const justAfter = new Date('2026-10-25T16:35:00.000Z'); // 25 min before slot start
    assert.equal(isSlotPastCutoff('2026-10-25', '18:00', 'Europe/Amsterdam', 60, justBefore), false);
    assert.equal(isSlotPastCutoff('2026-10-25', '18:00', 'Europe/Amsterdam', 60, justAfter), true);
  });
});

// ---------------------------------------------------------------------------
// Reminder-unsubscribe token — sanity (full round-trip + endpoint covered in
// test/reminder_optout.test.js).
// ---------------------------------------------------------------------------

describe('reminder unsubscribe token (sanity)', () => {
  test('is deterministic for the same email + secret', async () => {
    const env = { ADMIN_SESSION_SECRET: 'shh' };
    const a = await computeReminderUnsubscribeToken(env, 'Guest@Example.com');
    const b = await computeReminderUnsubscribeToken(env, 'guest@example.com');
    assert.equal(a, b, 'case-insensitive email normalization');
  });
});
