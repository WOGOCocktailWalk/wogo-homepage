// src/logic.js
//
// PURE functions only — no `env`, no `fetch`, no D1, no Worker globals.
// This file is imported unmodified by both the Node test suite (`node --test`)
// and the Cloudflare Worker at runtime, so it must never reach for a platform API.
//
// IMPORTANT date/time-format note (read before touching hold_expires anywhere):
// SQLite's `datetime('now')` (used throughout db.js's SQL) returns strings shaped
// like '2026-07-22 15:04:05' — a SPACE between date and time, no fractional
// seconds, no trailing 'Z'. If hold_expires were instead stored using
// `Date.prototype.toISOString()` (which produces '2026-07-22T15:04:05.000Z' —
// a 'T' separator and a 'Z' suffix), plain SQL string comparison
// (`hold_expires > datetime('now')`) would silently misbehave: for two
// same-calendar-day timestamps, the character at index 10 ('T' vs ' ') decides
// the comparison before the actual hour/minute/second is ever looked at, and
// 'T' (0x54) always sorts after ' ' (0x20) — so an ISO-formatted hold_expires
// would compare as "in the future" forever on the same day, and expired holds
// would never be swept. To keep the atomic SQL guard (SPEC.md §6.2/§6.5)
// correct, every hold_expires value written or compared MUST use this file's
// `toSqliteDatetime` formatter — matching SQLite's own format exactly so
// lexicographic string ordering equals chronological ordering.

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Format a JS Date as SQLite's `datetime('now')` shape: 'YYYY-MM-DD HH:MM:SS' (UTC). */
export function toSqliteDatetime(date) {
  const iso = date.toISOString(); // '2026-07-22T15:04:05.123Z'
  return iso.slice(0, 19).replace('T', ' ');
}

/** hold_expires for a freshly created hold, `minutes` from `nowDate` (default: now). */
export function computeHoldExpiry(minutes, nowDate = new Date()) {
  return toSqliteDatetime(new Date(nowDate.getTime() + minutes * MS_PER_MINUTE));
}

/** Current time in the same comparable format used for hold_expires / datetime('now'). */
export function nowSqlite(nowDate = new Date()) {
  return toSqliteDatetime(nowDate);
}

/** SQLite-comparable datetime string for `minutes` ago — used as the start of
 * sliding rate-limit windows and retention cutoffs (SPEC.md §15). */
export function sqliteMinutesAgo(minutes, nowDate = new Date()) {
  return toSqliteDatetime(new Date(nowDate.getTime() - minutes * MS_PER_MINUTE));
}

/** SQLite-comparable datetime string `minutes` from now — used for retry
 * backoff schedules (src/email_retry.js). The forward-time twin of
 * sqliteMinutesAgo above. */
export function sqliteMinutesFromNow(minutes, nowDate = new Date()) {
  return toSqliteDatetime(new Date(nowDate.getTime() + minutes * MS_PER_MINUTE));
}

/** SQLite-comparable datetime string `months` ago, using real calendar-month
 * arithmetic (not a 30-day approximation) — used for the GDPR retention cutoff
 * (src/retention.js), where a multi-month window makes the ~3% drift from a
 * flat 30-day approximation worth avoiding. */
