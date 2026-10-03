//! The editing session: which `.hush` file is open, the working copy in the app
//! data folder, and the in-memory thumbnail cache.
//!
//! The user's file changes only on `save` / `save_as`. Everything in between
//! lives in the working copy `working.hush`: the stashed body (present only
//! while there are unsaved changes) and the images imported since the last
//! save. For an unnamed document the working copy is the whole draft.
use crate::db::Db;
use crate::fsx::ensure_extension;
use crate::model::{Diary, ExportImage, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

pub const EXTENSION: &str = "hush";
const RECOVERY_FILE: &str = "recovery.json";
const WORKING_FILE: &str = "working.hush";
/// Folder, next to an exported HTML file, that receives the originals.
const EXPORT_ATTACHMENTS: &str = "附件";

// Stored as recovery.json: which document the next launch reopens.
#[derive(Serialize, Deserialize)]
struct Recovery {
    /// `None` means the draft.
    path: Option<PathBuf>,
}
#[derive(Serialize)]
pub struct Opened {
    pub document: Diary,
    pub path: Option<PathBuf>,
    /// The document has unsaved changes recovered from the working copy.
    pub recovered: bool,
    /// Shown to the user instead of the plain "recovered" notice.
    pub notice: Option<String>,
}
pub struct Store {
    /// App data folder holding recovery.json and the working copy.
    root: PathBuf,
    /// The open `.hush` file; `None` while editing the draft.
    file: Option<(PathBuf, Db)>,
    /// `None` only before `restore` or after a failed switch.
    work: Option<Db>,
    /// Thumbnails (or why they failed) by image id, kept until the document is switched.
    thumbnails: HashMap<String, Thumbnail>,
}
/// Filled once; requests arriving while it is being built wait for that build.
type Thumbnail = Arc<OnceLock<Result<Vec<u8>>>>;
impl Store {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Self {
            root,
            file: None,
            work: None,
            thumbnails: HashMap::new(),
        })
    }
    fn work(&self) -> Result<&Db> {
        self.work.as_ref().ok_or_else(|| "没有打开的日记".into())
    }
    fn working_file(&self) -> PathBuf {
        self.root.join(WORKING_FILE)
    }
    fn opened(&self, document: Diary, recovered: bool) -> Opened {
        Opened {
            document,
            path: self.file.as_ref().map(|(path, _)| path.clone()),
            recovered,
            notice: None,
        }
    }
    /// Records which document is open so the next launch can resume it.
    fn checkpoint(&self) -> Result<()> {
        let bytes = serde_json::to_vec(&Recovery {
            path: self.file.as_ref().map(|(path, _)| path.clone()),
        })
        .map_err(|e| e.to_string())?;
        fs::write(self.root.join(RECOVERY_FILE), bytes).map_err(|e| e.to_string())
    }
    /// Discards the working copy: no stashed body, no pending images.
    fn reset_work(&mut self) -> Result<()> {
        // Closes the old copy before its file is removed.
        self.work = None;
        let file = self.working_file();
        remove_if_exists(&file)?;
        self.work = Some(Db::create(&file)?);
        Ok(())
    }
    /// Opens the working copy left by the last session and returns its stashed body.
    fn resume_work(&mut self) -> Result<Option<Diary>> {
        self.work = None;
        let file = self.working_file();
        if !file.exists() {
            self.work = Some(Db::create(&file)?);
            return Ok(None);
        }
        let (db, stash) = Db::open_stash(&file)?;
        self.work = Some(db);
        Ok(stash)
    }
    /// Leaves the current file, dropping the images its saved body no longer
    /// references. The working copy is reset by whatever comes next.
    fn leave(&mut self) -> Result<()> {
        if let Some((_, db)) = &self.file {
            db.collect_garbage()?;
        }
        self.file = None;
        self.thumbnails.clear();
        Ok(())
    }
    fn start_draft(&mut self) -> Result<()> {
        self.file = None;
        self.reset_work()?;
        self.checkpoint()
    }
    pub fn restore(&mut self) -> Result<Opened> {
        // An unreadable recovery.json counts as missing.
        let recovery = fs::read(self.root.join(RECOVERY_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Recovery>(&bytes).ok());
        if let Some(path) = recovery.and_then(|r| r.path) {
            let (db, saved) = match Db::open(&path) {
                Ok(opened) => opened,
                Err(e) => {
                    // Unsaved changes outlive their file: keep them as the draft.
                    self.file = None;
                    if let Some(stash) = self.resume_work()? {
                        self.checkpoint()?;
                        return Ok(Opened {
                            notice: Some(format!(
                                "原文件无法打开，未保存的修改已作为未命名文档恢复。{e}"
                            )),
                            ..self.opened(stash, true)
                        });
                    }
                    self.start_draft()?;
                    return Err(e);
                }
            };
            let stash = self.resume_work()?;
            self.file = Some((path, db));
            let recovered = stash.is_some();
            return Ok(self.opened(stash.unwrap_or(saved), recovered));
        }
        self.file = None;
        let document = self.resume_work()?.unwrap_or_else(Diary::empty);
        // An untouched draft is not "recovered".
        let recovered = document != Diary::empty();
        Ok(self.opened(document, recovered))
    }
    pub fn new_document(&mut self) -> Result<Opened> {
        self.leave()?;
        self.start_draft()?;
        Ok(self.opened(Diary::empty(), false))
    }
    pub fn open(&mut self, path: &Path) -> Result<Opened> {
        let path =
            fs::canonicalize(path).map_err(|e| format!("无法打开 {}：{e}", path.display()))?;
        // Read the new file first so a failed open leaves the current one in use.
        let (db, document) = Db::open(&path)?;
        self.leave()?;
        // Reset before the checkpoint, so a crash in between never pairs the old
        // document's unsaved changes with the new file.
        self.reset_work()?;
        self.file = Some((path, db));
        self.checkpoint()?;
        Ok(self.opened(document, false))
    }
    /// Keeps the body in the working copy only; the user's file is not touched.
    pub fn stash(&self, doc: &Diary) -> Result<()> {
        self.work()?.save(doc)
    }
    /// Writes the body and the images imported since the last save into the
    /// open file in one transaction, then empties the working copy.
    pub fn save(&mut self, doc: &Diary) -> Result<()> {
        let (_, db) = self.file.as_ref().ok_or("尚未保存为文件，请使用另存为")?;
        db.save_with_images(doc, &self.working_file())?;
        self.reset_work()
    }
    pub fn save_as(&mut self, path: &Path, doc: &Diary) -> Result<Opened> {
        let path = ensure_extension(path, EXTENSION);
        let directory =
            fs::canonicalize(path.parent().ok_or("保存路径无效")?).map_err(|e| e.to_string())?;
        let path = directory.join(path.file_name().ok_or("文件名无效")?);
        let path = fs::canonicalize(&path).unwrap_or(path);
        if self.file.as_ref().is_some_and(|(open, _)| *open == path) {
            self.save(doc)?;
            return Ok(self.opened(doc.clone(), false));
        }
        // Unreferenced images are copied too; they are dropped when the new file is left.
        match &self.file {
            Some((_, db)) => db.copy_to(&path, doc, Some(&self.working_file()))?,
            None => self.work()?.copy_to(&path, doc, None)?,
        }
        let (db, _) = Db::open(&path)?;
        self.file = Some((path, db));
        // Checkpoint first: a crash before the reset then reopens the new file
        // (which already holds everything) rather than an emptied draft.
        self.checkpoint()?;
        self.reset_work()?;
        Ok(self.opened(doc.clone(), false))
    }
    /// Called when the window closes, after the user saved or chose to discard:
    /// drops the unsaved changes and the images the saved body no longer uses.
    pub fn close(&mut self) -> Result<()> {
        if let Some((_, db)) = &self.file {
            db.collect_garbage()?;
        }
        self.reset_work()
    }
    /// Stores an original in the working copy (once per distinct content) and
    /// caches its thumbnail.
    pub fn add_image(&mut self, id: &str, bytes: &[u8], thumbnail: Vec<u8>) -> Result<()> {
        self.work()?.insert_image(id, bytes)?;
        self.thumbnails
            .insert(id.to_owned(), Arc::new(OnceLock::from(Ok(thumbnail))));
        Ok(())
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
    /// Thumbnail of `id`, built by `build` once per document; concurrent callers
    /// wait for the first build. `build` runs without the store lock so a slow
    /// decode never holds up saving.
    pub fn thumbnail(
        store: &Mutex<Self>,
        id: &str,
        build: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> Result<Vec<u8>> {
        let (slot, source) = {
            let mut store = store.lock().map_err(|e| e.to_string())?;
            let slot = store.thumbnails.entry(id.to_owned()).or_default().clone();
            // The original is read only while the slot is still empty.
            let source = match slot.get() {
                None => Some(store.image(id)?),
                Some(_) => None,
            };
            (slot, source)
        };
        // A filled slot never runs `build`, so `source` is always present when it does.
        slot.get_or_init(|| build(source.as_deref().unwrap_or_default()))
            .clone()
    }
    /// Writes an original byte-for-byte.
    pub fn export_image(&self, id: &str, path: &Path) -> Result<()> {
        fs::write(path, self.image(id)?).map_err(|e| format!("无法保存图片：{e}"))
    }
    /// Writes `content` to `path` and each listed original to `附件/<file>` beside it,
    /// skipping files that already exist.
    pub fn export(&self, path: &Path, content: &str, images: &[ExportImage]) -> Result<()> {
        if !images.is_empty() {
            let folder = path
                .parent()
                .ok_or("导出路径无效")?
                .join(EXPORT_ATTACHMENTS);
            fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            for image in images {
                let out = folder.join(&image.file);
                if !out.exists() {
                    self.export_image(&image.id, &out)?;
                }
            }
        }
        fs::write(path, content).map_err(|e| format!("无法导出：{e}"))
    }
}
fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}
