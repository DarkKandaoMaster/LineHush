//! The `.hush` container: one SQLite file holding the body JSON, the original
//! bytes of its images, videos and audio clips, and the covers of its videos.
//! Every SQLite read and write goes through this module.
//!
//! The working copy in the app data folder uses the same schema. Its `doc` row
//! exists only while it holds a stashed (unsaved) body.
//!
//! Format v1 had no `posters` table. A v1 file is not changed when opened; the
//! first save (or save as) adds the table and sets `user_version` to 2.
use crate::errors::describe;
use crate::fsx::{shown, sidecar};
use crate::model::{Diary, Result};
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension};
use std::{collections::HashSet, fs, path::Path};

/// "HUSH" in the SQLite header, so the file can be identified without opening it.
const APPLICATION_ID: u32 = 0x4855_5348;
const FORMAT_VERSION: u32 = 2;
/// Video covers, keyed like `images`. Missing from files (and working copies) of v1.
const CREATE_POSTERS: &str = "CREATE TABLE IF NOT EXISTS {db}.posters (id TEXT PRIMARY KEY, data BLOB NOT NULL)";
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
/// Parses a body row; one that does not parse is reported as `{what}（serde's reason）`.
fn parse_body(body: &str, what: &str) -> Result<Diary> {
    serde_json::from_str(body).map_err(|e| format!("{what}（{e}）"))
}
/// Brings database `db` ("main", or an attached one) to the current format:
/// the `posters` table and `user_version`. Does nothing to a current one.
fn upgrade(conn: &Connection, db: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "{}; PRAGMA {db}.user_version = {FORMAT_VERSION};",
        CREATE_POSTERS.replace("{db}", db)
    ))
}
/// Whether database `db` has the `posters` table (a v1 file has not).
fn has_posters(conn: &Connection, db: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        &format!("SELECT 1 FROM {db}.sqlite_master WHERE type = 'table' AND name = 'posters'"),
        [],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
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
             CREATE TABLE posters (id TEXT PRIMARY KEY, data BLOB NOT NULL);
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
        let doc = parse_body(&body, NOT_HUSH).map_err(|_| cannot_open(path, NOT_HUSH))?;
        Ok((Self { conn }, doc))
    }
    /// Opens the working copy and its stashed body, if any.
    pub fn open_stash(path: &Path) -> Result<(Self, Option<Diary>)> {
        let db = Self {
            conn: connect(path)?,
        };
        let stash = db.stash()?;
        Ok((db, stash))
    }
    /// The stashed body of a working copy, if any.
    pub fn stash(&self) -> Result<Option<Diary>> {
        read_body(&self.conn)
            .map_err(sql)?
            .map(|body| parse_body(&body, "暂存的修改无法读取"))
            .transpose()
    }
    pub fn body(&self) -> Result<Diary> {
        let body = read_body(&self.conn)
            .map_err(sql)?
            .ok_or("笔记中缺少正文")?;
        parse_body(&body, NOT_HUSH)
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
    /// In one transaction, brings this file to the current format, copies every
    /// image and cover of the working copy at `work` that it lacks and rewrites
    /// the body.
    pub fn save_with_images(&self, doc: &Diary, work: &Path) -> Result<()> {
        let body = body_json(doc)?;
        self.conn
            .execute("ATTACH DATABASE ?1 AS work", [work.to_string_lossy()])
            .map_err(sql)?;
        let result = (|| {
            let tx = self.conn.unchecked_transaction()?;
            upgrade(&tx, "main")?;
            tx.execute(
                "INSERT OR IGNORE INTO main.images (id, data) SELECT id, data FROM work.images",
                [],
            )?;
            // A working copy left by format v1 has no covers.
            if has_posters(&tx, "work")? {
                tx.execute(
                    "INSERT OR IGNORE INTO main.posters (id, data) SELECT id, data FROM work.posters",
                    [],
                )?;
            }
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
    /// Size in bytes of an original, without reading it.
    pub fn image_len(&self, id: &str) -> Result<Option<u64>> {
        self.conn
            .query_row("SELECT length(data) FROM images WHERE id = ?1", [id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map(|len| len.map(|len| len as u64))
            .map_err(sql)
    }
    /// Up to `len` bytes of an original from byte `start` on (fewer at its end),
    /// read without loading the rest of it.
    pub fn image_range(&self, id: &str, start: u64, len: usize) -> Result<Option<Vec<u8>>> {
        let rowid = self
            .conn
            .query_row("SELECT rowid FROM images WHERE id = ?1", [id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map_err(sql)?;
        let Some(rowid) = rowid else {
            return Ok(None);
        };
        let blob = self
            .conn
            .blob_open("main", "images", "data", rowid, true)
            .map_err(sql)?;
        let start = (start as usize).min(blob.len());
        let mut bytes = vec![0; len.min(blob.len() - start)];
        blob.read_at_exact(&mut bytes, start).map_err(sql)?;
        Ok(Some(bytes))
    }
    /// Stores the cover of a video under the video's id, upgrading a working
    /// copy left by format v1 first.
    pub fn insert_poster(&self, id: &str, bytes: &[u8]) -> Result<()> {
        upgrade(&self.conn, "main").map_err(sql)?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO posters (id, data) VALUES (?1, ?2)",
                rusqlite::params![id, bytes],
            )
            .map(drop)
            .map_err(sql)
    }
    /// The cover of video `id`; None also for a v1 file, which has no covers.
    pub fn poster(&self, id: &str) -> Result<Option<Vec<u8>>> {
        if !has_posters(&self.conn, "main").map_err(sql)? {
            return Ok(None);
        }
        self.conn
            .query_row("SELECT data FROM posters WHERE id = ?1", [id], |row| {
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
            upgrade(&copy.conn, "main").map_err(sql)?;
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
    /// Deletes images (and covers) the saved body no longer references and
    /// returns the space to the file system. Only run when leaving a document, so
    /// undo within a session can always bring an image back.
    pub fn collect_garbage(&self) -> Result<()> {
        let body = self.body()?;
        let referenced: HashSet<&str> = body.pictures().map(|p| p.id.as_str()).collect();
        let mut tables = vec!["images"];
        if has_posters(&self.conn, "main").map_err(sql)? {
            tables.push("posters");
        }
        let mut unused = Vec::new();
        for table in tables {
            let stored = self
                .conn
                .prepare(&format!("SELECT id FROM {table}"))
                .and_then(|mut stmt| {
                    stmt.query_map([], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .map_err(sql)?;
            unused.extend(
                stored
                    .into_iter()
                    .filter(|id| !referenced.contains(id.as_str()))
                    .map(|id| (table, id)),
            );
        }
        if unused.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction().map_err(sql)?;
        for (table, id) in unused {
            tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])
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
