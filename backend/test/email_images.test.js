// test/email_images.test.js — the per-email-type, per-city hero imagery
// (config.js:EMAIL_IMAGE_BY_KIND_AND_ROUTE / emailImageFor, 2026-10-14).
//
// The owner's complaint this exists to prevent: "every mail uses the same
// picture". So the load-bearing assertions here are not "a URL came back"
// but:
//   1. NO (kind, route) pair can ever resolve to an empty/undefined URL —
//      a broken <img> in a live guest email is worse than a repeated one.
//   2. Within ONE city, every email a single guest can receive resolves to a
//      DIFFERENT picture. This is the regression that would quietly undo the
//      whole change (e.g. two kinds both falling through to the same default).
//   3. Every URL in the map points at a file that actually exists in the
//      published /email/ folder — caught here, at test time, rather than by
//      a guest seeing a torn-image placeholder.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EMAIL_IMAGE_BY_KIND_AND_ROUTE,
  emailImageFor,
  posterUrlFor,
  EMAIL_BANNER_URL,
  SITE_ASSET_BASE,
  POSTER_BY_ROUTE,
  ROUTE_PATHS,
} from '../src/config.js';
import {
  renderGuestConfirmation,
  renderAbandonedBooking,
  renderAbandonedFollowup,
  renderWalkReminder,
  renderReviewRequest,
  renderGuestReschedule,
  renderGuestCancellation,
  renderGiftCardRecipient,
  renderGiftCardBuyer,
  renderSubscribeConfirm,
  renderSubscribeWelcome,
  renderBarNotification,
  renderOwnerNotification,
} from '../src/emails.js';

// Every kind the system can send a picture for.
const KINDS = [
  'confirmation', 'abandoned', 'abandoned_followup', 'reminder',
  'review_request', 'giftcard_recipient', 'giftcard_buyer',
  'reschedule', 'cancellation', 'subscribe_confirm', 'welcome',
];

// Every real route id, plus ids that do NOT exist — a brand-new city added
// to the DB before anyone adds its photos must still render a valid image.
const REAL_ROUTE_IDS = Object.keys(ROUTE_PATHS);
const UNKNOWN_ROUTE_IDS = ['london', 'maastricht', 'eindhoven', '', 'definitely-not-a-route'];

const routeFor = (id) => ({ id, name: `WOGO ${id}`, city: id, currency: 'EUR' });

// The kinds ONE guest can receive about ONE booking. These are what must
// never collide within a city — the actual shape of the owner's complaint.
const GUEST_JOURNEY_KINDS = [
  'confirmation', 'abandoned', 'abandoned_followup',
  'reminder', 'review_request', 'reschedule', 'cancellation',
];

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** 'https://…/email/mail-x.jpg' -> the local file it must have been built from. */
function localPathFor(url) {
  assert.ok(url.startsWith(SITE_ASSET_BASE + '/'), `url must sit under SITE_ASSET_BASE: ${url}`);
  return repoRoot + url.slice(SITE_ASSET_BASE.length + 1);
}

function allMappedUrls() {
  const urls = new Set();
  for (const byRoute of Object.values(EMAIL_IMAGE_BY_KIND_AND_ROUTE)) {
    for (const url of Object.values(byRoute)) urls.add(url);
  }
  return [...urls];
}

// ---------------------------------------------------------------------------
// 1. Never empty, never broken
// ---------------------------------------------------------------------------

describe('emailImageFor — always resolves to a usable URL', () => {
  test('every (kind, real route id) pair returns an absolute https URL', () => {
    for (const kind of KINDS) {
      for (const id of REAL_ROUTE_IDS) {
        const url = emailImageFor(kind, routeFor(id));
        assert.ok(typeof url === 'string' && url.length > 0, `${kind}/${id} returned "${url}"`);
        assert.ok(url.startsWith('https://'), `${kind}/${id} is not absolute: ${url}`);
      }
    }
  });

  test('every (kind, UNKNOWN route id) pair still returns a usable URL', () => {
    for (const kind of KINDS) {
      for (const id of UNKNOWN_ROUTE_IDS) {
        const url = emailImageFor(kind, routeFor(id));
        assert.ok(url && url.startsWith('https://'), `${kind}/${id} returned "${url}"`);
      }
    }
  });

  test('a null/undefined route never throws and never returns empty', () => {
    for (const kind of KINDS) {
      for (const route of [null, undefined, {}, { id: undefined }]) {
        const url = emailImageFor(kind, route);
        assert.ok(url && url.startsWith('https://'), `${kind} with ${JSON.stringify(route)} -> "${url}"`);
      }
    }
  });

  test('an unknown KIND falls back to the branded banner rather than undefined', () => {
    assert.equal(emailImageFor('not_a_real_kind', routeFor('utrecht')), EMAIL_BANNER_URL);
    assert.equal(emailImageFor(undefined, null), EMAIL_BANNER_URL);
  });
});

