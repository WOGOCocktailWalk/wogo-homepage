// test/map_locale.test.js
//
// Per-language route maps (migrations/0012 + 0013). The owner makes SEPARATE
// English and Dutch map PDFs per route; the ONE guest confirmation email must
// link the map matching the booking's locale:
//   * EN booking → route.map_url
//   * NL booking → route.map_url_nl, falling back to map_url when unset
//   * neither set → no map section at all (exactly the pre-0012 behaviour)
// Plus: the column round-trips through db.createRoute / db.updateRoute (the
// admin Route manager's save path) so the owner can actually set it.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { renderGuestConfirmation } from '../src/emails.js';
import { createRoute, updateRoute, getRoute } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = [
  '0001_init.sql', '0003_slot_capacity.sql', '0004_customers_manual_discount.sql',
  '0005_security.sql', '0006_error_log.sql', '0007_admin_audit.sql',
  '0008_failed_email.sql', '0009_webhook_processing_status.sql', '0010_booking_notes.sql',
  '0011_currency_timezone.sql', '0012_map_url_nl.sql',
  '0014_weekday_capacity.sql', '0015_weekday_bars.sql',
].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

const EN_MAP = 'https://www.wogococktailwalk.com/maps/utrecht-en.pdf';
const NL_MAP = 'https://www.wogococktailwalk.com/maps/utrecht-nl.pdf';

function fixtureBooking(overrides = {}) {
  return {
    id: 'b_map1', route_id: 'utrecht', date: '2026-09-04', slot: '18:00',
    party: 2, name: 'Anna', email: 'anna@example.com', phone: null,
    locale: 'en', notes: null, ...overrides,
  };
}

