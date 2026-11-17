/* ==========================================================================
   backend/scripts/republish_blog_posts.mjs — one-off: publish every ALREADY
   published blog post again, so each one gets the new page layout and, when it
   has Dutch text, its real Dutch page under /nl/blog/ (plus both indexes and
   the sitemap lines). Same as pressing "Publish" on each post in the dashboard,
   without the clicking. It goes through the admin API, so every normal check
   and audit entry runs; it never touches D1 or GitHub directly.

   Safe to run again: a post whose pages did not change makes no commit. Each
   post is one git commit (the live site rebuilds once per commit).

   The admin token is read from an ENVIRONMENT VARIABLE only (never a flag, so
   it does not end up in shell history or process lists):
     WOGO_ADMIN_TOKEN   the Worker's ADMIN_TOKEN secret
     WOGO_ADMIN_URL     the Worker's address, e.g. https://admin.example.com  (or --base-url=)

   Usage (from backend/):
     node scripts/republish_blog_posts.mjs --dry-run     lists what it would do; publishes nothing
     node scripts/republish_blog_posts.mjs               does it
   Options:
     --only=slug-a,slug-b   just these posts
     --branch=name          commit to a scratch branch instead of main (owner-only rehearsal)
     --delay-ms=1500        pause between posts (default 1500)
   ========================================================================== */
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const bare = a.replace(/^--/, '');
    const eq = bare.indexOf('=');
    if (eq === -1) out[bare] = true; else out[bare.slice(0, eq)] = bare.slice(eq + 1);
  }
  return out;
}

const hasDutch = (post) => !!(post.body_nl && String(post.body_nl).replace(/<[^>]*>/g, '').trim());

export async function run({ argv = [], env = {}, fetchImpl = fetch, log = console.log, err = console.error, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const args = parseArgs(argv);
  const dry = !!args['dry-run'];
  const token = env.WOGO_ADMIN_TOKEN;
  const base = String(args['base-url'] || env.WOGO_ADMIN_URL || '').replace(/\/+$/, '');
  if (args['admin-token']) { err('Pass the token in the WOGO_ADMIN_TOKEN environment variable, not as a flag.'); return 2; }
  if (!token || !base) { err('Set WOGO_ADMIN_TOKEN and WOGO_ADMIN_URL (or --base-url=) first. See the top of this script.'); return 2; }
  const delay = Number(args['delay-ms'] ?? 1500);
  const branch = typeof args.branch === 'string' ? args.branch : '';
  const only = typeof args.only === 'string' ? new Set(args.only.split(',').map((x) => x.trim()).filter(Boolean)) : null;

  const login = await fetchImpl(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!login.ok) { err(`Login failed (${login.status}). Is WOGO_ADMIN_TOKEN right for ${base}?`); return 1; }
  const setCookie = login.headers.get('set-cookie');
  if (!setCookie) { err('Login worked but returned no session cookie.'); return 1; }
  const cookie = setCookie.split(';')[0];
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'wogo-admin', Cookie: cookie };

  const listRes = await fetchImpl(`${base}/admin/api/blog?status=published`, { headers });
  if (!listRes.ok) { err(`Could not list the published posts (${listRes.status}).`); return 1; }
  let posts = ((await listRes.json()).posts || []).filter((p) => p.status === 'published');
  if (only) posts = posts.filter((p) => only.has(p.slug));
  // oldest first, so the indexes grow in a stable order
  posts.sort((a, b) => String(a.published_at || '').localeCompare(String(b.published_at || '')));

  const withNl = posts.filter(hasDutch).length;
  log(`${dry ? 'DRY RUN — ' : ''}${posts.length} published post(s): ${withNl} with Dutch text (they get a Dutch page), ${posts.length - withNl} English only.${branch ? ` Branch: ${branch}.` : ''}`);
  if (dry) {
    for (const p of posts) log(`  would publish  ${p.slug}   [${hasDutch(p) ? 'EN + NL page' : 'EN page only'}]`);
    log('Nothing was changed. Run without --dry-run to publish.');
    return 0;
  }

  let ok = 0, failed = 0;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    let res = null, text = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetchImpl(`${base}/admin/api/blog/${encodeURIComponent(p.id)}/publish`, { method: 'POST', headers, body: JSON.stringify(branch ? { branch } : {}) });
        text = await res.text();
        if (res.status < 500) break;
      } catch (e) { text = String(e && e.message || e); res = null; }
      await sleep(3000);
    }
    if (res && res.ok) {
      let sha = '';
      try { sha = JSON.parse(text).commit_sha || ''; } catch { /* keep going */ }
      ok++; log(`  [${i + 1}/${posts.length}] published  ${p.slug}   [${hasDutch(p) ? 'EN + NL' : 'EN'}]  ${sha.slice(0, 7)}`);
    } else {
      failed++;
      let msg = text; try { msg = JSON.parse(text).message || text; } catch { /* plain text */ }
      err(`  [${i + 1}/${posts.length}] FAILED     ${p.slug}: ${res ? res.status : 'no answer'} ${String(msg).slice(0, 200)}`);
    }
    if (i < posts.length - 1 && delay > 0) await sleep(delay);
  }
  log(`Done: ${ok} published, ${failed} failed.${failed ? ' Fix the failures and run again (finished posts are skipped when nothing changed).' : ''}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run({ argv: process.argv.slice(2), env: process.env }).then((code) => { process.exitCode = code; });
}