// ---------------------------------------------------------------------------
// 2. THE point of the change: no city sends two identical pictures
// ---------------------------------------------------------------------------

describe('no city repeats a picture across the guest journey', () => {
  // A route with a poster, one without (so the confirmation falls back to
  // banner.jpg), and an unknown route — all three must stay collision-free.
  const buckets = [...REAL_ROUTE_IDS, ...UNKNOWN_ROUTE_IDS];

  for (const id of buckets) {
    test(`${id || '(empty route id)'} — all ${GUEST_JOURNEY_KINDS.length} guest emails show different images`, () => {
      const route = routeFor(id);
      const seen = new Map();
      for (const kind of GUEST_JOURNEY_KINDS) {
        const url = emailImageFor(kind, route);
        if (seen.has(url)) {
          assert.fail(
            `${id}: "${kind}" and "${seen.get(url)}" both resolve to ${url} — ` +
            `a guest would get the same picture twice (give one of them its own entry in ` +
            `EMAIL_IMAGE_BY_KIND_AND_ROUTE, or point it at a different kind default)`
          );
        }
        seen.set(url, kind);
      }
    });
  }

  test('the kind DEFAULTS are themselves all distinct', () => {
    // If two kinds shared a default, every city that falls through for both
    // would silently repeat — this is the single highest-leverage invariant.
    const seen = new Map();
    for (const [kind, byRoute] of Object.entries(EMAIL_IMAGE_BY_KIND_AND_ROUTE)) {
      if (!byRoute._default) continue;              // `confirmation` has none by design
      const prev = seen.get(byRoute._default);
      assert.ok(!prev, `kinds "${kind}" and "${prev}" share the default image ${byRoute._default}`);
      seen.set(byRoute._default, kind);
    }
  });

  test('the two abandoned nudges never show the same picture (the same guest gets both)', () => {
    for (const id of [...REAL_ROUTE_IDS, ...UNKNOWN_ROUTE_IDS]) {
      const route = routeFor(id);
      assert.notEqual(
        emailImageFor('abandoned', route),
        emailImageFor('abandoned_followup', route),
        `${id}: the 1h nudge and the 24h follow-up share an image`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Every mapped URL is a real, email-safe file on disk
// ---------------------------------------------------------------------------

describe('mapped images exist and are email-safe', () => {
  test('every URL in the map resolves to a file in the published /email/ folder', () => {
    for (const url of allMappedUrls()) {
      const path = localPathFor(url);
      assert.ok(existsSync(path), `missing file for ${url} (expected ${path})`);
    }
  });

  test('no mapped image exceeds 180KB (guests open these on mobile data)', () => {
    for (const url of allMappedUrls()) {
      const bytes = statSync(localPathFor(url)).size;
      assert.ok(bytes <= 180000, `${url} is ${bytes}B — over the 180,000B email budget`);
    }
  });

  test('the fallback banner and every route poster still exist too', () => {
    for (const url of [EMAIL_BANNER_URL, ...Object.values(POSTER_BY_ROUTE)]) {
      assert.ok(existsSync(localPathFor(url)), `missing ${url}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The renderers actually use it (the map is useless if nothing reads it)
// ---------------------------------------------------------------------------

const ROUTE = {
  id: 'rotterdam-hidden-gems', name: 'Rotterdam Hidden Gems', city: 'Rotterdam',
  price_cents: 3495, currency: 'EUR', map_url: 'https://example.com/map.pdf',
};
const BOOKING = {
  id: 'b_img_1', route_id: ROUTE.id, date: '2026-11-14', slot: '18:00', party: 2,
  name: 'Sophie de Vries', email: 'sophie@example.com', phone: null, locale: 'en',
  notes: null, discount_cents: 0, gift_applied_cents: 0,
};
const GIFT = {
  code: 'WOGO-7F3K-9QRT', initial_cents: 6000, balance_cents: 6000, currency: 'EUR',
  locale: 'en', buyer_name: 'Mark', buyer_email: 'mark@example.com',
  recipient_name: 'Lotte', recipient_email: 'lotte@example.com', message: null,
};
const SUB = { email: 'anna@example.com', first_name: 'Anna', locale: 'en' };

/** The hero <img src> — the one image the layout puts under the header. */
function heroSrc(html) {
  // [0] is the logo in the espresso band; [1] is the hero photograph.
  const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  return srcs[1] || null;
}

describe('renderers use the per-kind image', () => {
  test('the confirmation still shows the ROUTE POSTER (it is the guest ticket)', () => {
    const { html } = renderGuestConfirmation(BOOKING, ROUTE);
    assert.equal(heroSrc(html), posterUrlFor(ROUTE));
  });

  test('a per-route poster_url override still wins for the confirmation', () => {
    const custom = { ...ROUTE, poster_url: 'https://example.com/custom-poster.jpg' };
    const { html } = renderGuestConfirmation({ ...BOOKING }, custom);
    assert.equal(heroSrc(html), 'https://example.com/custom-poster.jpg');
  });

  const cases = [
    ['abandoned', () => renderAbandonedBooking(BOOKING, ROUTE)],
    ['abandoned_followup', () => renderAbandonedFollowup(BOOKING, ROUTE)],
    ['reminder', () => renderWalkReminder(BOOKING, ROUTE)],
    ['review_request', () => renderReviewRequest(BOOKING, ROUTE)],
    ['reschedule', () => renderGuestReschedule(BOOKING, ROUTE, { previous: { date: '2026-11-12', slot: '19:00' } })],
    ['cancellation', () => renderGuestCancellation(BOOKING, ROUTE)],
  ];
  for (const [kind, render] of cases) {
    test(`${kind} shows its own image, not the poster`, () => {
      const src = heroSrc(render().html);
      assert.equal(src, emailImageFor(kind, ROUTE));
      assert.notEqual(src, posterUrlFor(ROUTE), `${kind} is still on the route poster`);
    });
  }

  test('the route-less mails each get an image too (they used to have none)', () => {
    const routeless = [
      ['giftcard_recipient', renderGiftCardRecipient(GIFT)],
      ['giftcard_buyer', renderGiftCardBuyer(GIFT)],
      ['subscribe_confirm', renderSubscribeConfirm(SUB, 'https://example.com/confirm?token=x')],
      ['welcome', renderSubscribeWelcome(SUB, { unsubscribeUrl: 'https://example.com/u?token=x' })],
    ];
    for (const [kind, mail] of routeless) {
      assert.equal(heroSrc(mail.html), emailImageFor(kind, null), `${kind} hero image`);
    }
  });

  test('every guest mail for one booking shows a DIFFERENT image end to end', () => {
    const rendered = [
      renderGuestConfirmation(BOOKING, ROUTE),
      renderAbandonedBooking(BOOKING, ROUTE),
      renderAbandonedFollowup(BOOKING, ROUTE),
      renderWalkReminder(BOOKING, ROUTE),
      renderReviewRequest(BOOKING, ROUTE),
      renderGuestReschedule(BOOKING, ROUTE, { previous: { date: '2026-11-12', slot: '19:00' } }),
      renderGuestCancellation(BOOKING, ROUTE),
    ].map((m) => heroSrc(m.html));
    assert.equal(new Set(rendered).size, rendered.length,
      `the same picture appears twice across one guest's mails: ${rendered.join('\n')}`);
  });

  test('BAR and OWNER mails deliberately keep the route poster (reference, not atmosphere)', () => {
    const bar = { bar_name: 'Bar One', bar_email: 'b@example.com', arrival_time: '18:15', locale: 'nl' };
    assert.equal(heroSrc(renderBarNotification(bar, BOOKING, ROUTE).html), posterUrlFor(ROUTE));
    assert.equal(heroSrc(renderOwnerNotification(BOOKING, ROUTE).html), posterUrlFor(ROUTE));
  });
});
