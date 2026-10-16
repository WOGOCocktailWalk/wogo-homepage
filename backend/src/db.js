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

import { nowSqlite, sqliteMinutesAgo, buildSlotsForDate, isSlotPastCutoff, aggregateCustomers, generateGiftCardCode, normalizeGiftCardCode } from './logic.js';
import {
  SAME_DAY_CUTOFF_MINUTES,
  ABANDONED_FIRST_EMAIL_MIN_MINUTES, ABANDONED_FOLLOWUP_MIN_MINUTES, ABANDONED_WINDOW_MAX_MINUTES,
} from './config.js';

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
  (id, route_id, date, slot, party, name, email, phone, notes, locale, marketing_opt_in, status, created_at, hold_expires, ip,
   utm_source, utm_medium, utm_campaign, utm_content, referrer, landing_path)
SELECT
  :id, :route_id, :date, :slot, :party, :name, :email, :phone, :notes, :locale, :marketing_opt_in,
  'hold', datetime('now'), :hold_expires, :ip,
  :utm_source, :utm_medium, :utm_campaign, :utm_content, :referrer, :landing_path
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
    utm_source: params.utm_source ?? null,
    utm_medium: params.utm_medium ?? null,
    utm_campaign: params.utm_campaign ?? null,
    utm_content: params.utm_content ?? null,
    referrer: params.referrer ?? null,
    landing_path: params.landing_path ?? null,
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
    `INSERT INTO routes (id, name, city, price_cents, capacity, max_party, open_days, slots, slot_capacity, weekday_capacity, map_url, map_url_nl, active, currency, timezone, booking_cutoff_minutes)
     VALUES (:id, :name, :city, :price_cents, :capacity, :max_party, :open_days, :slots, :slot_capacity, :weekday_capacity, :map_url, :map_url_nl, :active, :currency, :timezone, :booking_cutoff_minutes)`,
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
      // migrations/0029: per-route booking cutoff (minutes before a slot's
      // start it stops being bookable) — default mirrors the column's own
      // SQL DEFAULT (60, same as SAME_DAY_CUTOFF_MINUTES) so a route created
      // without opting in behaves exactly like every pre-existing route.
      booking_cutoff_minutes: route.booking_cutoff_minutes ?? 60,
    }
  );
  return getRoute(db, route.id);
}

const ROUTE_EDITABLE_COLUMNS = [
  'name', 'city', 'price_cents', 'capacity', 'max_party', 'open_days', 'slots', 'slot_capacity', 'weekday_capacity', 'map_url', 'map_url_nl', 'active',
  'currency', 'timezone', 'booking_cutoff_minutes',
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

/** migrations/0022: the only two meaningful values are 'nl'/'en' — anything
 * else (missing, typo, future language not yet built) normalizes to 'nl',
 * same normalize-at-the-write-edge pattern used everywhere else a locale is
 * stored (vs. trusting an arbitrary string into a column every bar-email
 * renderer branches on). */
function normalizeBarLocale(value) {
  return value === 'en' ? 'en' : 'nl';
}

export async function addBar(db, routeId, bar) {
  const result = await run(
    db,
    `INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset, locale)
     VALUES (:route_id, :ord, :bar_name, :bar_email, :minutes_offset, :locale)`,
    {
      route_id: routeId,
      ord: bar.ord,
      bar_name: bar.bar_name,
      bar_email: bar.bar_email,
      minutes_offset: bar.minutes_offset ?? 0,
      locale: normalizeBarLocale(bar.locale),
    }
  );
  return first(db, `SELECT * FROM routes_bars WHERE id = :id`, { id: result.meta.last_row_id });
}

export async function updateBar(db, barId, patch) {
  const cols = ['ord', 'bar_name', 'bar_email', 'minutes_offset', 'locale'].filter((k) => k in patch);
  if (cols.length === 0) return first(db, `SELECT * FROM routes_bars WHERE id = :id`, { id: barId });
  const setClause = cols.map((c) => `${c} = :${c}`).join(', ');
  const bound = { id: barId };
  for (const c of cols) bound[c] = c === 'locale' ? normalizeBarLocale(patch[c]) : patch[c];
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
      sql: `INSERT INTO routes_bars (route_id, ord, bar_name, bar_email, minutes_offset, weekday, locale)
            VALUES (:route_id, :ord, :bar_name, :bar_email, :minutes_offset, :weekday, :locale)`,
      params: {
        route_id: routeId,
        ord: Number.isInteger(bar.ord) ? bar.ord : ord,
        bar_name: bar.bar_name,
        bar_email: bar.bar_email,
        minutes_offset: bar.minutes_offset ?? 0,
        weekday,
        locale: normalizeBarLocale(bar.locale),
      },
    });
    ord++;
  }
  await batchRun(db, statements);
  return listBars(db, routeId);
}

// ---------------------------------------------------------------------------
// Add-ons (migrations/0033) — bar-fulfilled booking upsells. See that
// migration's header comment for the full business-model + schema writeup;
// this section is the CRUD + the two load-bearing atomic/read paths
// (capacity reservation at hold time, capacity+cutoff re-check at
// reschedule time) that mirror createHold/rescheduleBooking's own guards.
// ---------------------------------------------------------------------------

/** Every add-on row for a route, ANY active state — the admin editor's full
 * picture (mirrors listBars). Ordered by sort_order, same convention as
 * routes_bars.ord. */
export async function listAddonsForRoute(db, routeId) {
  return all(db, `SELECT * FROM addons WHERE route_id = :route_id ORDER BY sort_order, created_at`, { route_id: routeId });
}

export async function getAddon(db, id) {
  return first(db, `SELECT * FROM addons WHERE id = :id`, { id });
}

export async function createAddon(db, routeId, addon) {
  const id = `addon_${crypto.randomUUID()}`;
  await run(
    db,
    `INSERT INTO addons
      (id, route_id, bar_id, name_en, name_nl, description_en, description_nl, image_url,
       price_cents, cost_cents, currency, vat_rate, is_food, unit, max_qty_per_booking,
       capacity_per_slot, cutoff_hours, sort_order, active, created_at, updated_at)
     VALUES
      (:id, :route_id, :bar_id, :name_en, :name_nl, :description_en, :description_nl, :image_url,
       :price_cents, :cost_cents, :currency, :vat_rate, :is_food, :unit, :max_qty_per_booking,
       :capacity_per_slot, :cutoff_hours, :sort_order, :active, datetime('now'), datetime('now'))`,
    {
      id,
      route_id: routeId,
      // Number(), not a bare passthrough: bar_id is an INTEGER column
      // (routes_bars.id's own type) — a string digit from a JSON body must
      // be coerced, not stored as text (see the migration's own doc
      // comment on why the column's affinity matters here).
      bar_id: addon.bar_id != null ? Number(addon.bar_id) : null,
      name_en: addon.name_en,
      name_nl: addon.name_nl,
      description_en: addon.description_en ?? null,
      description_nl: addon.description_nl ?? null,
      image_url: addon.image_url ?? null,
      price_cents: addon.price_cents,
      cost_cents: addon.cost_cents,
      currency: addon.currency || 'EUR',
      vat_rate: addon.vat_rate,
      is_food: addon.is_food ? 1 : 0,
      unit: addon.unit === 'per_booking' ? 'per_booking' : 'per_person',
      max_qty_per_booking: addon.max_qty_per_booking,
      capacity_per_slot: addon.capacity_per_slot ?? null,
      cutoff_hours: addon.cutoff_hours,
      sort_order: Number.isInteger(addon.sort_order) ? addon.sort_order : 0,
      active: addon.active ? 1 : 0,
    }
  );
  return getAddon(db, id);
}

const ADDON_PATCH_COLUMNS = [
  'bar_id', 'name_en', 'name_nl', 'description_en', 'description_nl', 'image_url',
  'price_cents', 'cost_cents', 'currency', 'vat_rate', 'is_food', 'unit',
  'max_qty_per_booking', 'capacity_per_slot', 'cutoff_hours', 'sort_order', 'active',
];

export async function updateAddon(db, id, patch) {
  const cols = ADDON_PATCH_COLUMNS.filter((k) => k in patch);
  if (cols.length === 0) return getAddon(db, id);
  const setClause = cols.map((c) => `${c} = :${c}`).join(', ');
  const bound = { id };
  for (const c of cols) {
    let v = patch[c];
    if (c === 'is_food' || c === 'active') v = v ? 1 : 0;
    if (c === 'unit') v = v === 'per_booking' ? 'per_booking' : 'per_person';
    if (c === 'bar_id') v = v != null ? Number(v) : null;
    bound[c] = v;
  }
  await run(db, `UPDATE addons SET ${setClause}, updated_at = datetime('now') WHERE id = :id`, bound);
  return getAddon(db, id);
}

export async function deleteAddon(db, id) {
  const result = await run(db, `DELETE FROM addons WHERE id = :id`, { id });
  return result.meta.changes === 1;
}

/** Cheap existence check powering GET /api/routes' `has_addons` flag — lets
 * the widget skip GET /api/addons entirely for a route with none, so "a
 * route with no active add-ons is byte-for-byte identical to today" holds
 * at the network layer, not just in the rendered DOM. */
export async function routeHasActiveAddons(db, routeId) {
  const row = await first(db, `SELECT 1 AS x FROM addons WHERE route_id = :route_id AND active = 1 LIMIT 1`, { route_id: routeId });
  return !!row;
}

/**
 * Guest-facing candidates for one (route, date, slot): every ACTIVE add-on
 * on the route, with `reserved_qty` — the total already committed for this
 * exact slot (confirmed, or a still-live hold) — so the caller can derive
 * remaining capacity. Cutoff is deliberately NOT filtered here: SQLite has
 * no per-route-timezone clock, so src/guest_api.js:handleListAddons filters
 * the returned rows through logic.js:isSlotPastCutoff (route.timezone,
 * addon.cutoff_hours * 60), the same division of labor every other
 * cutoff check in this codebase already uses.
 */
