-- migrations/0030_blog_posts.sql
-- Blog section (BUILD §21, SETUP.md "writing a post"): lets a non-technical
-- teammate write/preview/publish blog posts to the static site from the
-- admin dashboard, without touching code or the GitHub UI directly.
--
-- blog_posts — one row per post, draft or published.
--   id                 'blogpost_<uuid>'.
--   slug               [a-z0-9-]{3,80}, UNIQUE. The post's folder name under
--                       /blog/<slug>/ — IMMUTABLE after the post's first
--                       publish (src/admin_api.js enforces this; renaming
--                       would break any link already out in the world —
--                       surfaced in the dashboard UI, not just the API).
--   status             'draft' | 'published'.
--   category            One of the dashboard's fixed category chips (City
--                       guide / New route / Explained / Recipes / News) —
--                       stored as free text, validated client+server side
--                       against src/config.js:BLOG_CATEGORIES so adding a
--                       category later is a one-line config change, not a
--                       migration.
--   cover_image_path    Repo-relative path under blog/<slug>/ (e.g.
--                       'blog/<slug>/cover.jpg'), set by the asset-upload
--                       endpoint. NULL until the first cover image is
--                       uploaded.
--   cover_alt_en/nl     Required before publish (accessibility) — validated
--                       at publish time, not at draft-save time, so a draft
--                       in progress is never blocked on it.
--   title_en/nl, excerpt_en/nl   Short copy fields, EN required, NL optional
--                       (falls back to EN at render time — see blog_render.js
--                       — so a post can go live before its NL copy is ready,
--                       matching how the rest of the site already treats a
--                       missing translation as "fall back to English", not
--                       as an error).
--   body_en/nl          Sanitized HTML (src/logic.js:sanitizeBlogHtml ran on
--                       every write — never trust what's already in this
--                       column on read). body_en required before publish;
--                       body_nl optional, same EN-fallback rule as above.
--   seo_title_en/nl, seo_description_en/nl   Optional; blog_render.js falls
--                       back to title_en/excerpt_en when empty.
--   read_minutes        Owner-entered estimate shown as "N min read" (the
--                       existing posts' convention) — not auto-computed, so
--                       a teammate can round it sensibly.
--   published_at        Set once, the FIRST time a post is published; never
--                       cleared by a later unpublish (so "published then
--                       unpublished" still remembers when it first went
--                       live) and never updated by a re-publish of an
--                       already-published post.
--   created_by/updated_by   Admin user's email (or 'token' for the emergency
--                       ADMIN_TOKEN path) — same actor convention as
--                       admin_audit.actor (migrations/0025).
--   old_wix_slug        NULL unless this row was created by the one-off
--                       import script (backend/scripts/import_blog_posts.mjs)
--                       from a pre-existing /blog/<slug>/ page that itself
--                       carries an "OLD URL" head comment pointing at the
--                       retired Wix post — kept for redirect-map reference,
--                       never written by the dashboard itself.
--   last_published_commit   The GitHub Contents API commit SHA that last
--                       wrote this post's live file(s) — shown in the
--                       dashboard, and set directly (without a real commit)
--                       by the import script for the 8 pre-existing posts,
--                       whose content was already live before this table
--                       existed.
--
-- blog_assets — one row per image uploaded for a post (cover or in-body),
--   committed to GitHub immediately on upload (so Preview can show it before
--   the post itself is ever published) — see BUILD §21.3.
--
-- NOT applied to remote D1 by tooling — the operator applies this by hand
-- (wrangler d1 migrations apply wogo-bookings --remote) and redeploys.

CREATE TABLE blog_posts (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'published'
  category            TEXT NOT NULL,
  cover_image_path    TEXT,
  cover_alt_en        TEXT,
  cover_alt_nl        TEXT,
  title_en            TEXT NOT NULL,
  title_nl            TEXT,
  excerpt_en          TEXT,
  excerpt_nl          TEXT,
  body_en             TEXT,
  body_nl             TEXT,
  seo_title_en        TEXT,
  seo_title_nl        TEXT,
  seo_description_en  TEXT,
  seo_description_nl  TEXT,
  read_minutes        INTEGER NOT NULL DEFAULT 5,
  published_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  created_by          TEXT,
  updated_by          TEXT,
  old_wix_slug        TEXT,
  last_published_commit TEXT
);

CREATE INDEX idx_blog_posts_status ON blog_posts (status);
CREATE INDEX idx_blog_posts_published_at ON blog_posts (published_at);

CREATE TABLE blog_assets (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES blog_posts(id),
  path        TEXT NOT NULL,   -- repo-relative, e.g. 'blog/<slug>/cover.jpg'
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_blog_assets_post ON blog_assets (post_id);
