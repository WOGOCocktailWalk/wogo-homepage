// src/github.js — GitHub Contents API client, plain fetch, zero-dependency.
// Same shape as brevo.js/stripe.js: every function takes `env` (for
// GITHUB_TOKEN/GITHUB_REPO) and throws a plain Error with the HTTP status +
// GitHub's error body on a non-2xx response the caller doesn't explicitly
// handle itself.
//
// This is the ONLY write path from the admin dashboard to the public static
// site (BUILD §21, Blog) — every publish/unpublish/asset-upload lands as a
// real commit on the repo's default branch (or a caller-supplied branch, for
// the scratch-branch end-to-end test — see SETUP.md/the e2e test script).
//
// Workers have no Buffer/Node base64 helpers (no nodejs_compat flag, see
// wrangler.toml) — base64Encode/base64Decode below are plain Web-standard
// (TextEncoder/TextDecoder + atob/btoa) and handle full UTF-8, not just ASCII.

import { GITHUB_API_BASE, GITHUB_COMMIT_BRANCH_DEFAULT, GITHUB_COMMIT_AUTHOR } from './config.js';

/** UTF-8-safe string -> base64 (btoa alone mangles anything outside Latin-1 —
 * every WOGO post has NL copy, so this matters in practice, not just in theory). */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  return bytesToBase64(bytes);
}