export async function listAddonsForSlot(db, routeId, date, slot) {
  return all(
    db,
    `SELECT a.*,
        (SELECT COALESCE(SUM(ba.qty), 0)
           FROM booking_addons ba
           JOIN bookings b ON b.id = ba.booking_id
          WHERE ba.addon_id = a.id
            AND b.route_id = :route_id AND b.date = :date AND b.slot = :slot
            AND (b.status = 'confirmed' OR (b.status = 'hold' AND b.hold_expires > datetime('now')))
        ) AS reserved_qty
       FROM addons a
      WHERE a.route_id = :route_id AND a.active = 1
      ORDER BY a.sort_order, a.created_at`,
    { route_id: routeId, date, slot }
  );
}

// Atomic add-on capacity reservation at hold time — the exact same
// "INSERT ... SELECT ... WHERE capacity allows it" idiom CREATE_HOLD_SQL
// uses for seats, so two simultaneous requests for the last unit of a
// capacity-limited add-on can never both succeed. `capacity_per_slot IS
// NULL` (unlimited) short-circuits the whole guard. The status set
// (confirmed OR live hold) mirrors CREATE_HOLD_SQL's own set exactly —
// this call happens at the same moment in the booking flow (right after a
// seat hold is created), so it must count exactly the same competing rows.
const CREATE_BOOKING_ADDON_SQL = `
INSERT INTO booking_addons
  (id, booking_id, addon_id, qty, unit_price_cents, unit_cost_cents, currency, vat_rate, name_snapshot_en, name_snapshot_nl, created_at)
SELECT
  :id, :booking_id, :addon_id, :qty, :unit_price_cents, :unit_cost_cents, :currency, :vat_rate, :name_snapshot_en, :name_snapshot_nl, datetime('now')
WHERE
  (SELECT capacity_per_slot FROM addons WHERE id = :addon_id) IS NULL
  OR (
    (SELECT COALESCE(SUM(ba.qty), 0)
       FROM booking_addons ba
       JOIN bookings b ON b.id = ba.booking_id
      WHERE ba.addon_id = :addon_id
        AND b.route_id = :route_id AND b.date = :date AND b.slot = :slot
        AND (b.status = 'confirmed' OR (b.status = 'hold' AND b.hold_expires > datetime('now')))
    ) + :qty
  ) <= (SELECT capacity_per_slot FROM addons WHERE id = :addon_id);
`;

/**
 * Atomically reserves one add-on line item against a just-created hold.
 * Returns { created: true, id } or { created: false } (capacity guard
 * rejected it — caller's responsibility to release the seat hold, same
 * "hold stays, expires naturally OR is explicitly cancelled" contract as
 * every other post-hold failure in guest_api.js:handleBook).
 */
export async function createBookingAddon(db, params) {
  const id = `ba_${crypto.randomUUID()}`;
  const result = await run(db, CREATE_BOOKING_ADDON_SQL, {
    id,
    booking_id: params.booking_id,
    addon_id: params.addon_id,
    qty: params.qty,
    unit_price_cents: params.unit_price_cents,
    unit_cost_cents: params.unit_cost_cents,
    currency: params.currency || 'EUR',
    vat_rate: params.vat_rate,
    name_snapshot_en: params.name_snapshot_en,
    name_snapshot_nl: params.name_snapshot_nl,
    route_id: params.route_id,
    date: params.date,
    slot: params.slot,
  });
  if (result.meta.changes === 1) return { created: true, id };
  return { created: false };
}

/**
 * Every add-on line item for EVERY booking, grouped into a plain
 * `{ [booking_id]: [line, ...] }` object — the bookings CSV export's bulk
 * read (src/admin_api.js:handleExportCsv), so a 10,000-row export costs ONE
 * extra query total, not one per row. `booking_addons` stays small relative
 * to `bookings` (the overwhelming majority of bookings carry zero add-ons),
 * so one full scan here is cheap even as the export grows.
 */
export async function listAddonsGroupedByBooking(db) {
  const rows = await all(db, `SELECT * FROM booking_addons ORDER BY booking_id, created_at`, {});
  const grouped = {};
  for (const row of rows) {
    (grouped[row.booking_id] = grouped[row.booking_id] || []).push(row);
  }
  return grouped;
}

/** Records the guest's optional allergy/dietary free text — a SEPARATE
 * column from bookings.notes (see migrations/0033's header comment).
 * Called only when there's something to write (src/guest_api.js), so a
 * booking with no add-ons never touches this column at all. */
export async function setBookingAddonNotes(db, id, addonNotes) {
  await run(db, `UPDATE bookings SET addon_notes = :addon_notes WHERE id = :id`, { id, addon_notes: addonNotes ?? null });
}

/** All add-on line items for one booking — admin booking detail, every
 * email renderer, and the bookings CSV export all share this one read.
 * LEFT JOINs the live `addons` row for its current bar_id/is_food/image_url
 * (a deleted add-on still returns its booking_addons row, just with those
 * three columns NULL — renderers fall back to the snapshot name). */
export async function getAddonsForBooking(db, bookingId) {
  return all(
    db,
    `SELECT ba.*, a.bar_id AS bar_id, a.is_food AS is_food, a.image_url AS image_url
       FROM booking_addons ba
       LEFT JOIN addons a ON a.id = ba.addon_id
      WHERE ba.booking_id = :booking_id
      ORDER BY ba.created_at`,
    { booking_id: bookingId }
  );
}

/**
 * Read-only check: can every add-on line item already on this booking still
 * be honoured at (newDate, newSlot)? Checks BOTH halves — cutoff (needs
 * `timezone`, the route's own IANA zone, same DST-safe logic.js:
 * isSlotPastCutoff every other cutoff check in this codebase uses) AND
 * capacity. Used ONLY by the admin reschedule endpoint (src/admin_api.js:
 * handleRescheduleBooking), called BEFORE db.rescheduleBooking actually
 * moves the booking — "fail loudly" per the owner's requirement, rather
 * than moving the booking and silently stranding a paid add-on.
 *
 * Capacity's status set + self-exclusion mirror RESCHEDULE_BOOKING_SQL's own
 * seat guard exactly (confirmed/confirmed_conflict/live hold,
 * `b.id != :booking_id`) — a booking moving into a slot where it is the
 * ONLY order on this add-on must never fail against its own, about-to-move
 * reservation.
 *
 * A line item whose add-on has since been DELETED is skipped — there's no
 * live cutoff_hours/capacity_per_slot left to re-check it against, and
 * nothing meaningful to say about it either way.
 *
 * Returns [] when everything fits, else one entry per line item that
 * doesn't: { addon_id, name_en, reason: 'cutoff' | 'capacity',
 * requested_qty, capacity_per_slot, available_qty }  (capacity_per_slot/
 * available_qty are only present for a 'capacity' problem).
 */
export async function checkAddonsFitSlot(db, bookingId, routeId, newDate, newSlot, timezone) {
  const lines = await all(
    db,
    `SELECT ba.addon_id, ba.qty, ba.name_snapshot_en, a.capacity_per_slot, a.cutoff_hours
       FROM booking_addons ba
       JOIN addons a ON a.id = ba.addon_id
      WHERE ba.booking_id = :booking_id`,
    { booking_id: bookingId }
  );
  const problems = [];
  for (const line of lines) {
    const cutoffMinutes = (line.cutoff_hours || 0) * 60;
    if (isSlotPastCutoff(newDate, newSlot, timezone, cutoffMinutes)) {
      problems.push({ addon_id: line.addon_id, name_en: line.name_snapshot_en, reason: 'cutoff', requested_qty: line.qty });
      continue;
    }
    if (line.capacity_per_slot == null) continue; // unlimited
    const usedRow = await first(
      db,
      `SELECT COALESCE(SUM(ba.qty), 0) AS used
         FROM booking_addons ba
         JOIN bookings b ON b.id = ba.booking_id
        WHERE ba.addon_id = :addon_id AND b.id != :booking_id
          AND b.route_id = :route_id AND b.date = :date AND b.slot = :slot
          AND (b.status = 'confirmed' OR b.status = 'confirmed_conflict'
               OR (b.status = 'hold' AND b.hold_expires > datetime('now')))`,
      { addon_id: line.addon_id, booking_id: bookingId, route_id: routeId, date: newDate, slot: newSlot }
    );
    const used = usedRow ? usedRow.used : 0;
    const available = Math.max(0, line.capacity_per_slot - used);
    if (line.qty > available) {
      problems.push({
        reason: 'capacity',
        addon_id: line.addon_id,
        name_en: line.name_snapshot_en,
        requested_qty: line.qty,
        capacity_per_slot: line.capacity_per_slot,
        available_qty: available,
      });
    }
  }
  return problems;
}

/**
 * Analytics → Sales add-on rollup (SPEC.md): per add-on, units sold, guest
 * revenue, bar cost, WOGO margin, and take-rate — the share of CONFIRMED
 * bookings on that add-on's route (same date window, judged by WALK date
 * like every other Analytics query here) that included it at least once.
 * Revenue/cost are GROSS — deliberately not netted against any gift-card
 * amount applied to the booking (migrations/0033's header comment explains
 * why: attributing a gift card's discount between the ticket and an add-on
 * is an unresolved, owner-level allocation question, not something to guess
 * at silently here). A deleted add-on still contributes its historical
 * revenue/cost (name_snapshot_en, via COALESCE) but take_rate reads 0 —
 * there's no live `addons` row left to compute it from.
 */
