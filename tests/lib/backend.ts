// The database backend the tests use: Node's built-in SQLite, behaving like the Rust commands in
// src-tauri/src/db.rs (booleans become 0/1, transactions are all-or-nothing, { $ref: n } is statement n's row id).
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { setBackend, type Backend, type Param, type Row, type Statement } from '../../src/lib/db.ts';
import { freshLibrary } from './db.ts';

function bind(p: Param, ids: number[], n: number): SQLInputValue {
  if (p === null) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (typeof p === 'object') {
    const id = ids[p.$ref];
    if (id === undefined) throw new Error(`statement ${n}: no statement ${p.$ref} to refer to`);
    return id;
  }
  return p;
}

export function nodeBackend(db: DatabaseSync): Backend {
  const run = (sql: string, params: SQLInputValue[]) => {
    const r = db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
  };
  return {
    async query(sql, params) {
      return db.prepare(sql).all(...params.map((p) => bind(p, [], 0))) as Row[];
    },
    async execute(sql, params) {
      return run(sql, params.map((p) => bind(p, [], 0)));
    },
    async transaction(statements: Statement[]) {
      const ids: number[] = [];
      const out: unknown[] = [];
      db.exec('SAVEPOINT tx');     // like the Rust side: works inside a longer transaction too
      try {
        statements.forEach((s, n) => {
          const params = (s.params ?? []).map((p) => bind(p, ids, n));
          try {
            if (s.returnsRows) {
              out.push(db.prepare(s.sql).all(...params));
              ids.push(Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id));
            } else {
              const r = run(s.sql, params);
              ids.push(r.lastInsertId);
              out.push(r);
            }
          } catch (e) {
            throw new Error(`statement ${n}: ${(e as Error).message}`);
          }
        });
        db.exec('RELEASE tx');
      } catch (e) {
        db.exec('ROLLBACK TO tx');
        db.exec('RELEASE tx');
        throw e;
      }
      return out;
    },
  };
}

/** A fresh, migrated, in-memory library wired up as the app's database. Returns the raw handle for assertions. */
export function useFreshLibrary(): DatabaseSync {
  const db = freshLibrary();
  setBackend(nodeBackend(db));
  return db;
}
