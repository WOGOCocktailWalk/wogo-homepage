-- migrations/0010_booking_notes.sql
-- Optional guest "Allergies / notes" field (2026-08): one nullable TEXT column
-- on bookings, written once at hold-creation (guest widget) or manual-booking
-- time (admin dashboard) and never mutated afterwards. NULL means "the guest
-- left it blank" — the emails/dashboard render nothing in that case, so there
-- is no empty "Notes:" label anywhere.
--
-- Validation lives in code, not the schema: src/logic.js:validateNotes trims,
-- caps length at 500 chars and rejects control characters BEFORE the value is
-- ever bound; src/emails.js HTML-escapes it on every render (guest echo, owner
-- notification, and the bar's prominent "⚠️ Allergies / notes" block — the
-- whole point of the field). The value is treated as untrusted text always.
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

ALTER TABLE bookings ADD COLUMN notes TEXT; -- nullable; guest allergies / special requests
