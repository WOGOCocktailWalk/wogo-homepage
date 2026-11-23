// test/campaigns_rest.test.js — "send to the rest" for a campaign Brevo
// stopped part-way (23 Nov 2026): people who already got it are excluded.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleSendCampaignRest } from '../src/admin_api.js';

let calls, realFetch, status;
const fakeDb = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: [] }) }), run: async () => ({}) }) };
function req(body) {
  return new Request('https://x/admin/api/campaigns/24/send-rest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' }, body: JSON.stringify(body) });
}
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = []; status = 'suspended';
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ u, method, body });
    if (u.endsWith('/emailCampaigns/24') && method === 'GET') return j({ id: 24, name: 'NL', subject: 'Onze site', status, previewText: 'p', htmlContent: '<a href="{{ unsubscribe }}">x</a>', recipients: { lists: [77], exclusionLists: [] } });
    if (u.endsWith('/emailCampaigns/24/exportRecipients')) return j({ processId: 5 }, 202);
    if (u.endsWith('/processes/5')) return j({ id: 5, status: 'completed', export_url: 'https://files.example/export.csv' });
    if (u === 'https://files.example/export.csv') return new Response('EMAIL;NAME\nA@x.nl;\nb@x.nl;\n');
    if (u.includes('/contacts/folders?')) return j({ folders: [{ id: 3, name: 'WOGO' }] });
    if (u.includes('/contacts/lists?')) return j({ lists: [] });
    if (u.endsWith('/contacts/lists') && method === 'POST') return j({ id: 88 }, 201);
    if (/\/contacts\/lists\/88\/contacts\/add$/.test(u)) return j({ contacts: { success: body.emails, failure: [] } }, 201);
    if (u.endsWith('/emailCampaigns') && method === 'POST') return j({ id: 601 }, 201);
    if (u.endsWith('/emailCampaigns/601/sendNow')) return new Response(null, { status: 204 });
    return j({ message: 'unexpected ' + u }, 500);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test('excludes the people who already got it and sends the same email to the rest', async () => {
  const res = await handleSendCampaignRest(req({ confirm: true }), { DB: fakeDb, BREVO_API_KEY: 'k' }, { id: '24' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.excluded, 2);
  const add = calls.find((c) => c.u.endsWith('/contacts/lists/88/contacts/add'));
  assert.deepEqual(add.body.emails.sort(), ['a@x.nl', 'b@x.nl']);
  const create = calls.find((c) => c.u.endsWith('/emailCampaigns') && c.method === 'POST');
  assert.deepEqual(create.body.recipients, { listIds: [77], exclusionListIds: [88] });
  assert.equal(create.body.subject, 'Onze site');
  assert.ok(calls.some((c) => c.u.endsWith('/emailCampaigns/601/sendNow')));
});

test('needs confirm and refuses a campaign that is not stopped', async () => {
  let res = await handleSendCampaignRest(req({}), { DB: fakeDb, BREVO_API_KEY: 'k' }, { id: '24' });
  assert.equal(res.status, 400);
  status = 'sent';
  res = await handleSendCampaignRest(req({ confirm: true }), { DB: fakeDb, BREVO_API_KEY: 'k' }, { id: '24' });
  assert.equal(res.status, 400);
  assert.ok(!calls.some((c) => c.u.endsWith('/emailCampaigns') && c.method === 'POST'));
});
