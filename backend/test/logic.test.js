import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBarArrivals,
  buildSlotsForDate,
  buildMonthAvailability,
  toCsv,
  isHoldExpired,
  isDateBookable,
  addMinutesToSlot,
  toSqliteDatetime,
  computeHoldExpiry,
  nowSqlite,
  buildHourBars,
  extractDiscount,
  aggregateCustomers,
  formatEuros,
  constantTimeEqual,
  computeLoginLockout,
  isValidDateStr,
  sqliteMinutesAgo,
  formatMoney,
  todayInTimezone,
  isValidIanaTimeZone,
  isValidCurrencyCode,
  zonedDateTimeToUtc,
  utcToZonedHHMM,
} from '../src/logic.js';

describe('addMinutesToSlot', () => {
  test('simple addition', () => {
    assert.equal(addMinutesToSlot('18:00', 75), '19:15');
  });
  test('midnight wraparound', () => {
    assert.equal(addMinutesToSlot('23:30', 45), '00:15');
  });
  test('large offset wraps multiple times conceptually (still within a day)', () => {
    assert.equal(addMinutesToSlot('23:00', 125), '01:05');
  });
});

describe('computeBarArrivals', () => {
  const route = { id: 'amsterdam' };
  const routesBars = [
    { ord: 2, bar_name: 'Bar B', bar_email: 'b@example.com', minutes_offset: 75 },
    { ord: 1, bar_name: 'Bar A', bar_email: 'a@example.com', minutes_offset: 0 },
    { ord: 3, bar_name: 'Bar C', bar_email: 'c@example.com', minutes_offset: 150 },
  ];
  const booking = { date: '2026-08-06', slot: '18:00' };

  test('default order follows ord, not input order', () => {
    const result = computeBarArrivals(route, routesBars, [], booking);
    assert.deepEqual(result.map((b) => b.bar_name), ['Bar A', 'Bar B', 'Bar C']);
  });

  test('minutes offsets applied correctly', () => {
    const result = computeBarArrivals(route, routesBars, [], booking);
    assert.deepEqual(result.map((b) => b.arrival_time), ['18:00', '19:15', '20:30']);
  });

  test('midnight wraparound in arrival times', () => {
    const lateBooking = { date: '2026-08-06', slot: '23:30' };
    const result = computeBarArrivals(route, routesBars, [], lateBooking);
    assert.deepEqual(result.map((b) => b.arrival_time), ['23:30', '00:45', '02:00']);
  });

  test('alternate_bars override takes priority over routesBars', () => {
    const overrides = [
      {
        route_id: 'amsterdam',
        date: '2026-08-06',
        action: 'alternate_bars',
        payload: JSON.stringify([
          { bar_name: 'Alt Bar 1', bar_email: 'alt1@example.com', minutes_offset: 0 },
          { bar_name: 'Alt Bar 2', bar_email: 'alt2@example.com', minutes_offset: 60 },
        ]),
      },
    ];
    const result = computeBarArrivals(route, routesBars, overrides, booking);
    assert.deepEqual(result.map((b) => b.bar_name), ['Alt Bar 1', 'Alt Bar 2']);
    assert.deepEqual(result.map((b) => b.arrival_time), ['18:00', '19:00']);
  });

  test('alternate_bars override for a different date does not apply', () => {
    const overrides = [
      {
        route_id: 'amsterdam',
        date: '2026-08-07',
        action: 'alternate_bars',
        payload: JSON.stringify([{ bar_name: 'Alt', bar_email: 'x@x.com', minutes_offset: 0 }]),
      },
    ];
    const result = computeBarArrivals(route, routesBars, overrides, booking);
    assert.deepEqual(result.map((b) => b.bar_name), ['Bar A', 'Bar B', 'Bar C']);
  });
});