export async function listAddonSalesAnalytics(db, fromDate, toDate) {
  const sales = await all(
    db,
    `SELECT ba.addon_id,
            COALESCE(a.name_en, ba.name_snapshot_en) AS name_en,
            a.route_id AS route_id,
            SUM(ba.qty) AS units,
            SUM(ba.qty * ba.unit_price_cents) AS revenue_cents,
            SUM(ba.qty * ba.unit_cost_cents) AS cost_cents
       FROM booking_addons ba
       JOIN bookings b ON b.id = ba.booking_id
       LEFT JOIN addons a ON a.id = ba.addon_id
      WHERE b.status IN ('confirmed', 'confirmed_conflict')
        AND b.date >= :from_date AND b.date <= :to_date
      GROUP BY ba.addon_id
      ORDER BY revenue_cents DESC`,
    { from_date: fromDate, to_date: toDate }
  );

  const takeRateRows = await all(
    db,
    `SELECT a.id AS addon_id,
            (SELECT COUNT(*) FROM bookings b2
               WHERE b2.route_id = a.route_id AND b2.status IN ('confirmed', 'confirmed_conflict')
                 AND b2.date >= :from_date AND b2.date <= :to_date) AS route_bookings,
            (SELECT COUNT(DISTINCT ba2.booking_id) FROM booking_addons ba2
               JOIN bookings b3 ON b3.id = ba2.booking_id
              WHERE ba2.addon_id = a.id AND b3.status IN ('confirmed', 'confirmed_conflict')
                AND b3.date >= :from_date AND b3.date <= :to_date) AS addon_bookings
       FROM addons a`,
    { from_date: fromDate, to_date: toDate }
  );
  const takeRateByAddon = new Map(takeRateRows.map((r) => [r.addon_id, r]));

  return sales.map((row) => {
    const tr = takeRateByAddon.get(row.addon_id);
    const routeBookings = tr ? tr.route_bookings : 0;
    const addonBookings = tr ? tr.addon_bookings : 0;
    return {
      addon_id: row.addon_id,
      name_en: row.name_en,
      route_id: row.route_id,
      units: row.units,
      revenue_cents: row.revenue_cents,
      cost_cents: row.cost_cents,
      margin_cents: row.revenue_cents - row.cost_cents,
      take_rate: routeBookings > 0 ? addonBookings / routeBookings : 0,
    };
  });
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

/**
 * Slot list for one date, annotated with a live seats_left from real
 * bookings. Booking cutoff (audit item 1, originally SAME_DAY_CUTOFF_MINUTES;
 * per-route since migrations/0029's routes.booking_cutoff_minutes): a slot
 * whose start is already less than the route's own cutoff away (or has
 * already passed) is reported with seats_left forced to 0 — the same shape
 * the widget already renders as "Sold out" / disabled (widget/wogo-calendar.js:
 * `soldout = s.seats_left <= 0`), so no separate widget change is needed to
 * stop it being offered. isSlotPastCutoff is a real "slot start < now +
 * cutoff" instant comparison (not a same-calendar-day shortcut), so this
 * naturally reaches into TOMORROW's slots too once a route's cutoff exceeds
 * a day (e.g. the 24h Rotterdam Premium cutoff) — no separate "is this
 * today?" branch needed, same as before this migration for the 1h case.
 * `route.booking_cutoff_minutes` is only ever undefined for a hand-built
 * route object in a test fixture predating migrations/0029 — a real DB row
 * is NOT NULL, defaulted 60.
 */
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
  const cutoffMinutes = route.booking_cutoff_minutes ?? SAME_DAY_CUTOFF_MINUTES;
  return slots.map((s) => {
    const rawSeatsLeft = Math.max(0, s.capacity - (usedBySlot[s.slot] || 0));
    const pastCutoff = isSlotPastCutoff(date, s.slot, route.timezone, cutoffMinutes);
    return {
      slot: s.slot,
      capacity: s.capacity,
      seats_left: pastCutoff ? 0 : rawSeatsLeft,
    };
  });
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
    // migrations/0033: addons_count is a cheap correlated-subquery indicator
    // for the bookings LIST view (a small "2 extras" badge) — bounded by
    // the same LIMIT as every other row here, so it's never an unbounded
    // scan. The DETAIL view (handleGetBooking) fetches the full line items
    // separately via db.getAddonsForBooking.
    `SELECT b.*, r.name AS route_name, r.city,
        (SELECT COUNT(*) FROM booking_addons ba WHERE ba.booking_id = b.id) AS addons_count
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
// Gift cards (migrations/0018, 0019) — balance-tracked, D1 is the source of
// truth for balance_cents (Stripe never holds it — see src/stripe.js's doc
// comment on the one-time redemption coupon). Two flows:
//   * PURCHASE (src/guest_api.js:handleGiftCardCheckout ->
//     src/webhook.js's metadata.type==='giftcard' branch) creates the row.
//   * REDEMPTION (src/guest_api.js:handleBook's optional gift_code ->
//     src/webhook.js's booking-confirm path) atomically decrements it.
// ---------------------------------------------------------------------------

/**
 * Creates a gift card with a fresh, unique human-friendly code. Retries a
 * handful of times on a UNIQUE constraint hit (the ~1-in-huge chance two
 * random codes collide) — same "detect the constraint error, don't treat it
 * as fatal" pattern recordWebhookEvent uses below. `params.initial_cents` is
 * also the STARTING balance.
 */
export async function createGiftCard(db, params) {
  const id = `gc_${crypto.randomUUID()}`;
  const bound = {
    id,
    initial_cents: params.initial_cents,
    balance_cents: params.initial_cents,
    currency: params.currency || 'EUR',
    buyer_email: params.buyer_email,
    buyer_name: params.buyer_name,
    recipient_name: params.recipient_name,
    recipient_email: params.recipient_email,
    message: params.message ?? null,
    stripe_session: params.stripe_session ?? null,
    locale: params.locale === 'nl' ? 'nl' : 'en',
  };
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateGiftCardCode();
    try {
      await run(
        db,
        `INSERT INTO gift_cards
           (id, code, initial_cents, balance_cents, currency, buyer_email, buyer_name,
            recipient_name, recipient_email, message, status, stripe_session, locale, created_at)
         VALUES
           (:id, :code, :initial_cents, :balance_cents, :currency, :buyer_email, :buyer_name,
            :recipient_name, :recipient_email, :message, 'active', :stripe_session, :locale, datetime('now'))`,
        { ...bound, code }
      );
      return first(db, `SELECT * FROM gift_cards WHERE id = :id`, { id });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (/unique|constraint/i.test(msg)) continue; // code collision — try another
      throw err;
    }
  }
  throw new Error('gift_card_code_generation_failed');
}

export async function getGiftCardByCode(db, code) {
  return first(db, `SELECT * FROM gift_cards WHERE code = :code`, { code: normalizeGiftCardCode(code) });
}

/** Idempotency lookup for the purchase webhook — a redelivered
 * checkout.session.completed for the same PURCHASE session must not mint a
 * second card (see src/webhook.js's giftcard branch). */
export async function getGiftCardByStripeSession(db, sessionId) {
  return first(db, `SELECT * FROM gift_cards WHERE stripe_session = :session_id`, { session_id: sessionId });
}

export async function listGiftCards(db) {
  return all(db, `SELECT * FROM gift_cards ORDER BY created_at DESC`, {});
}

/** Owner "void" action (admin dashboard) — only an ACTIVE card can be voided;
 * a depleted/already-void card is left alone. */
export async function voidGiftCard(db, code) {
  const result = await run(
    db,
    `UPDATE gift_cards SET status = 'void' WHERE code = :code AND status = 'active'`,
    { code: normalizeGiftCardCode(code) }
  );
  return result.meta.changes === 1;
}

/**
 * Records what a HOLD will redeem against — called right after createHold
 * succeeds (src/guest_api.js:handleBook), mirroring the existing
 * attachStripeSession/setBookingDiscount pattern of "patch the row after
 * the fact" rather than widening CREATE_HOLD_SQL's own INSERT (every test
 * file's hand-built schema stops at a fixed migration list; adding a NOT-YET-
 * migrated column to that INSERT would break every one of them — see
 * migrations/0019's doc comment). `WHERE status = 'hold'` guard matches
 * attachStripeSession exactly.
 */
export async function attachGiftCardToBooking(db, bookingId, giftCode, appliedCents) {
  const result = await run(
    db,
    `UPDATE bookings SET gift_code = :gift_code, gift_applied_cents = :applied WHERE id = :id AND status = 'hold'`,
    { id: bookingId, gift_code: normalizeGiftCardCode(giftCode), applied: appliedCents }
  );
  return result.meta.changes === 1;
}

/**
 * Atomically redeems `applied_cents` off gift card `code` for `booking_id`.
 * ONE guarded UPDATE statement carries all three invariants at once (same
 * "atomic guarded SQL" style as CREATE_HOLD_SQL elsewhere in this file):
 *   * status = 'active'              — a voided/depleted card can't be spent
 *   * balance_cents >= :applied      — the double-spend guard: two bookings
 *     racing to redeem the same nearly-empty card can't both succeed; the
 *     one whose UPDATE lands second sees the already-decremented balance
 *     and its own guard fails.
 *   * NOT EXISTS (a redemption row for this booking_id already) — the
 *     idempotency guard: a Stripe webhook redelivery for an ALREADY-
 *     confirmed booking must not deduct twice. gift_card_redemptions.
 *     booking_id is also UNIQUE (migrations/0019) as a second, structural
 *     backstop if this NOT EXISTS ever raced.
 * Returns one of:
 *   { status: 'redeemed', gift_card }            — balance decremented, audit row written
 *   { status: 'already_redeemed', gift_card }    — this booking was redeemed before (no-op)
 *   { status: 'insufficient_balance', gift_card } — guard failed; booking stays paid+confirmed,
 *                                                     caller alerts the owner to reconcile by hand
 *   { status: 'not_found', gift_card: null }      — code doesn't exist at all (shouldn't happen —
 *                                                     handleBook validates it exists before booking)
 */
export async function redeemGiftCard(db, { code, applied_cents, booking_id }) {
  const normalizedCode = normalizeGiftCardCode(code);
  const result = await run(
    db,
    `UPDATE gift_cards
        SET balance_cents = balance_cents - :applied,
            status = CASE WHEN (balance_cents - :applied) <= 0 THEN 'depleted' ELSE status END
      WHERE code = :code
        AND status = 'active'
        AND balance_cents >= :applied
        AND NOT EXISTS (SELECT 1 FROM gift_card_redemptions WHERE booking_id = :booking_id)`,
    { code: normalizedCode, applied: applied_cents, booking_id }
  );
  if (result.meta.changes === 1) {
    await run(
      db,
      `INSERT INTO gift_card_redemptions (id, gift_card_code, booking_id, amount_cents, created_at)
       VALUES (:id, :code, :booking_id, :applied, datetime('now'))`,
      { id: `gcr_${crypto.randomUUID()}`, code: normalizedCode, booking_id, applied: applied_cents }
    );
    const gift_card = await first(db, `SELECT * FROM gift_cards WHERE code = :code`, { code: normalizedCode });
    return { status: 'redeemed', gift_card };
  }

  // Guard failed — work out WHY, so the caller's owner-alert email (or the
  // idempotent no-op) is specific rather than a bare "didn't work".
  const gift_card = await first(db, `SELECT * FROM gift_cards WHERE code = :code`, { code: normalizedCode });
  if (!gift_card) return { status: 'not_found', gift_card: null };

  const existingRedemption = await first(
    db, `SELECT 1 FROM gift_card_redemptions WHERE booking_id = :booking_id`, { booking_id }
  );
  if (existingRedemption) return { status: 'already_redeemed', gift_card };

  return { status: 'insufficient_balance', gift_card };
}

export async function listGiftCardRedemptions(db, code) {
  return all(
    db,
    `SELECT * FROM gift_card_redemptions WHERE gift_card_code = :code ORDER BY created_at`,
    { code: normalizeGiftCardCode(code) }
  );
}

// ---------------------------------------------------------------------------
// Contact + group-booking inquiries (migrations/0021, audit item 9)
// ---------------------------------------------------------------------------

/** Stores one POST /api/contact submission. `params.id` is generated by the
 * caller (src/guest_api.js, same 'prefix_uuid' convention as bookings/gift
 * cards) so the id is known before the row exists, for logging/testing. */
export async function createInquiry(db, params) {
  const bound = {
    id: params.id,
    kind: params.kind,
    name: params.name,
    email: params.email,
    phone: params.phone ?? null,
    city: params.city ?? null,
    date: params.date ?? null,
    party_size: params.party_size ?? null,
    message: params.message,
    locale: params.locale === 'nl' ? 'nl' : 'en',
    ip_hash: params.ip_hash ?? null,
  };
  await run(
    db,
    `INSERT INTO inquiries
       (id, kind, name, email, phone, city, date, party_size, message, locale, ip_hash, status, created_at)
     VALUES
       (:id, :kind, :name, :email, :phone, :city, :date, :party_size, :message, :locale, :ip_hash, 'new', datetime('now'))`,
    bound
  );
  return first(db, `SELECT * FROM inquiries WHERE id = :id`, { id: params.id });
}

/** GET /admin/api/inquiries — newest first. No filters/pagination yet (low
 * volume expected); add when the admin UI for this lands (see SETUP.md).
 * Tiebreak on `rowid` (monotonic per insert) as well as `created_at`:
 * `created_at` is `datetime('now')`, second-granularity, so two inquiries
 * submitted within the same second would otherwise sort in an UNDEFINED
 * order (SQLite's sort is not stable on ties) instead of true insert order. */
export async function listInquiries(db, limit = 200) {
  return all(db, `SELECT * FROM inquiries ORDER BY created_at DESC, rowid DESC LIMIT :limit`, { limit });
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

/** Earliest event's timestamp inside the same sliding window countRateEventsSince
 * counts — used to compute Retry-After (logic.js:computeRateLimitRetryAfterSeconds)
 * once the window is full. Null when there are no events in the window. */
export async function oldestRateEventSince(db, kind, identity, sinceStr) {
  const row = await first(
    db,
    `SELECT MIN(created_at) AS oldest FROM rate_events
      WHERE kind = :kind AND identity = :identity AND created_at >= :since`,
    { kind, identity, since: sinceStr }
  );
  return row ? row.oldest : null;
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

/** `actor` (migrations/0025) — the admin_users email behind this mutation, or
 * 'token' for the emergency ADMIN_TOKEN login path / any caller that didn't
 * have a resolved session (see src/admin_api.js's `audit()` helper). `null`
 * only for historical rows written before this column existed. */
export async function insertAdminAudit(db, { ip, action, entity_type, entity_id, detail, actor }) {
  await run(
    db,
    `INSERT INTO admin_audit (ip, action, entity_type, entity_id, detail, actor)
     VALUES (:ip, :action, :entity_type, :entity_id, :detail, :actor)`,
    {
      ip: ip ?? null,
      action,
      entity_type: entity_type ?? null,
      entity_id: entity_id == null ? null : String(entity_id),
      detail: detail ?? null,
      actor: actor ?? null,
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
// Newsletter subscribers (migrations/0024, BUILD §17). Orchestration (Brevo
// calls, token generation, the double-opt-in state machine) lives in
// src/subscribers.js; this file is pure storage, same split as everywhere
// else in this codebase.
// ---------------------------------------------------------------------------

export async function getSubscriberByEmail(db, email) {
  // `subscribers.email` is always stored lowercased (UNIQUE index). Lowercase
  // the PARAMETER in JS instead of wrapping the column in LOWER(): the latter
  // defeats the index and full-scans the table on every lookup — during the
  // 8 Oct 2026 Wix import that alone burned 7.4M row-reads and tripped D1's
  // free-tier daily read cap, taking the whole API offline until midnight.
  return first(db, `SELECT * FROM subscribers WHERE email = :email`, { email: String(email || '').toLowerCase() });
}

export async function getSubscriberById(db, id) {
  return first(db, `SELECT * FROM subscribers WHERE id = :id`, { id });
}

export async function getSubscriberByConfirmToken(db, token) {
  return first(db, `SELECT * FROM subscribers WHERE confirm_token = :token`, { token });
}

export async function getSubscriberByUnsubscribeToken(db, token) {
  return first(db, `SELECT * FROM subscribers WHERE unsubscribe_token = :token`, { token });
}

/** Brand-new signup row — always starts 'pending' (double opt-in). Every
 * field + both tokens are supplied by the caller (src/subscribers.js) so this
 * function stays pure storage with no token-generation logic of its own. */
export async function createSubscriber(db, params) {
  await run(
    db,
    `INSERT INTO subscribers
       (id, email, first_name, locale, city, source, status, confirm_token, unsubscribe_token, created_at, ip_hash)
     VALUES
       (:id, :email, :first_name, :locale, :city, :source, 'pending', :confirm_token, :unsubscribe_token, datetime('now'), :ip_hash)`,
    {
      id: params.id,
      email: String(params.email).trim().toLowerCase(),
      first_name: params.first_name ?? null,
      locale: params.locale === 'nl' ? 'nl' : 'en',
      city: params.city ?? null,
      source: params.source,
      confirm_token: params.confirm_token,
      unsubscribe_token: params.unsubscribe_token,
      ip_hash: params.ip_hash ?? null,
    }
  );
  return getSubscriberById(db, params.id);
}

/**
 * Re-arms a NOT-yet-confirmed (or previously unsubscribed) row for a fresh
 * double-opt-in round: a brand new confirm_token, `created_at` reset (so
 * logic.js:isConfirmTokenExpired's clock restarts), status forced back to
 * 'pending', and the freshest locale/city/source the guest just submitted.
 * Used when POST /api/subscribe sees an existing row that is NOT already
 * 'confirmed' (src/guest_api.js's double-opt-in state machine).
 */
export async function reissueSubscriberToken(db, id, { confirm_token, locale, city, source, first_name }) {
  await run(
    db,
    `UPDATE subscribers
        SET status = 'pending', confirm_token = :confirm_token, created_at = datetime('now'),
            confirmed_at = NULL, unsubscribed_at = NULL,
            locale = :locale, city = :city, source = :source,
            first_name = COALESCE(:first_name, first_name)
      WHERE id = :id`,
    {
      id,
      confirm_token,
      locale: locale === 'nl' ? 'nl' : 'en',
      city: city ?? null,
      source,
      first_name: first_name ?? null,
    }
  );
  return getSubscriberById(db, id);
}

/** Flips a 'pending' row to 'confirmed' via its confirm_token (the double
 * opt-in click). Returns the updated row, or null if the token didn't match a
 * still-pending row (already confirmed, unsubscribed, or token never existed
 * — the caller, src/guest_api.js, tells those apart by re-reading the row). */
export async function confirmSubscriberByToken(db, token) {
  const result = await run(
    db,
    `UPDATE subscribers SET status = 'confirmed', confirmed_at = datetime('now')
      WHERE confirm_token = :token AND status = 'pending'`,
    { token }
  );
  if (result.meta.changes !== 1) return null;
  return getSubscriberByConfirmToken(db, token);
}

/**
 * Upserts a subscriber straight to 'confirmed' — the consent act was a
 * booking's own opt-in checkbox or a pre-consented Wix import, so there is no
 * token/email round-trip (BUILD items #3/#5). If a row for this email already
 * exists (any prior status), it's reaffirmed to 'confirmed' and its
 * source/locale/city updated to the latest consent; a brand-new row still
 * gets a real unsubscribe_token (every confirmed subscriber must be able to
 * unsubscribe) but no confirm_token (nothing left to confirm).
 */
export async function upsertConfirmedSubscriber(db, params) {
  const existing = await getSubscriberByEmail(db, params.email);
  if (existing) {
    await run(
      db,
      `UPDATE subscribers
          SET status = 'confirmed', confirmed_at = datetime('now'),
              locale = :locale, city = COALESCE(:city, city), source = :source,
              first_name = COALESCE(:first_name, first_name)
        WHERE id = :id`,
      {
        id: existing.id,
        locale: params.locale === 'nl' ? 'nl' : 'en',
        city: params.city ?? null,
        source: params.source,
        first_name: params.first_name ?? null,
      }
    );
    return getSubscriberById(db, existing.id);
  }
  await run(
    db,
    `INSERT INTO subscribers
       (id, email, first_name, locale, city, source, status, confirm_token, unsubscribe_token, created_at, confirmed_at, ip_hash)
     VALUES
       (:id, :email, :first_name, :locale, :city, :source, 'confirmed', NULL, :unsubscribe_token, datetime('now'), datetime('now'), :ip_hash)`,
    {
      id: params.id,
      email: String(params.email).trim().toLowerCase(),
      first_name: params.first_name ?? null,
      locale: params.locale === 'nl' ? 'nl' : 'en',
      city: params.city ?? null,
      source: params.source,
      unsubscribe_token: params.unsubscribe_token,
      ip_hash: params.ip_hash ?? null,
    }
  );
  return getSubscriberById(db, params.id);
}

/** Marks a row unsubscribed via its (never-rotated) unsubscribe_token.
 * Returns the row (so the caller can remove it from Brevo by email) or null
 * if the token matched nothing, or matched a row already unsubscribed — an
 * already-unsubscribed click is treated as a harmless no-op by the caller,
 * not an error, which is why this returns the row either way when found;
 * callers distinguish via `already_unsubscribed` on the returned shape. */
export async function unsubscribeByToken(db, token) {
  const existing = await getSubscriberByUnsubscribeToken(db, token);
  if (!existing) return null;
  if (existing.status === 'unsubscribed') return { ...existing, already_unsubscribed: true };
  await run(
    db,
    `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = datetime('now') WHERE id = :id`,
    { id: existing.id }
  );
  return getSubscriberById(db, existing.id);
}

export async function listSubscribers(db, filters = {}) {
  const clauses = ['1=1'];
  const bound = {};
  if (filters.status) { clauses.push('status = :status'); bound.status = filters.status; }
  if (filters.source) { clauses.push('source = :source'); bound.source = filters.source; }
  if (filters.locale) { clauses.push('locale = :locale'); bound.locale = filters.locale; }
  if (filters.q) {
    clauses.push(`(email LIKE '%'||:q||'%' OR first_name LIKE '%'||:q||'%')`);
    bound.q = filters.q;
  }
  bound.limit = filters.limit ?? 200;
  bound.offset = filters.offset ?? 0;
  return all(
    db,
    `SELECT * FROM subscribers WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    bound
  );
}

