// src/blog_publish.js — decides WHICH files one blog publish/unpublish writes,
// and commits them together as ONE git commit (the live site rebuilds on every
// commit, so five files must not mean five rebuilds).
//
// Files touched by a publish:
//   blog/<slug>/index.html        English page (English text only)
//   nl/blog/<slug>/index.html     Dutch page — only when the post has a Dutch body;
//                                 a post without one gets NO Dutch page (and an
//                                 older Dutch page of it is removed)
//   blog/index.html               English index (all published posts)
//   nl/blog/index.html            Dutch index (only posts with a Dutch body);
//                                 removed when no post has Dutch text any more
//   sitemap.xml                   the post's lines + hreflang pairs (unless SITE_NOINDEX)
// An unpublish removes both post pages and rewrites the indexes and the sitemap.
//
// admin_api.js owns the HTTP side (auth, D1, audit); this module owns the files.

import { commitFiles } from './github.js';
import {
  renderPostPage, renderPostPageNl, renderIndexPage, renderIndexPageNl,
  updateBlogSitemap, hasDutchBody,
} from './blog_render.js';

const byNewest = (a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''));

/**
 * Builds the list of file changes. `read(path)` -> `{sha, content} | null`
 * (see github.js:commitFiles). `others` are the OTHER published posts (not
 * `post`); `post` must carry its final `published_at` when mode is 'publish'.
 */
export async function planBlogChanges({ read, templates, post, others, mode, siteNoindex }) {
  const publish = mode === 'publish';
  const all = (publish ? [post, ...others] : others).slice().sort(byNewest);
  const nlIndex = all.some(hasDutchBody);
  const opts = { siteNoindex, nlIndex };
  const changes = [];

  const put = (path, content) => changes.push({ path, content });
  const removeIfThere = async (path) => { if (await read(path)) changes.push({ path, delete: true }); };

  const enPath = `blog/${post.slug}/index.html`;
  const nlPath = `nl/blog/${post.slug}/index.html`;
  if (publish) {
    put(enPath, renderPostPage(templates.postEn, post, opts));
    const nl = renderPostPageNl(templates.postNl, post, opts);
    if (nl) put(nlPath, nl); else await removeIfThere(nlPath);
  } else {
    await removeIfThere(enPath);
    await removeIfThere(nlPath);
  }

  put('blog/index.html', renderIndexPage(templates.indexEn, all, opts));
  const nlIdx = renderIndexPageNl(templates.indexNl, all, opts);
  if (nlIdx) put('nl/blog/index.html', nlIdx); else await removeIfThere('nl/blog/index.html');

  if (!siteNoindex) {
    const sm = await read('sitemap.xml');
    if (sm) {
      const next = updateBlogSitemap(sm.content, { post, add: publish, nlIndex });
      if (next !== sm.content) put('sitemap.xml', next);
    }
  }
  return changes;
}

/** Plans and commits in one go. Returns `{ commit_sha, changed }`. */
export function commitBlogChange(env, args, message, branch) {
  return commitFiles(env, (read) => planBlogChanges({ ...args, read }), message, { branch });
}
