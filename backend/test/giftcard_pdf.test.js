import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildGiftCardPdf, giftCardPdfAttachment, giftCardBackgroundUrl } from '../src/giftcard_pdf.js';

const bgEn = readFileSync(new URL('../../email/giftcard-pdf-en.jpg', import.meta.url));
const bgNl = readFileSync(new URL('../../email/giftcard-pdf-nl.jpg', import.meta.url));
const card = {
  code: 'WOGO-2WJF-RK2R', initial_cents: 6000, balance_cents: 6000, currency: 'EUR', locale: 'en',
  buyer_name: 'Maroussia', recipient_name: 'Selin Özel',
  message: 'Happy birthday! Let\'s go for cocktails 🍹 soon, you deserve a night out with the three of us.',
};

describe('gift card PDF', () => {
  test('builds a one-page PDF, also with emoji in the message', async () => {
    const bytes = await buildGiftCardPdf(card, new Uint8Array(bgEn));
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
    assert.ok(bytes.length > 50000, 'contains the background image');
    if (process.env.GIFT_PDF_OUT) writeFileSync(`${process.env.GIFT_PDF_OUT}/giftcard-en.pdf`, bytes);
  });

  test('Dutch card, no names and no message still builds', async () => {
    const bytes = await buildGiftCardPdf({ code: 'WOGO-AAAA-BBBB', initial_cents: 3000, locale: 'nl' }, new Uint8Array(bgNl));
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
    if (process.env.GIFT_PDF_OUT) writeFileSync(`${process.env.GIFT_PDF_OUT}/giftcard-nl.pdf`, bytes);
  });

  test('attachment: named after the code, base64 content, language picks the background', async () => {
    const asked = [];
    const fetchOk = async (url) => { asked.push(url); return { ok: true, arrayBuffer: async () => bgNl.buffer.slice(bgNl.byteOffset, bgNl.byteOffset + bgNl.byteLength) }; };
    const att = await giftCardPdfAttachment({ ...card, locale: 'nl' }, { fetch: fetchOk });
    assert.equal(att.name, 'WOGO-cadeaubon-WOGO-2WJF-RK2R.pdf');
    assert.ok(Buffer.from(att.content, 'base64').subarray(0, 5).toString() === '%PDF-');
    assert.deepEqual(asked, [giftCardBackgroundUrl('nl')]);
  });

  test('attachment: a failed background download gives null, never throws', async () => {
    assert.equal(await giftCardPdfAttachment(card, { fetch: async () => ({ ok: false, status: 404 }) }), null);
    assert.equal(await giftCardPdfAttachment(card, { fetch: async () => { throw new Error('offline'); } }), null);
  });
});
