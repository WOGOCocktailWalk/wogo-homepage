// src/retention.js — GDPR data-minimization cron (owner audit item #14).
// Production hardening, 2026-07.
//
// Anonymizes name/email/phone on bookings that are BOTH terminal (confirmed,
// confirmed_conflict, cancelled, or expired — never 'hold', which always
// resolves within HOLD_MINUTES via the existing 5-minute sweep) and older
// than GDPR_RETENTION_MONTHS. See db.js:anonymizeOldBookings for the exact
// SQL and its idempotency guard.
//
// This does NOT delete the row — the aggregate/financial shape (route,
// party, price, date, status) stays for reporting; only what identifies the
// PERSON is scrubbed. That is exactly what "delete personal fields" (the
// owner's own wording) asks for, as distinct from full row deletion.

import * as db from './db.js';
import { sqliteMonthsAgo } from './logic.js';
import { GDPR_RETENTION_MONTHS } from './config.js';

export async function runGdprRetention(env, deps = {}) {
  const database = deps.database || db;
  const cutoff = sqliteMonthsAgo(GDPR_RETENTION_MONTHS);
  return database.anonymizeOldBookings(env.DB, cutoff);
}
