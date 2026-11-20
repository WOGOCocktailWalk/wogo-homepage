// test/campaigns.test.js — the owner "Campaigns" page API (20 Nov 2026):
// send/schedule a Brevo campaign from a saved template to a language group.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeTestDb } from './sqlite-d1-adapter.js';
import { handleCreateCampaign, handleTestCampaign, handleListCampaigns, handleCancelCampaign } from '../src/admin_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = ['0001_init.sql', '0007_admin_audit.sql', '0024_subscribers.sql', '0025_admin_users.sql']
  .map((n) => readFileSync(path.join(__dirname, `../migrations/${n}`), 'utf8')).join('\n');

const HTML_OK = '<html><body>Hi <a href="{{ unsubscribe }}">Unsubscribe</a> <a href="{{ mirror }}">web</a></body></html>';
let db, calls, realFetch, templates;

function req(body, url = 'https://x/admin/api/campaigns') {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin' }, body: JSON.stringify(body) });
}
function env() { return { DB: db, BREVO_API_KEY: 'k' }; }
function addSub(email, locale, status = 'confirmed') {
  db.prepare(`INSERT INTO subscribers (id, email, locale, source, status, unsubscribe_token, created_at) VALUES (?, ?, ?, 'wix_import', ?, ?, datetime('now'))`)
    .bind('sub_' + email, email, locale, status, 'tok_' + email).run();
}
function jsonRes(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }); }

beforeEach(async () => {
  db = makeTestDb(schemaSql);
  await db.prepare(`INSERT INTO settings (k, v) VALUES ('brevo_list_id', '7')`).run();
  calls = [];
  templates = {
    22: { id: 22, name: 'New website is live (EN)', subject: 'Our new website is live', isActive: true, htmlContent: HTML_OK },
    23: { id: 23, name: 'New website is live (NL)', subject: 'Onze nieuwe website', isActive: true, htmlContent: HTML_OK },
    5: { id: 5, name: '[REFERENCE] Booking confirmation', subject: 'x', isActive: true, htmlContent: HTML_OK },
    9: { id: 9, name: 'No unsubscribe', subject: 'x', isActive: true, htmlContent: '<p>hi</p>' },
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    let m;
    if ((m = u.match(/\/smtp\/templates\/(\d+)$/))) return templates[m[1]] ? jsonRes(templates[m[1]]) : jsonRes({ message: 'nf' }, 404);
    if (u.includes('/smtp/templates?')) return jsonRes({ templates: u.includes('templateStatus=true') ? Object.values(templates) : [] });
    if (u.includes('/contacts/folders?')) return jsonRes({ folders: [{ id: 3, name: 'WOGO' }] });
    if (u.includes('/contacts/lists?')) return jsonRes({ lists: [] });
    if (u.endsWith('/contacts/lists') && method === 'POST') return jsonRes({ id: 99 }, 201);
    if (/\/contacts\/lists\/\d+\/contacts\/add$/.test(u)) return jsonRes({ contacts: { success: body.emails, failure: [] } }, 201);
    if (u.endsWith('/emailCampaigns') && method === 'POST') return jsonRes({ id: 501 }, 201);
    if (u.includes('/emailCampaigns?')) return jsonRes({ campaigns: [{ id: 501, name: 'n', subject: 's', status: 'queued', scheduledAt: '2030-01-01T18:00:00Z' }] });
    if (/\/emailCampaigns\/\d+\/sendNow$/.test(u)) return new Response(null, { status: 204 });
    if (/\/emailCampaigns\/\d+\/status$/.test(u)) return new Response(null, { status: 204 });
    if (u.endsWith('/smtp/email')) return jsonRes({ messageId: 'm' }, 201);
    return jsonRes({ message: 'unexpected ' + u }, 500);
  };
  addSub('a@nl.nl', 'nl'); addSub('b@nl.nl', 'nl'); addSub('c@en.com', 'en');
  addSub('gone@nl.nl', 'nl', 'unsubscribed');
});
afterEach(() => { globalThis.fetch = realFetch; });

const future = () => new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();