/** Total rows matching the same filters as listSubscribers (minus pagination)
 * — for the admin dashboard's "N of M" pager. */
export async function countSubscribersFiltered(db, filters = {}) {
  const clauses = ['1=1'];
  const bound = {};
  if (filters.status) { clauses.push('status = :status'); bound.status = filters.status; }
  if (filters.source) { clauses.push('source = :source'); bound.source = filters.source; }
  if (filters.locale) { clauses.push('locale = :locale'); bound.locale = filters.locale; }
  if (filters.q) {
    clauses.push(`(email LIKE '%'||:q||'%' OR first_name LIKE '%'||:q||'%')`);
    bound.q = filters.q;
  }
  const row = await first(db, `SELECT COUNT(*) AS n FROM subscribers WHERE ${clauses.join(' AND ')}`, bound);
  return row ? row.n : 0;
}

/** Counts grouped by status / source / locale — the admin dashboard's summary
 * tiles. Three small GROUP BY queries (volume here is at most a few thousand
 * rows — not worth a single clever combined query). */
export async function countSubscribersByStatus(db) {
  return all(db, `SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status`, {});
}
export async function countSubscribersBySource(db) {
  return all(db, `SELECT source, COUNT(*) AS n FROM subscribers GROUP BY source`, {});
}
export async function countSubscribersByLocale(db) {
  return all(db, `SELECT locale, COUNT(*) AS n FROM subscribers GROUP BY locale`, {});
}

