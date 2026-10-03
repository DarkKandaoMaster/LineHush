//! The `.hush` container: one SQLite file holding the body JSON and the original
//! image bytes. Every SQLite read and write goes through this module.
use crate::fsx::sidecar;
use crate::model::{Diary, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{collections::HashSet, fs, path::Path};

/// "HUSH" in the SQLite header, so the file can be identified without opening it.
const APPLICATION_ID: u32 = 0x4855_5348;
const FORMAT_VERSION: u32 = 1;

fn sql(e: rusqlite::Error) -> String {
    e.to_string()
}
fn body_json(doc: &Diary) -> Result<String> {
    serde_json::to_string(doc).map_err(|e| e.to_string())
}

pub struct Db {
    conn: Connection,
}
impl Db {
    /// Creates a new empty document at `path`, which must not exist yet.
    pub fn create(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).map_err(sql)?;
        // auto_vacuum only takes effect before the first page is written.
        conn.execute_batch(&format!(
            "PRAGMA auto_vacuum = INCREMENTAL;
             BEGIN;
             PRAGMA application_id = {APPLICATION_ID};
             PRAGMA user_version = {FORMAT_VERSION};
             CREATE TABLE doc (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
             CREATE TABLE images (id TEXT PRIMARY KEY, data BLOB NOT NULL);
             COMMIT;"
        ))
        .map_err(sql)?;
        conn.execute(
            "INSERT INTO doc (id, body) VALUES (1, ?1)",
            [body_json(&Diary::empty())?],
        )
        .map_err(sql)?;
        Ok(Self { conn })
    }
    /// Opens an existing document. Only the serde structure of the body is checked.
    pub fn open(path: &Path) -> Result<(Self, Diary)> {
        let unreadable = format!(
            "无法打开 {}：不是 LineHush 日记或文件已损坏",
            path.display()
        );
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("无法打开 {}：{e}", path.display()))?;
        let body: String = conn
            .query_row("SELECT body FROM doc WHERE id = 1", [], |row| row.get(0))
            .map_err(|_| unreadable.clone())?;
        let doc = serde_json::from_str(&body).map_err(|_| unreadable)?;
        Ok((Self { conn }, doc))
    }
    pub fn body(&self) -> Result<Diary> {
        let body: String = self
            .conn
            .query_row("SELECT body FROM doc WHERE id = 1", [], |row| row.get(0))
            .map_err(sql)?;
        serde_json::from_str(&body).map_err(|e| e.to_string())
    }
    /// Rewrites only the body; image rows are left untouched.
    pub fn save(&self, doc: &Diary) -> Result<()> {
        self.conn
            .execute("UPDATE doc SET body = ?1 WHERE id = 1", [body_json(doc)?])
            .map(drop)
            .map_err(sql)
    }
    /// Stores an original under its hash; an identical image is kept only once.
    pub fn insert_image(&self, id: &str, bytes: &[u8]) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO images (id, data) VALUES (?1, ?2)",
                rusqlite::params![id, bytes],
            )
            .map(drop)
            .map_err(sql)
    }
    pub fn image(&self, id: &str) -> Result<Vec<u8>> {
        self.conn
            .query_row("SELECT data FROM images WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(sql)?
            .ok_or_else(|| "日记中缺少这张图片的数据".into())
    }
    /// Writes a compacted copy holding `doc` to `target`, replacing any file there.
    /// The open file itself is not modified.
    pub fn copy_to(&self, target: &Path, doc: &Diary) -> Result<()> {
        // VACUUM INTO refuses an existing file, so build next to the target and rename.
        let tmp = sidecar(target, ".tmp");
        let _ = fs::remove_file(&tmp);
        let result = (|| {
            self.conn
                .execute("VACUUM INTO ?1", [tmp.to_string_lossy()])
                .map_err(sql)?;
            let (copy, _) = Self::open(&tmp)?;
            copy.save(doc)?;
            drop(copy);
            fs::rename(&tmp, target).map_err(|e| format!("保存失败，原文件保留：{e}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }
    /// Deletes images the saved body no longer references and returns the space
    /// to the file system. Only run when leaving a document, so undo within a
    /// session can always bring an image back.
    pub fn collect_garbage(&self) -> Result<()> {
        let body = self.body()?;
        let referenced: HashSet<&str> = body.pictures().map(|p| p.id.as_str()).collect();
        let stored = self
            .conn
            .prepare("SELECT id FROM images")
            .and_then(|mut stmt| {
                stmt.query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(sql)?;
        let unused: Vec<_> = stored
            .iter()
            .filter(|id| !referenced.contains(id.as_str()))
            .collect();
        if unused.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction().map_err(sql)?;
        for id in unused {
            tx.execute("DELETE FROM images WHERE id = ?1", [id])
                .map_err(sql)?;
        }
        tx.commit().map_err(sql)?;
        // Each step frees one page and yields a row, so step until done.
        let mut vacuum = self
            .conn
            .prepare("PRAGMA incremental_vacuum")
            .map_err(sql)?;
        let mut rows = vacuum.query([]).map_err(sql)?;
        while rows.next().map_err(sql)?.is_some() {}
        Ok(())
    }
}
