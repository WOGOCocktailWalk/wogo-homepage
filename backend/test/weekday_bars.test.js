// test/weekday_bars.test.js — per-weekday bar sets (migrations/0015): a
// route can run a DIFFERENT, RECURRING ordered bar list on different
// weekdays (e.g. Thursday's route visits different bars than Friday's) —
// a standing rule, distinct from the existing one-off PER-DATE
// 'alternate_bars' date_override, which still applies to one specific date
// only and keeps outranking everything here.
//
// Coverage:
//   - db.js:listBarsForDate resolves the weekday's own set when rows exist
//     for that weekday, else falls back to the NULL/default set.
//   - webhook.js:notifyBars emails the right bars for a Thursday vs a
//     Friday on the same route.
//   - a per-date 'alternate_bars' override still beats the weekday set
//     (highest precedence, unchanged — computeBarArrivals applies it on top
//     of whatever bar list it's given).
//   - a route whose bars are all weekday IS NULL is completely unchanged
//     (byte-for-byte backward compatible).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import * as db from '../src/db.js';
import { listBarsForDate, listBars, toPositional } from '../src/db.js';
import { notifyBars } from '../src/webhook.js';
import { isoWeekday, addDaysToDateStr } from '../src/logic.js';
import { handleReplaceBars } from '../src/admin_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

function exec(db_, sql, params = {}) {
  const t = toPositional(sql, params);
  return db_.prepare(t.sql).bind(...t.values).run();
}

function seedRoute(db_, overrides = {}) {
  const route = {
    id: 'testroute', name: 'Test Route', city: 'Testville', price_cents: 2995,
    capacity: 10, max_party: 6, open_days: '[1,2,3,4,5,6,7]', slots: '["18:00"]',
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

function seedBar(db_, routeId, overrides = {}) {
  const bar = {
    route_id: routeId, ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com', minutes_offset: 0, weekday: null,
    ...overrides,
  };
  exec(
    db_,
    `INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset, weekday)
     VALUES (:route_id, :ord, :bar_name, :bar_email, :minutes_offset, :weekday)`,
    bar
  );
  return bar;
}

const TODAY = new Date().toISOString().slice(0, 10);
function nextIsoWeekday(targetIso) {
  let d = TODAY;
  for (let i = 0; i < 8; i++) {
    if (isoWeekday(d) === targetIso) return d;
    d = addDaysToDateStr(d, 1);
  }
  throw new Error('unreachable');
}
const THURSDAY = nextIsoWeekday(4);
const FRIDAY = nextIsoWeekday(5);
const SATURDAY = nextIsoWeekday(6); // has no bar rows of its own in most fixtures below

let sqliteDb;
beforeEach(() => {
  sqliteDb = makeTestDb(schemaSql);
  seedRoute(sqliteDb);
});

const realFetch = global.fetch;
beforeEach(() => { global.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 }); });
afterEach(() => { global.fetch = realFetch; });

// ---------------------------------------------------------------------------
// db.js — listBarsForDate resolution
// ---------------------------------------------------------------------------

describe('listBarsForDate — resolves the weekday set when present, else the NULL/default set', () => {
  test('a route with only weekday IS NULL bars is completely unchanged (byte-for-byte backward compatible)', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Bar A', bar_email: 'bara@example.com' });
    seedBar(sqliteDb, 'testroute', { ord: 2, bar_name: 'Bar B', bar_email: 'barb@example.com' });

    const all = await listBars(sqliteDb, 'testroute');
    const forThursday = await listBarsForDate(sqliteDb, 'testroute', THURSDAY);
    const forFriday = await listBarsForDate(sqliteDb, 'testroute', FRIDAY);

    assert.equal(all.length, 2);
    assert.deepEqual(forThursday.map((b) => b.bar_name), ['Bar A', 'Bar B']);
    assert.deepEqual(forFriday.map((b) => b.bar_name), ['Bar A', 'Bar B']);
  });

  test('a weekday with its own rows returns THAT set, not the default set', async () => {
    // default (NULL) set
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Default A', bar_email: 'da@example.com', weekday: null });
    // Thursday-only set
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Thu A', bar_email: 'thua@example.com', weekday: 4 });
    seedBar(sqliteDb, 'testroute', { ord: 2, bar_name: 'Thu B', bar_email: 'thub@example.com', weekday: 4 });
    // Friday-only set (different bars again)
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Fri A', bar_email: 'fria@example.com', weekday: 5 });

    const forThursday = await listBarsForDate(sqliteDb, 'testroute', THURSDAY);
    const forFriday = await listBarsForDate(sqliteDb, 'testroute', FRIDAY);
    const forSaturday = await listBarsForDate(sqliteDb, 'testroute', SATURDAY); // no weekday=6 rows

    assert.deepEqual(forThursday.map((b) => b.bar_name), ['Thu A', 'Thu B']);
    assert.deepEqual(forFriday.map((b) => b.bar_name), ['Fri A']);
    assert.deepEqual(forSaturday.map((b) => b.bar_name), ['Default A'], 'no weekday=6 rows -> falls back to the NULL/default set');
  });

  test('ordering is independent per weekday set (each set has its own ord numbering)', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 2, bar_name: 'Thu Second', bar_email: 'ts@example.com', weekday: 4 });
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Thu First', bar_email: 'tf@example.com', weekday: 4 });

    const forThursday = await listBarsForDate(sqliteDb, 'testroute', THURSDAY);
    assert.deepEqual(forThursday.map((b) => b.bar_name), ['Thu First', 'Thu Second']);
  });
});