// ---------------------------------------------------------------------------
// brevo_sync_queue (migrations/0024, BUILD item #7) — outbound Brevo CONTACT
// API retry queue. Mirrors failed_email's shape exactly (see src/email_retry.js
// for the transactional-email twin of this); drained by src/brevo_sync.js.
// ---------------------------------------------------------------------------

export async function queueBrevoSync(db, { kind, payload, last_error, next_attempt_at }) {
  await run(
    db,
    `INSERT INTO brevo_sync_queue (kind, payload, attempts, status, last_error, next_attempt_at)
     VALUES (:kind, :payload, 1, 'pending', :last_error, :next_attempt_at)`,
    { kind, payload: JSON.stringify(payload || {}), last_error: last_error ?? null, next_attempt_at }
  );
}

export async function listDueBrevoSyncItems(db, nowStr, limit = 50) {
  return all(
    db,
    `SELECT * FROM brevo_sync_queue WHERE status = 'pending' AND next_attempt_at <= :now ORDER BY id LIMIT :limit`,
    { now: nowStr, limit }
  );
}

export async function markBrevoSyncDone(db, id) {
  await run(db, `UPDATE brevo_sync_queue SET status = 'done', updated_at = datetime('now') WHERE id = :id`, { id });
}

export async function markBrevoSyncRetry(db, id, attempts, nextAttemptAt, lastError) {
  await run(
    db,
    `UPDATE brevo_sync_queue
        SET attempts = :attempts, next_attempt_at = :next_attempt_at, last_error = :last_error, updated_at = datetime('now')
      WHERE id = :id`,
    { id, attempts, next_attempt_at: nextAttemptAt, last_error: lastError ?? null }
  );
}

export async function markBrevoSyncPermanent(db, id, lastError) {
  await run(
    db,
    `UPDATE brevo_sync_queue SET status = 'failed_permanent', last_error = :last_error, updated_at = datetime('now') WHERE id = :id`,
    { id, last_error: lastError ?? null }
  );
}

/** Metadata-only listing — the dashboard-readable endpoint, same shape as
 * listRecentFailedEmails above. */
export async function listRecentBrevoSyncItems(db, limit = 100) {
  return all(
    db,
    `SELECT id, created_at, updated_at, kind, attempts, status, last_error, next_attempt_at
       FROM brevo_sync_queue ORDER BY id DESC LIMIT :limit`,
    { limit }
  );
}

/** Housekeeping — called from the cron sweep. Only resolved rows are pruned;
 * still-pending rows are untouched no matter how old. Returns rows deleted. */
