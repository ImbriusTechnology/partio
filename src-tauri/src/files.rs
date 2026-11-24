//! Saving files the app makes (CSV exports, templates, pick lists), through the system's own save and folder dialogs.
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

/// Ask where to save one file (a Save dialog, starting in `directory` if given), and write it.
/// Returns the path written, or None when the person cancels.
#[tauri::command]
pub async fn save_file(title: String, name: String, text: String, directory: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title(&title).set_file_name(&name);
    if name.to_lowercase().ends_with(".csv") {
        dialog = dialog.add_filter("CSV file", &["csv"]);
    }
    if let Some(dir) = directory.filter(|d| PathBuf::from(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    let Some(handle) = dialog.save_file().await else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    fs::write(&path, text.as_bytes()).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}
