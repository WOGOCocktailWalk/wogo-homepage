// test/brevo_templates.test.js — Brevo reference-copy pass (BUILD §19):
// brevo.js's transactional-TEMPLATES API client (listContactTemplates/
// upsertTransactionalTemplate), emails.js:buildReferenceTemplateSet, and
// POST /admin/api/brevo/push-reference-templates end to end against a
// stateful mocked global.fetch (folders/templates with real find-by-name
// semantics — not just "a call was made").

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listContactTemplates, upsertTransactionalTemplate } from '../src/brevo.js';
import { buildReferenceTemplateSet } from '../src/emails.js';
import { handleBrevoPushReferenceTemplates } from '../src/admin_api.js';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

// A small stateful fake of Brevo's /v3/smtp/templates — mirrors the "real
// idempotent find-or-create" testing style of test/subscribers.test.js's
// Brevo fake, scoped to just the templates endpoints this feature touches.
function makeFakeBrevoTemplates() {
  const templates = []; // {id, name, subject, sender, htmlContent, isActive}
  let nextId = 1;
  const calls = [];

  const fetchFn = async (url, opts = {}) => {
    const u = new URL(String(url));
    calls.push({ method: opts.method || 'GET', path: u.pathname + u.search });
    if (u.pathname === '/v3/smtp/templates' && (!opts.method || opts.method === 'GET')) {
      const status = u.searchParams.get('templateStatus');
      const wantActive = status === 'true';
      const limit = Number(u.searchParams.get('limit')) || 50;
      const offset = Number(u.searchParams.get('offset')) || 0;
      const matching = templates.filter((t) => !!t.isActive === wantActive);
      const page = matching.slice(offset, offset + limit);
      return new Response(JSON.stringify({ templates: page.map((t) => ({ id: t.id, name: t.name })) }), { status: 200 });
    }
    if (u.pathname === '/v3/smtp/templates' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      const row = { id: nextId++, name: body.templateName, subject: body.subject, sender: body.sender, htmlContent: body.htmlContent, isActive: !!body.isActive };
      templates.push(row);
      return new Response(JSON.stringify({ id: row.id }), { status: 201 });
    }
    const putMatch = u.pathname.match(/^\/v3\/smtp\/templates\/(\d+)$/);
    if (putMatch && opts.method === 'PUT') {
      const id = Number(putMatch[1]);
      const row = templates.find((t) => t.id === id);
      const body = JSON.parse(opts.body);
      Object.assign(row, { subject: body.subject, sender: body.sender, htmlContent: body.htmlContent, isActive: !!body.isActive });
      return new Response(null, { status: 204 });
    }
    throw new Error('unmocked Brevo call: ' + opts.method + ' ' + u.pathname);
  };
  return { fetchFn, templates, calls };
}

// ---------------------------------------------------------------------------
// brevo.js — listContactTemplates / upsertTransactionalTemplate
// ---------------------------------------------------------------------------

describe('upsertTransactionalTemplate', () => {
  test('creates a new template when no name match exists', async () => {
    const fake = makeFakeBrevoTemplates();
    global.fetch = fake.fetchFn;
    const env = { BREVO_API_KEY: 'key_x' };
    const result = await upsertTransactionalTemplate(env, {
      templateName: '[REFERENCE] Guest confirmation (EN)', subject: 'Subj', sender: { name: 'WOGO', email: 'info@wogoamsterdam.com' }, htmlContent: '<p>hi</p>', isActive: false,
    });
    assert.equal(result.created, true);
    assert.equal(fake.templates.length, 1);
    assert.equal(fake.templates[0].isActive, false);
  });

  test('a second upsert with the SAME name updates the existing template (PUT), not a duplicate', async () => {
    const fake = makeFakeBrevoTemplates();
    global.fetch = fake.fetchFn;
    const env = { BREVO_API_KEY: 'key_x' };
    const fields = { templateName: '[REFERENCE] Guest confirmation (EN)', subject: 'Subj v1', sender: { name: 'WOGO', email: 'info@wogoamsterdam.com' }, htmlContent: '<p>v1</p>', isActive: false };
    const first = await upsertTransactionalTemplate(env, fields);
    const second = await upsertTransactionalTemplate(env, { ...fields, subject: 'Subj v2', htmlContent: '<p>v2</p>' });
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.equal(fake.templates.length, 1, 'still exactly one template, not two');
    assert.equal(fake.templates[0].subject, 'Subj v2');
    assert.equal(fake.templates[0].htmlContent, '<p>v2</p>');
  });

  test('listContactTemplates pages through both inactive and active templates', async () => {
    const fake = makeFakeBrevoTemplates();
    global.fetch = fake.fetchFn;
    const env = { BREVO_API_KEY: 'key_x' };
    await upsertTransactionalTemplate(env, { templateName: 'A', subject: 's', sender: {}, htmlContent: '<p/>', isActive: false });
    await upsertTransactionalTemplate(env, { templateName: 'B', subject: 's', sender: {}, htmlContent: '<p/>', isActive: true });
    const all = await listContactTemplates(env, 50);
    assert.equal(all.length, 2);
    assert.ok(all.some((t) => t.name === 'A'));
    assert.ok(all.some((t) => t.name === 'B'));
  });
});

