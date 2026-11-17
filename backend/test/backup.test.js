// Backup coverage + restore round trip (audit finding O4).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTestDb } from './sqlite-d1-adapter.js';
import { exportBackupToR2, BACKUP_TABLES, BACKUP_EXCLUDED_TABLES } from '../src/backup.js';
import { applyMigrations, restoreInto, restoreBackupFile } from '../scripts/restore_backup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.join(__dirname, '../migrations');
const allMigrationsSql = readdirSync(MIG).filter((f) => /^\d+.*\.sql$/.test(f)).sort()
  .map((f) => readFileSync(path.join(MIG, f), 'utf8')).join('\n');

function tablesInMigrations() {
  const names = new Set();
  for (const m of allMigrationsSql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)) names.add(m[1]);
  return [...names];
}

/** Inserts `n` plausible rows into `table` using its own column definitions. */
function fillRows(raw, table, n = 2) {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
  for (let i = 1; i <= n; i++) {
    const names = []; const vals = [];
    for (const c of cols) {
      if (c.pk && /INT/i.test(c.type)) continue; // autoincrement id
      if (c.dflt_value !== null && !c.pk) continue; // let defaults apply
      if (!c.notnull && !c.pk) continue;
      names.push(c.name);
      vals.push(/INT|REAL|NUM/i.test(c.type) ? i : `${table}_${c.name}_${i}`);
    }
    if (!names.length) raw.exec(`INSERT INTO ${table} DEFAULT VALUES`);
    else raw.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...vals);
  }
}

function fakeBucket() {
  const store = new Map();
  return {
    store,
    put: async (k, v) => { store.set(k, v); },
    list: async () => ({ objects: [...store.keys()].map((key) => ({ key })), truncated: false }),
    delete: async (keys) => { for (const k of keys) store.delete(k); },
  };
}

describe('backup table coverage', () => {
  test('every table in the schema is either backed up or deliberately excluded', () => {
    const known = new Set([...BACKUP_TABLES, ...BACKUP_EXCLUDED_TABLES]);
    const missing = tablesInMigrations().filter((t) => !known.has(t));
    assert.deepEqual(missing, [], `new table(s) need a backup decision in src/backup.js: ${missing.join(', ')}`);
    for (const t of known) assert.ok(tablesInMigrations().includes(t), `${t} listed but not in any migration`);
    for (const t of BACKUP_TABLES) assert.ok(!BACKUP_EXCLUDED_TABLES.includes(t));
  });

  test('login-token and queue tables are never exported', () => {
    for (const t of ['admin_login_links', 'push_subscriptions', 'failed_email']) assert.ok(!BACKUP_TABLES.includes(t));
  });
});

describe('backup -> restore round trip', () => {
  test('every backed-up table survives and row counts match', async () => {
    const d1 = makeTestDb(allMigrationsSql);
    for (const t of BACKUP_TABLES) {
      // migrations may already seed rows (owner admin users, routes); add ours on top
      fillRows(d1._raw, t, 2);
    }
    const before = {};
    for (const t of BACKUP_TABLES) before[t] = d1._raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();

    const bucket = fakeBucket();
    const result = await exportBackupToR2({ DB: d1, BACKUP_BUCKET: bucket });
    assert.equal(result.ok, true);
    assert.equal(bucket.store.size, 1);
    const [[, payload]] = [...bucket.store.entries()];
    const parsed = JSON.parse(payload);
    assert.equal(parsed.format_version, 2);
    for (const t of BACKUP_TABLES) assert.equal(parsed.counts[t], before[t].length, t);
    assert.ok(!('admin_login_links' in parsed.tables));

    // restore through the real script code, via a file on disk
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wogo-restore-'));
    try {
      const file = path.join(dir, 'backup.json');
      writeFileSync(file, payload);
      const out = path.join(dir, 'restored.sqlite');
      const r = restoreBackupFile(file, out);
      assert.equal(r.ok, true, JSON.stringify(r.tables.filter((t) => !t.ok)));
      assert.equal(r.integrity, 'ok');
      assert.equal(r.tables.length, BACKUP_TABLES.length);

      const restored = new DatabaseSync(out);
      for (const t of BACKUP_TABLES) {
        assert.deepEqual(restored.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(), before[t], `rows differ in ${t}`);
      }
      restored.close();
      assert.throws(() => restoreBackupFile(file, out), /already exists/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a count mismatch is reported as a failure', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const r = restoreInto(db, { format_version: 2, counts: { inquiries: 5 }, tables: { inquiries: [] } });
    assert.equal(r.ok, false);
  });

  test('an old 4-table backup still restores, with a note', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const r = restoreInto(db, { exported_at: 'x', tables: { routes: [], routes_bars: [], date_overrides: [], bookings: [] } });
    assert.equal(r.ok, true);
    assert.ok(r.notes.length >= 1);
  });

  test('a file that is not a backup is refused', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    assert.throws(() => restoreInto(db, { hello: 1 }), /not a WOGO backup/);
  });
});

describe('partial failure', () => {
  test('one unreadable table does not lose the others and is recorded + alerted', async () => {
    const d1 = makeTestDb(allMigrationsSql);
    d1._raw.exec('DROP TABLE inquiries');
    const bucket = fakeBucket();
    const sent = [];
    const result = await exportBackupToR2(
      { DB: d1, BACKUP_BUCKET: bucket },
      { sendTransactional: async (_e, m) => { sent.push(m.subject); } }
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed_tables, ['inquiries']);
    const parsed = JSON.parse([...bucket.store.values()][0]);
    assert.ok(parsed.table_errors.inquiries);
    assert.ok(Array.isArray(parsed.tables.bookings));
    assert.ok(sent.some((s) => /incomplete/.test(s)));
  });
});
