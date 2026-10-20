//! The `.hush` container: one SQLite file holding the body JSON and the original
//! image bytes. Every SQLite read and write goes through this module.
//!
//! The working copy in the app data folder uses the same schema. Its `doc` row
//! exists only while it holds a stashed (unsaved) body.
use crate::errors::describe;
use crate::fsx::{shown, sidecar};
use crate::model::{Diary, Result};
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension};
use std::{collections::HashSet, fs, path::Path};

/// "HUSH" in the SQLite header, so the file can be identified without opening it.
const APPLICATION_ID: u32 = 0x4855_5348;
const FORMAT_VERSION: u32 = 1;
/// Writes the body, inserting the row when the working copy has none yet.
const WRITE_BODY: &str = "INSERT OR REPLACE INTO main.doc (id, body) VALUES (1, ?1)";

/// Shown when a file opens but holds no readable LineHush body.
const NOT_HUSH: &str = "不是有效的 .hush 文件或文件已损坏";

fn sql(e: rusqlite::Error) -> String {
    describe(e)
}
fn body_json(doc: &Diary) -> Result<String> {
    serde_json::to_string(doc).map_err(|e| e.to_string())
}
fn cannot_open(path: &Path, reason: impl std::fmt::Display) -> String {
    format!("无法打开 {}：{reason}", shown(path))
}
fn connect(path: &Path) -> Result<Connection> {
    // SQLite reports a missing file as "unable to open", which reads like a
    // permissions problem; ask the file system first.
    fs::metadata(path).map_err(|e| cannot_open(path, describe(e)))?;
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| cannot_open(path, describe(e)))
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
        let conn = Connection::open(path).map_err(|e| cannot_open(path, describe(e)))?;
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
        let conn = connect(path)?;
        let body = match read_body(&conn) {
            Ok(Some(body)) => body,
            Ok(None) => return Err(cannot_open(path, NOT_HUSH)),
            // A plain SQL error ("no such table") means some other SQLite file.
            Err(e)
                if e.sqlite_error_code()
                    .is_none_or(|code| code == ErrorCode::Unknown) =>
            {
                return Err(cannot_open(path, NOT_HUSH))
            }
            Err(e) => return Err(cannot_open(path, describe(e))),
        };
        let doc = serde_json::from_str(&body).map_err(|_| cannot_open(path, NOT_HUSH))?;
        Ok((Self { conn }, doc))
    }
    /// Opens the working copy and its stashed body, if any.
    pub fn open_stash(path: &Path) -> Result<(Self, Option<Diary>)> {
        let conn = connect(path)?;
        let stash = match read_body(&conn).map_err(sql)? {
            Some(body) => Some(
                serde_json::from_str(&body).map_err(|e| format!("暂存的修改无法读取（{e}）"))?,
            ),
            None => None,
        };
        Ok((Self { conn }, stash))
    }
    /// The stashed body of a working copy, if any.
    pub fn stash(&self) -> Result<Option<Diary>> {
        match read_body(&self.conn).map_err(sql)? {
            Some(body) => serde_json::from_str(&body)
                .map(Some)
                .map_err(|e| format!("暂存的修改无法读取（{e}）")),
            None => Ok(None),
        }
    }
    pub fn body(&self) -> Result<Diary> {
        let body = read_body(&self.conn)
            .map_err(sql)?
            .ok_or("日记中缺少正文")?;
        serde_json::from_str(&body).map_err(|e| format!("{NOT_HUSH}（{e}）"))
    }
    /// Rewrites only the body; image rows are left untouched.
    pub fn save(&self, doc: &Diary) -> Result<()> {
        self.conn
            .execute(WRITE_BODY, [body_json(doc)?])
            .map(drop)
            .map_err(sql)
    }
    /// Removes the stashed body of a working copy; its images stay.
    pub fn clear_stash(&self) -> Result<()> {
        self.conn
            .execute("DELETE FROM doc WHERE id = 1", [])
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
    pub fn has_image(&self, id: &str) -> Result<bool> {
        self.conn
            .query_row("SELECT 1 FROM images WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .map(|row| row.is_some())
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
            fs::rename(&tmp, target).map_err(|e| {
                format!(
                    "无法写入 {}，原有文件保持不变：{}",
                    shown(target),
                    describe(e)
                )
            })
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
