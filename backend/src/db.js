// src/db.js
//
// The ONLY file that touches `db` (the D1 binding `env.DB`, or the test
// adapter in test/sqlite-d1-adapter.js — both share the exact
// prepare/bind/run/all/first shape). Every exported function takes `db` as
// its first argument and returns plain JS objects/arrays, never a raw D1
// result wrapper — this is also the seam PORTABILITY.md points to.
//
// No business-logic math lives here beyond what SQL itself expresses; pure
// aggregation/formatting is delegated to src/logic.js.

import { nowSqlite, buildSlotsForDate, aggregateCustomers } from './logic.js';

// ---------------------------------------------------------------------------
// Named-param → positional translation (real-D1 compatibility)
// ---------------------------------------------------------------------------
//
// The SQL in this file is written with named `:tokens` for readability, but
// REAL Cloudflare D1 only supports positional parameters (`?` / `?N`) bound
// variadically — `.bind(paramsObj)` throws `D1_TYPE_ERROR: Type 'object' not
// supported` in production. toPositional() rewrites each `:name` to `?N`
// (ONE index per distinct name, so a name used several times in one statement
// still binds exactly once) and returns the values in index order for
// `.bind(...values)`.
//
// Safety rules — throws are deliberate; a silent mismatch is exactly how the
// original named-vs-positional bug survived 141 green tests:
//   * single-quoted string literals, double-quoted identifiers and `--` line
//     comments are copied verbatim — a ':' inside them is never a param
//     (e.g. the '$."18:00"' JSON paths built in effectiveCapacitySql)
//   * a param-like token (:[A-Za-z_][A-Za-z0-9_]*) outside literals whose
//     name is NOT a key of paramsObj → throw (missing binding)
//   * a paramsObj key the SQL never references → throw (unused binding)
//   * a bound value of `undefined` → throw (D1 has no undefined; use null)
//
// Exported so tests can (a) unit-test it directly and (b) reuse it for their
// own fixture SQL against the now-strict positional-only test adapter.

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

export function toPositional(sql, paramsObj) {
  const params = paramsObj || {};
  const indexByName = new Map(); // name -> 1-based ?N index
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // string literal ('...', with '' escapes) or quoted identifier ("...")
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; } // escaped quote
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    // -- line comment: copy verbatim up to end of line
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = sql.length;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ':') {
      const m = PARAM_NAME_RE.exec(sql.slice(i + 1));
      if (m) {
        const name = m[0];
        if (!Object.prototype.hasOwnProperty.call(params, name)) {
          throw new Error(`db: SQL references :${name} but no such binding was provided`);
        }
        let idx = indexByName.get(name);
        if (idx === undefined) {
          idx = indexByName.size + 1;
          indexByName.set(name, idx);
        }
        out += `?${idx}`;
        i += 1 + name.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  const values = new Array(indexByName.size);
  for (const [name, idx] of indexByName) {
    const v = params[name];
    if (v === undefined) {
      throw new Error(`db: binding '${name}' is undefined — bind null explicitly`);
    }
    values[idx - 1] = v;
  }
  for (const name of Object.keys(params)) {
    if (!indexByName.has(name)) {
      throw new Error(`db: binding '${name}' is never referenced by the SQL`);
    }
  }
  return { sql: out, values };
}

// ---------------------------------------------------------------------------
// small helpers — the ONLY places that touch prepare/bind, so translation
// happens exactly once, here.
// ---------------------------------------------------------------------------

async function run(db, sql, params) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).run();
}

async function all(db, sql, params) {
  const t = toPositional(sql, params);
  const res = await db.prepare(t.sql).bind(...t.values).all();
  return res.results || [];
}

async function first(db, sql, params) {
  const t = toPositional(sql, params);
  return db.prepare(t.sql).bind(...t.values).first();
}

/**
 * Runs several statements as ONE atomic unit via the D1 binding's native
 * `.batch()` (a real multi-statement transaction in production D1 — if any
 * statement fails, none of them land). Used wherever a multi-row write must
 * not be allowed to land partially (SPEC.md "no partial writes" — production
 * hardening, 2026-07); see replaceBars below for the first caller.
 * `statements` is `[{ sql, params }, ...]` in the same named-param SQL shape
 * as every other query in this file.
 */
async function batchRun(db, statements) {
  const prepared = statements.map(({ sql, params }) => {
    const t = toPositional(sql, params);
    return db.prepare(t.sql).bind(...t.values);
  });
  return db.batch(prepared);
}

// ---------------------------------------------------------------------------
// Holds / bookings — the load-bearing atomic path (SPEC.md §6)
// ---------------------------------------------------------------------------

/**
 * Builds the effective-capacity SQL expression for one (route, date, slot),
 * honoring the full per-timeslot precedence from migrations/0003 (highest to
 * lowest): date+slot override > date-wide override > route+slot default >
 * route default. `routeIdExpr`/`dateExpr`/`slotExpr` are raw SQL fragments
 * (a bound-param name like ':route_id', or a scalar subquery) so this same
 * builder serves both CREATE_HOLD_SQL (bound params) and confirmBooking's
 * §6.4 conflict-recovery UPDATE (which only has the booking id bound, and
 * derives route/date/slot via subqueries on that id) — one definition, so
 * the two guards can never drift apart. Slot keys are matched with SQLite's
 * quoted-member JSON path (`$."HH:MM"`) so the colon in "18:00" is never
 * mistaken for path syntax.
 */
function effectiveCapacitySql(routeIdExpr, dateExpr, slotExpr) {
  const slotPath = `('$."' || (${slotExpr}) || '"')`;
  // ISO weekday (Mon=1..Sun=7) of `dateExpr`, computed purely in SQL:
  // strftime('%w', date) is SQLite's day-of-week, 0=Sun..6=Sat; (+6)%7 then
  // +1 rotates that into the Mon=1..Sun=7 scheme logic.js:isoWeekday and
  // db.js's own isoWeekdayLocal use everywhere else (migrations/0014). Must
  // stay in exact lockstep with those two JS functions — same formula.
  const weekdayExpr = `(((CAST(strftime('%w', (${dateExpr})) AS INTEGER) + 6) % 7) + 1)`;
  const weekdayPath = `('$."' || ${weekdayExpr} || '"')`;
  return `
    COALESCE(
      -- 1. date+slot override (this exact date, this exact slot)
      (SELECT CAST(json_extract(payload, ${slotPath}) AS INTEGER)
         FROM date_overrides
        WHERE route_id = (${routeIdExpr}) AND date = (${dateExpr}) AND action = 'slot_capacity_override'
          AND json_extract(payload, ${slotPath}) IS NOT NULL),
      -- 2. date-wide override (this date, every slot)
      (SELECT CAST(json_extract(payload, '$.capacity') AS INTEGER)
         FROM date_overrides
        WHERE route_id = (${routeIdExpr}) AND date = (${dateExpr}) AND action = 'capacity_override'),
      -- 3. route's per-slot default (this route, this slot, any date)
      (SELECT CAST(json_extract(slot_capacity, ${slotPath}) AS INTEGER)
         FROM routes
        WHERE id = (${routeIdExpr})
          AND json_extract(slot_capacity, ${slotPath}) IS NOT NULL),
      -- 3.5 route's per-weekday default (migrations/0014) — this route, this
      -- date's ISO weekday, any slot; NULL column or missing key falls through.
      (SELECT CAST(json_extract(weekday_capacity, ${weekdayPath}) AS INTEGER)
         FROM routes
        WHERE id = (${routeIdExpr})
          AND json_extract(weekday_capacity, ${weekdayPath}) IS NOT NULL),
      -- 4. route-wide default
      (SELECT capacity FROM routes WHERE id = (${routeIdExpr}))
    )
  `;
}

