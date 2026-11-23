//! Partio Inventory's Rust side: the library database, secure storage for API keys, and (later)
//! printing and vendor lookups. Application logic lives in TypeScript (src/); Rust only does what
//! a web page can't. Nothing here may shell out to a platform-specific tool.

mod db;
mod files;
mod secrets;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let library = db::Library::open(app.handle())?;
            // One backup a day, written when the app opens. A failure here must not stop the app.
            if let Err(e) = library.daily_backup() {
                eprintln!("daily backup failed: {e}");
            }
            app.manage(library);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::db_query,
            db::db_execute,
            db::db_transaction,
            db::library_info,
            db::backup_library,
            files::save_files_to_folder,
            secrets::secret_set,
            secrets::secret_has
        ])
        .run(tauri::generate_context!())
        .expect("error while running Partio");
}