export function sqliteMonthsAgo(months, nowDate = new Date()) {
  const d = new Date(nowDate.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return toSqliteDatetime(d);
}

/** Parse a 'YYYY-MM-DD HH:MM:SS' (UTC, SQLite-shaped) string to epoch ms. */
export function parseSqliteDatetime(str) {
  return Date.parse(String(str).replace(' ', 'T') + 'Z');
}

/** Minutes elapsed from `fromStr` to `toStr` (both SQLite-shaped strings) —
 * negative if `fromStr` is after `toStr`. Used by the throttled-alert helper
 * (src/alerts.js) to compare a stored "last sent" timestamp against now. */
export function sqliteMinutesBetween(fromStr, toStr) {
  return (parseSqliteDatetime(toStr) - parseSqliteDatetime(fromStr)) / MS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// 15.x Security primitives (SPEC.md §15) — pure, Node-testable
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison. Unlike a naive `===`, comparison time does
 * not depend on WHERE the strings first differ, and there is no early return
 * on a length mismatch (the loop always runs over the longer length; the
 * length difference is folded into the accumulator instead). Used for the
 * admin token check, session-cookie signature check, and cron-secret check.
 * Note charCodeAt() past the end returns NaN, and (NaN | 0) === 0 — so
 * out-of-range reads contribute nothing but still take a loop iteration.
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * Admin-login lockout math (SPEC.md §15.2). Given the SQLite-shaped
 * timestamps of this IP's failed attempts SINCE ITS LAST SUCCESSFUL LOGIN
 * (db.js:listRecentLoginFailures already filters to that), decide whether the
 * IP is currently locked out and for how much longer.
 *
 * Escalation: under `threshold` fails → never locked. At `threshold` fails
 * the lock is `baseMinutes` from the most recent failure; each further
 * failure doubles it, capped at `maxMinutes`. Attempts made WHILE locked are
 * rejected before the token is ever checked and are not recorded — so the
 * schedule can't be inflated by hammering, but every post-lockout failure
 * still escalates (15 → 30 → 60 → ... → cap).
 *
 * @param failTimestamps  'YYYY-MM-DD HH:MM:SS' strings, any order
 * @param nowStr          same format (logic.js:nowSqlite())
 * @returns { locked, retryAfterSeconds, fails }
 */
export function computeLoginLockout(failTimestamps, nowStr, opts = {}) {
  const threshold = opts.threshold ?? 5;
  const baseMinutes = opts.baseMinutes ?? 15;
  const maxMinutes = opts.maxMinutes ?? 240;

  const fails = (failTimestamps || []).slice().sort(); // lexicographic == chronological for this format
  if (fails.length < threshold) {
    return { locked: false, retryAfterSeconds: 0, fails: fails.length };
  }

  const lockMinutes = Math.min(baseMinutes * Math.pow(2, fails.length - threshold), maxMinutes);
  const lastFailMs = parseSqliteDatetime(fails[fails.length - 1]);
  const remainingMs = lastFailMs + lockMinutes * MS_PER_MINUTE - parseSqliteDatetime(nowStr);
  if (!(remainingMs > 0)) {
    return { locked: false, retryAfterSeconds: 0, fails: fails.length };
  }
  return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000), fails: fails.length };
}

/**
 * True only for a syntactically valid AND calendar-real 'YYYY-MM-DD' date —
 * '2026-02-30' and '2026-13-01' pass a bare regex but fail the round-trip.
 */
export function isValidDateStr(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

/**
 * Validates + normalizes the optional guest "Allergies / notes" free-text
 * field (migrations/0010). Shared by the guest widget's POST /api/book
 * (src/guest_api.js) and the admin manual-booking endpoint (src/admin_api.js)
 * so the two entry points can never drift apart.
 *
 * Returns { ok: true, notes } — where `notes` is the trimmed string, or null
 * when the guest left it blank — or { ok: false, message } on rejection.
 *
 * Rules: optional (undefined/null/'' ⇒ null); must be a string; trimmed;
 * max MAX_NOTES_LENGTH chars AFTER trimming; control characters rejected
 * outright (tab/newline/CR are allowed — it's a textarea — everything else
 * in C0/C1/DEL is not). The value is STILL untrusted after this: every
 * renderer (src/emails.js, the admin dashboard) must HTML-escape it.
 */
export const MAX_NOTES_LENGTH = 500;

// C0 controls except \t \n \r, plus DEL and the C1 range.
const NOTES_FORBIDDEN_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function validateNotes(value) {
  if (value === undefined || value === null || value === '') return { ok: true, notes: null };
  if (typeof value !== 'string') return { ok: false, message: 'notes must be a string' };
  if (NOTES_FORBIDDEN_RE.test(value)) return { ok: false, message: 'notes contains unsupported characters' };
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTES_LENGTH) {
    return { ok: false, message: `notes must be at most ${MAX_NOTES_LENGTH} characters` };
  }
  return { ok: true, notes: trimmed === '' ? null : trimmed };
}

// ---------------------------------------------------------------------------
// 9.7 isHoldExpired
// ---------------------------------------------------------------------------

/**
 * Pure predicate mirroring the SQL guard's semantics exactly: a hold counts as
 * expired once hold_expires <= now (inclusive boundary — a hold expiring at
 * exactly `now` is treated as expired, matching `expireHolds`'s `<=` in §6.5).
 * Both arguments must be strings in the same sortable format (see note above);
 * `toSqliteDatetime`/`nowSqlite` produce that format.
 */