export async function pruneResolvedBrevoSyncItems(db, beforeStr) {
  const result = await run(
    db,
    `DELETE FROM brevo_sync_queue WHERE status IN ('done', 'failed_permanent') AND updated_at < :before`,
    { before: beforeStr }
  );
  return result.meta.changes;
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

// ---------------------------------------------------------------------------
// admin_users / admin_login_links (migrations/0025) — personal team logins,
// roles, per-user audit (BUILD §18).
// ---------------------------------------------------------------------------

export async function getAdminUserByEmail(db, email) {
  return first(db, `SELECT * FROM admin_users WHERE email = LOWER(:email)`, { email });
}

export async function getAdminUserById(db, id) {
  return first(db, `SELECT * FROM admin_users WHERE id = :id`, { id });
}

export async function listAdminUsers(db) {
  return all(db, `SELECT * FROM admin_users ORDER BY created_at`, {});
}

export async function createAdminUser(db, { id, email, name, role, status, locale, invited_by }) {
  await run(
    db,
    `INSERT INTO admin_users (id, email, name, role, status, locale, invited_by)
     VALUES (:id, LOWER(:email), :name, :role, :status, :locale, :invited_by)`,
    { id, email, name, role, status: status || 'active', locale: locale ?? null, invited_by: invited_by ?? null }
  );
  return getAdminUserById(db, id);
}

/** Partial update — `patch` may include any of `role`/`status`/`name`/`locale`.
 * Callers (src/admin_api.js) decide WHAT may change and enforce the
 * last-owner guard BEFORE calling this; this function applies whatever it's
 * given unconditionally. */
export async function updateAdminUser(db, id, patch) {
  const sets = [];
  const bound = { id };
  for (const key of ['role', 'status', 'name', 'locale']) {
    if (patch[key] === undefined) continue;
    sets.push(`${key} = :${key}`);
    bound[key] = patch[key];
  }
  if (sets.length > 0) {
    await run(db, `UPDATE admin_users SET ${sets.join(', ')} WHERE id = :id`, bound);
  }
  return getAdminUserById(db, id);
}

export async function touchAdminUserLogin(db, id) {
  await run(db, `UPDATE admin_users SET last_login_at = datetime('now') WHERE id = :id`, { id });
}

/** How many ACTIVE owners exist right now — the last-owner guard
 * (src/admin_api.js:handleUpdateUser) reads this before demoting/disabling
 * an owner, so the dashboard can never lock every owner out of itself. */
export async function countActiveOwners(db) {
  const row = await first(
    db, `SELECT COUNT(*) AS n FROM admin_users WHERE role = 'owner' AND status = 'active'`, {}
  );
  return row ? row.n : 0;
}

export async function createLoginLink(db, { token_hash, user_id, expires_at, ip_hash }) {
  await run(
    db,
    `INSERT INTO admin_login_links (token_hash, user_id, expires_at, ip_hash)
     VALUES (:token_hash, :user_id, :expires_at, :ip_hash)`,
    { token_hash, user_id, expires_at, ip_hash: ip_hash ?? null }
  );
}

/**
 * Atomically redeems a login-link token: single guarded UPDATE carries all
 * three invariants (unused, not expired, token exists) at once — same
 * "atomic guarded SQL" idiom as redeemGiftCard, so a mail client that
 * prefetches the link (or a guest double-clicking it) can't use it twice,
 * and a race between two near-simultaneous clicks can't both succeed.
 * Returns `{ user_id }` on success, `null` on any failure (expired, already
 * used, or no such token) — the caller doesn't need to know which.
 */
export async function consumeLoginLink(db, token_hash) {
  const result = await run(
    db,
    `UPDATE admin_login_links SET used_at = datetime('now')
      WHERE token_hash = :token_hash AND used_at IS NULL AND expires_at > datetime('now')`,
    { token_hash }
  );
  if (result.meta.changes !== 1) return null;
  const row = await first(db, `SELECT user_id FROM admin_login_links WHERE token_hash = :token_hash`, { token_hash });
  return row ? { user_id: row.user_id } : null;
}

// ---------------------------------------------------------------------------
// Analytics (migrations/0025's idx_bookings_created, BUILD §19). Raw/joined
// rows only — the revenue formula, period bucketing, and every "by X"
// breakdown is pure JS in logic.js:buildBookingAnalytics (same split as
// aggregateCustomers above: SQL filters/joins, logic.js folds).
//
// "CONFIRMED" here means status IN ('confirmed','confirmed_conflict') — a
// confirmed_conflict booking is still a real, paid guest (the rare §6.4
// overbooking edge case), so it counts toward revenue/guests. This
// deliberately diverges from participantsPerHour (confirmed-only), which is
// about today's literal seat count, not historical business totals.
// ---------------------------------------------------------------------------

const ANALYTICS_BOOKING_COLUMNS = `
  b.id, b.route_id, r.name AS route_name, r.city, b.date, b.slot, b.party,
  b.created_at, b.source, b.locale, b.payment_status, b.discount_code,
  b.discount_cents, b.gift_applied_cents, r.price_cents,
  b.email, b.name, b.utm_source, b.utm_medium, b.utm_campaign, b.utm_content`;

/** Confirmed bookings whose WALK date (`bookings.date`) falls in [from, to]
 * (both 'YYYY-MM-DD') — the "business happened in this period" lens: every
 * by-route/by-city/by-weekday/by-slot/by-source/by-locale/discount breakdown
 * is built from this set. */
export async function listBookingsForAnalyticsByWalkDate(db, from, to) {
  return all(
    db,
    `SELECT ${ANALYTICS_BOOKING_COLUMNS}
       FROM bookings b JOIN routes r ON r.id = b.route_id
      WHERE b.status IN ('confirmed', 'confirmed_conflict') AND b.date BETWEEN :from AND :to`,
    { from, to }
  );
}

/** Confirmed bookings whose SALE date (`bookings.created_at`) falls in
 * [fromDatetime, toDatetime] (full 'YYYY-MM-DD HH:MM:SS' bounds, built by the
 * caller) — the "sold in this period" lens, used only for the separate
 * sale-date time series (owner requirement: "by booking DATE ... and also by
 * created_at"). */
export async function listBookingsForAnalyticsBySaleDate(db, fromDatetime, toDatetime) {
  return all(
    db,
    `SELECT ${ANALYTICS_BOOKING_COLUMNS}
       FROM bookings b JOIN routes r ON r.id = b.route_id
      WHERE b.status IN ('confirmed', 'confirmed_conflict') AND b.created_at BETWEEN :from AND :to`,
    { from: fromDatetime, to: toDatetime }
  );
}

/** Cancelled bookings whose walk date falls in [from, to] — there is no
 * `cancelled_at` column (cancelBooking just flips status), so "cancellations
 * in this period" is necessarily "walks in this period that ended up
 * cancelled", not "cancelled during this period". Documented in SPEC.md §19. */
export async function countCancelledBookingsByWalkDate(db, from, to) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(party), 0) AS guests
       FROM bookings WHERE status = 'cancelled' AND date BETWEEN :from AND :to`,
    { from, to }
  );
  return row || { n: 0, guests: 0 };
}

/** Top `limit` upcoming (date >= fromDate) days by guest count — the
 * forward-looking operational lens, independent of the analytics from/to
 * range (BOOKING_HORIZON_DAYS already bounds how far out a web booking can
 * exist; a manual booking could in principle be further out, which is
 * correctly still useful information). */
export async function listUpcomingGuestsByDate(db, fromDate, limit = 10) {
  return all(
    db,
    `SELECT date, COALESCE(SUM(party), 0) AS guests, COUNT(*) AS bookings
       FROM bookings
      WHERE status IN ('confirmed', 'confirmed_conflict') AND date >= :from
      GROUP BY date
      ORDER BY guests DESC, date ASC
      LIMIT :limit`,
    { from: fromDate, limit }
  );
}

/** Guests booked per city across [from, to] by walk date — backs the KPI
 * endpoint's "next-14-days booked guests per city". */
export async function listUpcomingGuestsByCity(db, from, to) {
  return all(
    db,
    `SELECT r.city, COALESCE(SUM(b.party), 0) AS guests
       FROM bookings b JOIN routes r ON r.id = b.route_id
      WHERE b.status IN ('confirmed', 'confirmed_conflict') AND b.date BETWEEN :from AND :to
      GROUP BY r.city
      ORDER BY guests DESC`,
    { from, to }
  );
}

/** Gift cards SOLD (created) in [fromDatetime, toDatetime] — count + the
 * total initial value, regardless of what's happened to the balance since
 * (a later void doesn't retroactively un-sell it). */
export async function giftCardSalesSummary(db, fromDatetime, toDatetime) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS sold_count, COALESCE(SUM(initial_cents), 0) AS sold_value_cents
       FROM gift_cards WHERE created_at BETWEEN :from AND :to`,
    { from: fromDatetime, to: toDatetime }
  );
  return row || { sold_count: 0, sold_value_cents: 0 };
}

/** Gift-card value REDEEMED (spent against a booking) in [fromDatetime, toDatetime]. */
export async function giftCardRedemptionsSummary(db, fromDatetime, toDatetime) {
  const row = await first(
    db,
    `SELECT COALESCE(SUM(amount_cents), 0) AS redeemed_value_cents
       FROM gift_card_redemptions WHERE created_at BETWEEN :from AND :to`,
    { from: fromDatetime, to: toDatetime }
  );
  return row ? row.redeemed_value_cents : 0;
}

/** Current outstanding balance across every ACTIVE gift card — a snapshot
 * as of now, deliberately not period-bound (it's "what's still owed", not
 * "what happened in this period"). */
export async function giftCardOutstandingBalance(db) {
  const row = await first(db, `SELECT COALESCE(SUM(balance_cents), 0) AS outstanding_cents FROM gift_cards WHERE status = 'active'`, {});
  return row ? row.outstanding_cents : 0;
}

/** Inquiries (migrations/0021) SUBMITTED in [fromDatetime, toDatetime], by kind. */
export async function countInquiriesByKind(db, fromDatetime, toDatetime) {
  return all(
    db,
    `SELECT kind, COUNT(*) AS n FROM inquiries WHERE created_at BETWEEN :from AND :to GROUP BY kind`,
    { from: fromDatetime, to: toDatetime }
  );
}

/** New CONFIRMED subscribers (the double-opt-in click, a booking opt-in, or
 * an import landing as already-confirmed) in [fromDatetime, toDatetime]. */
