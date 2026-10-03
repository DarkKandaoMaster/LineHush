//! The `.hush` container: one SQLite file holding the body JSON and the original
//! image bytes. Every SQLite read and write goes through this module.
//!
//! The working copy in the app data folder uses the same schema. Its `doc` row
//! exists only while it holds a stashed (unsaved) body.
use crate::fsx::sidecar;
use crate::model::{Diary, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{collections::HashSet, fs, path::Path};

/// "HUSH" in the SQLite header, so the file can be identified without opening it.
const APPLICATION_ID: u32 = 0x4855_5348;
const FORMAT_VERSION: u32 = 1;
/// Writes the body, inserting the row when the working copy has none yet.
const WRITE_BODY: &str = "INSERT OR REPLACE INTO main.doc (id, body) VALUES (1, ?1)";

fn sql(e: rusqlite::Error) -> String {
    e.to_string()
}
fn body_json(doc: &Diary) -> Result<String> {
    serde_json::to_string(doc).map_err(|e| e.to_string())
}
fn connect(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("无法打开 {}：{e}", path.display()))
}
fn read_body(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT body FROM doc WHERE id = 1", [], |row| row.get(0))
        .optional()
}

pub struct Db {
    conn: Connection,
}
impl Db {
    /// Creates an empty container (no body row) at `path`, which must not exist yet.
    /// Used for the working copy; a user file always gets its body from `copy_to`.
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
        Ok(Self { conn })
    }
    /// Opens an existing document. Only the serde structure of the body is checked.
    pub fn open(path: &Path) -> Result<(Self, Diary)> {
        let unreadable = format!(
            "无法打开 {}：不是 LineHush 日记或文件已损坏",
            path.display()
        );
        let conn = connect(path)?;
        let body = read_body(&conn)
            .ok()
            .flatten()
            .ok_or_else(|| unreadable.clone())?;
        let doc = serde_json::from_str(&body).map_err(|_| unreadable)?;
        Ok((Self { conn }, doc))
    }
    /// Opens the working copy and its stashed body, if any.
    pub fn open_stash(path: &Path) -> Result<(Self, Option<Diary>)> {
        let conn = connect(path)?;
        let stash = match read_body(&conn).map_err(sql)? {
            Some(body) => Some(serde_json::from_str(&body).map_err(|e| e.to_string())?),
            None => None,
        };
        Ok((Self { conn }, stash))
    }
    pub fn body(&self) -> Result<Diary> {
        let body = read_body(&self.conn)
            .map_err(sql)?
            .ok_or("日记中缺少正文")?;
        serde_json::from_str(&body).map_err(|e| e.to_string())
    }
    /// Rewrites only the body; image rows are left untouched.
    pub fn save(&self, doc: &Diary) -> Result<()> {
        self.conn
            .execute(WRITE_BODY, [body_json(doc)?])
            .map(drop)
            .map_err(sql)
    }
    /// In one transaction, copies every image of the working copy at `work` that
    /// this file lacks and rewrites the body.
    pub fn save_with_images(&self, doc: &Diary, work: &Path) -> Result<()> {
        let body = body_json(doc)?;
        self.conn
            .execute("ATTACH DATABASE ?1 AS work", [work.to_string_lossy()])
            .map_err(sql)?;
        let result = (|| {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute(
                "INSERT OR IGNORE INTO main.images (id, data) SELECT id, data FROM work.images",
                [],
            )?;
            tx.execute(WRITE_BODY, [&body])?;
            tx.commit()
        })()
        .map_err(sql);
        let detached = self
            .conn
            .execute("DETACH DATABASE work", [])
            .map(drop)
            .map_err(sql);
        result.and(detached)
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
    pub fn image(&self, id: &str) -> Result<Option<Vec<u8>>> {
        self.conn
            .query_row("SELECT data FROM images WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(sql)
    }
    /// Writes a compacted copy holding `doc` to `target`, replacing any file there,
    /// plus the images of the working copy at `work` when given.
    /// The open file itself is not modified.
    pub fn copy_to(&self, target: &Path, doc: &Diary, work: Option<&Path>) -> Result<()> {
        // VACUUM INTO refuses an existing file, so build next to the target and rename.
        let tmp = sidecar(target, ".tmp");
        let _ = fs::remove_file(&tmp);
        let result = (|| {
            self.conn
                .execute("VACUUM INTO ?1", [tmp.to_string_lossy()])
                .map_err(sql)?;
            let copy = Self {
                conn: connect(&tmp)?,
            };
            match work {
                Some(work) => copy.save_with_images(doc, work)?,
                None => copy.save(doc)?,
            }
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
