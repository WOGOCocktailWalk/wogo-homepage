// test/data_retention.test.js — nightly retention: old enquiries and
// waiting-list entries are deleted; bookings are anonymised INCLUDING add-on
// (allergy/dietary) notes and marketing fields, also on rows an older version
// of the job had already half-cleaned.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, rows, addBooking } from './data_tools_helpers.js';
import * as db from '../src/db.js';
import { runGdprRetention, runInquiryRetention } from '../src/retention.js';
import { sqliteMonthsAgo } from '../src/logic.js';
import { INQUIRY_RETENTION_MONTHS } from '../src/config.js';

let testDb;
beforeEach(() => { testDb = freshDb(); });

function addInquiry(id, createdAt, message = 'hello') {
  sql(testDb, `INSERT INTO inquiries (id, kind, name, email, message, created_at) VALUES (?, 'contact', 'Test Person', 'p@example.com', ?, ?)`, id, message, createdAt);
}

describe('inquiry retention', () => {
  test('INQUIRY_RETENTION_MONTHS is 24', () => assert.equal(INQUIRY_RETENTION_MONTHS, 24));

  test('deletes enquiries and waiting-list rows older than 24 months, keeps newer ones', async () => {
    addInquiry('old_contact', '2000-01-01 00:00:00');
    addInquiry('old_waitlist', '2000-01-01 00:00:00', '[Utrecht waitlist]\n\nAdded by hand');
    addInquiry('recent', sqliteMonthsAgo(23));
    addInquiry('fresh', sqliteMonthsAgo(0));
    const res = await runInquiryRetention({ DB: testDb });
    assert.deepEqual(res, { deleted: 2 });
    assert.deepEqual(rows(testDb, 'SELECT id FROM inquiries ORDER BY id').map((r) => r.id), ['fresh', 'recent']);
  });

  test('boundary: a row a little older than the cutoff goes, a little younger stays', async () => {
    const cutoff = sqliteMonthsAgo(24);
    addInquiry('just_older', new Date(Date.parse(cutoff.replace(' ', 'T') + 'Z') - 3600e3).toISOString().slice(0, 19).replace('T', ' '));
    addInquiry('just_younger', new Date(Date.parse(cutoff.replace(' ', 'T') + 'Z') + 3600e3).toISOString().slice(0, 19).replace('T', ' '));
    await runInquiryRetention({ DB: testDb });
    assert.deepEqual(rows(testDb, 'SELECT id FROM inquiries').map((r) => r.id), ['just_younger']);
  });

  test('is a no-op on an empty table and safe to run twice', async () => {
    assert.deepEqual(await runInquiryRetention({ DB: testDb }), { deleted: 0 });
    addInquiry('old', '2000-01-01 00:00:00');
    await runInquiryRetention({ DB: testDb });
    assert.deepEqual(await runInquiryRetention({ DB: testDb }), { deleted: 0 });
  });

  test('uses the injected database seam like runGdprRetention does', async () => {
    let cutoff;
    const res = await runInquiryRetention({ DB: {} }, { database: { deleteOldInquiries: async (_d, c) => { cutoff = c; return 7; } } });
    assert.deepEqual(res, { deleted: 7 });
    assert.match(cutoff, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('booking anonymisation closes the notes gaps', () => {
  test('clears name, email, phone, notes, add-on notes, ip and marketing fields; keeps the financial facts', async () => {
    const b = addBooking(testDb, {
      notes: 'peanut allergy', addon_notes: 'vegan, no gluten', utm_source: 'ig', referrer: 'https://x.example/',
      landing_path: '/amsterdam/', ip: '203.0.113.9', stripe_session: 'cs_1', stripe_payment_intent: 'pi_1',
      discount_code: 'SAVE10', discount_cents: 500, party: 3,
    });
    const res = await runGdprRetention({ DB: testDb });
    assert.equal(res.anonymized, 1);
    const [r] = rows(testDb, 'SELECT * FROM bookings WHERE id = ?', b.id);
    assert.equal(r.name, '[deleted]');
    assert.equal(r.email, `deleted-${b.id}@wogoamsterdam.invalid`);
    for (const c of ['phone', 'notes', 'addon_notes', 'ip', 'utm_source', 'referrer', 'landing_path']) assert.equal(r[c], null, c);
    assert.equal(r.party, 3);
    assert.equal(r.date, '2020-05-01');
    assert.equal(r.route_id, 'r1');
    assert.equal(r.stripe_payment_intent, 'pi_1');
    assert.equal(r.discount_cents, 500);
  });

  test('a row already anonymised by the OLD job (name gone, add-on notes left) still gets cleaned', async () => {
    const b = addBooking(testDb, { name: '[deleted]', email: 'deleted-x@wogoamsterdam.invalid', phone: null, notes: null, addon_notes: 'shellfish allergy' });
    const res = await db.anonymizeOldBookings(testDb, '2030-01-01 00:00:00');
    assert.equal(res.anonymized, 1);
    assert.equal(rows(testDb, 'SELECT addon_notes FROM bookings WHERE id = ?', b.id)[0].addon_notes, null);
  });

  test('is idempotent: a fully clean row is not touched again', async () => {
    addBooking(testDb, { notes: 'x' });
    assert.equal((await db.anonymizeOldBookings(testDb, '2030-01-01 00:00:00')).anonymized, 1);
    assert.equal((await db.anonymizeOldBookings(testDb, '2030-01-01 00:00:00')).anonymized, 0);
  });

  test('never touches a hold, or a booking younger than the cutoff', async () => {
    addBooking(testDb, { status: 'hold', addon_notes: 'keep me' });
    addBooking(testDb, { created_at: sqliteMonthsAgo(1), addon_notes: 'keep me too' });
    assert.equal((await runGdprRetention({ DB: testDb })).anonymized, 0);
    assert.equal(rows(testDb, `SELECT COUNT(*) AS n FROM bookings WHERE addon_notes IS NOT NULL`)[0].n, 2);
  });
});
