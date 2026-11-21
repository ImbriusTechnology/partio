//! The library database: open it, apply migrations, run SQL sent from TypeScript, and write backups.
//! All application logic lives in TypeScript (src/); this file just moves rows across.

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// Migrations, applied in order and recorded in `_migrations`. Add new files here and nowhere else:
/// the tests (tests/lib/db.ts) apply every file in migrations/ in name order, so the two stay in step.
const MIGRATIONS: &[(&str, &str)] = &[
    ("001_initial.sql", include_str!("../../migrations/001_initial.sql")),
    ("002_packages.sql", include_str!("../../migrations/002_packages.sql")),
];

/// How many automatic backups to keep.
const KEEP_BACKUPS: usize = 30;

pub struct Library {
    conn: Mutex<Connection>,
    pub dir: PathBuf,
}

impl Library {
    /// The library lives in the system's per-user app data folder:
    /// macOS `~/Library/Application Support/<identifier>/`, Windows `%APPDATA%\<identifier>\`,
    /// Linux `~/.local/share/<identifier>/`. Keep it out of Dropbox, iCloud or OneDrive:
    /// syncing a live SQLite file can corrupt it. Backups are fine to sync.
    pub fn open(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = app.path().app_data_dir()?;
        fs::create_dir_all(dir.join("files"))?;
        let conn = Connection::open(dir.join("library.db"))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let _mode: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
        migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn), dir })
    }

    /// Where backups go: the folder chosen in Settings (setting 'backup_dir'), else backups/ beside the library.
    fn backup_dir(&self, conn: &Connection) -> PathBuf {
        let chosen: Option<String> = conn
            .query_row("SELECT value FROM setting WHERE key = 'backup_dir'", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        match chosen.filter(|d| !d.trim().is_empty()) {
            Some(d) => PathBuf::from(d),
            None => self.dir.join("backups"),
        }
    }

    /// Write today's backup unless one already exists.
    pub fn daily_backup(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(err)?;
        let target = self.backup_dir(&conn);
        let today: String = conn.query_row("SELECT strftime('%Y%m%d', 'now', 'localtime')", [], |r| r.get(0)).map_err(err)?;
        let prefix = format!("library-{today}");
        let done = fs::read_dir(&target)
            .map(|it| it.filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with(&prefix)))
            .unwrap_or(false);
        if !done {
            backup_into(&conn, &target)?;
        }
        Ok(())
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")?;
    for (name, sql) in MIGRATIONS {
        let done: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM _migrations WHERE name = ?1)", [name], |r| r.get(0))?;
        if done {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, datetime('now'))", [name])?;
        tx.commit()?;
    }
    Ok(())
}

/// Write a consistent copy of the library (VACUUM INTO) and keep the newest KEEP_BACKUPS copies.
fn backup_into(conn: &Connection, target: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(target).map_err(|e| format!("Can't create the backup folder {}: {e}", target.display()))?;
    let stamp: String = conn
        .query_row("SELECT strftime('%Y%m%d-%H%M%S', 'now', 'localtime')", [], |r| r.get(0))
        .map_err(err)?;
    // Two backups in the same second get -2, -3… rather than failing.
    let mut path = target.join(format!("library-{stamp}.db"));
    let mut n = 2;
    while path.exists() {
        path = target.join(format!("library-{stamp}-{n}.db"));
        n += 1;
    }
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy().to_string()]).map_err(err)?;
    let mut backups: Vec<PathBuf> = fs::read_dir(target)
        .map_err(err)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            name.starts_with("library-") && name.ends_with(".db")
        })
        .collect();
    backups.sort();
    while backups.len() > KEEP_BACKUPS {
        let old = backups.remove(0);
        let _ = fs::remove_file(old);
    }
    Ok(path)
}

// ------------------------------------------------------------------ JSON <-> SQLite

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn run_query(conn: &Connection, sql: &str, params: &[Value]) -> rusqlite::Result<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(params_from_iter(params.iter().map(to_sql)))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            m.insert(name.clone(), to_json(row.get_ref(i)?));
        }
        out.push(m);
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    changes: usize,
    last_insert_id: i64,
}

fn run_execute(conn: &Connection, sql: &str, params: &[Value]) -> rusqlite::Result<ExecResult> {
    let mut stmt = conn.prepare_cached(sql)?;
    let changes = stmt.execute(params_from_iter(params.iter().map(to_sql)))?;
    Ok(ExecResult { changes, last_insert_id: conn.last_insert_rowid() })
}

// ------------------------------------------------------------------ commands

/// Run a SELECT (or anything that returns rows); rows come back as objects keyed by column name.
#[tauri::command]
pub async fn db_query(lib: State<'_, Library>, sql: String, params: Option<Vec<Value>>) -> Result<Vec<Map<String, Value>>, String> {
    let conn = lib.conn.lock().map_err(err)?;
    run_query(&conn, &sql, &params.unwrap_or_default()).map_err(err)
}

/// Run one INSERT/UPDATE/DELETE.
#[tauri::command]
pub async fn db_execute(lib: State<'_, Library>, sql: String, params: Option<Vec<Value>>) -> Result<ExecResult, String> {
    let conn = lib.conn.lock().map_err(err)?;
    run_execute(&conn, &sql, &params.unwrap_or_default()).map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
    #[serde(default)]
    returns_rows: bool,
}

/// Run several statements in one transaction: all succeed or none do.
/// A parameter written as {"$ref": n} is replaced by the row id inserted by statement n.
#[tauri::command]
pub async fn db_transaction(lib: State<'_, Library>, statements: Vec<Statement>) -> Result<Vec<Value>, String> {
    let mut conn = lib.conn.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    let mut ids: Vec<i64> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for (n, s) in statements.iter().enumerate() {
        let params: Vec<Value> = s
            .params
            .iter()
            .map(|p| match p.get("$ref").and_then(|r| r.as_u64()) {
                Some(i) => ids.get(i as usize).map(|id| Value::from(*id)).ok_or(format!("statement {n}: no statement {i} to refer to")),
                None => Ok(p.clone()),
            })
            .collect::<Result<_, _>>()?;
        if s.returns_rows {
            let rows = run_query(&tx, &s.sql, &params).map_err(|e| format!("statement {n}: {e}"))?;
            ids.push(tx.last_insert_rowid());
            out.push(serde_json::to_value(rows).map_err(err)?);
        } else {
            let r = run_execute(&tx, &s.sql, &params).map_err(|e| format!("statement {n}: {e}"))?;
            ids.push(r.last_insert_id);
            out.push(serde_json::to_value(r).map_err(err)?);
        }
    }
    tx.commit().map_err(err)?;
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    dir: String,
    database: String,
    files: String,
    backup_dir: String,
    platform: String,
}

#[tauri::command]
pub async fn library_info(lib: State<'_, Library>) -> Result<LibraryInfo, String> {
    let conn = lib.conn.lock().map_err(err)?;
    Ok(LibraryInfo {
        dir: lib.dir.display().to_string(),
        database: lib.dir.join("library.db").display().to_string(),
        files: lib.dir.join("files").display().to_string(),
        backup_dir: lib.backup_dir(&conn).display().to_string(),
        platform: std::env::consts::OS.to_string(),
    })
}

/// Back up now, to `dir` if given, else to the usual backup folder. Returns the backup's path.
#[tauri::command]
pub async fn backup_library(lib: State<'_, Library>, dir: Option<String>) -> Result<String, String> {
    let conn = lib.conn.lock().map_err(err)?;
    let target = dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| lib.backup_dir(&conn));
    backup_into(&conn, &target).map(|p| p.display().to_string())
}