const EFFECTIVE_CAPACITY_BOUND = effectiveCapacitySql(':route_id', ':date', ':slot');

// Same expression, but for confirmBooking's §6.4 recovery path, which only
// has the booking id bound — route/date/slot are looked up from that row.
const BOOKING_ROUTE_ID = '(SELECT route_id FROM bookings WHERE id = :id)';
const BOOKING_DATE = '(SELECT date FROM bookings WHERE id = :id)';
const BOOKING_SLOT = '(SELECT slot FROM bookings WHERE id = :id)';
const EFFECTIVE_CAPACITY_RECOVERY = effectiveCapacitySql(BOOKING_ROUTE_ID, BOOKING_DATE, BOOKING_SLOT);

// Note `ip` (migrations/0005): recorded on the hold so "max N active holds
// per IP" (SPEC.md §15.1) is counted against real rows; cleared the moment
// the hold resolves (confirm/cancel/expire) so it's never retained on a
// finished booking.
const CREATE_HOLD_SQL = `
INSERT INTO bookings
  (id, route_id, date, slot, party, name, email, phone, notes, locale, marketing_opt_in, status, created_at, hold_expires, ip)
SELECT
  :id, :route_id, :date, :slot, :party, :name, :email, :phone, :notes, :locale, :marketing_opt_in,
  'hold', datetime('now'), :hold_expires, :ip
WHERE
  :party <= (SELECT max_party FROM routes WHERE id = :route_id AND active = 1)

  AND NOT EXISTS (
    SELECT 1 FROM date_overrides
    WHERE route_id = :route_id AND date = :date AND action = 'closed'
  )

  AND NOT EXISTS (
    SELECT 1 FROM date_overrides
    WHERE route_id = :route_id AND date = :date AND action = 'remove_slot'
      AND json_extract(payload, '$.slot') = :slot
  )

  AND (
    (SELECT COALESCE(SUM(party), 0) FROM bookings
      WHERE route_id = :route_id AND date = :date AND slot = :slot
        AND (status = 'confirmed' OR (status = 'hold' AND hold_expires > datetime('now')))
    ) + :party
  ) <= ${EFFECTIVE_CAPACITY_BOUND};
`;

// Manual (owner phone-booking) insert. Same ATOMIC capacity guard as
// createHold — so a manual booking can never oversell physical bar seats,
// enforced against the exact same four-level effective-capacity chain — but it
// lands straight as a CONFIRMED, source='manual' row (no Stripe hold/checkout),
// carrying an explicit payment_status. It deliberately does NOT enforce
// max_party / open_days / closed overrides: the owner is arranging this by hand
// with the bar, so those are hers to override; only the real overbooking
// constraint (seats) is kept hard. (SPEC.md §12.6)
const CREATE_MANUAL_BOOKING_SQL = `
INSERT INTO bookings
  (id, route_id, date, slot, party, name, email, phone, notes, locale, marketing_opt_in,
   status, source, payment_status, discount_code, discount_cents, created_at, hold_expires)
SELECT
  :id, :route_id, :date, :slot, :party, :name, :email, :phone, :notes, :locale, :marketing_opt_in,
  'confirmed', 'manual', :payment_status, :discount_code, :discount_cents, datetime('now'), NULL
WHERE
  (
    (SELECT COALESCE(SUM(party), 0) FROM bookings
      WHERE route_id = :route_id AND date = :date AND slot = :slot
        AND (status = 'confirmed' OR status = 'confirmed_conflict'
             OR (status = 'hold' AND hold_expires > datetime('now')))
    ) + :party
  ) <= ${EFFECTIVE_CAPACITY_BOUND};
`;

/**
 * Atomically creates a confirmed manual booking if seats allow. Returns
 * { created: true, booking } or { created: false, seats_left } (so the admin
 * form can say "only N seats left" without a second guess).
 */
export async function createManualBooking(db, params) {
  const bound = {
    id: params.id,
    route_id: params.route_id,
    date: params.date,
    slot: params.slot,
    party: params.party,
    name: params.name,
    email: params.email,
    phone: params.phone ?? null,
    notes: params.notes ?? null,
    locale: params.locale ?? 'en',
    marketing_opt_in: params.marketing_opt_in ? 1 : 0,
    payment_status: params.payment_status ?? 'paid_invoice',
    discount_code: params.discount_code ?? null,
    discount_cents: params.discount_cents ?? 0,
  };
  const result = await run(db, CREATE_MANUAL_BOOKING_SQL, bound);
  if (result.meta.changes === 1) {
    const booking = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id: params.id });
    return { created: true, booking };
  }
  // capacity guard rejected it — report how many seats were actually left.
  const route = await first(db, `SELECT capacity FROM routes WHERE id = :route_id`, { route_id: params.route_id });
  const usedRow = await first(
    db,
    `SELECT COALESCE(SUM(party), 0) AS used FROM bookings
       WHERE route_id = :route_id AND date = :date AND slot = :slot
         AND (status = 'confirmed' OR status = 'confirmed_conflict'
              OR (status = 'hold' AND hold_expires > datetime('now')))`,
    { route_id: params.route_id, date: params.date, slot: params.slot }
  );
  const capacity = await resolveEffectiveCapacity(
    db, params.route_id, params.date, params.slot, route ? route.capacity : 0
  );
  return { created: false, seats_left: Math.max(0, capacity - (usedRow ? usedRow.used : 0)) };
}

/** Persists promo-code + amount-saved onto a booking (called from the webhook
 * after a Stripe-paid confirm — see src/logic.js:extractDiscount). No-op when
 * nothing was discounted. */
export async function setBookingDiscount(db, id, code, cents) {
  if (!code && !(cents > 0)) return false;
  const result = await run(
    db,
    `UPDATE bookings SET discount_code = :code, discount_cents = :cents WHERE id = :id`,
    { id, code: code ?? null, cents: cents || 0 }
  );
  return result.meta.changes === 1;
}

/**
 * Atomically creates a hold if — and only if — capacity, party-size, and
 * closed/remove_slot guards all pass, in one SQL statement (SPEC.md §6.1/§6.2).
 * Returns { created: true, booking } on success or { created: false } on
 * failure (caller then calls diagnoseHoldFailure for the specific error code).
 */
export async function createHold(db, params) {
  const bound = {
    id: params.id,
    route_id: params.route_id,
    date: params.date,
    slot: params.slot,
    party: params.party,
    name: params.name,
    email: params.email,
    phone: params.phone ?? null,
    notes: params.notes ?? null,
    locale: params.locale ?? 'en',
    marketing_opt_in: params.marketing_opt_in ? 1 : 0,
    hold_expires: params.hold_expires,
    ip: params.ip ?? null,
  };
  const result = await run(db, CREATE_HOLD_SQL, bound);
  if (result.meta.changes === 1) {
    const booking = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id: params.id });
    return { created: true, booking };
  }
  return { created: false };
}

