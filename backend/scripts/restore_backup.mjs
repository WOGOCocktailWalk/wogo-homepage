#!/usr/bin/env node
// scripts/restore_backup.mjs — rebuild a LOCAL SQLite database from a WOGO
// nightly backup file and check it. A rehearsal tool: it never talks to
// Cloudflare and never touches production.
//
//   node scripts/restore_backup.mjs <backup.json> [--out restored.sqlite] [--force]
//
// What it does:
//   1. creates an empty SQLite file and applies every migrations/*.sql in order
//      (the same schema the live database has);
//   2. empties the tables the backup covers (migrations seed a few rows, e.g.
//      the owner's admin_users rows — the backup is the truth, not the seed);
//   3. inserts every backed-up row;
//   4. compares row counts with the counts recorded in the backup file and
//      runs SQLite's integrity check.
// Exit code 0 = everything matched, 1 = a mismatch or error (printed).
//
// Needs Node 22+ (built-in node:sqlite). No npm packages.
// The backup file contains guest data: keep it out of git and delete it after.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Applies every migration in filename order to a fresh database. */
export function applyMigrations(db, dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const f of files) {
    try {
      db.exec(readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      throw new Error(`migration ${f} failed: ${err.message}`);
    }
  }
  return files.length;
}

/**
 * Restores `backup` (the parsed JSON) into `db` (an open DatabaseSync that
 * already has the schema). Returns { tables: [{table, expected, restored, ok}],
 * ok, integrity, notes }.
 */
export function restoreInto(db, backup) {
  if (!backup || typeof backup !== 'object' || !backup.tables || typeof backup.tables !== 'object') {
    throw new Error('not a WOGO backup file (no "tables" object)');
  }
  const notes = [];
  if (!backup.format_version) notes.push('old-format backup (before all tables were included): only the tables listed below exist in it');
  if (backup.table_errors) notes.push(`this backup was INCOMPLETE when written: ${JSON.stringify(backup.table_errors)}`);

  const existing = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name));
  db.exec('PRAGMA foreign_keys = OFF;');
  const results = [];
  db.exec('BEGIN');
  try {
    for (const [table, rows] of Object.entries(backup.tables)) {
      if (!existing.has(table)) throw new Error(`backup has table "${table}" that the schema does not know`);
      if (!Array.isArray(rows)) throw new Error(`table "${table}" is not a list of rows`);
      db.exec(`DELETE FROM ${q(table)}`);
      const cols = new Set(db.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name));
      for (const row of rows) {
        const keys = Object.keys(row);
        const unknown = keys.filter((k) => !cols.has(k));
        if (unknown.length) throw new Error(`table "${table}": backup column(s) ${unknown.join(', ')} not in the schema`);
        const sql = `INSERT INTO ${q(table)} (${keys.map(q).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
        db.prepare(sql).run(...keys.map((k) => row[k]));
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  let ok = true;
  for (const [table, rows] of Object.entries(backup.tables)) {
    const expected = backup.counts && table in backup.counts ? backup.counts[table] : rows.length;
    const restored = db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get().n;
    const tableOk = restored === expected && rows.length === expected;
    if (!tableOk) ok = false;
    results.push({ table, expected, restored, ok: tableOk });
  }
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') ok = false;
  return { tables: results, ok, integrity, notes };
}

/** Convenience: file in, SQLite file out. */
export function restoreBackupFile(backupPath, outPath, { force = false } = {}) {
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  if (existsSync(outPath)) {
    if (!force) throw new Error(`${outPath} already exists (use --force to overwrite)`);
    unlinkSync(outPath);
  }
  const db = new DatabaseSync(outPath);
  try {
    applyMigrations(db);
    const result = restoreInto(db, backup);
    return { ...result, exported_at: backup.exported_at || null };
  } finally {
    db.close();
  }
}

function main(argv) {
  const args = argv.slice(2);
  const force = args.includes('--force');
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : 'restored.sqlite';
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!file) {
    console.error('usage: node scripts/restore_backup.mjs <backup.json> [--out restored.sqlite] [--force]');
    process.exit(2);
  }
  try {
    const r = restoreBackupFile(file, out, { force });
    console.log(`Backup written at: ${r.exported_at || '(unknown)'}`);
    console.log(`Rebuilt into: ${out}\n`);
    for (const t of r.tables) {
      console.log(`${t.ok ? 'OK  ' : 'FAIL'}  ${t.table.padEnd(24)} expected ${String(t.expected).padStart(6)}  restored ${String(t.restored).padStart(6)}`);
    }
    console.log(`\nSQLite integrity check: ${r.integrity}`);
    for (const n of r.notes) console.log(`NOTE: ${n}`);
    console.log(r.ok ? '\nRESULT: PASS - the backup restores cleanly.' : '\nRESULT: FAIL - see the lines marked FAIL above.');
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    console.error(`RESULT: FAIL - ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
