// test/map_weekday.test.js — per-weekday route map override (migrations/0017)
// A route may set map_url_by_weekday to send a DIFFERENT map on a given ISO
// weekday (e.g. a Thursday line-up), falling back to map_url / map_url_nl.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderGuestConfirmation } from '../src/emails.js';

const EN_DEFAULT = 'https://x/default-en.pdf';
const NL_DEFAULT = 'https://x/default-nl.pdf';
const EN_THU = 'https://x/thursday-en.pdf';
const NL_THU = 'https://x/thursday-nl.pdf';

function route(overrides = {}) {
  return {
    id: 'rotterdam-witte-de-with', name: 'Rotterdam Route 1', city: 'Rotterdam',
    price_cents: 2995, map_url: EN_DEFAULT, map_url_nl: NL_DEFAULT,
    map_url_by_weekday: JSON.stringify({ '4': { en: EN_THU, nl: NL_THU } }),
    ...overrides,
  };
}
function booking(date, locale = 'en') {
  return { id: 'b1', date, slot: '17:00', party: 2, name: 'Sam', email: 's@x.com', locale };
}

describe('per-weekday route map (migrations/0017)', () => {
  test('a Thursday booking gets the Thursday map (EN)', () => {
    // 2026-09-17 is a Thursday
    const mail = renderGuestConfirmation(booking('2026-09-17', 'en'), route(), { locale: 'en' });
    assert.ok(mail.html.includes(`href="${EN_THU}"`), 'Thursday EN map used');
    assert.ok(!mail.html.includes(EN_DEFAULT), 'default map not shown on Thursday');
  });

  test('a Thursday booking gets the Thursday map (NL)', () => {
    const mail = renderGuestConfirmation(booking('2026-09-17', 'nl'), route(), { locale: 'nl' });
    assert.ok(mail.html.includes(`href="${NL_THU}"`), 'Thursday NL map used');
    assert.ok(!mail.html.includes(NL_DEFAULT), 'default NL map not shown on Thursday');
  });

  test('a Friday booking falls back to the default map', () => {
    // 2026-09-18 is a Friday — no weekday override → default
    const mail = renderGuestConfirmation(booking('2026-09-18', 'en'), route(), { locale: 'en' });
    assert.ok(mail.html.includes(`href="${EN_DEFAULT}"`), 'default map used on non-override day');
    assert.ok(!mail.html.includes(EN_THU), 'Thursday map not shown on Friday');
  });

  test('a route with no weekday override behaves exactly as before', () => {
    const mail = renderGuestConfirmation(booking('2026-09-17', 'en'), route({ map_url_by_weekday: null }), { locale: 'en' });
    assert.ok(mail.html.includes(`href="${EN_DEFAULT}"`));
  });
});