describe('campaigns API', () => {
  test('refuses without confirm: true, and never calls Brevo', async () => {
    const res = await handleCreateCampaign(req({ template_id: 23, subject: 's', audience: 'nl', scheduled_at: future() }), env());
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  test('schedules the NL design to ONLY confirmed Dutch subscribers via a fresh list', async () => {
    const when = future();
    const res = await handleCreateCampaign(req({ template_id: 23, subject: 'Onze nieuwe website', preview_text: 'p', audience: 'nl', scheduled_at: when, confirm: true }), env());
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.recipients, 2);
    const add = calls.find((c) => c.url.endsWith('/contacts/lists/99/contacts/add'));
    assert.deepEqual(add.body.emails.sort(), ['a@nl.nl', 'b@nl.nl'], 'no English, no unsubscribed');
    const create = calls.find((c) => c.url.endsWith('/emailCampaigns') && c.method === 'POST');
    assert.deepEqual(create.body.recipients, { listIds: [99] });
    assert.equal(create.body.scheduledAt, new Date(when).toISOString());
    assert.equal(create.body.previewText, 'p');
    assert.ok(!calls.some((c) => c.url.includes('sendNow')), 'scheduled, not sent now');
  });

  test('"everyone" uses the main subscriber list', async () => {
    const res = await handleCreateCampaign(req({ template_id: 22, subject: 's', audience: 'all', scheduled_at: future(), confirm: true }), env());
    assert.equal(res.status, 200);
    const create = calls.find((c) => c.url.endsWith('/emailCampaigns') && c.method === 'POST');
    assert.deepEqual(create.body.recipients, { listIds: [7] });
  });

  test('send now calls sendNow', async () => {
    const res = await handleCreateCampaign(req({ template_id: 22, subject: 's', audience: 'en', send_now: true, confirm: true }), env());
    assert.equal(res.status, 200);
    assert.ok(calls.some((c) => c.url.endsWith('/emailCampaigns/501/sendNow')));
  });

  test('rejects a time in the past, reference designs, and designs without unsubscribe link', async () => {
    let res = await handleCreateCampaign(req({ template_id: 23, subject: 's', audience: 'nl', scheduled_at: new Date(Date.now() - 60000).toISOString(), confirm: true }), env());
    assert.equal(res.status, 400);
    res = await handleCreateCampaign(req({ template_id: 5, subject: 's', audience: 'nl', scheduled_at: future(), confirm: true }), env());
    assert.equal(res.status, 400);
    res = await handleCreateCampaign(req({ template_id: 9, subject: 's', audience: 'nl', scheduled_at: future(), confirm: true }), env());
    assert.equal(res.status, 400);
    assert.ok(!calls.some((c) => c.url.endsWith('/emailCampaigns') && c.method === 'POST'), 'no campaign created');
  });

  test('test send goes to one address, marked [TEST], placeholders replaced', async () => {
    const res = await handleTestCampaign(req({ template_id: 23, subject: 'Hoi', to: 'me@x.nl' }, 'https://x/admin/api/campaigns/test'), env());
    assert.equal(res.status, 200);
    const sent = calls.find((c) => c.url.endsWith('/smtp/email'));
    assert.deepEqual(sent.body.to, [{ email: 'me@x.nl' }]);
    assert.equal(sent.body.subject, '[TEST] Hoi');
    assert.ok(!sent.body.htmlContent.includes('{{'));
  });

  test('list hides reference designs and counts groups', async () => {
    const res = await handleListCampaigns(new Request('https://x/admin/api/campaigns'), env());
    const j = await res.json();
    assert.deepEqual(j.audiences, { all: 3, nl: 2, en: 1 });
    assert.ok(!j.templates.some((t) => t.name.startsWith('[REFERENCE]')));
    assert.equal(j.campaigns[0].status, 'queued');
  });

  test('cancel suspends the campaign', async () => {
    const res = await handleCancelCampaign(req({}, 'https://x/admin/api/campaigns/501/cancel'), env(), { id: '501' });
    assert.equal(res.status, 200);
    const c = calls.find((x) => x.url.endsWith('/emailCampaigns/501/status'));
    assert.deepEqual(c.body, { status: 'suspended' });
  });
});
