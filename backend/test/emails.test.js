// test/emails.test.js — bar-name double-escaping (audit fix) + plain alert
// subjects. See src/emails.js's heroBand() (~line 122): it escapes hero.chip
// itself, so a caller must pass the RAW string, not an already-escaped one.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderBarNotification,
  renderBarReschedule,
  renderBarCancellation,
  renderOwnerConflict,
  renderGiftCardRedemptionAlert,
} from '../src/emails.js';

const route = { id: 'amsterdam', name: 'WOGO Amsterdam', city: 'Amsterdam', currency: 'EUR' };
const bar = { bar_name: "Let's Meat", bar_email: 'lets-meat@example.com', arrival_time: '19:30' };
const booking = {
  id: 'b_1', date: '2026-10-05', slot: '18:00', party: 4,
  name: 'Anna', email: 'anna@example.com', phone: null, notes: null,
};

// A bar name with an apostrophe must appear escaped EXACTLY ONCE in the
// rendered HTML: "Let&#39;s Meat", never "Let&amp;#39;s Meat" (the entity's
// & re-escaped) and never the raw "Let's Meat" (which would be unsafe if the
// name ever contained real HTML).
function assertSingleEscape(html, needleEscaped) {
  assert.ok(html.includes(needleEscaped), `expected to find "${needleEscaped}" in the email HTML`);
  // Doubled escaping turns "Let&#39;s Meat" into "Let&amp;#39;s Meat" (the
  // entity's own & re-escaped) — that must never appear.
  const doubleEscaped = needleEscaped.replace('&#39;', '&amp;#39;');
  assert.ok(!html.includes(doubleEscaped), `must not contain double-escaped "${doubleEscaped}"`);
}

describe('bar name — escaped exactly once in hero.chip (audit fix)', () => {
  test('renderBarNotification', () => {
    const { html } = renderBarNotification(bar, booking, route);
    assertSingleEscape(html, 'Let&#39;s Meat');
  });

  test('renderBarReschedule', () => {
    const { html } = renderBarReschedule(bar, booking, route, {});
    assertSingleEscape(html, 'Let&#39;s Meat');
  });

  test('renderBarCancellation', () => {
    const { html } = renderBarCancellation(bar, booking, route);
    assertSingleEscape(html, 'Let&#39;s Meat');
  });
});

describe('alert email subjects are plain text (no HTML entities)', () => {
  test('renderOwnerConflict subject uses the real warning glyph, not &#9888;', () => {
    const { subject } = renderOwnerConflict(booking, route);
    assert.ok(subject.startsWith('⚠ '), `subject should start with the ⚠ glyph, got: ${subject}`);
    assert.ok(!subject.includes('&#9888;'), 'subject must not contain the raw HTML entity');
  });

  test('renderGiftCardRedemptionAlert subject uses the real warning glyph, not &#9888;', () => {
    const { subject } = renderGiftCardRedemptionAlert(booking, { status: 'card_not_found', gift_card: null });
    assert.ok(subject.startsWith('⚠ '), `subject should start with the ⚠ glyph, got: ${subject}`);
    assert.ok(!subject.includes('&#9888;'), 'subject must not contain the raw HTML entity');
  });
});
