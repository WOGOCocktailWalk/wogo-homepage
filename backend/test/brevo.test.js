// test/brevo.test.js — plain-text alternative for Brevo sends (audit item 7).

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, sendTransactional } from '../src/brevo.js';

describe('htmlToText — plain-text derived from owned HTML emails', () => {
  test('strips tags and keeps readable text', () => {
    const html = '<h1>You’re booked!</h1><p>See you soon.</p>';
    const text = htmlToText(html);
    assert.ok(text.includes('You’re booked!'));
    assert.ok(text.includes('See you soon.'));
    assert.ok(!text.includes('<'), 'no tags should remain');
  });

  test('keeps links as visible URLs', () => {
    const html = '<a href="https://wogococktailwalk.com/maps/x">Open your route map</a>';
    const text = htmlToText(html);
    assert.ok(text.includes('https://wogococktailwalk.com/maps/x'), 'the URL must survive as plain text');
    assert.ok(text.includes('Open your route map'), 'the label must survive too');
  });

  test('decodes named and numeric entities', () => {
    const html = 'Amsterdam &middot; 4 guests &mdash; &#8226; bullet &amp; &#39;quoted&#39;';
    const text = htmlToText(html);
    assert.ok(text.includes('Amsterdam · 4 guests'));
    assert.ok(text.includes('—'));
    assert.ok(text.includes('•'));
    assert.ok(text.includes('&'));
    assert.ok(text.includes("'quoted'"));
  });

  test('block tags become line breaks, not run-together text', () => {
    const html = '<table><tr><td>Route</td></tr><tr><td>Amsterdam</td></tr></table><p>Next line.</p>';
    const text = htmlToText(html);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.ok(lines.includes('Route'));
    assert.ok(lines.includes('Amsterdam'));
    assert.ok(lines.includes('Next line.'));
  });

  test('drops <head>/<style>/<script> content entirely', () => {
    const html = '<head><title>hidden</title></head><style>.x{color:red}</style><script>evil()</script><p>Visible</p>';
    const text = htmlToText(html);
    assert.equal(text, 'Visible');
  });

  test('drops the hidden inbox-preview div (layout()\'s display:none preheader)', () => {
    const html = '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Hidden preview text</div><p>Visible body</p>';
    const text = htmlToText(html);
    assert.equal(text, 'Visible body');
  });

  test('collapses excess blank lines and trims', () => {
    const html = '<p>A</p>\n\n\n\n<p>B</p>';
    const text = htmlToText(html);
    assert.ok(!/\n{3,}/.test(text));
  });

  test('empty/undefined input returns empty string', () => {
    assert.equal(htmlToText(''), '');
    assert.equal(htmlToText(undefined), '');
    assert.equal(htmlToText(null), '');
  });
});

describe('sendTransactional — every owned-HTML send carries a textContent alternative', () => {
  const realFetch = global.fetch;
  let captured;
  beforeEach(() => {
    captured = null;
    global.fetch = async (url, opts) => {
      captured = JSON.parse(opts.body);
      return new Response('{}', { status: 200 });
    };
  });
  afterEach(() => { global.fetch = realFetch; });

  test('derives textContent from htmlContent when none is supplied', async () => {
    const env = { BREVO_API_KEY: 'key_x' };
    await sendTransactional(env, {
      to: 'guest@example.com',
      subject: 'You are booked',
      htmlContent: '<h1>Hi</h1><p>See you at <strong>19:30</strong>.</p>',
    });
    assert.ok(captured.textContent, 'textContent must be present');
    assert.ok(captured.textContent.includes('Hi'));
    assert.ok(captured.textContent.includes('See you at'));
    assert.ok(!captured.textContent.includes('<'));
  });

  test('an explicit textContent overrides the derived one', async () => {
    const env = { BREVO_API_KEY: 'key_x' };
    await sendTransactional(env, {
      to: 'guest@example.com',
      subject: 'You are booked',
      htmlContent: '<p>ignored for text</p>',
      textContent: 'Custom plain text body',
    });
    assert.equal(captured.textContent, 'Custom plain text body');
  });

  test('a legacy templateId send is untouched (no textContent added)', async () => {
    const env = { BREVO_API_KEY: 'key_x' };
    await sendTransactional(env, { to: 'guest@example.com', templateId: 5, params: { a: 1 } });
    assert.equal(captured.textContent, undefined);
    assert.equal(captured.templateId, 5);
  });
});