// ---------------------------------------------------------------------------
// db.js — replaceBars with an optional weekday
// ---------------------------------------------------------------------------

describe('replaceBars — optional weekday parameter (migrations/0015, additive)', () => {
  test('omitting weekday (existing call shape) replaces only the DEFAULT set, leaving weekday-specific sets untouched', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Old Default', bar_email: 'old@example.com', weekday: null });
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Thu Keep', bar_email: 'thukeep@example.com', weekday: 4 });

    await db.replaceBars(sqliteDb, 'testroute', [{ bar_name: 'New Default', bar_email: 'new@example.com', minutes_offset: 0 }]);

    const forThursday = await listBarsForDate(sqliteDb, 'testroute', THURSDAY);
    const forFriday = await listBarsForDate(sqliteDb, 'testroute', FRIDAY); // falls to default set
    assert.deepEqual(forThursday.map((b) => b.bar_name), ['Thu Keep'], 'Thursday set must be untouched by a default-set replace');
    assert.deepEqual(forFriday.map((b) => b.bar_name), ['New Default']);
  });

  test('passing weekday=4 replaces ONLY Thursday\'s set, leaving the default set and other weekdays untouched', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Default', bar_email: 'default@example.com', weekday: null });
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Old Thu', bar_email: 'oldthu@example.com', weekday: 4 });
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Fri Bar', bar_email: 'fri@example.com', weekday: 5 });

    await db.replaceBars(sqliteDb, 'testroute', [{ bar_name: 'New Thu', bar_email: 'newthu@example.com', minutes_offset: 0 }], 4);

    const forThursday = await listBarsForDate(sqliteDb, 'testroute', THURSDAY);
    const forFriday = await listBarsForDate(sqliteDb, 'testroute', FRIDAY);
    const forSaturday = await listBarsForDate(sqliteDb, 'testroute', SATURDAY); // falls to default set

    assert.deepEqual(forThursday.map((b) => b.bar_name), ['New Thu']);
    assert.deepEqual(forFriday.map((b) => b.bar_name), ['Fri Bar'], 'Friday set must be untouched');
    assert.deepEqual(forSaturday.map((b) => b.bar_name), ['Default'], 'default set must be untouched');
  });
});

// ---------------------------------------------------------------------------
// admin_api.js — handleReplaceBars validates the optional weekday field
// ---------------------------------------------------------------------------

