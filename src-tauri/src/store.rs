//! One tab's document: which `.hush` file it shows, its working copy in the
//! app data folder, and the in-memory thumbnail cache.
//!
//! The user's file changes only on `save` / `save_as`. Everything in between
//! lives in the tab's working copy `tabs/<id>.hush`: the stashed body (present
//! only while there are unsaved changes) and the images imported since the last
//! save. For an unnamed document the working copy is the whole draft. Which file
//! a working copy belongs to is recorded in session.json (see session.rs).
use crate::db::Db;
use crate::errors::describe;
use crate::fsx::{ensure_extension, shown};
use crate::lock;
use crate::model::{Diary, ExportImage, Result};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const EXTENSION: &str = "hush";
/// Folder, next to an exported HTML file, that receives the originals.
const EXPORT_ATTACHMENTS: &str = "附件";

#[derive(Clone, Debug, Serialize)]
pub struct Opened {
    pub document: Diary,
    pub path: Option<PathBuf>,
    /// The document has unsaved changes recovered from the working copy.
    pub recovered: bool,
    /// Shown to the user: instead of the plain "recovered" notice, or after a
    /// switch whose best-effort cleanup of the previous file failed.
    pub notice: Option<String>,
}
impl Opened {
    /// A new, empty unnamed document.
    pub fn blank() -> Self {
        Self {
            document: Diary::empty(),
            path: None,
            recovered: false,
            notice: None,
        }
    }
}
pub struct Store {
    /// This tab's working copy, `tabs/<id>.hush` in the app data folder.
    work_file: PathBuf,
    /// The open `.hush` file; `None` while editing the draft.
    file: Option<(PathBuf, Db)>,
    /// `None` only after `close` or a failed switch.
    work: Option<Db>,
    /// Thumbnails (or why they failed) by image id, kept until the document is switched.
    thumbnails: HashMap<String, Result<Vec<u8>>>,
}
impl Store {
    fn blank(work_file: PathBuf) -> Result<Self> {
        if let Some(folder) = work_file.parent() {
            fs::create_dir_all(folder)
                .map_err(|e| format!("无法创建数据文件夹 {}：{}", shown(folder), describe(e)))?;
        }
        Ok(Self {
            work_file,
            file: None,
            work: None,
            thumbnails: HashMap::new(),
        })
    }
    /// A new tab: an empty unnamed document with a fresh working copy at `work`.
    pub fn create(work: PathBuf) -> Result<Self> {
        let mut store = Self::blank(work)?;
        store.reset_work()?;
        Ok(store)
    }
    /// A new tab showing the file at `path`. A failed open leaves no working copy.
    pub fn open_new(work: PathBuf, path: &Path) -> Result<(Self, Opened)> {
        let mut store = Self::blank(work)?;
        let opened = store.open(path)?;
        Ok((store, opened))
    }
    /// The working copy at `work`, opened, with its stashed body if that is worth
    /// restoring: any stash of a file (`named`), a non-empty one of an unnamed
    /// document.
    fn stashed(work: &Path, named: bool) -> Result<Option<(Db, Diary)>> {
        if !work.exists() {
            return Ok(None);
        }
        Ok(match Db::open_stash(work)? {
            (db, Some(stash)) if named || stash != Diary::empty() => Some((db, stash)),
            _ => None,
        })
    }
    /// Whether the working copy at `work` holds unsaved changes worth restoring
    /// (see `load`). A working copy that cannot be read counts, so loading it
    /// says why.
    pub fn has_stash(work: &Path, named: bool) -> bool {
        Self::stashed(work, named).map_or(true, |stash| stash.is_some())
    }
    /// A tab of session.json, loaded at the start or when a window destroyed
    /// without closing its tabs is opened again. Unsaved changes in its working
    /// copy (see `has_stash`) are picked up and paired with `path`, the file it
    /// belongs to; a file that can no longer be opened leaves them as an
    /// unnamed document, with a notice saying why. Otherwise `path` is opened
    /// afresh. A file (or working copy) that cannot be opened leaves a new
    /// unnamed document, and the reason as the third value.
    pub fn load(work: PathBuf, path: Option<&Path>) -> Result<(Self, Opened, Option<String>)> {
        let mut store = Self::blank(work)?;
        let error = match Self::stashed(&store.work_file, path.is_some()) {
            Ok(Some((db, stash))) => {
                store.work = Some(db);
                let mut notice = None;
                if let Some(path) = path {
                    match Db::open(path) {
                        Ok((db, _)) => store.file = Some((path.to_path_buf(), db)),
                        // Unsaved changes outlive their file: keep them as the draft.
                        Err(e) => {
                            notice = Some(format!(
                                "原文件无法打开，未保存的修改已作为未命名文档恢复。{e}"
                            ))
                        }
                    }
                }
                let opened = Opened {
                    notice,
                    ..store.opened(stash, true)
                };
                return Ok((store, opened, None));
            }
            Ok(None) => match path.map(|path| store.open(path)) {
                Some(Ok(opened)) => return Ok((store, opened, None)),
                Some(Err(e)) => Some(e),
                None => None,
            },
            Err(e) => Some(e),
        };
        store.reset_work()?;
        Ok((store, Opened::blank(), error))
    }
    /// What the tab shows now, for a window that loads again (e.g. a reload
    /// while developing): the stash if there is one, else the saved body.
    pub fn current(&self) -> Result<Opened> {
        if let Some(stash) = self.work()?.stash()? {
            let recovered = self.file.is_some() || stash != Diary::empty();
            return Ok(self.opened(stash, recovered));
        }
        let document = match &self.file {
            Some((_, db)) => db.body()?,
            None => Diary::empty(),
        };
        Ok(self.opened(document, false))
    }
    /// The open `.hush` file (canonical); `None` for the draft.
    pub fn path(&self) -> Option<&Path> {
        self.file.as_ref().map(|(path, _)| path.as_path())
    }
    fn work(&self) -> Result<&Db> {
        self.work.as_ref().ok_or_else(|| "没有打开的日记".into())
    }
    fn opened(&self, document: Diary, recovered: bool) -> Opened {
        Opened {
            document,
            path: self.file.as_ref().map(|(path, _)| path.clone()),
            recovered,
            notice: None,
        }
    }
    /// Discards the working copy: no stashed body, no pending images.
    fn reset_work(&mut self) -> Result<()> {
        // Closes the old copy before its file is removed.
        self.work = None;
        remove_if_exists(&self.work_file)?;
        self.work = Some(Db::create(&self.work_file)?);
        Ok(())
    }
    /// Leaves the current file, dropping the images its saved body no longer
    /// references, and the thumbnails. The cleanup is best effort: a file that
    /// is gone or damaged is still left, and the error says why its images stay.
    fn leave_file(&mut self) -> Option<String> {
        self.thumbnails.clear();
        let (_, db) = self.file.take()?;
        db.collect_garbage().err()
    }
    /// Opens `path` in this tab: Ctrl+O in an unnamed, unchanged tab opens in
    /// place. A failed open leaves the current document in use.
    pub fn open(&mut self, path: &Path) -> Result<Opened> {
        let path = fs::canonicalize(path)
            .map_err(|e| format!("无法打开 {}：{}", shown(path), describe(e)))?;
        // Read the new file first so a failed open leaves the current one in use.
        let (db, document) = Db::open(&path)?;
        let notice = self
            .leave_file()
            .map(|e| format!("上一个文件的未引用图片未能清理：{e}"));
        self.reset_work()?;
        self.file = Some((path, db));
        Ok(Opened {
            notice,
            ..self.opened(document, false)
        })
    }
    /// Keeps the body in the working copy only; the user's file is not touched.
    pub fn stash(&self, doc: &Diary) -> Result<()> {
        self.work()?.save(doc)
    }
    /// 丢掉工作副本里的暂存正文（工作副本中的图片不动）：内容与已保存的相同时用，
    /// 免得下次启动把它当成未保存的修改恢复。
    pub fn discard_stash(&self) -> Result<()> {
        self.work()?.clear_stash()
    }
    /// Writes the body and the images imported since the last save into the
    /// open file in one transaction, then empties the working copy.
    pub fn save(&mut self, doc: &Diary) -> Result<()> {
        let (_, db) = self.file.as_ref().ok_or("尚未保存为文件，请使用另存为")?;
        db.save_with_images(doc, &self.work_file)?;
        self.reset_work()
    }
    /// The file `save_as(path)` writes: `.hush` added, the folder made canonical.
    pub fn save_as_target(path: &Path) -> Result<PathBuf> {
        let path = ensure_extension(path, EXTENSION);
        let parent = path.parent().ok_or("保存路径无效")?;
        let directory = fs::canonicalize(parent)
            .map_err(|e| format!("无法访问 {}：{}", shown(parent), describe(e)))?;
        let path = directory.join(path.file_name().ok_or("文件名无效")?);
        Ok(fs::canonicalize(&path).unwrap_or(path))
    }
    pub fn save_as(&mut self, path: &Path, doc: &Diary) -> Result<Opened> {
        let path = Self::save_as_target(path)?;
        if self.file.as_ref().is_some_and(|(open, _)| *open == path) {
            self.save(doc)?;
            return Ok(self.opened(doc.clone(), false));
        }
        // Unreferenced images are copied too; they are dropped when the new file is left.
        match &self.file {
            Some((_, db)) => db.copy_to(&path, doc, Some(&self.work_file))?,
            None => self.work()?.copy_to(&path, doc, None)?,
        }
        let (db, _) = Db::open(&path)?;
        self.file = Some((path, db));
        self.reset_work()?;
        Ok(self.opened(doc.clone(), false))
    }
    /// Called when the tab closes, after the user saved or chose to discard:
    /// drops the images the saved body no longer uses and deletes the working
    /// copy with its unsaved changes. Both are best effort and never keep the tab
    /// open; the returned text says what failed. The store is unusable afterwards.
    /// A working copy that could not be deleted is removed on a later launch, as
    /// session.json no longer names it.
    pub fn close(&mut self) -> Option<String> {
        let garbage = self.leave_file();
        // Closes the working copy before its file is removed.
        self.work = None;
        let warnings: Vec<String> = [
            garbage.map(|e| format!("未引用图片未能清理：{e}")),
            remove_if_exists(&self.work_file)
                .err()
                .map(|e| format!("未保存的修改未能丢弃：{e}")),
        ]
        .into_iter()
        .flatten()
        .collect();
        (!warnings.is_empty()).then(|| warnings.join("；"))
    }
    /// Stores an original in the working copy (once per distinct content), so it
    /// is saved with this document: an import, which brings its `thumbnail`
    /// along, or an image pasted from another document (its id already checked).
    pub fn add_image(&mut self, id: &str, bytes: &[u8], thumbnail: Option<Vec<u8>>) -> Result<()> {
        self.work()?.insert_image(id, bytes)?;
        if let Some(thumbnail) = thumbnail {
            self.thumbnails.insert(id.to_owned(), Ok(thumbnail));
        }
        Ok(())
    }
    /// Whether this document can show `id`: the working copy or the open file holds it.
    pub fn has_image(&self, id: &str) -> Result<bool> {
        Ok(self.work()?.has_image(id)?
            || match &self.file {
                Some((_, db)) => db.has_image(id)?,
                None => false,
            })
    }
    /// An original, from the working copy or else from the open file.
    pub fn image(&self, id: &str) -> Result<Vec<u8>> {
        if let Some(bytes) = self.work()?.image(id)? {
            return Ok(bytes);
        }
        match &self.file {
            Some((_, db)) => db.image(id)?,
            None => None,
        }
        .ok_or_else(|| "日记中缺少这张图片的数据".into())
    }
    /// Thumbnail of `id`, built by `build` and then kept. `build` runs without
    /// the store lock so a slow decode never holds up saving. Two requests for an
    /// image not cached yet may both build it; the id is the content hash, so
    /// either result is the same.
    pub fn thumbnail(
        store: &Mutex<Self>,
        id: &str,
        build: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> Result<Vec<u8>> {
        let source = {
            let store = lock(store);
            if let Some(cached) = store.thumbnails.get(id) {
                return cached.clone();
            }
            store.image(id)?
        };
        let thumbnail = build(&source);
        lock(store).thumbnails.insert(id.to_owned(), thumbnail.clone());
        thumbnail
    }
    /// Writes an original byte-for-byte.
    pub fn export_image(&self, id: &str, path: &Path) -> Result<()> {
        fs::write(path, self.image(id)?)
            .map_err(|e| format!("无法写入 {}：{}", shown(path), describe(e)))
    }
    /// Writes `content` to `path` and each listed original to `附件/<file>` beside it,
    /// skipping files that already exist.
    pub fn export(&self, path: &Path, content: &str, images: &[ExportImage]) -> Result<()> {
        if !images.is_empty() {
            let folder = path
                .parent()
                .ok_or("导出路径无效")?
                .join(EXPORT_ATTACHMENTS);
            fs::create_dir_all(&folder)
                .map_err(|e| format!("无法创建 {}：{}", shown(&folder), describe(e)))?;
            for image in images {
                let out = folder.join(&image.file);
                if !out.exists() {
                    self.export_image(&image.id, &out)?;
                }
            }
        }
        fs::write(path, content).map_err(|e| format!("无法写入 {}：{}", shown(path), describe(e)))
    }
}
pub fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("无法清空 {}：{}", shown(path), describe(e)))
        }
        _ => Ok(()),
    }
}
