// test/route_names.test.js — migrations/0020 (audit item 5): routes.name
// must be the guest-facing display name only, never a marketing label.
// "Rotterdam Route 2 · Hidden Gems (best seller)" (migrations/0002's seed)
// leaked into Stripe Checkout's line-item name, the guest/owner/bar emails,
// and the admin dashboard — anywhere routes.name is rendered verbatim.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { getRoute, listAllRoutes } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(path.join(__dirname, '../migrations/0001_init.sql'), 'utf8');

describe('migrations/0020_route_names — cleans the "(best seller)" label off rotterdam-hidden-gems', () => {
  test('applying 0020 on top of the real 0002 seed strips the marketing label, leaving the rest of the name intact', async () => {
    const db = makeTestDb(schemaSql);
    const seedRoutes = readFileSync(path.join(__dirname, '../migrations/0002_seed_routes.sql'), 'utf8');
    db._raw.exec(seedRoutes);

    // Before: the original seed's marketing-tagged name.
    const before = await getRoute(db, 'rotterdam-hidden-gems');
    assert.equal(before.name, 'Rotterdam Route 2 · Hidden Gems (best seller)');

    const migration0020 = readFileSync(path.join(__dirname, '../migrations/0020_route_names.sql'), 'utf8');
    db._raw.exec(migration0020);

    const after = await getRoute(db, 'rotterdam-hidden-gems');
    assert.equal(after.name, 'Rotterdam Route 2 · Hidden Gems');
    assert.ok(!after.name.includes('('), 'no parenthetical marketing label remains');
  });

  test('is idempotent — re-applying does not change the already-clean name or throw', async () => {
    const db = makeTestDb(schemaSql);
    db._raw.exec(readFileSync(path.join(__dirname, '../migrations/0002_seed_routes.sql'), 'utf8'));
    const migration0020 = readFileSync(path.join(__dirname, '../migrations/0020_route_names.sql'), 'utf8');
    db._raw.exec(migration0020);
    db._raw.exec(migration0020); // must not throw

    const after = await getRoute(db, 'rotterdam-hidden-gems');
    assert.equal(after.name, 'Rotterdam Route 2 · Hidden Gems');
  });

  test('no other seeded route name carries a trailing parenthetical marketing/status label', async () => {
    const db = makeTestDb(schemaSql);
    db._raw.exec(readFileSync(path.join(__dirname, '../migrations/0002_seed_routes.sql'), 'utf8'));
    db._raw.exec(readFileSync(path.join(__dirname, '../migrations/0020_route_names.sql'), 'utf8'));

    const routes = await listAllRoutes(db);
    for (const r of routes) {
      assert.ok(!/\([^)]*\)\s*$/.test(r.name), `route "${r.id}" name "${r.name}" still carries a trailing parenthetical label`);
    }
  });
});