export function isHoldExpired(hold, nowIso) {
  return hold.hold_expires !== null && hold.hold_expires !== undefined && hold.hold_expires <= nowIso;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** ISO weekday of a 'YYYY-MM-DD' string: Mon=1 .. Sun=7 (matches routes.open_days). */
export function isoWeekday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  return day === 0 ? 7 : day;
}

/** Add `days` (integer, may be negative) to a 'YYYY-MM-DD' string, UTC-safe. */
export function addDaysToDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days-in-month for a 'YYYY-MM' string. */
function daysInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add `minutes` (may be negative) to an 'HH:MM' 24h string, wrapping past midnight. */
export function addMinutesToSlot(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  let total = (h * 60 + m + minutes) % (24 * 60);
  if (total < 0) total += 24 * 60;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 9.1 isDateBookable
// ---------------------------------------------------------------------------

export function isDateBookable(route, dateOverrides, dateStr) {
  const openDays = JSON.parse(route.open_days);
  const weekday = isoWeekday(dateStr);
  if (!openDays.includes(weekday)) return false;
  const closed = (dateOverrides || []).some(
    (o) => o.date === dateStr && o.action === 'closed'
  );
  return !closed;
}

// ---------------------------------------------------------------------------
// Timezone-aware time helpers (routes.timezone, migrations/0011) — IANA zone
// support via the Intl API's `timeZone` option ONLY (no tz database bundled/
// shipped, no new dependency — Workers-safe). Every route defaults to
// 'Europe/Amsterdam', so any caller that doesn't pass a timezone (or an
// existing NL route) behaves exactly as before this file gained these.
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEZONE = 'Europe/Amsterdam';

/** True for any IANA zone name Intl recognizes (e.g. 'Europe/London'),
 * false for garbage — the only validation an IANA name needs, and the only
 * way to validate one without shipping a tz database (Intl.DateTimeFormat
 * throws RangeError on an unknown zone). Used by admin_api.js's route
 * create/update validation. */
export function isValidIanaTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** True for a 3-letter uppercase ISO 4217-shaped code (e.g. 'EUR', 'GBP',
 * 'USD') — a format check only, not a lookup against the full ISO list, so
 * a brand-new market's currency never needs a code change here. Used by
 * admin_api.js's route create/update validation. */
export function isValidCurrencyCode(code) {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code);
}

/** The UTC offset (in minutes) of `timeZone` at the instant `date` — e.g.
 * Europe/London is 0 in winter and 60 (BST) in summer; Europe/Amsterdam is
 * 60 (CET) / 120 (CEST). Computed purely from Intl.DateTimeFormat's
 * formatToParts, so it automatically accounts for each zone's own DST rules
 * without a bundled tz database. Internal — zonedDateTimeToUtc/
 * utcToZonedHHMM below are the public building blocks. */
function tzOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  // formatToParts can render midnight as hour '24' under hourCycle:'h23' in
  // some ICU builds — normalize to 0 before feeding Date.UTC.
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return Math.round((asUtc - date.getTime()) / MS_PER_MINUTE);
}

/** Combines a route-LOCAL 'YYYY-MM-DD' date + 'HH:MM' wall-clock time in the
 * given IANA `timeZone` into the real UTC instant it represents — e.g.
 * ('2026-08-06','17:30','Europe/London') during BST -> 16:30 UTC. This is
 * what lets the staggered per-bar arrival-time math (computeBarArrivals,
 * below) operate on real instants in the ROUTE's own timezone rather than
 * assuming the server's — a London route's slot times are never silently
 * treated as Amsterdam/UTC time. */
export function zonedDateTimeToUtc(dateStr, hhmm, timeZone = DEFAULT_TIMEZONE) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  const naiveUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offsetMin = tzOffsetMinutes(timeZone, new Date(naiveUtcMs));
  return new Date(naiveUtcMs - offsetMin * MS_PER_MINUTE);
}

/** The inverse of zonedDateTimeToUtc: renders a UTC instant back to an
 * 'HH:MM' wall-clock time AS SEEN in `timeZone`. */
