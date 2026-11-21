// A library database for tests: Node's built-in SQLite, with every migration in migrations/ applied
// in name order, the same way src-tauri/src/db.rs applies them in the app.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export function migrate(db: DatabaseSync): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((r) => r.name));
  const applied: string[] = [];
  for (const file of migrationFiles()) {
    if (done.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, datetime('now'))").run(file);
      db.exec('COMMIT');
      applied.push(file);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    }
  }
  return applied;
}

/** A fresh, fully migrated library in memory. */
export function freshLibrary(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
