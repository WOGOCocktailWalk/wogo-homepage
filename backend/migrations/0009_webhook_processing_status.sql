-- migrations/0009_webhook_processing_status.sql
-- Production-readiness hardening (2026-07): fixes a real ordering bug in the
-- Stripe webhook handler. Before this migration, src/webhook.js called
-- recordWebhookEvent() (an INSERT — i.e. "mark this Stripe event as handled")
-- BEFORE attempting the actual booking write (confirmBooking/cancelIfHold).
-- If that write then threw (a transient D1 error, say), the event was
-- ALREADY marked handled — so when Stripe retried the same event (exactly
-- the case it retries FOR), the dedupe check saw it as a duplicate and
-- silently skipped it forever. A guest could pay and never get confirmed.
--
-- Fix: split "claim" from "done". A new event is claimed atomically (INSERT,
-- status='processing' — the INSERT's UNIQUE constraint on `id` is the
-- concurrency guard against two workers claiming the same event at once,
-- unchanged from before). Only once the booking write has completed WITHOUT
-- throwing does the handler call finishWebhookProcessing() to flip the row to
-- 'done'. A retry of a still-'processing' row (the write attempt crashed
-- last time) re-attempts the write — safe, because confirmBooking/
-- cancelIfHold are themselves idempotent (guarded by `WHERE status = 'hold'`
-- etc., SPEC.md §6.3/§6.4/§6.5) — a re-run that finds the booking already in
-- its target state is a correct no-op, not a double-charge or double-email
-- risk on its own (the emails/CAPI side effects are the one exception; see
-- src/webhook.js's comment at the finishWebhookProcessing() call site).
--
-- Existing rows default to 'done': every event this table already holds was
-- inserted by the OLD single-INSERT-is-the-whole-thing code path, i.e. it
-- really was fully handled (the only way an old row got inserted at all).

ALTER TABLE webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'done'; -- 'processing' | 'done'
ALTER TABLE webhook_events ADD COLUMN processed_at TEXT;                  -- set when status -> 'done'
