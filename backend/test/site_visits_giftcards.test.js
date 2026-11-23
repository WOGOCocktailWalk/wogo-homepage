// test/site_visits_giftcards.test.js — 23 Nov 2026: own visit counter and
// gift card sales in the dashboard's key stats.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeTestDb } from './sqlite-d1-adapter.js';
import { addGiftCardSalesToHighlights, overlaySiteVisitTraffic, buildHighlightsSales } from '../src/logic.js';
import { recordSiteVisit, listSiteVisitDays } from '../src/db.js';
import { handleSiteVisitHit } from '../src/missing_pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = ['0001_init.sql', '0005_security.sql'].map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

describe('gift cards in key stats', () => {
  test('adds value + one order on the purchase day and recomputes AOV', () => {
    const sales = buildHighlightsSales([], '2026-11-01', '2026-11-03', { dateField: 'created_at' });
    addGiftCardSalesToHighlights(sales, [{ initial_cents: 5990, created_at: '2026-11-02 10:00:00' }, { initial_cents: 1000, created_at: '2026-10-30 10:00:00' }]);
    assert.equal(sales.totals.revenue_cents, 5990);
    assert.equal(sales.totals.orders, 1);
    assert.equal(sales.totals.avg_order_value_cents, 5990);
    assert.equal(sales.daily.find((d) => d.date === '2026-11-02').revenue_cents, 5990);
  });
});

describe('own visit counter', () => {
  test('overlay replaces GA4 days that have own data and re-totals', () => {
    const ga = [{ date: '2026-11-22', sessions: 10, page_views: 20, unique_visitors: 8 }, { date: '2026-11-23', sessions: 5, page_views: 9, unique_visitors: 4 }];
    const r = overlaySiteVisitTraffic(ga, { '2026-11-23': { sessions: 50, page_views: 90, unique_visitors: 40 } });
    assert.deepEqual(r.totals, { sessions: 60, page_views: 110, unique_visitors: 48 });
    const partial = overlaySiteVisitTraffic(ga, { '2026-11-23': { sessions: 2, page_views: 3, unique_visitors: 2 } });
    assert.equal(partial.daily[1].sessions, 5, 'a partial own day never undercuts Google Analytics');
  });

  test('db counter increments page views, sessions and uniques', async () => {
    const db = makeTestDb(schemaSql);
    await recordSiteVisit(db, '2026-11-23', { session: true, unique: true });
    await recordSiteVisit(db, '2026-11-23', { session: false, unique: false });
    const d = await listSiteVisitDays(db, '2026-11-20', '2026-11-23');
    assert.deepEqual(d['2026-11-23'], { page_views: 2, sessions: 1, unique_visitors: 1 });
  });

  test('hit endpoint: same visitor twice = 2 views, 1 session, 1 unique; bots ignored', async () => {
    const db = makeTestDb(schemaSql);
    const env = { DB: db };
    const mk = (ua) => new Request('https://x/api/site-visit', { method: 'POST', body: '/rotterdam/', headers: { Origin: 'https://www.wogococktailwalk.com', 'User-Agent': ua, 'CF-Connecting-IP': '1.2.3.4' } });
    await handleSiteVisitHit(mk('Mozilla/5.0 iPhone'), env);
    await handleSiteVisitHit(mk('Mozilla/5.0 iPhone'), env);
    await handleSiteVisitHit(mk('Googlebot/2.1'), env);
    const all = await listSiteVisitDays(db, '2000-01-01', '2100-01-01');
    const day = Object.values(all)[0];
    assert.deepEqual(day, { page_views: 2, sessions: 1, unique_visitors: 1 });
  });
});
