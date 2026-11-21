// Thin wrapper over the Rust commands in src-tauri/src/db.rs.
import { invoke } from '@tauri-apps/api/core';

export type Row = Record<string, unknown>;
export type Param = string | number | boolean | null | { $ref: number };

export interface ExecResult { changes: number; lastInsertId: number }
export interface Statement { sql: string; params?: Param[]; returnsRows?: boolean }

export function query<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
  return invoke<T[]>('db_query', { sql, params });
}

export async function queryOne<T = Row>(sql: string, params: Param[] = []): Promise<T | undefined> {
  return (await query<T>(sql, params))[0];
}

export function execute(sql: string, params: Param[] = []): Promise<ExecResult> {
  return invoke<ExecResult>('db_execute', { sql, params });
}

/** All statements run in one transaction. `ref(n)` stands for the row id inserted by statement n. */
export function transaction(statements: Statement[]): Promise<unknown[]> {
  return invoke<unknown[]>('db_transaction', { statements });
}

export const ref = (n: number) => ({ $ref: n });

export interface LibraryInfo { dir: string; database: string; files: string; backupDir: string; platform: string }
export const libraryInfo = () => invoke<LibraryInfo>('library_info');

/** Back up now; resolves to the backup's path. */
export const backupLibrary = (dir?: string | null) => invoke<string>('backup_library', { dir: dir ?? null });

/** A fresh id for grouping stock transactions that belong to one action. */
export const batchId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