export async function countNewConfirmedSubscribers(db, fromDatetime, toDatetime) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS n FROM subscribers WHERE status = 'confirmed' AND confirmed_at BETWEEN :from AND :to`,
    { from: fromDatetime, to: toDatetime }
  );
  return row ? row.n : 0;
}

/** Day-by-day new-CONFIRMED-subscriber counts in [fromDatetime, toDatetime]
 * — the Marketing tab's "subscribers growth" chart (BUILD §19.4). Grouped by
 * the first 10 characters of confirmed_at (the date part) — zero-filling any
 * day with no confirmations is the CALLER's job (logic.js has no notion of
 * "subscriber growth" today; admin_api.js zero-fills the same way
 * buildHighlightsSales does for bookings). */
export async function subscribersGrowthByDay(db, fromDatetime, toDatetime) {
  return all(
    db,
    `SELECT substr(confirmed_at, 1, 10) AS date, COUNT(*) AS n
       FROM subscribers
      WHERE status = 'confirmed' AND confirmed_at BETWEEN :from AND :to
      GROUP BY date`,
    { from: fromDatetime, to: toDatetime }
  );
}

// ---------------------------------------------------------------------------
// Review requests (migrations/0026_review_requests.sql, BUILD §20).
// ---------------------------------------------------------------------------

/** Confirmed web/manual bookings for `dateStr` ('YYYY-MM-DD', the walk date)
 * that haven't had a review request sent yet — the daily cron's candidate
 * set (src/reviews.js). Joined with routes for the email's route name/city/
 * poster. `confirmed_conflict` is deliberately excluded (unlike the
 * analytics "confirmed" set) — a review ask doesn't belong on the rare
 * overbooking edge case the same way revenue reporting does. */
export async function listBookingsNeedingReviewRequest(db, dateStr) {
  return all(
    db,
    `SELECT b.*, r.name AS route_name, r.city, r.id AS route_id
       FROM bookings b JOIN routes r ON r.id = b.route_id
      WHERE b.status = 'confirmed' AND b.date = :date AND b.review_sent_at IS NULL
        AND b.source IN ('web', 'manual')`,
    { date: dateStr }
  );
}

/**
 * Atomically claims ONE booking's review-request slot — marks
 * review_sent_at BEFORE the email is actually sent, same "mark atomically
 * first" idiom as redeemGiftCard/consumeLoginLink, so a cron overlap or the
 * manual POST .../send-review trigger racing the cron can never double-send.
 * Returns true if THIS call won the claim (still 'confirmed', not yet
 * sent); false if another caller already claimed it, or the booking isn't
 * in a sendable state anymore (cancelled/rescheduled away/etc.).
 */
export async function markReviewRequestSent(db, id) {
  const result = await run(
    db,
    `UPDATE bookings SET review_sent_at = datetime('now')
      WHERE id = :id AND status = 'confirmed' AND review_sent_at IS NULL`,
    { id }
  );
  return result.meta.changes === 1;
}

// ---------------------------------------------------------------------------
// Blog (migrations/0030_blog_posts.sql, BUILD §21) — admin-authored posts,
// published to the static site via the GitHub Contents API (src/github.js).
// D1 is the editable source of truth; the committed HTML files are a BUILD
// OUTPUT of a D1 row, regenerated in full on every publish/unpublish — never
// hand-edited, never read back into D1.
// ---------------------------------------------------------------------------

const BLOG_POST_COLUMNS = [
  'id', 'slug', 'status', 'category', 'cover_image_path', 'cover_alt_en', 'cover_alt_nl',
  'title_en', 'title_nl', 'excerpt_en', 'excerpt_nl', 'body_en', 'body_nl',
  'seo_title_en', 'seo_title_nl', 'seo_description_en', 'seo_description_nl',
  'read_minutes', 'published_at', 'created_at', 'updated_at', 'created_by', 'updated_by',
  'old_wix_slug', 'last_published_commit',
];

/**
 * Creates a new blog post row. Every nullable column is bound explicitly as
 * `null` when absent — toPositional() throws on `undefined`, and this
 * table's ~20 mostly-optional columns make "just spread the input object"
 * unsafe (see this file's header comment on toPositional's safety rules).
 * `status`/`published_at`/`last_published_commit` default to the normal
 * draft-creation shape; the one-off import script (BUILD §21.5) is the only
 * caller that ever passes `status:'published'` + the other two pre-filled,
 * seeding a post that was already live before this table existed.
 */
export async function createBlogPost(db, post) {
  const bound = {
    id: post.id,
    slug: post.slug,
    status: post.status === 'published' ? 'published' : 'draft',
    category: post.category,
    cover_image_path: post.cover_image_path ?? null,
    cover_alt_en: post.cover_alt_en ?? null,
    cover_alt_nl: post.cover_alt_nl ?? null,
    title_en: post.title_en,
    title_nl: post.title_nl ?? null,
    excerpt_en: post.excerpt_en ?? null,
    excerpt_nl: post.excerpt_nl ?? null,
    body_en: post.body_en ?? null,
    body_nl: post.body_nl ?? null,
    seo_title_en: post.seo_title_en ?? null,
    seo_title_nl: post.seo_title_nl ?? null,
    seo_description_en: post.seo_description_en ?? null,
    seo_description_nl: post.seo_description_nl ?? null,
    read_minutes: post.read_minutes ?? 5,
    published_at: post.published_at ?? null,
    created_by: post.created_by ?? null,
    updated_by: post.created_by ?? null,
    old_wix_slug: post.old_wix_slug ?? null,
    last_published_commit: post.last_published_commit ?? null,
  };
  await run(
    db,
    `INSERT INTO blog_posts
       (id, slug, status, category, cover_image_path, cover_alt_en, cover_alt_nl,
        title_en, title_nl, excerpt_en, excerpt_nl, body_en, body_nl,
        seo_title_en, seo_title_nl, seo_description_en, seo_description_nl,
        read_minutes, published_at, created_at, updated_at, created_by, updated_by,
        old_wix_slug, last_published_commit)
     VALUES
       (:id, :slug, :status, :category, :cover_image_path, :cover_alt_en, :cover_alt_nl,
        :title_en, :title_nl, :excerpt_en, :excerpt_nl, :body_en, :body_nl,
        :seo_title_en, :seo_title_nl, :seo_description_en, :seo_description_nl,
        :read_minutes, :published_at, datetime('now'), datetime('now'), :created_by, :updated_by,
        :old_wix_slug, :last_published_commit)`,
    bound
  );
  return getBlogPost(db, post.id);
}

export async function getBlogPost(db, id) {
  return first(db, `SELECT * FROM blog_posts WHERE id = :id`, { id });
}

export async function getBlogPostBySlug(db, slug) {
  return first(db, `SELECT * FROM blog_posts WHERE slug = :slug`, { slug });
}

export async function listBlogPosts(db, filters = {}) {
  const clauses = ['1=1'];
  const bound = {};
  if (filters.status) { clauses.push('status = :status'); bound.status = filters.status; }
  return all(
    db,
    `SELECT * FROM blog_posts WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`,
    bound
  );
}

/** `{draft, published}` counts for the list view's status chips. Two tiny
 * aggregate reads rather than one GROUP BY — this table is small (a blog,
 * not bookings) and it keeps the result shape trivial to consume. */
export async function countBlogPostsByStatus(db) {
  const draft = await first(db, `SELECT COUNT(*) AS n FROM blog_posts WHERE status = 'draft'`, {});
  const published = await first(db, `SELECT COUNT(*) AS n FROM blog_posts WHERE status = 'published'`, {});
  return { draft: draft.n, published: published.n };
}

const BLOG_POST_EDITABLE_COLUMNS = BLOG_POST_COLUMNS.filter(
  (c) => !['id', 'created_at', 'created_by'].includes(c)
);

/**
 * Patches only the columns present in `patch` (same dynamic-SET idiom as
 * updateRoute above) and always bumps `updated_at`. Callers (admin_api.js)
 * are responsible for setting `updated_by` themselves and for NEVER
 * including `slug` once a post has ever been published (enforced at the
 * handler layer, not here, so this stays a plain data-access function).
 */
export async function updateBlogPost(db, id, patch) {
  const cols = Object.keys(patch).filter((k) => BLOG_POST_EDITABLE_COLUMNS.includes(k));
  const bound = { id };
  const sets = ['updated_at = datetime(\'now\')'];
  for (const c of cols) {
    sets.push(`${c} = :${c}`);
    bound[c] = patch[c];
  }
  if (cols.length === 0 && sets.length === 1) return getBlogPost(db, id); // nothing to do at all
  await run(db, `UPDATE blog_posts SET ${sets.join(', ')} WHERE id = :id`, bound);
  return getBlogPost(db, id);
}

export async function deleteBlogPost(db, id) {
  const result = await run(db, `DELETE FROM blog_posts WHERE id = :id`, { id });
  return result.meta.changes === 1;
}

export async function insertBlogAsset(db, asset) {
  await run(
    db,
    `INSERT INTO blog_assets (id, post_id, path, bytes, created_at)
     VALUES (:id, :post_id, :path, :bytes, datetime('now'))`,
    { id: asset.id, post_id: asset.post_id, path: asset.path, bytes: asset.bytes }
  );
  return first(db, `SELECT * FROM blog_assets WHERE id = :id`, { id: asset.id });
}

export async function listBlogAssets(db, postId) {
  return all(db, `SELECT * FROM blog_assets WHERE post_id = :post_id ORDER BY created_at`, { post_id: postId });
}

/** Deletes every blog_assets row for a post — blog_assets.post_id is a REAL
 * foreign key against blog_posts(id) (migrations/0030), and real D1
 * enforces it (unlike this repo's test sqlite adapter, which runs with
 * `PRAGMA foreign_keys = OFF`) — admin_api.js:handleDeleteBlogPost calls
 * this BEFORE deleteBlogPost, or the post delete itself fails with a
 * foreign-key-constraint error on any post that ever had an image uploaded. */
export async function deleteBlogAssetsForPost(db, postId) {
  await run(db, `DELETE FROM blog_assets WHERE post_id = :post_id`, { post_id: postId });
}

// ---------------------------------------------------------------------------
// Abandoned-booking reminders (migrations/0031, src/abandoned.js) — a
// 'hold'/'expired' booking with a real email that never became confirmed.
// Two sends per GUEST (not per row — see the sibling-stamp functions below),
// both atomically claimed before the email actually goes out, same
// "mark-then-send" idiom as redeemGiftCard/markReviewRequestSent elsewhere
// in this file.
// ---------------------------------------------------------------------------

/**
 * First-email candidates: a 'hold'/'expired' WEB booking (never a manual
 * phone booking — that's not an abandoned online checkout) with a real
 * email, old enough to be genuinely abandoned (>= ABANDONED_FIRST_EMAIL_MIN_MINUTES)
 * but not so old it's stale (<= ABANDONED_WINDOW_MAX_MINUTES — a safety cap
 * so a cron outage lasting days doesn't fire a pile of nudges once it
 * recovers), never sent one yet. Ordered NEWEST first so the caller's
 * dedupe-by-email (several hold rows from the same retrying guest) keeps the
 * most relevant one.
 */
export async function listAbandonedFirstCandidates(db) {
  return all(
    db,
    `SELECT * FROM bookings
       WHERE status IN ('hold','expired')
         AND source = 'web'
         AND email IS NOT NULL AND TRIM(email) != ''
         AND abandoned_sent_at IS NULL
         AND created_at <= :min_age
         AND created_at >= :max_age
       ORDER BY created_at DESC`,
    { min_age: sqliteMinutesAgo(ABANDONED_FIRST_EMAIL_MIN_MINUTES), max_age: sqliteMinutesAgo(ABANDONED_WINDOW_MAX_MINUTES) }
  );
}

/** Follow-up candidates: same shape, but already got the first email and
 * hasn't booked since, old enough for the ~24h follow-up. */
export async function listAbandonedFollowupCandidates(db) {
  return all(
    db,
    `SELECT * FROM bookings
       WHERE status IN ('hold','expired')
         AND source = 'web'
         AND email IS NOT NULL AND TRIM(email) != ''
         AND abandoned_sent_at IS NOT NULL
         AND abandoned_followup_sent_at IS NULL
         AND created_at <= :min_age
         AND created_at >= :max_age
       ORDER BY created_at DESC`,
    { min_age: sqliteMinutesAgo(ABANDONED_FOLLOWUP_MIN_MINUTES), max_age: sqliteMinutesAgo(ABANDONED_WINDOW_MAX_MINUTES) }
  );
}

/**
 * True if this email should NOT be nagged: either they already have a
 * CONFIRMED (or confirmed-but-double-booked, confirmed_conflict — they paid,
 * they're not a prospect anymore) booking for this exact route+date+slot, OR
 * they have any confirmed booking at all created AFTER this abandoned
 * attempt (they went on to book something else — don't nag someone who
 * already came back). `createdAt` must be the row's own `created_at`
 * (SQLite datetime text), so the string comparison sorts correctly.
 */
export async function hasBlockingConfirmedBooking(db, email, routeId, date, slot, createdAt) {
  const row = await first(
    db,
    `SELECT 1 FROM bookings
       WHERE LOWER(email) = LOWER(:email)
         AND status IN ('confirmed','confirmed_conflict')
         AND ((route_id = :route_id AND date = :date AND slot = :slot) OR created_at > :created_at)
       LIMIT 1`,
    { email, route_id: routeId, date, slot, created_at: createdAt }
  );
  return !!row;
}

/** Atomic claim for the 1h "still free" email — changes===1 means THIS call
 * won the claim. */
export async function claimAbandonedFirstSent(db, id) {
  const result = await run(
    db,
    `UPDATE bookings SET abandoned_sent_at = datetime('now')
       WHERE id = :id AND abandoned_sent_at IS NULL AND status IN ('hold','expired')`,
    { id }
  );
  return result.meta.changes === 1;
}

/** Atomic claim for the ~24h follow-up. */
export async function claimAbandonedFollowupSent(db, id) {
  const result = await run(
    db,
    `UPDATE bookings SET abandoned_followup_sent_at = datetime('now')
       WHERE id = :id AND abandoned_followup_sent_at IS NULL AND abandoned_sent_at IS NOT NULL
         AND status IN ('hold','expired')`,
    { id }
  );
  return result.meta.changes === 1;
}

/**
 * One GUEST can have several 'hold'/'expired' rows (retried checkout a few
 * times) — ONE email per guest, not one per row. After winning the claim on
 * the row we actually email, best-effort-stamp every OTHER unsent hold/
 * expired row for the same email as "sent" too, so a later sweep tick never
 * independently re-discovers a sibling row and sends a second mail. Not
 * itself atomic (a lost race here just means a future tick stamps the
 * remainder) — that's fine, this is suppression, not a side effect the guest
 * would ever notice either way.
 */
export async function stampAbandonedFirstSentForSiblings(db, email, excludeId) {
  await run(
    db,
    `UPDATE bookings SET abandoned_sent_at = datetime('now')
       WHERE LOWER(email) = LOWER(:email) AND id != :exclude_id
         AND status IN ('hold','expired') AND abandoned_sent_at IS NULL`,
    { email, exclude_id: excludeId }
  );
}

/** Same sibling-suppression, for the follow-up stage. */
export async function stampAbandonedFollowupSentForSiblings(db, email, excludeId) {
  await run(
    db,
    `UPDATE bookings SET abandoned_followup_sent_at = datetime('now')
       WHERE LOWER(email) = LOWER(:email) AND id != :exclude_id
         AND status IN ('hold','expired') AND abandoned_sent_at IS NOT NULL
         AND abandoned_followup_sent_at IS NULL`,
    { email, exclude_id: excludeId }
  );
}

// ---------------------------------------------------------------------------
// Walk reminder, 2 days before (migrations/0031, src/reminders.js) — mirrors
// listBookingsNeedingReviewRequest's shape exactly, just a different status/
// date/column triple.
// ---------------------------------------------------------------------------

export async function listBookingsNeedingWalkReminder(db, dateStr) {
  return all(
    db,
    `SELECT b.*, r.name AS route_name, r.city, r.id AS route_id, r.timezone,
            r.map_url, r.map_url_nl, r.map_url_by_weekday, r.currency, r.price_cents
       FROM bookings b JOIN routes r ON r.id = b.route_id
      WHERE b.status = 'confirmed' AND b.date = :date AND b.reminder_sent_at IS NULL
        AND b.source IN ('web', 'manual')`,
    { date: dateStr }
  );
}

/** Atomic claim, same idiom as markReviewRequestSent. */
export async function claimReminderSent(db, id) {
  const result = await run(
    db,
    `UPDATE bookings SET reminder_sent_at = datetime('now')
       WHERE id = :id AND status = 'confirmed' AND reminder_sent_at IS NULL`,
    { id }
  );
  return result.meta.changes === 1;
}

// REMOVED 2026-10-14 — `claimReviewThanked` and `getNewestActiveRouteExcluding`
// existed ONLY for the post-review thank-you mail, which is gone (see
// src/admin_api.js's note where the endpoint used to be). `bookings
// .review_thanked_at` is deliberately left in the schema but is now never
// read or written. Nothing else ever called either helper.

