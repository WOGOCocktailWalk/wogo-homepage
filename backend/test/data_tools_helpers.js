// test/data_tools_helpers.js — shared fixtures for the data-housekeeping
// tests (retention, missing-page log, export/erase one customer). Only fake
// people and example.com addresses live here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeTestDb } from './sqlite-d1-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function migration(name) { return readFileSync(path.join(__dirname, `../migrations/${name}`), 'utf8'); }

export const SCHEMA_SQL = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql', '0008_failed_email.sql',
  '0009_webhook_processing_status.sql', '0010_booking_notes.sql', '0011_currency_timezone.sql',
  '0018_gift_cards.sql', '0019_gift_card_redemptions.sql', '0021_inquiries.sql',
  '0024_subscribers.sql', '0025_admin_users.sql', '0026_review_requests.sql',
  '0027_booking_utm.sql', '0031_abandoned_reminders.sql', '0033_addons.sql',
].map(migration).join('\n');

export function freshDb() { return makeTestDb(SCHEMA_SQL); }

/** Runs literal SQL with positional params straight on the test database. */
export function sql(testDb, text, ...values) {
  return testDb._raw.prepare(text).run(...values);
}
export function rows(testDb, text, ...values) {
  return testDb._raw.prepare(text).all(...values).map((r) => ({ ...r }));
}

let n = 0;
/** Inserts a booking with sensible defaults; `over` overrides any column. */
export function addBooking(testDb, over = {}) {
  n += 1;
  const b = {
    id: `b_${n}`, route_id: 'r1', date: '2020-05-01', slot: '18:00', party: 2,
    name: 'Test Guest', email: 'guest@example.com', phone: '+31600000000',
    status: 'confirmed', created_at: '2020-01-01 10:00:00',
    notes: null, addon_notes: null, utm_source: null, referrer: null, landing_path: null,
    ...over,
  };
  const cols = Object.keys(b);
  sql(testDb, `INSERT INTO bookings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => b[c]));
  return b;
}
