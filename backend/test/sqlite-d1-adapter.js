// test/sqlite-d1-adapter.js
//
// Wraps Node's built-in node:sqlite (DatabaseSync, unflagged on Node >= 22;
// confirmed working here on Node v24) behind a D1-shaped interface so
// src/db.js runs UNMODIFIED against both this adapter (tests) and the real
// env.DB binding (production). See SPEC.md §11.
//
// STRICT D1 SEMANTICS (added after the 2026-07 production incident): real D1
// only supports POSITIONAL parameters (`?` / `?N`) bound variadically —
// `.bind({ named: 'object' })` throws `D1_TYPE_ERROR: Type 'object' not
// supported` in production. This adapter now enforces exactly that, so any
// code path that tries named-object binding fails in tests the same way it
// would fail against real D1. src/db.js's toPositional() translation layer
// is what feeds this adapter (and production D1) valid positional binds.

import { DatabaseSync } from 'node:sqlite';

// Mirrors D1's accepted value types: null, Number, String, Boolean (coerced
// to 1/0 like D1 does), ArrayBuffer. Everything else — most importantly a
// plain object of named params — throws the same D1_TYPE_ERROR production
// raises.
function validateD1Value(v) {
  if (v === null) return v;
  const t = typeof v;
  if (t === 'number' || t === 'string') return v;
  if (t === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return v;
  throw new Error(`D1_TYPE_ERROR: Type '${t}' not supported for value '${v}'`);
}

export function makeTestDb(schemaSql) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF;');
  raw.exec(schemaSql);

  return {
    _raw: raw,
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        _values: [],
        bind(...values) {
          this._values = values.map(validateD1Value);
          return this;
        },
        run() {
          const info = stmt.run(...this._values);
          return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        },
        all() {
          return { results: stmt.all(...this._values) };
        },
        first() {
          return stmt.get(...this._values) ?? null;
        },
      };
    },
    batch(stmts) {
      return stmts.map((s) => s.run());
    },
  };
}