/**
 * Read-only diagnosis of why createHold failed — only ever called on the
 * rare "someone just took the last seat" path, so it's fine that it costs
 * a few extra reads. Returns one of:
 *   { code: 'route_not_found' }
 *   { code: 'party_too_large' }
 *   { code: 'route_closed' }
 *   { code: 'sold_out', seats_left }
 */
export async function diagnoseHoldFailure(db, { route_id, date, slot, party }) {
  const route = await first(db, `SELECT * FROM routes WHERE id = :route_id AND active = 1`, { route_id });
  if (!route) return { code: 'route_not_found' };

  if (party > route.max_party) return { code: 'party_too_large' };

  const closed = await first(
    db,
    `SELECT 1 FROM date_overrides WHERE route_id = :route_id AND date = :date AND action = 'closed'`,
    { route_id, date }
  );
  if (closed) return { code: 'route_closed' };

  const openDays = JSON.parse(route.open_days);
  const weekday = isoWeekdayLocal(date);
  if (!openDays.includes(weekday)) return { code: 'route_closed' };

  const removed = await first(
    db,
    `SELECT 1 FROM date_overrides
       WHERE route_id = :route_id AND date = :date AND action = 'remove_slot'
         AND json_extract(payload, '$.slot') = :slot`,
    { route_id, date, slot }
  );
  if (removed) return { code: 'route_closed' };

  const usedRow = await first(
    db,
    `SELECT COALESCE(SUM(party), 0) AS used FROM bookings
       WHERE route_id = :route_id AND date = :date AND slot = :slot
         AND (status = 'confirmed' OR (status = 'hold' AND hold_expires > datetime('now')))`,
    { route_id, date, slot }
  );
  const capacity = await resolveEffectiveCapacity(db, route_id, date, slot, route.capacity);
  const seatsLeft = Math.max(0, capacity - usedRow.used);
  return { code: 'sold_out', seats_left: seatsLeft };
}

/**
 * Read-only resolution of the same per-timeslot precedence CREATE_HOLD_SQL's
 * effectiveCapacitySql() enforces atomically — used only on diagnostic /
 * reporting paths (never the hot path), so plain sequential reads are fine
 * here even though the atomic guard has to do it in one statement.
 */
export async function resolveEffectiveCapacity(db, route_id, date, slot, routeCapacityFallback) {
  const slotOverrideRow = await first(
    db,
    `SELECT CAST(json_extract(payload, '$."' || :slot || '"') AS INTEGER) AS capacity
       FROM date_overrides
      WHERE route_id = :route_id AND date = :date AND action = 'slot_capacity_override'
        AND json_extract(payload, '$."' || :slot || '"') IS NOT NULL`,
    { route_id, date, slot }
  );
  if (slotOverrideRow && slotOverrideRow.capacity != null) return slotOverrideRow.capacity;

  const dateOverrideRow = await first(
    db,
    `SELECT CAST(json_extract(payload, '$.capacity') AS INTEGER) AS capacity
       FROM date_overrides WHERE route_id = :route_id AND date = :date AND action = 'capacity_override'`,
    { route_id, date }
  );
  if (dateOverrideRow && dateOverrideRow.capacity != null) return dateOverrideRow.capacity;

  const routeSlotRow = await first(
    db,
    `SELECT CAST(json_extract(slot_capacity, '$."' || :slot || '"') AS INTEGER) AS capacity
       FROM routes
      WHERE id = :route_id AND json_extract(slot_capacity, '$."' || :slot || '"') IS NOT NULL`,
    { route_id, slot }
  );
  if (routeSlotRow && routeSlotRow.capacity != null) return routeSlotRow.capacity;

  // 3.5 route's per-weekday default (migrations/0014) — same precedence
  // level, same JSON shape, as the SQL guard's weekdayExpr above; MUST stay
  // in lockstep so the guest-facing seats_left number and the atomic
  // no-overbook guard agree (this function is the read-only mirror).
  const weekday = isoWeekdayLocal(date);
  const routeWeekdayRow = await first(
    db,
    `SELECT CAST(json_extract(weekday_capacity, '$."' || :weekday || '"') AS INTEGER) AS capacity
       FROM routes
      WHERE id = :route_id AND json_extract(weekday_capacity, '$."' || :weekday || '"') IS NOT NULL`,
    { route_id, weekday: String(weekday) }
  );
  if (routeWeekdayRow && routeWeekdayRow.capacity != null) return routeWeekdayRow.capacity;

  return routeCapacityFallback;
}

// duplicated tiny helper (kept local so db.js never imports Date-math besides
// what it needs — logic.js's isoWeekday is the canonical version used everywhere else)
function isoWeekdayLocal(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}

export async function attachStripeSession(db, bookingId, sessionId) {
  const result = await run(
    db,
    `UPDATE bookings SET stripe_session = :session_id WHERE id = :id AND status = 'hold'`,
    { id: bookingId, session_id: sessionId }
  );
  return result.meta.changes === 1;
}

/**
 * Confirms a hold on webhook success. Tries the normal path (§6.3) first;
 * if the booking is no longer 'hold' (already expired/swept), tries the
 * conflict-recovery re-reserve path (§6.4). Returns:
 *   { status: 'confirmed' }            — normal or recovered path
 *   { status: 'confirmed_conflict' }   — paid but seat genuinely gone
 *   { status: 'not_found' }            — booking id doesn't exist at all
 */
export async function confirmBooking(db, bookingId, sessionId, paymentIntentId) {
  const normal = await run(
    db,
    `UPDATE bookings
       SET status = 'confirmed', stripe_session = :session_id, stripe_payment_intent = :pi_id, hold_expires = NULL, ip = NULL
     WHERE id = :id AND status = 'hold'`,
    { id: bookingId, session_id: sessionId, pi_id: paymentIntentId }
  );
  if (normal.meta.changes === 1) {
    const booking = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id: bookingId });
    return { status: 'confirmed', booking };
  }

  const existing = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id: bookingId });
  if (!existing) return { status: 'not_found' };
  if (existing.status === 'confirmed' || existing.status === 'confirmed_conflict') {
    return { status: existing.status, booking: existing };
  }

  // conflict-recovery path (§6.4): only meaningful if the row is 'expired'.
  // Capacity guard uses the exact same per-timeslot precedence as
  // CREATE_HOLD_SQL (effectiveCapacitySql) — route/date/slot are derived via
  // subqueries on :id since only the booking id is bound here.
  const recovered = await run(
    db,
    `UPDATE bookings
       SET status = 'confirmed', stripe_session = :session_id, stripe_payment_intent = :pi_id, hold_expires = NULL, ip = NULL
     WHERE id = :id AND status = 'expired'
       AND (
         (SELECT COALESCE(SUM(party), 0) FROM bookings
           WHERE route_id = (SELECT route_id FROM bookings WHERE id = :id)
             AND date = (SELECT date FROM bookings WHERE id = :id)
             AND slot = (SELECT slot FROM bookings WHERE id = :id)
             AND id != :id
             AND (status = 'confirmed' OR (status = 'hold' AND hold_expires > datetime('now')))
         ) + (SELECT party FROM bookings WHERE id = :id)
       ) <= ${EFFECTIVE_CAPACITY_RECOVERY}`,
    { id: bookingId, session_id: sessionId, pi_id: paymentIntentId }
  );
  if (recovered.meta.changes === 1) {
    const booking = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id: bookingId });
    return { status: 'confirmed', booking };
  }

  // seat truly gone — guest paid, mark the honest conflict status
  await run(
    db,
    `UPDATE bookings
       SET status = 'confirmed_conflict', stripe_session = :session_id, stripe_payment_intent = :pi_id, ip = NULL
     WHERE id = :id`,
    { id: bookingId, session_id: sessionId, pi_id: paymentIntentId }
  );
  const booking = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id: bookingId });
  return { status: 'confirmed_conflict', booking };
}