// ---------------------------------------------------------------------------
// emails.js — buildReferenceTemplateSet
// ---------------------------------------------------------------------------

describe('buildReferenceTemplateSet', () => {
  test('renders every expected reference template, each named/tagged distinctly, never used to actually send', () => {
    const set = buildReferenceTemplateSet();
    assert.equal(set.length, 21);
    const names = set.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'no duplicate template names');
    names.forEach((n) => {
      assert.ok(n.startsWith('[REFERENCE] '), `"${n}" must carry the [REFERENCE] prefix`);
      assert.ok(n.includes('copy only, editing here changes nothing'));
    });
    set.forEach((t) => {
      assert.ok(t.subject && t.subject.length > 0);
      assert.ok(t.html.includes('<'), 'every entry has real rendered HTML');
    });
    assert.ok(names.some((n) => n.includes('Guest confirmation') && n.includes('(EN)')));
    assert.ok(names.some((n) => n.includes('Guest confirmation') && n.includes('(NL)')));
    assert.ok(names.some((n) => n.includes('Gift card recipient') && n.includes('(NL)')));
    assert.ok(names.some((n) => n.includes('Review request') && n.includes('(NL)')));
  });
});

// ---------------------------------------------------------------------------
// POST /admin/api/brevo/push-reference-templates
// ---------------------------------------------------------------------------

function pushRequest(headers = {}) {
  return new Request('https://api.example.com/admin/api/brevo/push-reference-templates', {
    method: 'POST', headers: { 'X-Requested-With': 'wogo-admin', ...headers },
  });
}

describe('POST /admin/api/brevo/push-reference-templates', () => {
  test('rejected without the CSRF header', async () => {
    const res = await handleBrevoPushReferenceTemplates(new Request('https://api.example.com/admin/api/brevo/push-reference-templates', { method: 'POST' }), { BREVO_API_KEY: 'key_x' });
    assert.equal(res.status, 403);
  });

  test('400 when BREVO_API_KEY is not configured', async () => {
    const res = await handleBrevoPushReferenceTemplates(pushRequest(), {});
    assert.equal(res.status, 400);
  });

  test('pushes all 21 reference templates on a first run; a second run updates in place, not duplicates', async () => {
    const fake = makeFakeBrevoTemplates();
    global.fetch = fake.fetchFn;
    const env = { BREVO_API_KEY: 'key_x' }; // no DB — audit() swallows its own write failure

    const first = await handleBrevoPushReferenceTemplates(pushRequest(), env);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.pushed, 21);
    assert.equal(firstBody.failed, 0);
    assert.equal(fake.templates.length, 21);
    assert.ok(fake.templates.every((t) => t.isActive === false), 'every reference template is created INACTIVE');
    assert.ok(fake.templates.every((t) => t.sender.email === 'info@wogoamsterdam.com'));

    const second = await handleBrevoPushReferenceTemplates(pushRequest(), env);
    const secondBody = await second.json();
    assert.equal(secondBody.pushed, 21);
    assert.equal(fake.templates.length, 21, 'still 21 — the second run updated in place');
  });

  test('a per-template Brevo failure is reported, not fatal to the rest of the run', async () => {
    let calls = 0;
    global.fetch = async (url, opts) => {
      const u = new URL(String(url));
      if (u.pathname === '/v3/smtp/templates' && (!opts.method || opts.method === 'GET')) {
        return new Response(JSON.stringify({ templates: [] }), { status: 200 });
      }
      if (u.pathname === '/v3/smtp/templates' && opts.method === 'POST') {
        calls++;
        if (calls === 1) return new Response('rate limited', { status: 429 });
        return new Response(JSON.stringify({ id: calls }), { status: 201 });
      }
      throw new Error('unmocked: ' + opts.method + ' ' + u.pathname);
    };
    const env = { BREVO_API_KEY: 'key_x' };
    const res = await handleBrevoPushReferenceTemplates(pushRequest(), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.failed, 1);
    assert.equal(body.pushed, 20);
    assert.ok(body.templates.find((t) => t.error));
  });
});