/** Raw bytes (Uint8Array/ArrayBuffer — an uploaded image's body) -> base64. */
export function bytesToBase64(bytes) {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = '';
  // Chunked to avoid a call-stack blowup on a large image (String.fromCharCode
  // with a huge spread/apply argument list can exceed engine limits).
  const CHUNK = 8192;
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function repoPath(env, path) {
  if (!env.GITHUB_REPO) throw new Error('github_not_configured: GITHUB_REPO secret is not set');
  if (!env.GITHUB_TOKEN) throw new Error('github_not_configured: GITHUB_TOKEN secret is not set');
  return `${GITHUB_API_BASE}/repos/${env.GITHUB_REPO}/contents/${path}`;
}

async function githubRequest(env, method, path, body) {
  const res = await fetch(repoPath(env, path), {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'wogo-admin-dashboard',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { /* non-JSON error page, etc. */ }
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Reads one file's current `sha` + decoded text content on `branch`.
 * Returns `null` if the file doesn't exist yet (a brand-new post's first
 * publish) — NOT an error, since "doesn't exist" is the expected state for
 * a create. Any OTHER non-2xx (auth failure, rate limit, repo typo) throws.
 */
export async function getFile(env, path, branch = GITHUB_COMMIT_BRANCH_DEFAULT) {
  const { ok, status, json } = await githubRequest(
    env, 'GET', `${encodeGithubPath(path)}?ref=${encodeURIComponent(branch)}`
  );
  if (status === 404) return null;
  if (!ok) throw githubError('GET', path, status, json);
  return { sha: json.sha, content: base64ToUtf8(json.content) };
}

/**
 * Creates or updates one file in a single commit. Looks up the current
 * `sha` itself when not supplied (the normal call shape — callers don't
 * have to fetch-then-write), and retries exactly once on a `409` (someone
 * else's commit landed between the lookup and this write — refetch the sha
 * and try again; a second 409 is treated as a real failure, not retried
 * forever). `contentBytes` is either a UTF-8 string (an HTML/XML/JSON file)
 * or raw bytes (a Uint8Array/ArrayBuffer — an uploaded image).
 * Returns `{ sha, commit_sha }` — `sha` is the new file blob's sha (useful
 * for a follow-up write in the same request without another GET), `commit_sha`
 * is the commit this landed in (what blog_posts.last_published_commit stores).
 */
export async function putFile(env, path, contentBytes, message, opts = {}) {
  const branch = opts.branch || GITHUB_COMMIT_BRANCH_DEFAULT;
  const isText = typeof contentBytes === 'string';
  const base64 = isText ? utf8ToBase64(contentBytes) : bytesToBase64(contentBytes);

  let sha = opts.sha;
  if (sha === undefined) {
    const existing = await getFile(env, path, branch);
    sha = existing ? existing.sha : undefined;
  }

  const attempt = async (shaForAttempt) => {
    const body = {
      message,
      content: base64,
      branch,
      committer: GITHUB_COMMIT_AUTHOR,
      author: GITHUB_COMMIT_AUTHOR,
    };
    if (shaForAttempt) body.sha = shaForAttempt;
    return githubRequest(env, 'PUT', encodeGithubPath(path), body);
  };

  let result = await attempt(sha);
  if (!result.ok && result.status === 409) {
    // Conflict: our `sha` is stale. Refetch once and retry — see doc comment.
    const fresh = await getFile(env, path, branch);
    result = await attempt(fresh ? fresh.sha : undefined);
  }
  if (!result.ok) throw githubError('PUT', path, result.status, result.json);
  return {
    sha: result.json.content && result.json.content.sha,
    commit_sha: result.json.commit && result.json.commit.sha,
  };
}

/**
 * Deletes one file (the "unpublish" path — BUILD §21). No-ops (returns
 * `{ deleted: false }`) if the file is already gone, rather than treating a
 * double-unpublish as an error. Same 409/sha-refresh retry as putFile.
 */
export async function deleteFile(env, path, message, opts = {}) {
  const branch = opts.branch || GITHUB_COMMIT_BRANCH_DEFAULT;
  const existing = await getFile(env, path, branch);
  if (!existing) return { deleted: false };

  const attempt = (sha) => githubRequest(env, 'DELETE', encodeGithubPath(path), {
    message, sha, branch, committer: GITHUB_COMMIT_AUTHOR, author: GITHUB_COMMIT_AUTHOR,
  });

  let result = await attempt(existing.sha);
  if (!result.ok && result.status === 409) {
    const fresh = await getFile(env, path, branch);
    if (!fresh) return { deleted: false }; // someone else already deleted it
    result = await attempt(fresh.sha);
  }
  if (!result.ok) throw githubError('DELETE', path, result.status, result.json);
  return { deleted: true, commit_sha: result.json.commit && result.json.commit.sha };
}

// Git-refs requests (branch create/delete/lookup) hit a different URL shape
// than the Contents API (`/git/refs/...` vs `/contents/...`) — this tiny
// sibling to githubRequest() hits the repo root directly rather than
// reusing repoPath()'s `/contents/` prefix.
async function gitRefRequest(env, method, refPath, body) {
  if (!env.GITHUB_REPO) throw new Error('github_not_configured: GITHUB_REPO secret is not set');
  if (!env.GITHUB_TOKEN) throw new Error('github_not_configured: GITHUB_TOKEN secret is not set');
  const res = await fetch(`${GITHUB_API_BASE}/repos/${env.GITHUB_REPO}${refPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'wogo-admin-dashboard',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* noop */ } }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Creates a branch pointed at the SAME commit as `fromBranch` — used only by
 * the Blog feature's end-to-end test (SETUP.md), which publishes a throwaway
 * post to a scratch branch rather than `main` so a real test run never
 * touches the live site. If the branch already exists, GitHub's `422` is
 * treated as "already there" (`{ created: false, already_exists: true }`),
 * not an error — re-running the e2e test after a previous crash shouldn't
 * require a manual branch delete first.
 */
export async function ensureBranch(env, branchName, fromBranch = GITHUB_COMMIT_BRANCH_DEFAULT) {
  const refRes = await gitRefRequest(env, 'GET', `/git/ref/heads/${encodeURIComponent(fromBranch)}`);
  if (!refRes.ok) throw githubError('GET', `git/ref/heads/${fromBranch}`, refRes.status, refRes.json);
  const baseSha = refRes.json.object.sha;

  const createRes = await gitRefRequest(env, 'POST', '/git/refs', { ref: `refs/heads/${branchName}`, sha: baseSha });
  if (createRes.status === 422) return { created: false, already_exists: true };
  if (!createRes.ok) throw githubError('POST', 'git/refs', createRes.status, createRes.json);
  return { created: true };
}

/** Deletes a branch ref — the scratch-branch end-to-end test's cleanup step.
 * A 422/404 (already gone) is reported as `{ deleted: false }`, not thrown —
 * cleanup must never fail the test run it's cleaning up after. */
export async function deleteBranch(env, branchName) {
  const res = await gitRefRequest(env, 'DELETE', `/git/refs/heads/${encodeURIComponent(branchName)}`);
  return { deleted: res.ok };
}

function encodeGithubPath(path) {
  // Each path SEGMENT is percent-encoded separately — encodeURIComponent on
  // the whole path would also escape the '/' separators GitHub's API needs.
  return path.split('/').map(encodeURIComponent).join('/');
}

function githubError(method, path, status, body) {
  const err = new Error(`github_api_failed: ${method} ${path} -> ${status} ${body ? JSON.stringify(body) : ''}`);
  err.status = status;
  err.body = body;
  return err;
}