// ---------------------------------------------------------------------------
// Reminder opt-out (migrations/0031) — shared by the abandoned-booking mails
// and the walk reminder ONLY. See migrations/0031's own comment for why this
// is a separate table from `subscribers` (marketing consent).
// ---------------------------------------------------------------------------

export async function isReminderOptedOut(db, email) {
  const row = await first(db, `SELECT 1 FROM reminder_optouts WHERE email_lower = LOWER(:email)`, { email });
  return !!row;
}

export async function recordReminderOptOut(db, email) {
  await run(db, `INSERT OR IGNORE INTO reminder_optouts (email_lower, created_at) VALUES (LOWER(:email), datetime('now'))`, { email });
}

// ---------------------------------------------------------------------------
// Push subscriptions + in-dashboard notifications (migrations/0032, the PWA
// + Web Push build). See that migration's doc comment for the full schema
// rationale. Per-user KIND PREFERENCES are NOT a new table — five booleans
// don't need one — they live in the existing `settings` k/v table under
// `push_prefs:<user_id>`; src/notifications.js owns the read/write/default-
// merge logic around getSetting/setSetting above.
// ---------------------------------------------------------------------------

/**
 * Registers (or re-registers) a browser's push subscription. `endpoint` is
 * UNIQUE, so re-subscribing the SAME device (a token refresh, or re-enabling
 * after a previous deny) updates this row in place rather than piling up a
 * duplicate — also resets failure_count/last_error, since a device that just
 * successfully subscribed again deserves a clean slate, not a carried-over
 * failure streak from before.
 */
export async function upsertPushSubscription(db, { id, user_id, endpoint, p256dh, auth, user_agent }) {
  await run(
    db,
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
     VALUES (:id, :user_id, :endpoint, :p256dh, :auth, :user_agent)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = :user_id, p256dh = :p256dh, auth = :auth, user_agent = :user_agent,
       failure_count = 0, last_error = NULL`,
    { id, user_id, endpoint, p256dh, auth, user_agent: user_agent ?? null }
  );
  return first(db, `SELECT * FROM push_subscriptions WHERE endpoint = :endpoint`, { endpoint });
}

/** Scoped to the owning user — a device can only ever unsubscribe itself
 * (or, from the Settings device list, one of this SAME user's other
 * devices), never another person's. Returns `true` if a row was actually
 * deleted. Keyed by `id` (not `endpoint`) because the Settings device list
 * deliberately never gets the raw endpoint back from the server — see
 * admin_api.js:handleListPushSubscriptions's doc comment. */
export async function deletePushSubscriptionForUserById(db, userId, id) {
  const result = await run(
    db,
    `DELETE FROM push_subscriptions WHERE id = :id AND user_id = :user_id`,
    { id, user_id: userId }
  );
  return result.meta.changes > 0;
}

/** Unscoped delete-by-endpoint — used when a push SERVICE itself (not the
 * user) reports the subscription is gone (404/410), see
 * src/notifications.js:fanOutPush. */
export async function deletePushSubscriptionByEndpoint(db, endpoint) {
  const result = await run(db, `DELETE FROM push_subscriptions WHERE endpoint = :endpoint`, { endpoint });
  return result.meta.changes > 0;
}

export async function listPushSubscriptionsForUser(db, userId) {
  return all(db, `SELECT * FROM push_subscriptions WHERE user_id = :user_id ORDER BY created_at DESC`, { user_id: userId });
}

/** Every active subscription, any user — the fan-out target for a broadcast
 * notification (kind-preference filtering happens in src/notifications.js,
 * not here; this is a plain, unfiltered read). */
export async function listAllPushSubscriptions(db) {
  return all(db, `SELECT * FROM push_subscriptions`, {});
}

export async function markPushSubscriptionSuccess(db, endpoint) {
  await run(
    db,
    `UPDATE push_subscriptions SET last_success_at = datetime('now'), failure_count = 0, last_error = NULL WHERE endpoint = :endpoint`,
    { endpoint }
  );
}

/** A non-gone failure (anything but 404/410, or a network error) — recorded
 * for visibility in the Settings device list, but NEVER auto-deletes the
 * subscription on its own (see migrations/0032's doc comment on why). */
export async function markPushSubscriptionFailure(db, endpoint, error) {
  await run(
    db,
    `UPDATE push_subscriptions SET failure_count = failure_count + 1, last_error = :error WHERE endpoint = :endpoint`,
    { endpoint, error }
  );
}

export async function createNotification(db, { id, kind, title, body, url, booking_id, user_id }) {
  await run(
    db,
    `INSERT INTO notifications (id, kind, title, body, url, booking_id, user_id)
     VALUES (:id, :kind, :title, :body, :url, :booking_id, :user_id)`,
    {
      id, kind, title, body,
      url: url ?? null,
      booking_id: booking_id ?? null,
      user_id: user_id ?? null,
    }
  );
  return first(db, `SELECT * FROM notifications WHERE id = :id`, { id });
}

export async function getNotificationById(db, id) {
  return first(db, `SELECT * FROM notifications WHERE id = :id`, { id });
}

/**
 * Notifications VISIBLE to `userId` — every broadcast row (`user_id IS
 * NULL`) plus any row targeted specifically at this user (the Settings
 * "test notification" button). `userId` may be `null` itself (the emergency
 * ADMIN_TOKEN session has no admin_users row) — that still correctly shows
 * every broadcast row, just no user-targeted ones (there's no user to
 * target). `read_at` is a single shared column (migrations/0032's doc
 * comment) — this is NOT a per-viewer unread count.
 */
export async function listNotifications(db, { userId = null, unreadOnly = false, limit = 50 } = {}) {
  const unreadClause = unreadOnly ? 'read_at IS NULL AND' : '';
  return all(
    db,
    `SELECT * FROM notifications
      WHERE ${unreadClause} (user_id IS NULL OR user_id = :user_id)
      ORDER BY created_at DESC, id DESC
      LIMIT :limit`,
    { user_id: userId, limit }
  );
}

export async function countUnreadNotifications(db, userId = null) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND (user_id IS NULL OR user_id = :user_id)`,
    { user_id: userId }
  );
  return row ? row.n : 0;
}

/** Idempotent — marking an already-read (or nonexistent) notification read
 * is a no-op, `false`. */
export async function markNotificationRead(db, id) {
  const result = await run(
    db,
    `UPDATE notifications SET read_at = datetime('now') WHERE id = :id AND read_at IS NULL`,
    { id }
  );
  return result.meta.changes === 1;
}

/** Housekeeping — called from the daily cron (src/notifications.js's
 * pruneOldNotifications wraps the two-tier retention rule). Returns rows
 * deleted. */
export async function pruneNotifications(db, { readBeforeStr, anyBeforeStr }) {
  const read = await run(db, `DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < :before`, { before: readBeforeStr });
  const any = await run(db, `DELETE FROM notifications WHERE created_at < :before`, { before: anyBeforeStr });
  return (read.meta.changes || 0) + (any.meta.changes || 0);
}

export { nowSqlite };