export async function cancelIfHold(db, bookingId) {
  const result = await run(
    db,
    `UPDATE bookings SET status = 'cancelled', hold_expires = NULL, ip = NULL WHERE id = :id AND status = 'hold'`,
    { id: bookingId }
  );
  return result.meta.changes === 1;
}

// ---------------------------------------------------------------------------
// Owner "Move" / "Cancel" drawer actions — admin-only, on an already-CONFIRMED
// booking (guests never self-serve either of these; see admin_api.js).
// Both mirror createManualBooking's guarded-SQL shape: one atomic statement,
// read-back on success, diagnostic reads only on the (rare) failure path.
// ---------------------------------------------------------------------------

// Same seat-counting rule CREATE_MANUAL_BOOKING_SQL uses (confirmed +
// confirmed_conflict + live holds count against capacity) — `id != :id`
// excludes the booking being moved itself, which (pre-UPDATE) still sits at
// its OLD date/slot, so it would otherwise double-count itself in the one
// case where old and new (date, slot) happen to be the same.
const RESCHEDULE_BOOKING_SQL = `
UPDATE bookings
   SET date = :date, slot = :slot
 WHERE id = :id
   AND (status = 'confirmed' OR status = 'confirmed_conflict')
   AND (
     (SELECT COALESCE(SUM(party), 0) FROM bookings
        WHERE route_id = :route_id AND date = :date AND slot = :slot AND id != :id
          AND (status = 'confirmed' OR status = 'confirmed_conflict'
               OR (status = 'hold' AND hold_expires > datetime('now')))
     ) + :party
   ) <= ${EFFECTIVE_CAPACITY_BOUND};
`;

/**
 * Atomically moves a CONFIRMED (or confirmed_conflict) booking to a new
 * date/slot on its own route, guarded by the exact same effective-capacity
 * chain as every other booking write — the owner can never move a booking
 * into a bar that's already full. Returns one of:
 *   { not_found: true }
 *   { not_movable: true }                          — wrong status to move
 *   { moved: true, booking, previous, noop?: true } — noop when date/slot
 *                                                       didn't actually change
 *                                                       (no email should fire)
 *   { moved: false, seats_left }                    — new slot doesn't have room
 */
export async function rescheduleBooking(db, { id, date, slot }) {
  const booking = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id });
  if (!booking) return { not_found: true };
  if (booking.status !== 'confirmed' && booking.status !== 'confirmed_conflict') {
    return { not_movable: true };
  }

  const previous = { date: booking.date, slot: booking.slot };
  if (date === booking.date && slot === booking.slot) {
    // Same date+slot: nothing to move. Treated as a successful no-op rather
    // than an error (the owner clicking "Move" into the slot the booking is
    // already in shouldn't feel like a failure) — but flagged `noop: true` so
    // the caller can skip sending a pointless "your booking moved" email.
    return { moved: true, booking, previous, noop: true };
  }

  const result = await run(db, RESCHEDULE_BOOKING_SQL, {
    id, date, slot, party: booking.party, route_id: booking.route_id,
  });
  if (result.meta.changes === 1) {
    const moved = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id });
    return { moved: true, booking: moved, previous };
  }

  // capacity guard rejected it — report how many seats were actually left,
  // same diagnostic shape createManualBooking's failure path returns.
  const route = await first(db, `SELECT capacity FROM routes WHERE id = :route_id`, { route_id: booking.route_id });
  const usedRow = await first(
    db,
    `SELECT COALESCE(SUM(party), 0) AS used FROM bookings
       WHERE route_id = :route_id AND date = :date AND slot = :slot AND id != :id
         AND (status = 'confirmed' OR status = 'confirmed_conflict'
              OR (status = 'hold' AND hold_expires > datetime('now')))`,
    { route_id: booking.route_id, date, slot, id }
  );
  const capacity = await resolveEffectiveCapacity(
    db, booking.route_id, date, slot, route ? route.capacity : 0
  );
  return { moved: false, seats_left: Math.max(0, capacity - (usedRow ? usedRow.used : 0)) };
}

/**
 * Cancels a CONFIRMED (or confirmed_conflict) booking. Cancelled bookings are
 * already excluded from every capacity SUM in this file, so this alone frees
 * the seats — no separate "release capacity" step needed. Refunds are NOT
 * handled here (out of scope — the owner does that by hand in Stripe; see
 * admin_api.js's doc comment on handleCancelBooking).
 */
export async function cancelBooking(db, { id }) {
  const booking = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id });
  if (!booking) return { not_found: true };
  if (booking.status !== 'confirmed' && booking.status !== 'confirmed_conflict') {
    return { not_cancellable: true };
  }

  const result = await run(
    db,
    `UPDATE bookings SET status = 'cancelled', hold_expires = NULL
       WHERE id = :id AND (status = 'confirmed' OR status = 'confirmed_conflict')`,
    { id }
  );
  if (result.meta.changes !== 1) return { not_cancellable: true };

  const cancelled = await first(db, `SELECT * FROM bookings WHERE id = :id`, { id });
  return { cancelled: true, booking: cancelled };
}

export async function expireHolds(db) {
  const result = await run(
    db,
    `UPDATE bookings SET status = 'expired', ip = NULL WHERE status = 'hold' AND hold_expires <= datetime('now')`,
    {}
  );
  return { expired: result.meta.changes };
}

export async function getBooking(db, id) {
  return first(db, `SELECT * FROM bookings WHERE id = :id`, { id });
}