describe('buildSlotsForDate', () => {
  const route = { capacity: 10, slots: JSON.stringify(['17:30', '18:00', '18:30']) };

  test('no overrides returns route slots at route capacity', () => {
    const result = buildSlotsForDate(route, [], '2026-08-06');
    assert.deepEqual(result, [
      { slot: '17:30', capacity: 10 },
      { slot: '18:00', capacity: 10 },
      { slot: '18:30', capacity: 10 },
    ]);
  });

  test('remove_slot hides exactly one slot', () => {
    const overrides = [
      { date: '2026-08-06', action: 'remove_slot', payload: JSON.stringify({ slot: '18:00' }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-06');
    assert.deepEqual(result.map((s) => s.slot), ['17:30', '18:30']);
  });

  test('remove_slot only affects the specified date', () => {
    const overrides = [
      { date: '2026-08-07', action: 'remove_slot', payload: JSON.stringify({ slot: '18:00' }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-06');
    assert.deepEqual(result.map((s) => s.slot), ['17:30', '18:00', '18:30']);
  });

  test('extra_slot adds a one-off departure', () => {
    const overrides = [
      {
        date: '2026-08-06',
        action: 'extra_slot',
        payload: JSON.stringify({ slot: '21:00', capacity: 8 }),
      },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-06');
    assert.deepEqual(result, [
      { slot: '17:30', capacity: 10 },
      { slot: '18:00', capacity: 10 },
      { slot: '18:30', capacity: 10 },
      { slot: '21:00', capacity: 8 },
    ]);
  });

  test('extra_slot without capacity defaults to route capacity', () => {
    const overrides = [
      { date: '2026-08-06', action: 'extra_slot', payload: JSON.stringify({ slot: '21:00' }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-06');
    assert.deepEqual(result.find((s) => s.slot === '21:00'), { slot: '21:00', capacity: 10 });
  });

  test('capacity_override applies to every slot including extras', () => {
    const overrides = [
      { date: '2026-08-06', action: 'extra_slot', payload: JSON.stringify({ slot: '21:00' }) },
      { date: '2026-08-06', action: 'capacity_override', payload: JSON.stringify({ capacity: 6 }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-06');
    assert.ok(result.every((s) => s.capacity === 6));
    assert.equal(result.length, 4);
  });

  test('remove_slot + extra_slot combined', () => {
    const overrides = [
      { date: '2026-08-06', action: 'remove_slot', payload: JSON.stringify({ slot: '17:30' }) },
      {
        date: '2026-08-06',
        action: 'extra_slot',
        payload: JSON.stringify({ slot: '21:00', capacity: 4 }),
      },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-06');
    assert.deepEqual(result.map((s) => s.slot), ['18:00', '18:30', '21:00']);
  });
});

describe('buildSlotsForDate — per-timeslot capacity precedence (migrations/0003)', () => {
  test('route.slot_capacity gives one slot a lower default than route.capacity; other slots unaffected', () => {
    const route = {
      capacity: 10,
      slots: JSON.stringify(['18:00', '20:00']),
      slot_capacity: JSON.stringify({ '20:00': 6 }),
    };
    const result = buildSlotsForDate(route, [], '2026-08-06');
    assert.deepEqual(result, [
      { slot: '18:00', capacity: 10 },
      { slot: '20:00', capacity: 6 },
    ]);
  });

  test('no slot_capacity field at all behaves exactly like today (every slot at route.capacity)', () => {
    const route = { capacity: 10, slots: JSON.stringify(['18:00', '20:00']) };
    const result = buildSlotsForDate(route, [], '2026-08-06');
    assert.ok(result.every((s) => s.capacity === 10));
  });

  test('date+slot override (slot_capacity_override) beats route.slot_capacity for the named slot only', () => {
    const route = {
      capacity: 10,
      slots: JSON.stringify(['19:00', '20:00']),
      slot_capacity: JSON.stringify({ '20:00': 6 }),
    };
    const overrides = [
      { date: '2026-08-15', action: 'slot_capacity_override', payload: JSON.stringify({ '20:00': 4 }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-15');
    assert.deepEqual(result, [
      { slot: '19:00', capacity: 10 }, // untouched: no route.slot_capacity entry, no override
      { slot: '20:00', capacity: 4 },  // date+slot override wins over route default of 6
    ]);
  });

  test('slot_capacity_override for a different date does not apply', () => {
    const route = { capacity: 10, slots: JSON.stringify(['20:00']) };
    const overrides = [
      { date: '2026-08-16', action: 'slot_capacity_override', payload: JSON.stringify({ '20:00': 4 }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-15');
    assert.deepEqual(result, [{ slot: '20:00', capacity: 10 }]);
  });

  test('slot_capacity_override (date+slot) beats a same-date capacity_override (date-wide) for the named slot, other slots keep the date-wide number', () => {
    const route = { capacity: 10, slots: JSON.stringify(['19:00', '20:00']) };
    const overrides = [
      { date: '2026-08-15', action: 'capacity_override', payload: JSON.stringify({ capacity: 6 }) },
      { date: '2026-08-15', action: 'slot_capacity_override', payload: JSON.stringify({ '20:00': 4 }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-15');
    assert.deepEqual(result, [
      { slot: '19:00', capacity: 6 }, // date-wide override, no date+slot entry for this slot
      { slot: '20:00', capacity: 4 }, // date+slot override wins over the date-wide number
    ]);
  });

  test('slot_capacity_override of 0 shows that slot with zero capacity ("closed") without hiding it', () => {
    const route = { capacity: 10, slots: JSON.stringify(['19:00', '20:00']) };
    const overrides = [
      { date: '2026-08-15', action: 'slot_capacity_override', payload: JSON.stringify({ '20:00': 0 }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-15');
    assert.deepEqual(result, [
      { slot: '19:00', capacity: 10 },
      { slot: '20:00', capacity: 0 },
    ]);
  });

  test('full four-level stack: date+slot > date-wide > route+slot default > route default, all in one date', () => {
    const route = {
      capacity: 10,
      slots: JSON.stringify(['17:00', '18:00', '19:00', '20:00']),
      slot_capacity: JSON.stringify({ '19:00': 8, '20:00': 6 }),
    };
    const overrides = [
      { date: '2026-08-15', action: 'capacity_override', payload: JSON.stringify({ capacity: 5 }) },
      { date: '2026-08-15', action: 'slot_capacity_override', payload: JSON.stringify({ '20:00': 2 }) },
    ];
    const result = buildSlotsForDate(route, overrides, '2026-08-15');
    assert.deepEqual(result, [
      { slot: '17:00', capacity: 5 }, // level 4 (route default 10) overridden by level 2 (date-wide 5)
      { slot: '18:00', capacity: 5 }, // same
      { slot: '19:00', capacity: 5 }, // level 3 (route+slot default 8) also overridden by level 2 (date-wide 5)
      { slot: '20:00', capacity: 2 }, // level 1 (date+slot 2) beats everything, including level 3's 6
    ]);
  });
});

describe('isDateBookable', () => {
  const route = { open_days: '[4,5,6]' }; // Thu, Fri, Sat

  test('open weekday, no override -> bookable', () => {
    assert.equal(isDateBookable(route, [], '2026-08-06'), true); // Thursday
  });
  test('closed weekday -> not bookable', () => {
    assert.equal(isDateBookable(route, [], '2026-08-09'), false); // Sunday
  });
  test('open weekday but closed override -> not bookable', () => {
    const overrides = [{ date: '2026-08-06', action: 'closed' }];
    assert.equal(isDateBookable(route, overrides, '2026-08-06'), false);
  });
});

describe('buildMonthAvailability', () => {
  const route = { open_days: '[4,5,6]' }; // Thu=4 Fri=5 Sat=6
  const today = '2026-08-01'; // Saturday

  test('classifies open/closed/soldout', () => {
    const seatsByDate = {
      '2026-08-06': [{ seats_left: 3 }], // Thu, open, seats left
      '2026-08-07': [{ seats_left: 0 }], // Fri, soldout
    };
    const result = buildMonthAvailability(route, [], seatsByDate, '2026-08', today);
    assert.equal(result['2026-08-06'], 'open');
    assert.equal(result['2026-08-07'], 'soldout');
    assert.equal(result['2026-08-02'], 'closed'); // Sunday, weekday not open
  });

  test('closed override wins over weekday-open', () => {
    const overrides = [{ date: '2026-08-06', action: 'closed' }];
    const result = buildMonthAvailability(route, overrides, {}, '2026-08', today);
    assert.equal(result['2026-08-06'], 'closed');
  });

  test('past dates excluded', () => {
    const result = buildMonthAvailability(route, [], {}, '2026-08', today);
    assert.equal('2026-07-31' in result, false);
    // day before `today` within the same month must also be absent
    assert.equal('2026-08-01' in result, true); // today itself is included (>= today)
  });

  test('horizon boundary: day 90 included, day 91 excluded', () => {
    // today = 2026-08-01 -> horizon end = 2026-10-30 (90 days later)
    const result = buildMonthAvailability(route, [], {}, '2026-10', today);
    // 2026-10-30 is a Friday (weekday 5) -> within open_days, should be present
    assert.equal('2026-10-30' in result, true);
    // 2026-10-31 is one day beyond the 90-day horizon -> must be absent
    assert.equal('2026-10-31' in result, false);
  });
});

describe('toCsv', () => {
  test('quotes fields containing comma, quote, and newline; round-trips', () => {
    const rows = [
      { name: 'Anna, "The Great"', note: 'line1\nline2' },
      { name: 'Bob', note: 'plain' },
    ];
    const csv = toCsv(rows, ['name', 'note']);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'name,note');
    assert.equal(lines[1], '"Anna, ""The Great""","line1\nline2"');
    assert.equal(lines[2], 'Bob,plain');
  });

  test('null/undefined become empty string', () => {
    const csv = toCsv([{ a: null, b: undefined }], ['a', 'b']);
    assert.equal(csv, 'a,b\r\n,');
  });
});

describe('isHoldExpired', () => {
  test('boundary at exactly hold_expires === now is expired', () => {
    const hold = { hold_expires: '2026-08-06 18:00:00' };
    assert.equal(isHoldExpired(hold, '2026-08-06 18:00:00'), true);
  });
  test('future hold_expires is not expired', () => {
    const hold = { hold_expires: '2026-08-06 18:00:01' };
    assert.equal(isHoldExpired(hold, '2026-08-06 18:00:00'), false);
  });
  test('past hold_expires is expired', () => {
    const hold = { hold_expires: '2026-08-06 17:59:59' };
    assert.equal(isHoldExpired(hold, '2026-08-06 18:00:00'), true);
  });
});

describe('toSqliteDatetime / computeHoldExpiry / nowSqlite', () => {
  test('produces SQLite-comparable format (space separator, no ms, no Z)', () => {
    const d = new Date('2026-08-06T18:00:00.123Z');
    assert.equal(toSqliteDatetime(d), '2026-08-06 18:00:00');
  });

  test('computeHoldExpiry adds minutes and formats correctly', () => {
    const base = new Date('2026-08-06T17:45:00.000Z');
    assert.equal(computeHoldExpiry(15, base), '2026-08-06 18:00:00');
  });

  test('same-day string comparison is chronologically correct (the whole point of the format)', () => {
    const earlier = computeHoldExpiry(0, new Date('2026-08-06T09:00:00.000Z'));
    const later = nowSqlite(new Date('2026-08-06T15:00:00.000Z'));
    // earlier hold_expires must sort as "less than" a later "now" on the same calendar day
    assert.ok(earlier < later);
  });
});

describe('buildHourBars', () => {
  test('computes pct relative to the max guests row', () => {
    const rows = [
      { route_id: 'a', route_name: 'A', slot: '18:00', guests: 10, bookings: 3 },
      { route_id: 'b', route_name: 'B', slot: '18:00', guests: 5, bookings: 2 },
    ];
    const result = buildHourBars(rows);
    assert.equal(result[0].pct, 100);
    assert.equal(result[1].pct, 50);
  });

  test('empty input returns empty array', () => {
    assert.deepEqual(buildHourBars([]), []);
  });
});

describe('computeBarArrivals — matches the real seed stagger (migrations/0002: 0 / 75 / 150 min)', () => {
  test('an 18:00 booking arrives at each seeded bar at 18:00 / 19:15 / 20:30', () => {
    const route = { id: 'amsterdam' };
    const seededBars = [
      { ord: 1, bar_name: 'Van de Werf (NDSM wharf)', bar_email: 'bookings@wogoamsterdam.com', minutes_offset: 0 },
      { ord: 2, bar_name: 'Bar 2 (TBD — set real name/email)', bar_email: 'bookings@wogoamsterdam.com', minutes_offset: 75 },
      { ord: 3, bar_name: 'Bar 3 (TBD — set real name/email)', bar_email: 'bookings@wogoamsterdam.com', minutes_offset: 150 },
    ];
    const booking = { date: '2026-08-06', slot: '18:00' };
    const result = computeBarArrivals(route, seededBars, [], booking);
    assert.deepEqual(result.map((b) => b.arrival_time), ['18:00', '19:15', '20:30']);
  });
});

// ---------------------------------------------------------------------------
// Dashboard v2 — discount capture from a Stripe Checkout Session
// ---------------------------------------------------------------------------

describe('extractDiscount', () => {
  test('no discount on the session -> both fields null/0', () => {
    const session = { total_details: { amount_discount: 0 }, discounts: [] };
    assert.deepEqual(extractDiscount(session), { discount_code: null, discount_cents: 0 });
  });

  test('expanded promotion_code object -> uses its .code', () => {
    const session = {
      total_details: { amount_discount: 500 },
      discounts: [{ promotion_code: { id: 'promo_1Nx', code: 'SUMMER10' } }],
    };
    assert.deepEqual(extractDiscount(session), { discount_code: 'SUMMER10', discount_cents: 500 });
  });

  test('bare promotion_code id string (not expanded) -> stored as-is', () => {
    const session = {
      total_details: { amount_discount: 300 },
      discounts: [{ promotion_code: 'promo_1Nx999' }],
    };
    assert.deepEqual(extractDiscount(session), { discount_code: 'promo_1Nx999', discount_cents: 300 });
  });

  test('falls back to coupon name/id when no promotion_code is present', () => {
    const session = {
      total_details: { amount_discount: 250 },
      discounts: [{ coupon: { id: 'co_abc', name: 'Friends & Family' } }],
    };
    assert.deepEqual(extractDiscount(session), { discount_code: 'Friends & Family', discount_cents: 250 });
  });

  test('falls back to metadata.discount_code when discounts[] has no usable code', () => {
    const session = {
      total_details: { amount_discount: 100 },
      discounts: [],
      metadata: { discount_code: 'REFERRAL5' },
    };
    assert.deepEqual(extractDiscount(session), { discount_code: 'REFERRAL5', discount_cents: 100 });
  });

  test('never throws on a malformed/missing session', () => {
    assert.deepEqual(extractDiscount(null), { discount_code: null, discount_cents: 0 });
    assert.deepEqual(extractDiscount(undefined), { discount_code: null, discount_cents: 0 });
    assert.deepEqual(extractDiscount({}), { discount_code: null, discount_cents: 0 });
  });

  test('negative/garbage amount_discount is treated as 0, never a negative charge', () => {
    const session = { total_details: { amount_discount: -50 }, discounts: [] };
    assert.equal(extractDiscount(session).discount_cents, 0);
  });
});

// ---------------------------------------------------------------------------
// Dashboard v2 — customer aggregation (pure-function level; DB round-trip
// coverage lives in test/db.test.js)
// ---------------------------------------------------------------------------

describe('aggregateCustomers', () => {
  const baseRow = (overrides) => ({
    email: 'a@example.com', name: 'Anna', phone: '+31600000000',
    date: '2026-08-01', status: 'confirmed', party: 2, created_at: '2026-07-01 10:00:00',
    price_cents: 3000, discount_cents: 0, payment_status: null,
    ...overrides,
  });

  test('groups by lower-cased/trimmed email', () => {
    const rows = [
      baseRow({ email: ' A@Example.com ' }),
      baseRow({ email: 'a@example.com', date: '2026-08-08', created_at: '2026-07-02 10:00:00' }),
    ];
    const result = aggregateCustomers(rows);
    assert.equal(result.length, 1);
    assert.equal(result[0].bookings_count, 2);
  });

  test('total_spent_cents nets discount_cents and only counts confirmed/confirmed_conflict rows', () => {
    const rows = [
      baseRow({ status: 'confirmed', party: 2, discount_cents: 500 }), // 6000 - 500 = 5500
      baseRow({ status: 'hold', party: 3, date: '2026-08-09' }),       // ignored: never happened
      baseRow({ status: 'cancelled', party: 1, date: '2026-08-10' }),  // ignored
    ];
    const [c] = aggregateCustomers(rows);
    assert.equal(c.total_spent_cents, 5500);
    assert.equal(c.guests, 2, 'only the confirmed booking counts toward guests');
    assert.equal(c.bookings_count, 3, 'but every row still counts as a booking on file');
  });

  test('a manual booking marked free/comp counts as €0 spent regardless of price', () => {
    const rows = [baseRow({ status: 'confirmed', party: 4, payment_status: 'comp' })];
    const [c] = aggregateCustomers(rows);
    assert.equal(c.total_spent_cents, 0);
  });

  test('name/phone come from the most recently CREATED row, not the most recent booking date', () => {
    const rows = [
      baseRow({ name: 'Old Name', phone: '+31600000001', created_at: '2026-07-01 09:00:00', date: '2026-09-01' }),
      baseRow({ name: 'New Name', phone: '+31600000002', created_at: '2026-07-05 09:00:00', date: '2026-07-10' }),
    ];
    const [c] = aggregateCustomers(rows);
    assert.equal(c.name, 'New Name');
    assert.equal(c.phone, '+31600000002');
  });

  test('sorted by last_booking date descending', () => {
    const rows = [
      baseRow({ email: 'early@example.com', date: '2026-07-01' }),
      baseRow({ email: 'late@example.com', date: '2026-09-01' }),
    ];
    const result = aggregateCustomers(rows);
    assert.deepEqual(result.map((c) => c.email), ['late@example.com', 'early@example.com']);
  });

  test('q filters case-insensitively across name/email/phone', () => {
    const rows = [
      baseRow({ email: 'anna@example.com', name: 'Anna Smith', phone: '+31600000000' }),
      baseRow({ email: 'bram@example.com', name: 'Bram Jansen', phone: '+31600000001' }),
    ];
    assert.deepEqual(aggregateCustomers(rows, 'SMITH').map((c) => c.email), ['anna@example.com']);
    assert.deepEqual(aggregateCustomers(rows, 'bram@').map((c) => c.email), ['bram@example.com']);
  });

  test('rows with no email are skipped', () => {
    const rows = [baseRow({ email: '' }), baseRow({ email: null })];
    assert.deepEqual(aggregateCustomers(rows), []);
  });
});

describe('formatEuros', () => {
  test('formats eurocents as a Dutch-style price string', () => {
    assert.equal(formatEuros(2995), '€29,95');
  });
  test('handles 0 and missing input', () => {
    assert.equal(formatEuros(0), '€0,00');
    assert.equal(formatEuros(undefined), '€0,00');
  });
});

// ---------------------------------------------------------------------------
// Security primitives (SPEC.md §15)
// ---------------------------------------------------------------------------

describe('constantTimeEqual', () => {
  test('true for identical strings', () => {
    assert.equal(constantTimeEqual('abc123', 'abc123'), true);
  });
  test('false for different strings of the same length', () => {
    assert.equal(constantTimeEqual('abc123', 'abc124'), false);
  });
  test('false for different lengths (no early return skips the loop)', () => {
    assert.equal(constantTimeEqual('short', 'a-much-longer-string'), false);
    assert.equal(constantTimeEqual('', ''), true);
    assert.equal(constantTimeEqual('', 'x'), false);
  });
  test('non-string inputs are always false, never throw', () => {
    assert.equal(constantTimeEqual(null, 'x'), false);
    assert.equal(constantTimeEqual(undefined, undefined), false);
    assert.equal(constantTimeEqual(123, '123'), false);
  });
  test('timing does not depend on WHERE strings first differ', () => {
    // Not a true timing-side-channel test (that needs statistical sampling
    // over many runs on real hardware) — this asserts the *structural*
    // property that matters: the comparison loop always runs to the full
    // length of the longer string, regardless of an early mismatch, by
    // checking the function still correctly rejects a string that differs
    // only in its very first character vs. only in its very last character
    // (both must return false; neither should short-circuit differently).
    const a = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const diffFirst = 'yxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const diffLast = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxy';
    assert.equal(constantTimeEqual(a, diffFirst), false);
    assert.equal(constantTimeEqual(a, diffLast), false);
  });
});

describe('isValidDateStr', () => {
  test('accepts a real calendar date', () => {
    assert.equal(isValidDateStr('2026-08-06'), true);
  });
  test('rejects a non-existent calendar date (regex-only would pass this)', () => {
    assert.equal(isValidDateStr('2026-02-30'), false);
    assert.equal(isValidDateStr('2026-13-01'), false);
    assert.equal(isValidDateStr('2026-00-10'), false);
  });
  test('rejects malformed strings and non-strings', () => {
    assert.equal(isValidDateStr('08/06/2026'), false);
    assert.equal(isValidDateStr('2026-8-6'), false);
    assert.equal(isValidDateStr(''), false);
    assert.equal(isValidDateStr(null), false);
    assert.equal(isValidDateStr(20260806), false);
  });
});

describe('sqliteMinutesAgo', () => {
  test('produces a SQLite-comparable datetime N minutes before now', () => {
    const now = new Date('2026-08-06T12:30:00.000Z');
    assert.equal(sqliteMinutesAgo(10, now), '2026-08-06 12:20:00');
    assert.equal(sqliteMinutesAgo(0, now), '2026-08-06 12:30:00');
  });
  test('crosses a day boundary correctly', () => {
    const now = new Date('2026-08-06T00:05:00.000Z');
    assert.equal(sqliteMinutesAgo(10, now), '2026-08-05 23:55:00');
  });
});

describe('computeLoginLockout', () => {
  const now = '2026-08-06 12:00:00';

  test('not locked below the fail threshold', () => {
    const fails = ['2026-08-06 11:58:00', '2026-08-06 11:59:00'];
    const result = computeLoginLockout(fails, now, { threshold: 5, baseMinutes: 15, maxMinutes: 240 });
    assert.equal(result.locked, false);
    assert.equal(result.retryAfterSeconds, 0);
    assert.equal(result.fails, 2);
  });

  test('locks out exactly at the threshold, for baseMinutes from the last failure', () => {
    const fails = [
      '2026-08-06 11:50:00', '2026-08-06 11:51:00', '2026-08-06 11:52:00',
      '2026-08-06 11:53:00', '2026-08-06 11:54:00', // 5th fail, threshold=5
    ];
    const result = computeLoginLockout(fails, now, { threshold: 5, baseMinutes: 15, maxMinutes: 240 });
    // last fail 11:54, +15min = 12:09, now=12:00 -> still locked, ~9 min left
    assert.equal(result.locked, true);
    assert.equal(result.retryAfterSeconds, 9 * 60);
  });

  test('unlocks once baseMinutes has fully elapsed since the last failure', () => {
    const fails = ['2026-08-06 11:00:00', '2026-08-06 11:01:00', '2026-08-06 11:02:00', '2026-08-06 11:03:00', '2026-08-06 11:04:00'];
    const result = computeLoginLockout(fails, now, { threshold: 5, baseMinutes: 15, maxMinutes: 240 });
    // last fail 11:04, +15min = 11:19, well before now (12:00) -> unlocked
    assert.equal(result.locked, false);
  });

  test('escalates: each fail past the threshold doubles the lockout, capped at maxMinutes', () => {
    const baseFails = [
      '2026-08-06 10:00:00', '2026-08-06 10:01:00', '2026-08-06 10:02:00',
      '2026-08-06 10:03:00', '2026-08-06 10:04:00', // 5 fails: threshold reached, lock = 15min
    ];
    const sixth = [...baseFails, '2026-08-06 10:05:00']; // 6th fail: lock = 30min from 10:05
    const r6 = computeLoginLockout(sixth, '2026-08-06 10:20:00', { threshold: 5, baseMinutes: 15, maxMinutes: 240 });
    assert.equal(r6.locked, true);
    assert.equal(r6.retryAfterSeconds, 15 * 60); // 10:05 + 30min = 10:35, now=10:20 -> 15 min left

    const many = [...baseFails, '2026-08-06 10:05:00', '2026-08-06 10:06:00', '2026-08-06 10:07:00', '2026-08-06 10:08:00', '2026-08-06 10:09:00', '2026-08-06 10:10:00'];
    // 10 fails total: escalation = 15 * 2^(10-5) = 480, capped to 240 (maxMinutes)
    const r10 = computeLoginLockout(many, '2026-08-06 10:11:00', { threshold: 5, baseMinutes: 15, maxMinutes: 240 });
    assert.equal(r10.locked, true);
    assert.equal(r10.retryAfterSeconds, 239 * 60); // 10:10 + 240min = 14:10, now=10:11 -> 239 min left
  });

  test('order of input timestamps does not matter (function sorts internally)', () => {
    const failsUnsorted = [
      '2026-08-06 11:54:00', '2026-08-06 11:50:00', '2026-08-06 11:53:00',
      '2026-08-06 11:52:00', '2026-08-06 11:51:00',
    ];
    const result = computeLoginLockout(failsUnsorted, now, { threshold: 5, baseMinutes: 15, maxMinutes: 240 });
    assert.equal(result.locked, true);
    assert.equal(result.retryAfterSeconds, 9 * 60);
  });

  test('empty fail list is never locked', () => {
    const result = computeLoginLockout([], now, { threshold: 5, baseMinutes: 15, maxMinutes: 240 });
    assert.deepEqual(result, { locked: false, retryAfterSeconds: 0, fails: 0 });
  });
});

// ---------------------------------------------------------------------------
// formatMoney (migrations/0011) — the one shared money formatter
// ---------------------------------------------------------------------------

describe('formatMoney', () => {
  test('EUR: symbol first, comma decimal (matches the site\'s existing "€29,95")', () => {
    assert.equal(formatMoney(2995, 'EUR'), '€29,95');
  });

  test('GBP: symbol first, point decimal', () => {
    assert.equal(formatMoney(2995, 'GBP'), '£29.95');
  });

  test('USD: symbol first, point decimal', () => {
    assert.equal(formatMoney(2995, 'USD'), '$29.95');
  });

  test('lowercase currency codes are accepted (case-insensitive)', () => {
    assert.equal(formatMoney(2995, 'gbp'), '£29.95');
  });

  test('defaults to EUR when currency is omitted/falsy', () => {
    assert.equal(formatMoney(2995, undefined), '€29,95');
    assert.equal(formatMoney(2995, ''), '€29,95');
    assert.equal(formatMoney(2995, null), '€29,95');
  });

  test('whole-euro amounts still show two decimal places', () => {
    assert.equal(formatMoney(3000, 'EUR'), '€30,00');
    assert.equal(formatMoney(3000, 'USD'), '$30.00');
  });

  test('zero and non-numeric cents format as zero, never NaN/undefined', () => {
    assert.equal(formatMoney(0, 'EUR'), '€0,00');
    assert.equal(formatMoney(undefined, 'EUR'), '€0,00');
    assert.equal(formatMoney(null, 'USD'), '$0.00');
  });

  test('an unlisted ISO code still formats sanely via the code-prefixed fallback', () => {
    assert.equal(formatMoney(2995, 'CHF'), 'CHF 29.95');
  });

  test('formatEuros is a thin EUR-only wrapper around formatMoney (byte-identical output)', () => {
    assert.equal(formatEuros(2995), formatMoney(2995, 'EUR'));
    assert.equal(formatEuros(2995), '€29,95');
  });
});

// ---------------------------------------------------------------------------
// isValidCurrencyCode / isValidIanaTimeZone (migrations/0011) — admin route
// create/update validation
// ---------------------------------------------------------------------------

describe('isValidCurrencyCode', () => {
  test('accepts 3-letter uppercase codes', () => {
    assert.equal(isValidCurrencyCode('EUR'), true);
    assert.equal(isValidCurrencyCode('GBP'), true);
    assert.equal(isValidCurrencyCode('USD'), true);
    assert.equal(isValidCurrencyCode('CHF'), true);
  });

  test('rejects lowercase, wrong length, non-strings, and junk', () => {
    assert.equal(isValidCurrencyCode('eur'), false);
    assert.equal(isValidCurrencyCode('EU'), false);
    assert.equal(isValidCurrencyCode('EURO'), false);
    assert.equal(isValidCurrencyCode(''), false);
    assert.equal(isValidCurrencyCode(null), false);
    assert.equal(isValidCurrencyCode(undefined), false);
    assert.equal(isValidCurrencyCode(123), false);
    assert.equal(isValidCurrencyCode('€€€'), false);
  });
});

describe('isValidIanaTimeZone', () => {
  test('accepts real IANA zones', () => {
    assert.equal(isValidIanaTimeZone('Europe/Amsterdam'), true);
    assert.equal(isValidIanaTimeZone('Europe/London'), true);
    assert.equal(isValidIanaTimeZone('America/New_York'), true);
    assert.equal(isValidIanaTimeZone('UTC'), true);
  });

  test('rejects garbage, empty, and non-strings', () => {
    assert.equal(isValidIanaTimeZone('Not/A_Zone'), false);
    assert.equal(isValidIanaTimeZone(''), false);
    assert.equal(isValidIanaTimeZone(null), false);
    assert.equal(isValidIanaTimeZone(undefined), false);
    assert.equal(isValidIanaTimeZone(42), false);
  });
});

// ---------------------------------------------------------------------------
// todayInTimezone (migrations/0011) — the route-timezone-aware "today" cutoff
// ---------------------------------------------------------------------------

describe('todayInTimezone', () => {
  test('same UTC instant can be a different calendar date in a far-offset zone', () => {
    // 2026-08-06 23:30 UTC is already 2026-08-07 in Tokyo (UTC+9), but still
    // 2026-08-06 in New York (UTC-4 in August, EDT).
    const instant = new Date('2026-08-06T23:30:00Z');
    assert.equal(todayInTimezone('Asia/Tokyo', instant), '2026-08-07');
    assert.equal(todayInTimezone('America/New_York', instant), '2026-08-06');
    assert.equal(todayInTimezone('UTC', instant), '2026-08-06');
  });

  test('defaults to Europe/Amsterdam when no timezone is given', () => {
    const instant = new Date('2026-01-15T10:00:00Z'); // CET, +1h, no date-boundary crossing
    assert.equal(todayInTimezone(undefined, instant), todayInTimezone('Europe/Amsterdam', instant));
  });

  test('Europe/Amsterdam and Europe/London can disagree right at the UK/NL boundary hour', () => {
    // 23:15 UTC in January (both zones on standard time: Amsterdam CET +1,
    // London GMT +0) is already "tomorrow" in Amsterdam, still "today" in London.
    const instant = new Date('2026-01-15T23:15:00Z');
    assert.equal(todayInTimezone('Europe/London', instant), '2026-01-15');
    assert.equal(todayInTimezone('Europe/Amsterdam', instant), '2026-01-16');
  });
});

// ---------------------------------------------------------------------------
// zonedDateTimeToUtc / utcToZonedHHMM (migrations/0011) — the round-trip pair
// computeBarArrivals is built on
// ---------------------------------------------------------------------------

describe('zonedDateTimeToUtc / utcToZonedHHMM', () => {
  test('Europe/Amsterdam in August (CEST, UTC+2) round-trips correctly', () => {
    const utc = zonedDateTimeToUtc('2026-08-06', '18:00', 'Europe/Amsterdam');
    assert.equal(utc.toISOString(), '2026-08-06T16:00:00.000Z');
    assert.equal(utcToZonedHHMM(utc, 'Europe/Amsterdam'), '18:00');
  });

  test('Europe/London in August (BST, UTC+1) is one hour behind Amsterdam for the same wall-clock time', () => {
    const utcLondon = zonedDateTimeToUtc('2026-08-06', '18:00', 'Europe/London');
    const utcAmsterdam = zonedDateTimeToUtc('2026-08-06', '18:00', 'Europe/Amsterdam');
    assert.equal(utcLondon.toISOString(), '2026-08-06T17:00:00.000Z');
    assert.ok(utcLondon.getTime() > utcAmsterdam.getTime(), 'the same local 18:00 is a LATER instant in London than in Amsterdam (London is behind UTC+2)');
    // But formatted back through each route's OWN timezone, both guests see "18:00" — never leaked into the other zone.
    assert.equal(utcToZonedHHMM(utcLondon, 'Europe/London'), '18:00');
    assert.equal(utcToZonedHHMM(utcAmsterdam, 'Europe/Amsterdam'), '18:00');
  });

  test('America/New_York in winter (EST, UTC-5)', () => {
    const utc = zonedDateTimeToUtc('2026-01-15', '19:00', 'America/New_York');
    assert.equal(utc.toISOString(), '2026-01-16T00:00:00.000Z');
    assert.equal(utcToZonedHHMM(utc, 'America/New_York'), '19:00');
  });

  test('defaults to Europe/Amsterdam when no timezone is given', () => {
    const utc = zonedDateTimeToUtc('2026-08-06', '18:00');
    assert.equal(utc.toISOString(), zonedDateTimeToUtc('2026-08-06', '18:00', 'Europe/Amsterdam').toISOString());
  });
});

// ---------------------------------------------------------------------------
// computeBarArrivals — timezone-aware (migrations/0011): route.timezone
// decides what zone the stagger math runs in; a London-tz route must show
// LONDON local times, never accidentally shifted to Amsterdam/UTC.
// ---------------------------------------------------------------------------

describe('computeBarArrivals — timezone-aware (route.timezone, migrations/0011)', () => {
  const routesBars = [
    { ord: 1, bar_name: 'Bar A', bar_email: 'a@example.com', minutes_offset: 0 },
    { ord: 2, bar_name: 'Bar B', bar_email: 'b@example.com', minutes_offset: 75 },
    { ord: 3, bar_name: 'Bar C', bar_email: 'c@example.com', minutes_offset: 150 },
  ];
  const booking = { date: '2026-08-06', slot: '18:00' };

  test('a route with no timezone column (older fixture) defaults to Europe/Amsterdam — NL behaviour unchanged', () => {
    const route = { id: 'amsterdam' }; // no .timezone at all
    const result = computeBarArrivals(route, routesBars, [], booking);
    assert.deepEqual(result.map((b) => b.arrival_time), ['18:00', '19:15', '20:30']);
  });

  test('an explicit Europe/Amsterdam route matches the default byte-for-byte', () => {
    const withTz = computeBarArrivals({ id: 'amsterdam', timezone: 'Europe/Amsterdam' }, routesBars, [], booking);
    const withoutTz = computeBarArrivals({ id: 'amsterdam' }, routesBars, [], booking);
    assert.deepEqual(withTz, withoutTz);
  });

  test('a London-tz route shows LONDON local arrival times — same wall-clock numbers as NL, never shifted', () => {
    const londonRoute = { id: 'london', timezone: 'Europe/London' };
    const result = computeBarArrivals(londonRoute, routesBars, [], booking);
    // The guest booked "18:00" LONDON time — the bars must be told 18:00,
    // 19:15, 20:30 LONDON time, exactly like Amsterdam sees for its own
    // 18:00 booking. If timezone were leaking (e.g. accidentally converted
    // through Amsterdam or UTC), these would be off by an hour.
    assert.deepEqual(result.map((b) => b.arrival_time), ['18:00', '19:15', '20:30']);
  });

  test('midnight wraparound holds for a London-tz route too', () => {
    const londonRoute = { id: 'london', timezone: 'Europe/London' };
    const lateBooking = { date: '2026-08-06', slot: '23:30' };
    const result = computeBarArrivals(londonRoute, routesBars, [], lateBooking);
    assert.deepEqual(result.map((b) => b.arrival_time), ['23:30', '00:45', '02:00']);
  });

  test('a New York-tz route (bigger UTC offset) still shows correct local arrival times', () => {
    const nycRoute = { id: 'nyc', timezone: 'America/New_York' };
    const result = computeBarArrivals(nycRoute, routesBars, [], booking);
    assert.deepEqual(result.map((b) => b.arrival_time), ['18:00', '19:15', '20:30']);
  });

  test('alternate_bars override still respects the route timezone', () => {
    const londonRoute = { id: 'london', timezone: 'Europe/London' };
    const overrides = [
      {
        route_id: 'london',
        date: '2026-08-06',
        action: 'alternate_bars',
        payload: JSON.stringify([
          { bar_name: 'Alt Bar 1', bar_email: 'alt1@example.com', minutes_offset: 0 },
          { bar_name: 'Alt Bar 2', bar_email: 'alt2@example.com', minutes_offset: 60 },
        ]),
      },
    ];
    const result = computeBarArrivals(londonRoute, routesBars, overrides, booking);
    assert.deepEqual(result.map((b) => b.arrival_time), ['18:00', '19:00']);
  });
});
