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

/**
 * Run `fn` as one transaction: everything it changes is kept if it finishes, and undone if it throws
 * (or if `keep` is false, which is how an import's preview runs the import and then takes it back).
 * Inner transaction() calls become savepoints inside it.
 */
export async function withTransaction<T>(fn: () => Promise<T>, keep = true): Promise<T> {
  await execute('BEGIN');
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    await execute('ROLLBACK');
    throw e;
  }
  await execute(keep ? 'COMMIT' : 'ROLLBACK');
  return result;
}

/** Undo a row's work inside a transaction if it fails, without undoing the rest. */
export async function savepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await execute(`SAVEPOINT ${name}`);
  try {
    const r = await fn();
    await execute(`RELEASE ${name}`);
    return r;
  } catch (e) {
    await execute(`ROLLBACK TO ${name}`);
    await execute(`RELEASE ${name}`);
    throw e;
  }
}

/** A fresh id for grouping stock transactions that belong to one action. */
export const batchId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ------------------------------------------------------------------ app-only commands

export interface LibraryInfo { dir: string; database: string; files: string; backupDir: string; platform: string }

export async function libraryInfo(): Promise<LibraryInfo> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<LibraryInfo>('library_info');
}

/**
 * Ask for a folder and write these files into a new folder inside it named `subfolder`.
 * Resolves to the folder written to, or null if the person cancelled.
 */
export async function saveFilesToFolder(title: string, subfolder: string, files: Array<{ name: string; text: string }>): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('save_files_to_folder', { title, subfolder, files });
}

/** Show a file or folder in the system's file manager (Finder, Explorer, Files). */
export async function revealInFileManager(path: string): Promise<void> {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

/** Back up now; resolves to the backup's path. */
export async function backupLibrary(dir?: string | null): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('backup_library', { dir: dir ?? null });
}
