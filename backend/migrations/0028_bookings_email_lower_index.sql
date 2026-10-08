-- 8 Oct 2026: expression index so the two `WHERE LOWER(email) = LOWER(?)`
-- lookups on bookings (active-holds-per-email guard in createHold, customer
-- email rename) use an index instead of scanning the whole table on every
-- booking attempt. Sibling of the getSubscriberByEmail fix in src/db.js —
-- both found when the subscriber import tripped D1's free-tier daily read cap.
CREATE INDEX IF NOT EXISTS idx_bookings_email_lower ON bookings (LOWER(email));
