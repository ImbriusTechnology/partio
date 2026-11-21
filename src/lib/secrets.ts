// API keys go to the system's secure storage through Rust (src-tauri/src/secrets.rs).
// The page can store a key or ask whether one is stored, but never read one back.
import { invoke } from '@tauri-apps/api/core';

/** Store a key, or remove it with an empty value. */
export const secretSet = (name: string, value: string) => invoke<void>('secret_set', { name, value });

export const secretHas = (name: string) => invoke<boolean>('secret_has', { name });