function fixtureRoute(overrides = {}) {
  return {
    id: 'utrecht', name: 'WOGO Cocktail Walk Utrecht', city: 'Utrecht',
    price_cents: 2995, map_url: EN_MAP, map_url_nl: NL_MAP, ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderGuestConfirmation — the map link follows the booking's language
// ---------------------------------------------------------------------------

describe('guest confirmation — per-language route map (migrations/0012)', () => {
  test('EN booking links the English map (map_url), never the Dutch one', () => {
    const mail = renderGuestConfirmation(fixtureBooking({ locale: 'en' }), fixtureRoute());
    assert.ok(mail.html.includes('Open your route map'), 'EN map button copy present');
    assert.ok(mail.html.includes(`href="${EN_MAP}"`), 'button links the EN map');
    assert.ok(!mail.html.includes(NL_MAP), 'the NL map URL must not appear anywhere in an EN email');
  });

  test('NL booking links the Dutch map (map_url_nl), never the English one', () => {
    const mail = renderGuestConfirmation(fixtureBooking({ locale: 'nl' }), fixtureRoute());
    assert.ok(mail.html.includes('Open je routekaart'), 'NL map button copy present');
    assert.ok(mail.html.includes(`href="${NL_MAP}"`), 'button links the NL map');
    assert.ok(!mail.html.includes(EN_MAP), 'the EN map URL must not appear anywhere in an NL email');
  });

  test('NL booking falls back to the English map when map_url_nl is empty', () => {
    for (const missing of [null, undefined, '']) {
      const mail = renderGuestConfirmation(
        fixtureBooking({ locale: 'nl' }),
        fixtureRoute({ map_url_nl: missing })
      );
      assert.ok(mail.html.includes('Open je routekaart'), 'map section still renders (Dutch copy)');
      assert.ok(mail.html.includes(`href="${EN_MAP}"`), `map_url_nl=${JSON.stringify(missing)} falls back to map_url`);
    }
  });

  test('a Dutch-only map still reaches NL guests, while EN guests get no dead section', () => {
    // Owner uploaded the NL PDF first — NL bookings get it immediately…
    const nlOnly = fixtureRoute({ map_url: null });
    const nl = renderGuestConfirmation(fixtureBooking({ locale: 'nl' }), nlOnly);
    assert.ok(nl.html.includes(`href="${NL_MAP}"`));
    // …and an EN booking on the same route omits the section rather than
    // linking a map the guest can't read (map_url is the EN/default map).
    const en = renderGuestConfirmation(fixtureBooking({ locale: 'en' }), nlOnly);
    assert.ok(!en.html.includes('Open your route map'));
    assert.ok(!en.html.includes(NL_MAP));
  });

  test('neither map set → no map block at all, in both languages', () => {
    const bare = fixtureRoute({ map_url: null, map_url_nl: null });
    const en = renderGuestConfirmation(fixtureBooking({ locale: 'en' }), bare);
    assert.ok(!en.html.includes('Open your route map'));
    assert.ok(!en.html.includes('Your route map'));
    const nl = renderGuestConfirmation(fixtureBooking({ locale: 'nl' }), bare);
    assert.ok(!nl.html.includes('Open je routekaart'));
    assert.ok(!nl.html.includes('Je routekaart'));
  });

  test('unknown/missing locale is treated as EN (gets the English map)', () => {
    const mail = renderGuestConfirmation(fixtureBooking({ locale: undefined }), fixtureRoute());
    assert.ok(mail.html.includes(`href="${EN_MAP}"`));
    assert.ok(!mail.html.includes(NL_MAP));
  });
});

// ---------------------------------------------------------------------------
// db.js — the admin save path persists map_url_nl
// ---------------------------------------------------------------------------

describe('db.js — routes.map_url_nl round-trips (migrations/0012)', () => {
  let db;
  beforeEach(() => { db = makeTestDb(schemaSql); });

  test('createRoute stores both maps; omitting map_url_nl stores NULL', async () => {
    const withBoth = await createRoute(db, {
      id: 'utrecht', name: 'WOGO Cocktail Walk Utrecht', city: 'Utrecht',
      price_cents: 2995, open_days: '[1,2,3]', slots: '["18:00"]',
      map_url: EN_MAP, map_url_nl: NL_MAP,
    });
    assert.equal(withBoth.map_url, EN_MAP);
    assert.equal(withBoth.map_url_nl, NL_MAP);

    const without = await createRoute(db, {
      id: 'haarlem', name: 'WOGO Cocktail Walk Haarlem', city: 'Haarlem',
      price_cents: 2995, open_days: '[1,2,3]', slots: '["18:00"]',
    });
    assert.equal(without.map_url_nl, null);
  });

  test('updateRoute can set and clear map_url_nl without touching map_url', async () => {
    await createRoute(db, {
      id: 'utrecht', name: 'WOGO Cocktail Walk Utrecht', city: 'Utrecht',
      price_cents: 2995, open_days: '[1,2,3]', slots: '["18:00"]', map_url: EN_MAP,
    });
    const set = await updateRoute(db, 'utrecht', { map_url_nl: NL_MAP });
    assert.equal(set.map_url_nl, NL_MAP);
    assert.equal(set.map_url, EN_MAP, 'EN map untouched by an NL-only edit');

    const cleared = await updateRoute(db, 'utrecht', { map_url_nl: null });
    assert.equal(cleared.map_url_nl, null);
    assert.equal(cleared.map_url, EN_MAP);
  });

  test('the 0013 seed applies cleanly on top and is idempotent', async () => {
    // Simulate the remote: 0002's real utrecht/groningen rows exist, then the
    // operator applies 0013 (and could re-apply it without harm).
    const seedRoutes = readFileSync(path.join(__dirname, '../migrations/0002_seed_routes.sql'), 'utf8');
    db._raw.exec(seedRoutes);
    const seedMaps = readFileSync(path.join(__dirname, '../migrations/0013_seed_city_maps.sql'), 'utf8');
    db._raw.exec(seedMaps);
    db._raw.exec(seedMaps); // idempotent — second run must not throw or change meaning

    const utrecht = await getRoute(db, 'utrecht');
    assert.equal(utrecht.map_url, 'https://www.wogococktailwalk.com/maps/utrecht-en.pdf');
    assert.equal(utrecht.map_url_nl, 'https://www.wogococktailwalk.com/maps/utrecht-nl.pdf');
    const groningen = await getRoute(db, 'groningen');
    assert.equal(groningen.map_url, 'https://www.wogococktailwalk.com/maps/groningen-en.pdf');
    assert.equal(groningen.map_url_nl, 'https://www.wogococktailwalk.com/maps/groningen-nl.pdf');
    // untouched city stays mapless
    const amsterdam = await getRoute(db, 'amsterdam');
    assert.equal(amsterdam.map_url, null);
    assert.equal(amsterdam.map_url_nl, null);
  });
});
