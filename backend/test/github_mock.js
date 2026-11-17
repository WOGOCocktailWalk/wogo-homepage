// test/github_mock.js — shared fake of the GitHub API for the blog tests (no network).

import { createHash } from 'node:crypto';

/** A minimal stateful fake of the parts of GitHub's API the blog uses:
 *  - the Contents API (GET/PUT/DELETE /contents/:path, ?ref= a branch OR a commit
 *    sha) — used for single-file writes (image uploads) and for reading files, and
 *  - the Git Data API (ref, commit, tree, new commit, move the ref) — what one
 *    blog publish/unpublish uses to land ALL its files in ONE commit.
 * Each branch has its own files; `gh.files` is the default branch ('main').
 * `commitCount()` is how many commits the code created. `forceRefConflictOnce()`
 * makes the next "move the branch" call fail as "not a fast-forward" (422), as
 * if someone else had committed first; `forceConflictOnce(path)` does the same
 * as a 409 on the next Contents-API PUT of that path. */
export function makeGithubFetchMock() {
  const sha1 = (x) => createHash('sha1').update(x).digest('hex');
  const clone = (m) => new Map([...m].map(([k, v]) => [k, { ...v }]));
  const entry = (b64) => ({ sha: sha1(b64), content: b64 });
  const treeOf = (files) => sha1(JSON.stringify([...files].map(([p, f]) => [p, f.content]).sort()));
  const calls = [];
  const conflictOnce = new Set();
  let refConflictOnce = false;
  let counter = 0;
  const commits = new Map();   // sha -> { tree, parent, files }
  const branches = new Map();  // name -> { commit, files }
  const trees = new Map();     // sha -> files snapshot
  const makeCommit = (files, parent) => {
    counter += 1;
    const sha = `commit${counter}`;
    const tree = treeOf(files);
    trees.set(tree, clone(files));
    commits.set(sha, { tree, parent, files: clone(files) });
    return sha;
  };
  const root = makeCommit(new Map(), null);
  branches.set('main', { commit: root, files: new Map() });
  const filesAt = (ref) => (branches.has(ref) ? branches.get(ref).files : (commits.get(ref) || {}).files);
  const respond = (status, body) => new Response(JSON.stringify(body), { status });
  const api = {
    calls,
    get files() { return branches.get('main').files; },
    filesOn(branch) { return branches.has(branch) ? branches.get(branch).files : null; },
    createBranch(name, from = 'main') { const b = branches.get(from); branches.set(name, { commit: b.commit, files: clone(b.files) }); },
    head(branch = 'main') { return branches.get(branch).commit; },
    commitCount() { return commits.size - 1; },
    forceConflictOnce(filePath) { conflictOnce.add(filePath); },
    forceRefConflictOnce() { refConflictOnce = true; },
    /** put a file straight onto a branch (a page that already exists on the live site) */
    seed(filePath, text, branch = 'main') {
      const b = branches.get(branch);
      b.files.set(filePath, entry(Buffer.from(text, 'utf8').toString('base64')));
      b.commit = makeCommit(b.files, b.commit);
    },
    text(filePath, branch = 'main') {
      const f = branches.get(branch).files.get(filePath);
      return f ? Buffer.from(f.content, 'base64').toString('utf8') : null;
    },
    fetchMock: async (url, opts = {}) => {
      const method = (opts && opts.method) || 'GET';
      const u = new URL(String(url));
      const body = opts && opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
      calls.push({ url: String(url), method, body });
      const g = /\/repos\/[^/]+\/[^/]+\/git\/(.+)$/.exec(u.pathname);
      if (g) {
        const rest = decodeURIComponent(g[1]);
        let m;
        if (method === 'GET' && (m = /^ref\/heads\/(.+)$/.exec(rest))) {
          const b = branches.get(m[1]);
          return b ? respond(200, { object: { sha: b.commit } }) : respond(404, { message: 'Not Found' });
        }
        if (method === 'GET' && (m = /^commits\/(.+)$/.exec(rest))) {
          const c = commits.get(m[1]);
          return c ? respond(200, { tree: { sha: c.tree } }) : respond(404, { message: 'Not Found' });
        }
        if (method === 'POST' && rest === 'trees') {
          const base = trees.get(body.base_tree);
          if (!base) return respond(422, { message: 'bad base_tree' });
          const next = clone(base);
          for (const t of body.tree) {
            if (t.sha === null) {
              if (!next.has(t.path)) return respond(422, { message: `cannot delete ${t.path}: not in tree` });
              next.delete(t.path);
            } else next.set(t.path, entry(Buffer.from(t.content, 'utf8').toString('base64')));
          }
          const sha = treeOf(next);
          trees.set(sha, next);
          return respond(201, { sha });
        }
        if (method === 'POST' && rest === 'commits') {
          counter += 1;
          const sha = `commit${counter}`;
          commits.set(sha, { tree: body.tree, parent: body.parents[0], files: clone(trees.get(body.tree)), message: body.message });
          return respond(201, { sha });
        }
        if (method === 'PATCH' && (m = /^refs\/heads\/(.+)$/.exec(rest))) {
          const b = branches.get(m[1]);
          if (!b) return respond(404, { message: 'Not Found' });
          if (refConflictOnce) { refConflictOnce = false; return respond(422, { message: 'Update is not a fast forward' }); }
          const c = commits.get(body.sha);
          if (body.force !== true && c.parent !== b.commit) return respond(422, { message: 'Update is not a fast forward' });
          b.commit = body.sha; b.files = clone(c.files);
          return respond(200, { object: { sha: body.sha } });
        }
        return respond(400, { message: 'git call not mocked: ' + method + ' ' + rest });
      }
      const m = /\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(u.pathname);
      if (!m) return respond(404, { message: 'not found' });
      const filePath = decodeURIComponent(m[1]);

      if (method === 'GET') {
        const files = filesAt(u.searchParams.get('ref') || 'main');
        const existing = files && files.get(filePath);
        if (!existing) return respond(404, { message: 'Not Found' });
        return respond(200, { sha: existing.sha, content: existing.content });
      }
      const branchName = (body && body.branch) || 'main';
      const b = branches.get(branchName);
      if (!b) return respond(404, { message: 'branch not found' });
      if (method === 'PUT') {
        if (conflictOnce.has(filePath)) {
          conflictOnce.delete(filePath);
          return respond(409, { message: 'conflict' });
        }
        b.files.set(filePath, { sha: sha1(body.content), content: body.content });
        b.commit = makeCommit(b.files, b.commit);
        return respond(200, { content: { sha: b.files.get(filePath).sha }, commit: { sha: b.commit } });
      }
      if (method === 'DELETE') {
        b.files.delete(filePath);
        b.commit = makeCommit(b.files, b.commit);
        return respond(200, { commit: { sha: b.commit } });
      }
      return respond(400, { message: 'method not mocked' });
    },
  };
  return api;
}
