// test/geo.test.js — GET /api/geo (guest_api.handleGeo). The homepage floats
// the visitor's own country section to the top from this. Contract: returns
// {"country":"GB"} (ISO-3166 alpha-2, UPPERCASE) from the CURRENT request's
// Cloudflare geo (request.cf.country, or the CF-IPCountry header), and
// {"country":null} when unknown. Nothing is stored — it's a pure function of
// the request — so these tests are just input → output + CORS.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleGeo, corsHeaders } from '../src/guest_api.js';

// A minimal request stand-in: handleGeo only touches request.cf and
// request.headers.get (via corsHeaders). request.cf mirrors the Cloudflare
// Workers runtime, where it's a plain property on the incoming request.
function geoRequest({ cf, headers } = {}) {
  return { cf, headers: new Headers(headers || {}) };
}

describe('GET /api/geo', () => {
  test('returns the country from request.cf.country', async () => {
    const res = handleGeo(geoRequest({ cf: { country: 'GB' } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { country: 'GB' });
  });

  test('falls back to the CF-IPCountry header when request.cf is absent', async () => {
    const res = handleGeo(geoRequest({ headers: { 'CF-IPCountry': 'NL' } }));
    assert.deepEqual(await res.json(), { country: 'NL' });
  });

  test('prefers request.cf.country over the header', async () => {
    const res = handleGeo(geoRequest({ cf: { country: 'US' }, headers: { 'CF-IPCountry': 'NL' } }));
    assert.deepEqual(await res.json(), { country: 'US' });
  });

  test('uppercases and trims a lowercase / padded code', async () => {
    const res = handleGeo(geoRequest({ headers: { 'CF-IPCountry': ' gb ' } }));
    assert.deepEqual(await res.json(), { country: 'GB' });
  });

  test('returns null when there is no geo at all', async () => {
    const res = handleGeo(geoRequest());
    assert.deepEqual(await res.json(), { country: null });
  });

  test("maps Cloudflare's 'XX' unknown sentinel to null", async () => {
    const res = handleGeo(geoRequest({ cf: { country: 'XX' } }));
    assert.deepEqual(await res.json(), { country: null });
  });

  test("maps Cloudflare's 'T1' Tor sentinel to null", async () => {
    const res = handleGeo(geoRequest({ headers: { 'CF-IPCountry': 'T1' } }));
    assert.deepEqual(await res.json(), { country: null });
  });

  test('rejects a malformed (non 2-letter) code as null', async () => {
    const res = handleGeo(geoRequest({ cf: { country: 'GBR' } }));
    assert.deepEqual(await res.json(), { country: null });
  });

  test('echoes an allowlisted Origin in the CORS header (same allowlist as other guest endpoints)', async () => {
    const req = geoRequest({ cf: { country: 'GB' }, headers: { Origin: 'https://www.wogococktailwalk.com' } });
    const res = handleGeo(req);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://www.wogococktailwalk.com');
    // sanity: corsHeaders is what wired that up
    assert.equal(corsHeaders(req)['Access-Control-Allow-Origin'], 'https://www.wogococktailwalk.com');
  });

  test('localhost dev origin is allowed for local preview', async () => {
    const res = handleGeo(geoRequest({ cf: { country: 'GB' }, headers: { Origin: 'http://localhost:8000' } }));
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
  });

  test('a non-allowlisted Origin gets no allow-origin header', async () => {
    const res = handleGeo(geoRequest({ cf: { country: 'GB' }, headers: { Origin: 'https://evil.example.com' } }));
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  });
});