export function utcToZonedHHMM(date, timeZone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

/** The 'YYYY-MM-DD' calendar date AS SEEN in `timeZone` right now — the
 * timezone-aware replacement for a naive `new Date().toISOString().slice(0,
 * 10)` (always UTC). Used for the booking-horizon / availability "today"
 * cutoff so a London or New York guest's calendar day is judged by THEIR
 * local clock, not the server's UTC one. Defaults to Europe/Amsterdam, so
 * every existing NL call site (and every call that omits a timezone) is
 * unaffected. */
export function todayInTimezone(timeZone = DEFAULT_TIMEZONE, nowDate = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(nowDate);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// ---------------------------------------------------------------------------
// 9.2 computeBarArrivals
// ---------------------------------------------------------------------------

/**
 * @param route  routes row — route.timezone (migrations/0011) decides which
 *               IANA zone the booking's slot/date are wall-clock LOCAL to;
 *               defaults to Europe/Amsterdam when absent (older fixtures /
 *               callers that predate this column), matching every route's
 *               own column default so NL behaviour is byte-for-byte unchanged.
 */
export function computeBarArrivals(route, routesBars, dateOverridesForDate, booking) {
  const overrides = dateOverridesForDate || [];
  const altOverride = overrides.find(
    (o) => o.action === 'alternate_bars' && o.date === booking.date
  );

  let bars;
  if (altOverride) {
    const payload = typeof altOverride.payload === 'string'
      ? JSON.parse(altOverride.payload)
      : altOverride.payload;
    bars = payload;
  } else {
    bars = [...(routesBars || [])].sort((a, b) => a.ord - b.ord);
  }

  const timeZone = (route && route.timezone) || DEFAULT_TIMEZONE;

  return bars.map((b) => {
    const offsetMinutes = b.minutes_offset || 0;
    // offset 0 (the first bar, always) needs no zoned math at all — it's
    // exactly the booked slot time, verbatim.
    const arrival_time = offsetMinutes === 0
      ? booking.slot
      : utcToZonedHHMM(
          new Date(zonedDateTimeToUtc(booking.date, booking.slot, timeZone).getTime() + offsetMinutes * MS_PER_MINUTE),
          timeZone
        );
    return { bar_name: b.bar_name, bar_email: b.bar_email, arrival_time };
  });
}

// ---------------------------------------------------------------------------
// 9.3 buildSlotsForDate
// ---------------------------------------------------------------------------
//
// Per-timeslot capacity precedence (SPEC.md §7.6 / migrations/0003), highest
// to lowest specificity — each level only fills in what the level above it
// didn't already decide:
//   1. date_overrides 'slot_capacity_override' — { "HH:MM": capacity, ... }
//      for this exact (route, date); touches only the slots named in it.
//   2. date_overrides 'capacity_override'      — one capacity applied to
//      EVERY slot on this date (existing behaviour, unchanged).
//   3. route.slot_capacity                     — { "HH:MM": capacity, ... },
//      this route's per-slot default, independent of date.
//   4. route.capacity                          — route-wide default.
// This function must stay in exact lockstep with the SQL guard in db.js's
// CREATE_HOLD_SQL (same precedence, same JSON shapes) — that's what makes
// the guest-facing seats_left number and the atomic no-overbook guard agree.

/** Parses routes.slot_capacity ('{}' by default, or absent on older in-memory
 * fixtures/tests) into a plain { "HH:MM": capacity } object. */
function parseSlotCapacityMap(value) {
  if (!value) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed || {};
}

/** Parses routes.weekday_capacity (NULL by default — migrations/0014) into a
 * plain { "1".."7": capacity } object (ISO weekday, Mon=1..Sun=7). Mirrors
 * parseSlotCapacityMap's leniency: NULL/absent/already-parsed all tolerated. */
function parseWeekdayCapacityMap(value) {
  if (!value) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed || {};
}

/**
 * Resolves routes.slots (TEXT/JSON) into the flat "HH:MM" array that applies
 * on `date` — the column is POLYMORPHIC (different-start-times-per-weekday
 * feature):
 *   - a JSON ARRAY (e.g. ["17:00","18:00"]) -> the SAME start times on every
 *     open day. This is the original shape; returned as-is, so every
 *     existing route's behaviour is byte-for-byte unchanged.
 *   - a JSON OBJECT keyed by ISO weekday string "1".."7" (Mon=1 .. Sun=7),
 *     e.g. {"1":["16:00","17:00"],"6":["13:00","14:00"]} -> that weekday's
 *     start times only. A weekday absent from the object, or present with an
 *     empty array, yields NO start times that day (buildSlotsForDate then
 *     naturally returns zero bookable slots for that date).
 * Accepts route.slots already-parsed (an Array/Object) as well as the raw
 * TEXT string, matching parseSlotCapacityMap's leniency above.
 */
export function slotsForWeekday(route, date) {
  const parsed = typeof route.slots === 'string' ? JSON.parse(route.slots) : route.slots;
  if (Array.isArray(parsed)) return parsed;
  return (parsed && parsed[String(isoWeekday(date))]) || [];
}

export function buildSlotsForDate(route, dateOverridesForDate, date) {
  const overrides = (dateOverridesForDate || []).filter((o) => o.date === date);
  const parsedPayload = (o) =>
    typeof o.payload === 'string' ? JSON.parse(o.payload) : o.payload;

  const baseSlots = slotsForWeekday(route, date);
  const routeSlotCapacity = parseSlotCapacityMap(route.slot_capacity);
  const routeWeekdayCapacity = parseWeekdayCapacityMap(route.weekday_capacity);

  // Precedence level 3 -> 3.5 -> 4 (migrations/0014): route's per-slot
  // default, then this route's per-WEEKDAY default (Mon=1..Sun=7) for
  // `date`, finally falling back to the route-wide default capacity.
  const routeDefaultFor = (slot) => {
    if (routeSlotCapacity[slot] != null) return routeSlotCapacity[slot];
    const weekdayCap = routeWeekdayCapacity[String(isoWeekday(date))];
    return weekdayCap != null ? weekdayCap : route.capacity;
  };

  const removeSet = new Set(
    overrides.filter((o) => o.action === 'remove_slot').map((o) => parsedPayload(o).slot)
  );

  let slots = baseSlots
    .filter((s) => !removeSet.has(s))
    .map((s) => ({ slot: s, capacity: routeDefaultFor(s) }));

  for (const o of overrides.filter((o) => o.action === 'extra_slot')) {
    const payload = parsedPayload(o);
    if (!slots.some((s) => s.slot === payload.slot)) {
      slots.push({
        slot: payload.slot,
        capacity: payload.capacity != null ? payload.capacity : routeDefaultFor(payload.slot),
      });
    }
  }

  // Precedence level 2: date-wide override applies to every slot that date
  // (including any extra_slot just added), regardless of the levels below.
  const capOverride = overrides.find((o) => o.action === 'capacity_override');
  if (capOverride) {
    const cap = parsedPayload(capOverride).capacity;
    slots = slots.map((s) => ({ ...s, capacity: cap }));
  }

  // Precedence level 1 (highest, applied last): date+slot override touches
  // ONLY the slots named in its payload map — every other slot that date
  // keeps whatever level 2/3/4 already gave it.
  const slotCapOverride = overrides.find((o) => o.action === 'slot_capacity_override');
  if (slotCapOverride) {
    const map = parsedPayload(slotCapOverride) || {};
    slots = slots.map((s) =>
      Object.prototype.hasOwnProperty.call(map, s.slot) ? { ...s, capacity: map[s.slot] } : s
    );
  }

  slots.sort((a, b) => a.slot.localeCompare(b.slot));
  return slots;
}

// ---------------------------------------------------------------------------
// 9.4 buildMonthAvailability
// ---------------------------------------------------------------------------

/**
 * @param route                        routes row (needs open_days)
 * @param dateOverridesInMonth         date_overrides rows for this route, any dates
 *                                     (only 'closed' rows are consulted here)
 * @param slotSeatsLeftByDate          { [date]: [{ seats_left }, ...] } — precomputed
 *                                     per-date slot list w/ live seats_left, for dates
 *                                     that are weekday-open and not closed. Dates absent
 *                                     from this map are treated as 'open' if they have
 *                                     no override data available (caller's choice not to
 *                                     compute for a masked-out date is not our concern).
 * @param monthStr                     'YYYY-MM'
 * @param today                        'YYYY-MM-DD' — booking horizon start (inclusive)
 */
export function buildMonthAvailability(route, dateOverridesInMonth, slotSeatsLeftByDate, monthStr, today) {
  const openDays = JSON.parse(route.open_days);
  const closedDates = new Set(
    (dateOverridesInMonth || []).filter((o) => o.action === 'closed').map((o) => o.date)
  );

  const horizonEnd = addDaysToDateStr(today, 90); // day 90 included, day 91 excluded
  const total = daysInMonth(monthStr);
  const result = {};

  for (let day = 1; day <= total; day++) {
    const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`;
    if (dateStr < today || dateStr > horizonEnd) continue;

    const weekday = isoWeekday(dateStr);
    if (!openDays.includes(weekday) || closedDates.has(dateStr)) {
      result[dateStr] = 'closed';
      continue;
    }

    const slots = (slotSeatsLeftByDate && slotSeatsLeftByDate[dateStr]) || null;
    if (slots && slots.length > 0 && slots.every((s) => s.seats_left === 0)) {
      result[dateStr] = 'soldout';
    } else {
      result[dateStr] = 'open';
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 9.5 buildHourBars
// ---------------------------------------------------------------------------

export function buildHourBars(participantsPerHourRows) {
  const rows = participantsPerHourRows || [];
  const maxGuests = rows.reduce((max, r) => Math.max(max, r.guests), 0);
  return rows.map((r) => ({
    route_id: r.route_id,
    route_name: r.route_name,
    slot: r.slot,
    guests: r.guests,
    bookings: r.bookings,
    pct: maxGuests > 0 ? Math.round((r.guests / maxGuests) * 100) : 0,
  }));
}

// ---------------------------------------------------------------------------
// 9.6 toCsv
// ---------------------------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows, columns) {
  const header = columns.map(csvEscape).join(',');
  const lines = (rows || []).map((row) => columns.map((col) => csvEscape(row[col])).join(','));
  return [header, ...lines].join('\r\n');
}

// ---------------------------------------------------------------------------
// Money — currency-aware formatting (routes.currency, migrations/0011)
// ---------------------------------------------------------------------------

// Per-currency display rules: symbol placed before the amount always; EUR
// uses a comma decimal separator (Dutch convention, matches the site's
// existing "€29,95"); GBP/USD use a point. Add a new currency here when it's
// needed (ADD-A-CITY recipe) — an unlisted ISO code still formats sanely via
// the fallback below ("CODE 29.95"), it just won't get a pretty symbol yet.
const CURRENCY_FORMATS = {
  EUR: { symbol: '€', decimal: ',' },
  GBP: { symbol: '£', decimal: '.' },
  USD: { symbol: '$', decimal: '.' },
};

/**
 * Formats a whole-cents integer as a price string in `currency` (ISO 4217
 * code, e.g. 'EUR' | 'GBP' | 'USD' — case-insensitive, defaults to 'EUR').
 * The ONE money formatter used everywhere a price is rendered (emails,
 * admin dashboard, the guest widget) — see migrations/0011's doc comment for
 * the full list of call sites. Pure, Node-testable, no locale/Intl dependency
 * (keeps the exact "€29,95" shape the site has always shown for EUR, rather
 * than whatever the host's ICU data happens to produce).
 *   formatMoney(2995, 'EUR') -> '€29,95'
 *   formatMoney(2995, 'GBP') -> '£29.95'
 *   formatMoney(2995, 'USD') -> '$29.95'
 */
export function formatMoney(cents, currency) {
  const code = String(currency || 'EUR').toUpperCase();
  const fmt = CURRENCY_FORMATS[code] || { symbol: code + ' ', decimal: '.' };
  const n = Number(cents) || 0;
  const amount = (n / 100).toFixed(2).replace('.', fmt.decimal);
  return `${fmt.symbol}${amount}`;
}

/** Format eurocents as a Dutch-style price string, e.g. 2995 -> '€29,95'.
 * Kept as a thin EUR-only wrapper around formatMoney for existing callers —
 * prefer formatMoney(cents, route.currency) for anything route-specific. */
export function formatEuros(cents) {
  return formatMoney(cents, 'EUR');
}

// ---------------------------------------------------------------------------
// Dashboard v2 — discount capture from a Stripe Checkout Session (§ webhook)
// ---------------------------------------------------------------------------
//
// Pure so it's unit-testable without a live Stripe payload. Reads whatever the
// `checkout.session.completed` object carries and returns a normalized
// { discount_code, discount_cents } we persist onto the booking. Stripe puts
// the money saved in `total_details.amount_discount` (already in cents). The
// human-readable promo code depends on how the session was created:
//   * if `discounts[].promotion_code` is expanded to an object -> use its .code
//   * if it's a bare id string ('promo_123')                   -> store that
//   * else fall back to the coupon name, then to metadata.discount_code
// (SPEC.md §8.6). Always returns a well-formed object, never throws.
export function extractDiscount(session) {
  const empty = { discount_code: null, discount_cents: 0 };
  if (!session || typeof session !== 'object') return empty;

  const td = session.total_details || {};
  const cents = Number.isFinite(td.amount_discount) && td.amount_discount > 0
    ? Math.round(td.amount_discount)
    : 0;

  let code = null;
  const first = Array.isArray(session.discounts) && session.discounts.length ? session.discounts[0] : null;
  if (first) {
    const pc = first.promotion_code;
    if (pc && typeof pc === 'object' && pc.code) code = pc.code;
    else if (typeof pc === 'string' && pc) code = pc;
    else if (first.coupon && typeof first.coupon === 'object' && (first.coupon.name || first.coupon.id)) {
      code = first.coupon.name || first.coupon.id;
    }
  }
  if (!code && session.metadata && session.metadata.discount_code) code = session.metadata.discount_code;

  return { discount_code: code || null, discount_cents: cents };
}

// ---------------------------------------------------------------------------
// Dashboard v2 — customer aggregation (Customers tab / CRM, §12.5)
// ---------------------------------------------------------------------------
//
// A "customer" is DERIVED from bookings, not stored in its own table — keyed by
// lower-cased, trimmed email. Given raw booking rows already joined with their
// route price (`price_cents`), this returns one entry per customer with the
// numbers the Customers tab shows. Pure + testable; db.js does the fetch, this
// does the math (same split-of-responsibility as buildHourBars etc.).
//
// Row shape expected (extra fields ignored): {
//   email, name, phone, date, party, status, created_at,
//   price_cents,            // per-person price of the booked route
//   discount_cents,         // amount saved on THIS booking
//   payment_status          // 'free'|'comp' => counts as €0 spent
// }
//
// A booking counts toward guests/spend only if it actually happened —
// 'confirmed' or 'confirmed_conflict' (a paid seat). Holds, expired and
// cancelled rows still surface the person (so a lead who never paid is still
// findable) but contribute 0 guests and €0 spent.
const COUNTS_TOWARD_SPEND = new Set(['confirmed', 'confirmed_conflict']);

/** Money actually taken for one booking row (0 for free/comp/unpaid). */
function bookingSpendCents(row) {
  if (!COUNTS_TOWARD_SPEND.has(row.status)) return 0;
  if (row.payment_status === 'free' || row.payment_status === 'comp') return 0;
  const gross = (Number(row.price_cents) || 0) * (Number(row.party) || 0);
  const net = gross - (Number(row.discount_cents) || 0);
  return net > 0 ? net : 0;
}

/**
 * @param rows   booking rows (see shape above), any order.
 * @param q      optional case-insensitive search over name/email/phone.
 * @returns      customers sorted by most recent booking date first.
 */
export function aggregateCustomers(rows, q) {
  const byEmail = new Map();

  for (const row of rows || []) {
    const key = String(row.email || '').trim().toLowerCase();
    if (!key) continue;

    let c = byEmail.get(key);
    if (!c) {
      c = {
        email: key,
        name: row.name || '',
        phone: row.phone || '',
        bookings_count: 0,
        guests: 0,
        total_spent_cents: 0,
        discount_total_cents: 0,
        last_booking: null,
        first_booking: null,
        _lastCreated: '',
      };
      byEmail.set(key, c);
    }

    c.bookings_count += 1;
    if (COUNTS_TOWARD_SPEND.has(row.status)) c.guests += Number(row.party) || 0;
    c.total_spent_cents += bookingSpendCents(row);
    c.discount_total_cents += Number(row.discount_cents) || 0;

    if (row.date && (!c.last_booking || row.date > c.last_booking)) c.last_booking = row.date;
    if (row.date && (!c.first_booking || row.date < c.first_booking)) c.first_booking = row.date;

    // Freshest name/phone wins (fixes "which spelling is current?" — use the
    // most recently created booking's values, since that's the latest the
    // customer or owner typed).
    const created = String(row.created_at || '');
    if (created >= c._lastCreated) {
      c._lastCreated = created;
      if (row.name) c.name = row.name;
      if (row.phone) c.phone = row.phone;
    }
  }

  let list = [...byEmail.values()].map((c) => {
    delete c._lastCreated;
    return c;
  });

  const needle = (q || '').trim().toLowerCase();
  if (needle) {
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.email.includes(needle) ||
        (c.phone || '').toLowerCase().includes(needle)
    );
  }

  list.sort((a, b) => String(b.last_booking || '').localeCompare(String(a.last_booking || '')));
  return list;
}
