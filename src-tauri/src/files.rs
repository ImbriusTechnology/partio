//! Saving files the app makes (CSV exports and templates), through the system's own folder chooser.
//! rfd uses the native dialog on macOS, Windows and Linux.

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
pub struct OutFile {
    name: String,
    text: String,
}

/// Ask for a folder, make `subfolder` inside it (adding -2, -3… if that name is taken), and write the files there.
/// Returns the folder written to, or None when the person cancels.
#[tauri::command]
pub async fn save_files_to_folder(title: String, subfolder: String, files: Vec<OutFile>) -> Result<Option<String>, String> {
    for f in &files {
        if f.name.is_empty() || f.name.contains(['/', '\\']) || f.name.starts_with('.') {
            return Err(format!("Bad file name: {}", f.name));
        }
    }
    let Some(handle) = rfd::AsyncFileDialog::new().set_title(&title).pick_folder().await else {
        return Ok(None);
    };
    let base: PathBuf = handle.path().to_path_buf();
    let clean: String = subfolder.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let mut target = base.join(&clean);
    let mut n = 2;
    while target.exists() {
        target = base.join(format!("{clean}-{n}"));
        n += 1;
    }
    fs::create_dir_all(&target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
    for f in files {
        let path = target.join(&f.name);
        fs::write(&path, f.text.as_bytes()).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    }
    Ok(Some(target.display().to_string()))
}
