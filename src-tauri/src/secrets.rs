//! API keys for vendor lookups, kept in the system's secure storage rather than in the library,
//! so they never end up in backups or CSV exports. The web page can store a key and ask whether one
//! is stored, but can never read one back: Rust adds keys to outgoing requests itself (phase 5).

use keyring::Entry;

const SERVICE: &str = "Partio Inventory";

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| format!("Secure storage is not available: {e}"))
}

/// Read a stored key, for Rust's own use only (not exposed as a command).
#[allow(dead_code)]
pub fn secret_get(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok()
}

/// Store an API key, or remove it when `value` is empty.
#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    let e = entry(&name)?;
    if value.trim().is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("Couldn't remove the key: {err}")),
        };
    }
    e.set_password(value.trim()).map_err(|err| format!("Couldn't save the key: {err}"))
}

/// Whether a key is stored (the value itself never leaves Rust).
#[tauri::command]
pub fn secret_has(name: String) -> bool {
    secret_get(&name).is_some()
}
