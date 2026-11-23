// How TypeScript talks to the library database.
// In the app, statements go to the Rust commands in src-tauri/src/db.rs. Tests swap in a Node SQLite
// backend (tests/lib/backend.ts) with setBackend(), so the same code is exercised against a real database.

export type Row = Record<string, unknown>;
export type Param = string | number | boolean | null | { $ref: number };

export interface ExecResult { changes: number; lastInsertId: number }
export interface Statement { sql: string; params?: Param[]; returnsRows?: boolean }

export interface Backend {
  query(sql: string, params: Param[]): Promise<Row[]>;
  execute(sql: string, params: Param[]): Promise<ExecResult>;
  /** All statements in one transaction; a { $ref: n } parameter is the row id inserted by statement n. */
  transaction(statements: Statement[]): Promise<unknown[]>;
}

let backend: Backend | null = null;

/** Use a different backend (tests). */
export function setBackend(b: Backend | null): void { backend = b; }

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import('@tauri-apps/api/core');
  return {
    query: (sql, params) => invoke<Row[]>('db_query', { sql, params }),
    execute: (sql, params) => invoke<ExecResult>('db_execute', { sql, params }),
    transaction: (statements) => invoke<unknown[]>('db_transaction', { statements }),
  };
}

async function db(): Promise<Backend> {
  return (backend ??= await tauriBackend());
}

export async function query<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
  return (await db()).query(sql, params) as Promise<T[]>;
}

export async function queryOne<T = Row>(sql: string, params: Param[] = []): Promise<T | undefined> {
  return (await query<T>(sql, params))[0];
}

export async function execute(sql: string, params: Param[] = []): Promise<ExecResult> {
  return (await db()).execute(sql, params);
}

/** All statements run in one transaction. `ref(n)` stands for the row id inserted by statement n. */
export async function transaction(statements: Statement[]): Promise<unknown[]> {
  return (await db()).transaction(statements);
}

export const ref = (n: number) => ({ $ref: n });

/** A fresh id for grouping stock transactions that belong to one action. */
export const batchId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ------------------------------------------------------------------ app-only commands

export interface LibraryInfo { dir: string; database: string; files: string; backupDir: string; platform: string }

export async function libraryInfo(): Promise<LibraryInfo> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<LibraryInfo>('library_info');
}

/** Back up now; resolves to the backup's path. */
export async function backupLibrary(dir?: string | null): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('backup_library', { dir: dir ?? null });
}