function adminRequest(pathname, body) {
  return new Request(`https://api.example.com${pathname}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' },
  });
}

describe('handleReplaceBars — optional weekday field (migrations/0015)', () => {
  test('omitting weekday saves the default set exactly as before this feature', async () => {
    const env = { DB: sqliteDb };
    const res = await handleReplaceBars(adminRequest('/admin/api/routes/testroute/bars', {
      bars: [{ bar_name: 'Def', bar_email: 'def@example.com', minutes_offset: 0 }],
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);

    const forThursday = await listBarsForDate(sqliteDb, 'testroute', THURSDAY);
    assert.deepEqual(forThursday.map((b) => b.bar_name), ['Def']);
  });

  test('passing weekday: 4 saves only Thursday\'s set', async () => {
    const env = { DB: sqliteDb };
    const res = await handleReplaceBars(adminRequest('/admin/api/routes/testroute/bars', {
      bars: [{ bar_name: 'Thu', bar_email: 'thu@example.com', minutes_offset: 0 }],
      weekday: 4,
    }), env, { id: 'testroute' });
    assert.equal(res.status, 200);

    const forThursday = await listBarsForDate(sqliteDb, 'testroute', THURSDAY);
    const forFriday = await listBarsForDate(sqliteDb, 'testroute', FRIDAY); // no default bars seeded -> empty
    assert.deepEqual(forThursday.map((b) => b.bar_name), ['Thu']);
    assert.deepEqual(forFriday, []);
  });

  test('rejects an out-of-range weekday (0 or 8)', async () => {
    const env = { DB: sqliteDb };
    const res = await handleReplaceBars(adminRequest('/admin/api/routes/testroute/bars', {
      bars: [{ bar_name: 'X', bar_email: 'x@example.com' }],
      weekday: 8,
    }), env, { id: 'testroute' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /weekday/);
  });
});

// ---------------------------------------------------------------------------
// webhook.js — notifyBars emails the right bars per weekday
// ---------------------------------------------------------------------------

describe('notifyBars — emails the right bar set for a Thursday vs a Friday booking', () => {
  test('a Thursday booking emails Thursday\'s bars; a Friday booking on the same route emails Friday\'s bars', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Thu Only', bar_email: 'thuonly@example.com', weekday: 4, minutes_offset: 0 });
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Fri Only', bar_email: 'frionly@example.com', weekday: 5, minutes_offset: 0 });

    const route = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };

    const thuSent = [];
    const thuBooking = { route_id: 'testroute', date: THURSDAY, slot: '18:00', name: 'Anna', email: 'anna@example.com', party: 2 };
    await notifyBars(env, thuBooking, route, { database: db, sendTransactional: async (env2, msg) => { thuSent.push(msg); } });
    assert.equal(thuSent.length, 1);
    assert.equal(thuSent[0].to, 'thuonly@example.com');

    const friSent = [];
    const friBooking = { route_id: 'testroute', date: FRIDAY, slot: '18:00', name: 'Bo', email: 'bo@example.com', party: 2 };
    await notifyBars(env, friBooking, route, { database: db, sendTransactional: async (env2, msg) => { friSent.push(msg); } });
    assert.equal(friSent.length, 1);
    assert.equal(friSent[0].to, 'frionly@example.com');
  });

  test('a per-date alternate_bars override still beats the weekday set (highest precedence, unchanged)', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Thu Normal', bar_email: 'thunormal@example.com', weekday: 4, minutes_offset: 0 });
    exec(
      sqliteDb,
      `INSERT INTO date_overrides (route_id, date, action, payload) VALUES (:route_id, :date, :action, :payload)`,
      {
        route_id: 'testroute', date: THURSDAY, action: 'alternate_bars',
        payload: JSON.stringify([{ bar_name: 'Alt Bar', bar_email: 'alt@example.com', minutes_offset: 0 }]),
      }
    );

    const route = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };
    const sent = [];
    const booking = { route_id: 'testroute', date: THURSDAY, slot: '18:00', name: 'Cas', email: 'cas@example.com', party: 2 };
    const arrivals = await notifyBars(env, booking, route, { database: db, sendTransactional: async (env2, msg) => { sent.push(msg); } });

    assert.equal(arrivals.length, 1);
    assert.equal(arrivals[0].bar_email, 'alt@example.com', 'the per-date alternate_bars override must win over Thursday\'s own recurring set');
    assert.equal(sent[0].to, 'alt@example.com');
  });

  test('a route whose bars are all weekday IS NULL sends to the same set regardless of the booking\'s weekday (unchanged)', async () => {
    seedBar(sqliteDb, 'testroute', { ord: 1, bar_name: 'Only Bar', bar_email: 'onlybar@example.com', weekday: null, minutes_offset: 0 });
    const route = { id: 'testroute', name: 'Test Route', city: 'Testville' };
    const env = { DB: sqliteDb };

    const sentThu = [];
    await notifyBars(env, { route_id: 'testroute', date: THURSDAY, slot: '18:00', name: 'A', email: 'a@example.com', party: 1 }, route, {
      database: db, sendTransactional: async (env2, msg) => { sentThu.push(msg); },
    });
    const sentSat = [];
    await notifyBars(env, { route_id: 'testroute', date: SATURDAY, slot: '18:00', name: 'B', email: 'b@example.com', party: 1 }, route, {
      database: db, sendTransactional: async (env2, msg) => { sentSat.push(msg); },
    });

    assert.equal(sentThu[0].to, 'onlybar@example.com');
    assert.equal(sentSat[0].to, 'onlybar@example.com');
  });
});
