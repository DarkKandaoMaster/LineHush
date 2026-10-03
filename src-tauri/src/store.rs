//! The editing session: which `.hush` file is open, the unnamed draft in the
//! app data folder, and the in-memory thumbnail cache.
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
const DRAFT_FILE: &str = "draft.hush";
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
    pub recovered: bool,
}
pub struct Store {
    /// App data folder holding recovery.json and the draft.
    root: PathBuf,
    /// The open `.hush` file; `None` while editing the draft.
    path: Option<PathBuf>,
    /// `None` only before `restore` or after a failed switch.
    db: Option<Db>,
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
            path: None,
            db: None,
            thumbnails: HashMap::new(),
        })
    }
    fn db(&self) -> Result<&Db> {
        self.db.as_ref().ok_or_else(|| "没有打开的日记".into())
    }
    fn draft_file(&self) -> PathBuf {
        self.root.join(DRAFT_FILE)
    }
    fn opened(&self, document: Diary, recovered: bool) -> Opened {
        Opened {
            document,
            path: self.path.clone(),
            recovered,
        }
    }
    /// Records which document is open so the next launch can resume it.
    fn checkpoint(&self) -> Result<()> {
        let bytes = serde_json::to_vec(&Recovery {
            path: self.path.clone(),
        })
        .map_err(|e| e.to_string())?;
        fs::write(self.root.join(RECOVERY_FILE), bytes).map_err(|e| e.to_string())
    }
    /// Leaves the current document: a file drops images its body no longer
    /// references; the draft is discarded (the UI only switches away from an
    /// empty draft or after saving it as a file).
    fn leave(&mut self) -> Result<()> {
        let Some(db) = &self.db else {
            return Ok(());
        };
        if self.path.is_some() {
            db.collect_garbage()?;
        }
        // Closes the file before the draft is removed.
        self.db = None;
        self.thumbnails.clear();
        if self.path.is_none() {
            remove_if_exists(&self.draft_file())?;
        }
        Ok(())
    }
    fn start_draft(&mut self) -> Result<()> {
        let draft = self.draft_file();
        remove_if_exists(&draft)?;
        self.db = Some(Db::create(&draft)?);
        self.path = None;
        self.checkpoint()
    }
    pub fn restore(&mut self) -> Result<Opened> {
        // An unreadable recovery.json counts as missing.
        let recovery = fs::read(self.root.join(RECOVERY_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Recovery>(&bytes).ok());
        if let Some(path) = recovery.and_then(|r| r.path) {
            return match self.open(&path) {
                Ok(opened) => Ok(opened),
                Err(e) => {
                    self.start_draft()?;
                    Err(e)
                }
            };
        }
        let draft = self.draft_file();
        if draft.exists() {
            let (db, document) = Db::open(&draft)?;
            self.db = Some(db);
            self.path = None;
            // Same as before the move to .hush: an untouched draft is not "recovered".
            let recovered = document != Diary::empty();
            return Ok(self.opened(document, recovered));
        }
        self.start_draft()?;
        Ok(self.opened(Diary::empty(), false))
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
        self.db = Some(db);
        self.path = Some(path);
        self.checkpoint()?;
        Ok(self.opened(document, false))
    }
    pub fn save(&self, doc: &Diary) -> Result<()> {
        self.db()?.save(doc)
    }
    pub fn save_as(&mut self, path: &Path, doc: &Diary) -> Result<Opened> {
        let path = ensure_extension(path, EXTENSION);
        let directory =
            fs::canonicalize(path.parent().ok_or("保存路径无效")?).map_err(|e| e.to_string())?;
        let path = directory.join(path.file_name().ok_or("文件名无效")?);
        let path = fs::canonicalize(&path).unwrap_or(path);
        if self.path.as_ref() == Some(&path) {
            self.save(doc)?;
            return Ok(self.opened(doc.clone(), false));
        }
        // Unreferenced images are copied too; they are dropped when the new file is left.
        self.db()?.copy_to(&path, doc)?;
        let (db, _) = Db::open(&path)?;
        self.db = Some(db);
        if self.path.is_none() {
            // The draft now lives in the file. A leftover draft is replaced by the next one.
            let _ = fs::remove_file(self.draft_file());
        }
        self.path = Some(path);
        self.checkpoint()?;
        Ok(self.opened(doc.clone(), false))
    }
    /// Called when the window closes; the document stays usable if closing is cancelled.
    pub fn close(&self) -> Result<()> {
        self.db()?.collect_garbage()
    }
    /// Stores an original (once per distinct content) and caches its thumbnail.
    pub fn add_image(&mut self, id: &str, bytes: &[u8], thumbnail: Vec<u8>) -> Result<()> {
        self.db()?.insert_image(id, bytes)?;
        self.thumbnails
            .insert(id.to_owned(), Arc::new(OnceLock::from(Ok(thumbnail))));
        Ok(())
    }
    pub fn image(&self, id: &str) -> Result<Vec<u8>> {
        self.db()?.image(id)
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