export async function getBookingBySession(db, sessionId) {
  return first(db, `SELECT * FROM bookings WHERE stripe_session = :session_id`, { session_id: sessionId });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function listActiveRoutes(db) {
  return all(db, `SELECT * FROM routes WHERE active = 1 ORDER BY city, name`, {});
}

export async function listAllRoutes(db) {
  return all(db, `SELECT * FROM routes ORDER BY city, name`, {});
}

export async function getRoute(db, id) {
  return first(db, `SELECT * FROM routes WHERE id = :id`, { id });
}

export async function createRoute(db, route) {
  await run(
    db,
    `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, weekday_capacity, map_url, map_url_nl, active, currency, timezone)
     VALUES (:id, :name, :city, :price_cents, :capacity, :max_party, :open_days, :slots, :slot_capacity, :weekday_capacity, :map_url, :map_url_nl, :active, :currency, :timezone)`,
    {
      id: route.id,
      name: route.name,
      city: route.city,
      price_cents: route.price_cents,
      capacity: route.capacity ?? 10,
      max_party: route.max_party ?? 6,
      open_days: route.open_days,
      slots: route.slots,
      slot_capacity: route.slot_capacity ?? '{}',
      // migrations/0014: per-weekday capacity default — NULL (the column's
      // own default) unless explicitly given, so creating a route never
      // opts it into the feature by accident.
      weekday_capacity: route.weekday_capacity ?? null,
      map_url: route.map_url ?? null,
      // migrations/0012: Dutch route map; NULL falls back to map_url in the
      // NL confirmation email, so an EN-only route stays fully functional.
      map_url_nl: route.map_url_nl ?? null,
      active: route.active ?? 1,
      // migrations/0011: ISO currency + IANA timezone, per route/city. Default
      // here mirrors the column's own SQL DEFAULT so every pre-existing NL
      // route (and any caller written before this column existed) is
      // unaffected — 'EUR' / 'Europe/Amsterdam'.
      currency: route.currency ?? 'EUR',
      timezone: route.timezone ?? 'Europe/Amsterdam',
    }
  );
  return getRoute(db, route.id);
}

const ROUTE_EDITABLE_COLUMNS = [
  'name', 'city', 'price_cents', 'capacity', 'max_party', 'open_days', 'slots', 'slot_capacity', 'weekday_capacity', 'map_url', 'map_url_nl', 'active',
  'currency', 'timezone',
];

export async function updateRoute(db, id, patch) {
  const cols = Object.keys(patch).filter((k) => ROUTE_EDITABLE_COLUMNS.includes(k));
  if (cols.length === 0) return getRoute(db, id);
  const setClause = cols.map((c) => `${c} = :${c}`).join(', ');
  const bound = { id };
  for (const c of cols) bound[c] = patch[c];
  await run(db, `UPDATE routes SET ${setClause} WHERE id = :id`, bound);
  return getRoute(db, id);
}

// ---------------------------------------------------------------------------
// routes_bars
// ---------------------------------------------------------------------------

export async function listBars(db, routeId) {
  return all(db, `SELECT * FROM routes_bars WHERE route_id = :route_id ORDER BY ord`, { route_id: routeId });
}

/**
 * Resolves the bar set for one (route, date) — per-weekday bar sets
 * (migrations/0015): a route can run a DIFFERENT, RECURRING ordered bar
 * list on different weekdays (e.g. Thursday's route stops differ from
 * Friday's), distinct from the existing one-off per-DATE 'alternate_bars'
 * date_override, which src/logic.js:computeBarArrivals still applies ON TOP
 * of whatever this returns and keeps outranking it.
 *
 * If any routes_bars rows exist for (route_id, weekday = date's ISO
 * weekday), return those (ordered by ord) — that weekday's own set. Else
 * return the rows with weekday IS NULL (ordered by ord) — the DEFAULT set,
 * exactly what listBars has always returned for a route that never used
 * this feature (every existing row's weekday is NULL after migrations/0015's
 * additive ALTER TABLE), so that case is byte-for-byte unchanged.
 */
export async function listBarsForDate(db, routeId, date) {
  const weekday = isoWeekdayLocal(date);
  const forWeekday = await all(
    db,
    `SELECT * FROM routes_bars WHERE route_id = :route_id AND weekday = :weekday ORDER BY ord`,
    { route_id: routeId, weekday }
  );
  if (forWeekday.length > 0) return forWeekday;
  return all(
    db,
    `SELECT * FROM routes_bars WHERE route_id = :route_id AND weekday IS NULL ORDER BY ord`,
    { route_id: routeId }
  );
}

export async function addBar(db, routeId, bar) {
  const result = await run(
    db,
    `INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset)
     VALUES (:route_id, :ord, :bar_name, :bar_email, :minutes_offset)`,
    {
      route_id: routeId,
      ord: bar.ord,
      bar_name: bar.bar_name,
      bar_email: bar.bar_email,
      minutes_offset: bar.minutes_offset ?? 0,
    }
  );
  return first(db, `SELECT * FROM routes_bars WHERE id = :id`, { id: result.meta.last_row_id });
}

export async function updateBar(db, barId, patch) {
  const cols = ['ord', 'bar_name', 'bar_email', 'minutes_offset'].filter((k) => k in patch);
  if (cols.length === 0) return first(db, `SELECT * FROM routes_bars WHERE id = :id`, { id: barId });
  const setClause = cols.map((c) => `${c} = :${c}`).join(', ');
  const bound = { id: barId };
  for (const c of cols) bound[c] = patch[c];
  await run(db, `UPDATE routes_bars SET ${setClause} WHERE id = :id`, bound);
  return first(db, `SELECT * FROM routes_bars WHERE id = :id`, { id: barId });
}

export async function deleteBar(db, barId) {
  const result = await run(db, `DELETE FROM routes_bars WHERE id = :id`, { id: barId });
  return result.meta.changes === 1;
}

/**
 * Bulk-replaces the entire bar list for a route in one call — the shape the
 * admin dashboard's "Save bars" button uses (it edits the whole ordered list
 * client-side, then saves it in one shot rather than per-row CRUD calls).
 *
 * `weekday` (migrations/0015, additive): omitted/null (the original,
 * pre-existing call shape) replaces only the DEFAULT set (weekday IS NULL) —
 * byte-for-byte the same behaviour this function always had, since every
 * pre-migration row's weekday is NULL. Passing an ISO weekday 1..7 instead
 * replaces ONLY that weekday's own set, leaving the default set and every
 * other weekday's set completely untouched — `weekday IS :weekday` is the
 * NULL-safe SQLite match (works whether :weekday is NULL or an integer), so
 * one WHERE clause serves both cases without branching SQL.
 */
export async function replaceBars(db, routeId, bars, weekday = null) {
  // Atomic (single D1 transaction via batchRun) so a crash mid-list can never
  // leave a route with ZERO bars (deleted, but not yet re-inserted) — see
  // batchRun's doc comment. Previously this ran as N+1 separate statements.
  const statements = [
    {
      sql: `DELETE FROM routes_bars WHERE route_id = :route_id AND weekday IS :weekday`,
      params: { route_id: routeId, weekday },
    },
  ];
  let ord = 1;
  for (const bar of bars) {
    statements.push({
      sql: `INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset, weekday)
            VALUES (:route_id, :ord, :bar_name, :bar_email, :minutes_offset, :weekday)`,
      params: {
        route_id: routeId,
        ord: Number.isInteger(bar.ord) ? bar.ord : ord,
        bar_name: bar.bar_name,
        bar_email: bar.bar_email,
        minutes_offset: bar.minutes_offset ?? 0,
        weekday,
      },
    });
    ord++;
  }
  await batchRun(db, statements);
  return listBars(db, routeId);
}

// ---------------------------------------------------------------------------
// date_overrides
// ---------------------------------------------------------------------------

export async function listOverrides(db, routeId, dateFrom, dateTo) {
  const clauses = ['route_id = :route_id'];
  const bound = { route_id: routeId };
  if (dateFrom) { clauses.push('date >= :date_from'); bound.date_from = dateFrom; }
  if (dateTo) { clauses.push('date <= :date_to'); bound.date_to = dateTo; }
  return all(db, `SELECT * FROM date_overrides WHERE ${clauses.join(' AND ')} ORDER BY date`, bound);
}

export async function listOverridesForDate(db, routeId, date) {
  return all(
    db,
    `SELECT * FROM date_overrides WHERE route_id = :route_id AND date = :date`,
    { route_id: routeId, date }
  );
}

/**
 * `payload` is stored EXACTLY as given — callers (admin_api.js) are
 * responsible for passing an already-JSON-encoded string (or null for
 * `closed`), matching what's persisted in the TEXT column and what
 * logic.js's JSON.parse(...) calls expect to decode exactly once.
 */
export async function upsertOverride(db, { route_id, date, action, payload }) {
  await run(
    db,
    `INSERT OR REPLACE INTO date_overrides (route_id, date, action, payload)
     VALUES (:route_id, :date, :action, :payload)`,
    { route_id, date, action, payload: payload ?? null }
  );
  return first(
    db,
    `SELECT * FROM date_overrides WHERE route_id = :route_id AND date = :date AND action = :action`,
    { route_id, date, action }
  );
}

export async function deleteOverride(db, id) {
  const result = await run(db, `DELETE FROM date_overrides WHERE id = :id`, { id });
  return result.meta.changes === 1;
}

// ---------------------------------------------------------------------------
// Availability reads (feed logic.js's pure aggregators)
// ---------------------------------------------------------------------------

/** Slot list for one date, annotated with a live seats_left from real bookings. */
export async function getSlotsWithSeatsLeft(db, route, dateOverridesForDate, date) {
  const slots = buildSlotsForDate(route, dateOverridesForDate, date);
  const used = await all(
    db,
    `SELECT slot, COALESCE(SUM(party), 0) AS used FROM bookings
       WHERE route_id = :route_id AND date = :date
         AND (status = 'confirmed' OR (status = 'hold' AND hold_expires > datetime('now')))
       GROUP BY slot`,
    { route_id: route.id, date }
  );
  const usedBySlot = Object.fromEntries(used.map((r) => [r.slot, r.used]));
  return slots.map((s) => ({
    slot: s.slot,
    capacity: s.capacity,
    seats_left: Math.max(0, s.capacity - (usedBySlot[s.slot] || 0)),
  }));
}

// ---------------------------------------------------------------------------
// Admin: bookings list / CSV / participants-per-hour (SPEC.md §7)
// ---------------------------------------------------------------------------

export async function listBookings(db, filters = {}) {
  const clauses = ['1=1'];
  const bound = {};
  if (filters.route) { clauses.push('b.route_id = :route'); bound.route = filters.route; }
  if (filters.city) { clauses.push('r.city = :city'); bound.city = filters.city; }
  if (filters.date_from) { clauses.push('b.date >= :date_from'); bound.date_from = filters.date_from; }
  if (filters.date_to) { clauses.push('b.date <= :date_to'); bound.date_to = filters.date_to; }
  if (filters.status) { clauses.push('b.status = :status'); bound.status = filters.status; }
  if (filters.source) { clauses.push('b.source = :source'); bound.source = filters.source; }
  if (filters.email) { clauses.push('LOWER(b.email) = LOWER(:email)'); bound.email = filters.email; }
  if (filters.q) {
    clauses.push(`(b.name LIKE '%'||:q||'%' OR b.email LIKE '%'||:q||'%' OR b.phone LIKE '%'||:q||'%')`);
    bound.q = filters.q;
  }
  bound.limit = filters.limit ?? 200;
  bound.offset = filters.offset ?? 0;
  return all(
    db,
    `SELECT b.*, r.name AS route_name, r.city
       FROM bookings b JOIN routes r ON r.id = b.route_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY b.date DESC, b.slot DESC
      LIMIT :limit OFFSET :offset`,
    bound
  );
}

export async function participantsPerHour(db, date, route) {
  const clauses = ['b.date = :date', `(b.status = 'confirmed' OR (b.status = 'hold' AND b.hold_expires > datetime('now')))`];
  const bound = { date };
  if (route) { clauses.push('b.route_id = :route'); bound.route = route; }
  return all(
    db,
    `SELECT b.route_id, r.name AS route_name, b.slot, SUM(b.party) AS guests, COUNT(*) AS bookings
       FROM bookings b JOIN routes r ON r.id = b.route_id
      WHERE ${clauses.join(' AND ')}
      GROUP BY b.route_id, b.slot
      ORDER BY b.slot`,
    bound
  );
}

// ---------------------------------------------------------------------------
// Customers (CRM) — SPEC.md §12.5. No customers table: derived from bookings.
// ---------------------------------------------------------------------------

/** Every booking row joined with its route's per-person price + name/city, for
 * logic.js:aggregateCustomers to fold into one entry per customer. Returns the
 * lean column set the aggregation needs (not SELECT *), across ALL statuses so
 * a lead who only ever held (never paid) still surfaces in the CRM. */
export async function listCustomerBookingRows(db) {
  return all(
    db,
    `SELECT b.email, b.name, b.phone, b.date, b.slot, b.party, b.status,
            b.created_at, b.source, b.payment_status, b.discount_code, b.discount_cents,
            b.route_id, r.name AS route_name, r.city, r.price_cents
       FROM bookings b JOIN routes r ON r.id = b.route_id
      ORDER BY b.created_at DESC`,
    {}
  );
}

/**
 * Edits a customer's contact details and PROPAGATES to every one of their
 * bookings (owner requirement: "fix typos — edits propagate"). Matches on the
 * old email (case-insensitive); only the fields present in `patch` are written.
 * Changing the email re-points all their rows to the new address, so the
 * derived customer keeps its whole history. Returns the number of bookings
 * updated.
 */
export async function updateCustomer(db, oldEmail, patch) {
  const sets = [];
  const bound = { old_email: oldEmail };
  if (patch.name !== undefined) { sets.push('name = :name'); bound.name = patch.name; }
  if (patch.phone !== undefined) { sets.push('phone = :phone'); bound.phone = patch.phone || null; }
  if (patch.email !== undefined) { sets.push('email = :email'); bound.email = patch.email; }
  if (sets.length === 0) return { updated: 0 };
  const result = await run(
    db,
    `UPDATE bookings SET ${sets.join(', ')} WHERE LOWER(email) = LOWER(:old_email)`,
    bound
  );
  return { updated: result.meta.changes };
}

// ---------------------------------------------------------------------------
// webhook_events dedupe (SPEC.md §8.3 step 4)
// ---------------------------------------------------------------------------

export async function recordWebhookEvent(db, id, type) {
  try {
    await run(db, `INSERT INTO webhook_events (id, type) VALUES (:id, :type)`, { id, type });
    return { duplicate: false };
  } catch (err) {
    // SQLite raises a constraint-violation error on a duplicate PRIMARY KEY.
    // Node's node:sqlite and D1 both surface this with a message containing
    // "UNIQUE" or "constraint" — treat any such failure as "already handled"
    // rather than re-throwing, per §8.3 step 4.
    const msg = String(err && err.message ? err.message : err);
    if (/unique|constraint/i.test(msg)) {
      return { duplicate: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Security: hold caps, rate events, admin-login audit (SPEC.md §15,
// migrations/0005). Counters are D1-backed on purpose — Workers isolates
// share no memory, so an in-memory limiter would be trivially bypassed.
// ---------------------------------------------------------------------------

/** Live (unexpired) holds currently open under this email address. */
export async function countActiveHoldsByEmail(db, email) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS n FROM bookings
      WHERE LOWER(email) = LOWER(:email) AND status = 'hold' AND hold_expires > datetime('now')`,
    { email }
  );
  return row ? row.n : 0;
}

/** Live (unexpired) holds currently open from this IP (bookings.ip is set on
 * hold creation and cleared on confirm/cancel/expire — see CREATE_HOLD_SQL). */
export async function countActiveHoldsByIp(db, ip) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS n FROM bookings
      WHERE ip = :ip AND status = 'hold' AND hold_expires > datetime('now')`,
    { ip }
  );
  return row ? row.n : 0;
}

/** One row per rate-limited attempt (kind='book' = a POST /api/book call). */
export async function recordRateEvent(db, kind, identity) {
  await run(db, `INSERT INTO rate_events (kind, identity) VALUES (:kind, :identity)`, { kind, identity });
}

/** Attempts by this identity inside the sliding window starting at sinceStr
 * (a SQLite-shaped datetime from logic.js:sqliteMinutesAgo). */
export async function countRateEventsSince(db, kind, identity, sinceStr) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS n FROM rate_events
      WHERE kind = :kind AND identity = :identity AND created_at >= :since`,
    { kind, identity, since: sinceStr }
  );
  return row ? row.n : 0;
}

/** Housekeeping — called from the cron sweep. Returns rows deleted. */
export async function pruneRateEvents(db, beforeStr) {
  const result = await run(db, `DELETE FROM rate_events WHERE created_at < :before`, { before: beforeStr });
  return result.meta.changes;
}

/** Records one admin-login attempt (ok = success, else failure). */
export async function recordAuthEvent(db, ip, ok) {
  await run(db, `INSERT INTO auth_events (ip, ok) VALUES (:ip, :ok)`, { ip, ok: ok ? 1 : 0 });
}

/**
 * Timestamps of this IP's failed logins inside the look-back window AND after
 * its most recent successful login (a success resets the count — the owner
 * mistyping a few times then logging in doesn't leave a lockout armed).
 * Feed the result to logic.js:computeLoginLockout.
 *
 * Uses `id` (not `created_at`) to find "after the last success": SQLite's
 * `datetime('now')` only has 1-second resolution, so a burst of attempts
 * landing in the same second — exactly what a scripted brute force looks
 * like — could tie on created_at and make a strict `>` on the timestamp
 * miscount. `id` is an AUTOINCREMENT primary key, so insertion order (and
 * therefore real chronological order) is exact even when timestamps collide.
 */
export async function listRecentLoginFailures(db, ip, sinceStr) {
  const rows = await all(
    db,
    `SELECT created_at FROM auth_events
      WHERE ip = :ip AND ok = 0 AND created_at >= :since
        AND id > COALESCE(
          (SELECT MAX(id) FROM auth_events WHERE ip = :ip AND ok = 1), 0)
      ORDER BY id`,
    { ip, since: sinceStr }
  );
  return rows.map((r) => r.created_at);
}

/** Total failed logins (any IP) since sinceStr — the audit-count endpoint. */
export async function countLoginFailuresSince(db, sinceStr) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS n FROM auth_events WHERE ok = 0 AND created_at >= :since`,
    { since: sinceStr }
  );
  return row ? row.n : 0;
}

/** Most recent failed logins, newest first — the audit-list endpoint. */
export async function listLoginFailures(db, limit = 50) {
  return all(
    db,
    `SELECT ip, created_at FROM auth_events WHERE ok = 0 ORDER BY created_at DESC, id DESC LIMIT :limit`,
    { limit }
  );
}

/** Housekeeping — called from the cron sweep. Returns rows deleted. */
export async function pruneAuthEvents(db, beforeStr) {
  const result = await run(db, `DELETE FROM auth_events WHERE created_at < :before`, { before: beforeStr });
  return result.meta.changes;
}

// ---------------------------------------------------------------------------
// settings (k/v) — generic get/set, migrations/0001. Reused as the D1-backed
// "clock" for throttled owner alerts (src/alerts.js) so a crash loop or a
// flapping health check can't spam Brevo/the owner's inbox — no new table
// needed, this one already existed and was unused.
// ---------------------------------------------------------------------------

export async function getSetting(db, k) {
  const row = await first(db, `SELECT v FROM settings WHERE k = :k`, { k });
  return row ? row.v : null;
}

export async function setSetting(db, k, v) {
  await run(
    db,
    `INSERT INTO settings (k, v) VALUES (:k, :v)
       ON CONFLICT(k) DO UPDATE SET v = :v`,
    { k, v }
  );
}

// ---------------------------------------------------------------------------
// Webhook processing state (migrations/0009, production hardening 2026-07).
// Replaces the old "one INSERT = claimed AND done at once" dedupe with a
// claim/finish pair so a booking write that THROWS never gets marked done —
// see migrations/0009's doc comment for the full incident this fixes.
// recordWebhookEvent() above still exists (and is still correct on its own
// terms — an atomic insert-or-detect-duplicate) but src/webhook.js no longer
// calls it; these two functions are what it uses instead.
// ---------------------------------------------------------------------------

/**
 * Atomically claims a Stripe event id for processing.
 * Returns 'new' (first time seen — proceed), 'retry' (seen before but never
 * finished — proceed, the write is idempotent so redoing it is safe) or
 * 'duplicate' (already finished — short-circuit, ack 200, do nothing).
 */
export async function beginWebhookProcessing(db, id, type) {
  const existing = await first(db, `SELECT status FROM webhook_events WHERE id = :id`, { id });
  if (existing) {
    return existing.status === 'done' ? 'duplicate' : 'retry';
  }
  try {
    await run(db, `INSERT INTO webhook_events (id, type, status) VALUES (:id, :type, 'processing')`, { id, type });
    return 'new';
  } catch (err) {
    // Lost a race to claim the same event id (two near-simultaneous
    // deliveries) — the other request owns it; treat this one as a retry so
    // it still ends up doing (idempotent) work rather than silently no-oping.
    const msg = String(err && err.message ? err.message : err);
    if (/unique|constraint/i.test(msg)) return 'retry';
    throw err;
  }
}

/** Marks a claimed event 'done' — call ONLY after its booking write has
 * completed without throwing (see src/webhook.js). */
export async function finishWebhookProcessing(db, id) {
  await run(db, `UPDATE webhook_events SET status = 'done', processed_at = datetime('now') WHERE id = :id`, { id });
}

// ---------------------------------------------------------------------------
// error_log (migrations/0006) — €0 Sentry-equivalent. Written from
// src/errors.js:captureError, called from index.js's top-level catch blocks.
// ---------------------------------------------------------------------------

export async function insertErrorLog(db, { message, stack, url, method, context }) {
  await run(
    db,
    `INSERT INTO error_log (message, stack, url, method, context)
     VALUES (:message, :stack, :url, :method, :context)`,
    { message, stack: stack ?? null, url: url ?? null, method: method ?? null, context: context ?? null }
  );
}

/** Newest-first — the dashboard-readable endpoint (GET /admin/api/error-log). */
export async function listRecentErrors(db, limit = 100) {
  return all(db, `SELECT * FROM error_log ORDER BY id DESC LIMIT :limit`, { limit });
}

export async function countErrorsSince(db, sinceStr) {
  const row = await first(db, `SELECT COUNT(*) AS n FROM error_log WHERE created_at >= :since`, { since: sinceStr });
  return row ? row.n : 0;
}

/** Housekeeping — called from the cron sweep. Returns rows deleted. */
export async function pruneErrorLog(db, beforeStr) {
  const result = await run(db, `DELETE FROM error_log WHERE created_at < :before`, { before: beforeStr });
  return result.meta.changes;
}

// ---------------------------------------------------------------------------
// admin_audit (migrations/0007) — who/what/when for every admin mutation.
// Written from src/admin_api.js's `audit()` helper, one row per successful
// mutating call. Read back via GET /admin/api/audit-log.
// ---------------------------------------------------------------------------

export async function insertAdminAudit(db, { ip, action, entity_type, entity_id, detail }) {
  await run(
    db,
    `INSERT INTO admin_audit (ip, action, entity_type, entity_id, detail)
     VALUES (:ip, :action, :entity_type, :entity_id, :detail)`,
    {
      ip: ip ?? null,
      action,
      entity_type: entity_type ?? null,
      entity_id: entity_id == null ? null : String(entity_id),
      detail: detail ?? null,
    }
  );
}

/** Newest-first — the dashboard-readable endpoint (GET /admin/api/audit-log). */
export async function listAdminAudit(db, limit = 200) {
  return all(db, `SELECT * FROM admin_audit ORDER BY id DESC LIMIT :limit`, { limit });
}

/** Housekeeping — called from the cron sweep. Returns rows deleted. */
export async function pruneAdminAudit(db, beforeStr) {
  const result = await run(db, `DELETE FROM admin_audit WHERE created_at < :before`, { before: beforeStr });
  return result.meta.changes;
}

// ---------------------------------------------------------------------------
// failed_email (migrations/0008) — email-delivery retry queue. Written from
// src/email_retry.js:sendWithRetry when an inline Brevo send fails; drained
// by the retry cron (src/email_retry.js:retryFailedEmails).
// ---------------------------------------------------------------------------

export async function queueFailedEmail(db, msg) {
  await run(
    db,
    `INSERT INTO failed_email
       (to_email, subject, html_content, sender_email, sender_name, reply_to, kind, attempts, status, last_error, next_attempt_at)
     VALUES
       (:to_email, :subject, :html_content, :sender_email, :sender_name, :reply_to, :kind, 1, 'pending', :last_error, :next_attempt_at)`,
    {
      to_email: msg.to_email,
      subject: msg.subject,
      html_content: msg.html_content,
      sender_email: msg.sender_email ?? null,
      sender_name: msg.sender_name ?? null,
      reply_to: msg.reply_to ?? null,
      kind: msg.kind || 'unknown',
      last_error: msg.last_error ?? null,
      next_attempt_at: msg.next_attempt_at,
    }
  );
}

/** Rows due for a retry attempt right now, oldest-queued first. */
export async function listDueFailedEmails(db, nowStr, limit = 50) {
  return all(
    db,
    `SELECT * FROM failed_email WHERE status = 'pending' AND next_attempt_at <= :now ORDER BY id LIMIT :limit`,
    { now: nowStr, limit }
  );
}

export async function markFailedEmailSent(db, id) {
  await run(db, `UPDATE failed_email SET status = 'sent', updated_at = datetime('now') WHERE id = :id`, { id });
}

export async function markFailedEmailRetry(db, id, attempts, nextAttemptAt, lastError) {
  await run(
    db,
    `UPDATE failed_email
        SET attempts = :attempts, next_attempt_at = :next_attempt_at, last_error = :last_error, updated_at = datetime('now')
      WHERE id = :id`,
    { id, attempts, next_attempt_at: nextAttemptAt, last_error: lastError ?? null }
  );
}

export async function markFailedEmailPermanent(db, id, lastError) {
  await run(
    db,
    `UPDATE failed_email SET status = 'failed_permanent', last_error = :last_error, updated_at = datetime('now') WHERE id = :id`,
    { id, last_error: lastError ?? null }
  );
}

/** Metadata only (no html_content — keeps this cheap and avoids shipping raw
 * guest-PII HTML over the wire) — the dashboard-readable endpoint
 * (GET /admin/api/failed-emails). */
export async function listRecentFailedEmails(db, limit = 100) {
  return all(
    db,
    `SELECT id, created_at, updated_at, to_email, subject, kind, attempts, status, last_error, next_attempt_at
       FROM failed_email ORDER BY id DESC LIMIT :limit`,
    { limit }
  );
}

/** Housekeeping — called from the cron sweep. Only rows that reached a final
 * state (sent or gave-up) are ever pruned; still-pending rows are untouched
 * no matter how old (they're actively being retried). Returns rows deleted. */
export async function pruneResolvedFailedEmails(db, beforeStr) {
  const result = await run(
    db,
    `DELETE FROM failed_email WHERE status IN ('sent', 'failed_permanent') AND updated_at < :before`,
    { before: beforeStr }
  );
  return result.meta.changes;
}

// ---------------------------------------------------------------------------
// Health check (src/healthcheck.js) — cheapest possible real D1 round-trip.
// ---------------------------------------------------------------------------

export async function pingDb(db) {
  const row = await first(db, `SELECT 1 AS ok`, {});
  if (!row || row.ok !== 1) throw new Error('unexpected_ping_result');
  return true;
}

// ---------------------------------------------------------------------------
// GDPR retention (src/retention.js, owner audit item #14) — anonymizes guest
// PII on TERMINAL bookings once they're older than the retention window.
// Never touches 'hold' rows (they always resolve within HOLD_MINUTES via the
// existing 5-minute sweep, long before any retention window could apply).
// Idempotent: the `name != '[deleted]'` guard means re-running the cron only
// ever touches rows it hasn't already anonymized.
// ---------------------------------------------------------------------------

export async function anonymizeOldBookings(db, beforeStr) {
  const result = await run(
    db,
    `UPDATE bookings
        SET name = '[deleted]', email = 'deleted-' || id || '@wogoamsterdam.invalid', phone = NULL, notes = NULL
      WHERE created_at < :before
        AND status IN ('confirmed', 'confirmed_conflict', 'cancelled', 'expired')
        AND name != '[deleted]'`,
    { before: beforeStr }
  );
  return { anonymized: result.meta.changes };
}

// ---------------------------------------------------------------------------
// Full-table dumps for the daily R2 export (src/backup.js). Deliberately
// separate from every other read function in this file (which all filter/
// paginate) — a backup needs EVERY row, every column, unfiltered.
// ---------------------------------------------------------------------------

export async function listAllRoutesForBackup(db) {
  return all(db, `SELECT * FROM routes ORDER BY id`, {});
}

export async function listAllBarsForBackup(db) {
  return all(db, `SELECT * FROM routes_bars ORDER BY route_id, ord`, {});
}

export async function listAllDateOverridesForBackup(db) {
  return all(db, `SELECT * FROM date_overrides ORDER BY route_id, date`, {});
}

export async function listAllBookingsForBackup(db) {
  return all(db, `SELECT * FROM bookings ORDER BY created_at`, {});
}

export { nowSqlite };
