// test/blog_sanitize.test.js — src/logic.js's blog-post helpers (BUILD §21):
// sanitizeBlogHtml (the one thing standing between a teammate's editor and a
// live public page), validateBlogSlug, validateBlogCategory, stripHtmlTags.
// Pure functions only — no DB, no Worker runtime assumptions.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeBlogHtml, validateBlogSlug, validateBlogCategory, stripHtmlTags, BLOG_SLUG_RE,
} from '../src/logic.js';

describe('sanitizeBlogHtml — allowlist', () => {
  test('keeps every allowed tag untouched', () => {
    const html = '<p>Hello <strong>world</strong> <em>!</em></p><h2>H2</h2><h3>H3</h3>' +
      '<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>quote</blockquote>' +
      '<figure><img src="https://example.com/a.jpg" alt="a"><figcaption>cap</figcaption></figure>' +
      'line<br>break<hr>';
    const out = sanitizeBlogHtml(html);
    assert.ok(out.includes('<p>Hello <strong>world</strong> <em>!</em></p>'));
    assert.ok(out.includes('<h2>H2</h2>'));
    assert.ok(out.includes('<h3>H3</h3>'));
    assert.ok(out.includes('<ul><li>one</li></ul>'));
    assert.ok(out.includes('<ol><li>two</li></ol>'));
    assert.ok(out.includes('<blockquote>quote</blockquote>'));
    assert.ok(out.includes('<figcaption>cap</figcaption>'));
    assert.ok(out.includes('<br />'));
    assert.ok(out.includes('<hr />'));
  });

  test('strips <script> tags AND their content entirely', () => {
    const out = sanitizeBlogHtml('<p>before</p><script>alert(1)</script><p>after</p>');
    assert.ok(!out.includes('script'));
    assert.ok(!out.includes('alert'));
    assert.ok(out.includes('before'));
    assert.ok(out.includes('after'));
  });

  test('strips <style> tags and their content', () => {
    const out = sanitizeBlogHtml('<style>body{color:red}</style><p>text</p>');
    assert.ok(!out.includes('style'));
    assert.ok(!out.includes('color:red'));
    assert.ok(out.includes('text'));
  });

  test('strips HTML comments', () => {
    const out = sanitizeBlogHtml('<!-- hidden --><p>visible</p>');
    assert.ok(!out.includes('hidden'));
    assert.ok(out.includes('visible'));
  });

  test('drops a disallowed tag but KEEPS its inner text', () => {
    const out = sanitizeBlogHtml('<div onclick="evil()">kept text</div>');
    assert.ok(!out.includes('div'));
    assert.ok(!out.includes('onclick'));
    assert.ok(!out.includes('evil'));
    assert.ok(out.includes('kept text'));
  });

  test('drops every on* event handler on an ALLOWED tag', () => {
    const out = sanitizeBlogHtml('<p onmouseover="evil()" onclick="x()">text</p>');
    assert.ok(!out.includes('onmouseover'));
    assert.ok(!out.includes('onclick'));
    assert.ok(!out.includes('evil'));
    assert.ok(out.includes('<p>text</p>'));
  });

  test('drops style/class attributes on an allowed tag', () => {
    const out = sanitizeBlogHtml('<p style="color:red" class="foo">text</p>');
    assert.ok(!out.includes('style='));
    assert.ok(!out.includes('class='));
    assert.ok(out.includes('<p>text</p>'));
  });

  test('keeps href/rel/target on <a>, drops everything else', () => {
    const out = sanitizeBlogHtml('<a href="https://wogococktailwalk.com" onclick="x()" style="color:red">link</a>');
    assert.ok(out.includes('href="https://wogococktailwalk.com"'));
    assert.ok(!out.includes('onclick'));
    assert.ok(!out.includes('style='));
  });

  test('rejects javascript: URLs in href', () => {
    const out = sanitizeBlogHtml('<a href="javascript:alert(1)">link</a>');
    assert.ok(!out.includes('javascript:'));
  });

  test('rejects data: and vbscript: and file: URLs in src/href', () => {
    for (const scheme of ['data:text/html,x', 'vbscript:x', 'file:///etc/passwd']) {
      const out = sanitizeBlogHtml(`<img src="${scheme}" alt="x">`);
      assert.ok(!out.includes(scheme), `expected ${scheme} to be stripped`);
    }
  });

  test('keeps a normal https image src/alt', () => {
    const out = sanitizeBlogHtml('<img src="https://example.com/a.jpg" alt="a photo">');
    assert.ok(out.includes('src="https://example.com/a.jpg"'));
    assert.ok(out.includes('alt="a photo"'));
  });

  test('forces rel="noopener" onto a target="_blank" link with no rel of its own', () => {
    const out = sanitizeBlogHtml('<a href="https://x.com" target="_blank">link</a>');
    assert.ok(out.includes('rel="noopener"'));
  });

  test('does not duplicate rel when the author already set one', () => {
    const out = sanitizeBlogHtml('<a href="https://x.com" target="_blank" rel="nofollow">link</a>');
    assert.equal((out.match(/rel="/g) || []).length, 1);
    assert.ok(out.includes('rel="nofollow"'));
  });

  test('a single-quoted attribute value containing a raw " is re-escaped so it cannot break out of the double-quoted output', () => {
    // parseBlogAttrs accepts single-quoted values too; the output always
    // re-serializes as double-quoted, so a raw " inside a single-quoted
    // INPUT value must be escaped on the way out, or it would terminate the
    // attribute early and let the rest of the string become new markup.
    const out = sanitizeBlogHtml(`<a href='https://x.com/?q="val"'>link</a>`);
    assert.ok(out.includes('&quot;val&quot;'));
    assert.ok(!/href="https:\/\/x\.com\/\?q="val"/.test(out));
  });

  test('null/undefined input is a safe empty string', () => {
    assert.equal(sanitizeBlogHtml(null), '');
    assert.equal(sanitizeBlogHtml(undefined), '');
  });

  test('an unterminated tag-looking "<" does not crash and drops the remainder safely', () => {
    const out = sanitizeBlogHtml('<p>before</p><unterminated');
    assert.ok(out.includes('before'));
  });
});

describe('validateBlogSlug', () => {
  test('accepts a well-formed slug', () => {
    assert.deepEqual(validateBlogSlug('best-cocktail-bars'), { ok: true, slug: 'best-cocktail-bars' });
  });
  test('rejects uppercase', () => { assert.equal(validateBlogSlug('Best-Bars').ok, false); });
  test('rejects spaces/special characters', () => { assert.equal(validateBlogSlug('best bars!').ok, false); });
  test('rejects too short (< 3 chars)', () => { assert.equal(validateBlogSlug('ab').ok, false); });
  test('rejects too long (> 80 chars)', () => { assert.equal(validateBlogSlug('a'.repeat(81)).ok, false); });
  test('rejects empty/non-string', () => {
    assert.equal(validateBlogSlug('').ok, false);
    assert.equal(validateBlogSlug(undefined).ok, false);
    assert.equal(validateBlogSlug(42).ok, false);
  });
  test('BLOG_SLUG_RE matches the documented shape directly', () => {
    assert.ok(BLOG_SLUG_RE.test('abc'));
    assert.ok(BLOG_SLUG_RE.test('a'.repeat(80)));
    assert.ok(!BLOG_SLUG_RE.test('a'.repeat(81)));
  });
});

describe('validateBlogCategory', () => {
  const CATS = ['City guide', 'New route', 'Explained', 'Recipes', 'News'];
  test('accepts an exact match', () => {
    assert.deepEqual(validateBlogCategory('News', CATS), { ok: true, category: 'News' });
  });
  test('rejects a category not in the list', () => {
    assert.equal(validateBlogCategory('Gossip', CATS).ok, false);
  });
  test('is case-sensitive (no silent normalization)', () => {
    assert.equal(validateBlogCategory('news', CATS).ok, false);
  });
});

describe('stripHtmlTags', () => {
  test('strips tags, keeps text', () => {
    assert.equal(stripHtmlTags('<b>bold</b> text'), 'bold text');
  });
  test('decodes common entities', () => {
    assert.equal(stripHtmlTags('Fish &amp; chips &quot;great&quot;'), 'Fish & chips "great"');
  });
  test('trims and caps length when a max is given', () => {
    assert.equal(stripHtmlTags('  hello world  ', 5), 'hello');
  });
  test('null/undefined is an empty string', () => {
    assert.equal(stripHtmlTags(null), '');
    assert.equal(stripHtmlTags(undefined), '');
  });
});
