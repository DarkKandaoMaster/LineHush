//! The editing session: which document is open, where its attachments live,
//! and the crash-recovery checkpoint in the app data folder.
use crate::fsx::{
    atomic_write, backup, ensure_extension, read_diary, read_file, sidecar, write_diary,
    BACKUP_EXTENSION,
};
use crate::model::{validate_picture_path, Diary, Result, ATTACHMENTS};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

const RECOVERY_FILE: &str = "recovery.json";
const DRAFTS_DIR: &str = "drafts";

// Stored as recovery.json; the field names are part of the on-disk format.
#[derive(Serialize, Deserialize)]
struct Recovery {
    path: Option<PathBuf>,
    directory: PathBuf,
    // Only drafts without a file keep their content here; saved files are reopened by path.
    document: Option<Diary>,
}
#[derive(Serialize)]
pub struct Opened {
    pub document: Diary,
    pub path: Option<PathBuf>,
    pub recovered: bool,
}
pub struct Store {
    /// Folder that `附件/…` picture paths resolve against: the open file's
    /// folder, or `<root>/drafts` for a new draft.
    pub base_dir: PathBuf,
    /// App data folder holding recovery.json and drafts/.
    root: PathBuf,
    /// The open `.linehush` file; `None` while editing a draft.
    path: Option<PathBuf>,
}
impl Store {
    pub fn new(root: PathBuf) -> Result<Self> {
        let base_dir = root.join(DRAFTS_DIR);
        fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;
        Ok(Self {
            root,
            base_dir,
            path: None,
        })
    }
    fn opened(&self, document: Diary, recovered: bool) -> Opened {
        Opened {
            document,
            path: self.path.clone(),
            recovered,
        }
    }
    fn recovery_file(&self) -> PathBuf {
        self.root.join(RECOVERY_FILE)
    }
    pub fn restore(&mut self) -> Result<Opened> {
        let file = self.recovery_file();
        if !file.exists() {
            return Ok(self.opened(Diary::empty(), false));
        }
        let Ok(r) = serde_json::from_slice::<Recovery>(&read_file(&file)?) else {
            fs::rename(&file, sidecar(&file, ".broken")).map_err(|e| e.to_string())?;
            return Err(
                "恢复草稿无法读取，已改名为 recovery.json.broken，本次以空文档启动。".into(),
            );
        };
        if let Some(path) = r.path {
            return self.open(&path);
        }
        let document = r.document.unwrap_or_else(Diary::empty);
        document.validate()?;
        self.path = None;
        self.base_dir = r.directory;
        Ok(self.opened(document, true))
    }
    /// Records the session in recovery.json so the next launch can resume it.
    pub fn checkpoint(&self, doc: &Diary) -> Result<()> {
        let r = Recovery {
            path: self.path.clone(),
            directory: self.base_dir.clone(),
            document: self.path.is_none().then(|| doc.clone()),
        };
        let bytes = serde_json::to_vec(&r).map_err(|e| e.to_string())?;
        atomic_write(&self.recovery_file(), &bytes)
    }
    pub fn new_document(&mut self) -> Result<Opened> {
        self.path = None;
        self.base_dir = self.root.join(DRAFTS_DIR);
        self.checkpoint(&Diary::empty())?;
        Ok(self.opened(Diary::empty(), false))
    }
    pub fn open(&mut self, path: &Path) -> Result<Opened> {
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let document = read_diary(&path)?;
        self.base_dir = path.parent().ok_or("文档路径无效")?.to_path_buf();
        if path.extension().is_some_and(|ext| ext == BACKUP_EXTENSION) {
            self.path = None;
        } else {
            // .bak is the version this session started from.
            backup(&path)?;
            self.path = Some(path);
        }
        self.checkpoint(&document)?;
        Ok(self.opened(document, false))
    }
    pub fn save(&mut self, doc: &Diary) -> Result<()> {
        doc.validate()?;
        match &self.path {
            None => self.checkpoint(doc),
            Some(path) => write_diary(path, doc),
        }
    }
    pub fn save_as(&mut self, path: &Path, doc: &Diary) -> Result<Opened> {
        doc.validate()?;
        let path = ensure_extension(path, "linehush");
        let directory =
            fs::canonicalize(path.parent().ok_or("保存路径无效")?).map_err(|e| e.to_string())?;
        let path = directory.join(path.file_name().ok_or("文件名无效")?);
        if self.path.as_ref() != Some(&path) {
            self.copy_referenced(doc, &directory)?;
            if path.exists() {
                backup(&path)?;
            }
        }
        write_diary(&path, doc)?;
        self.base_dir = directory;
        self.path = Some(path);
        self.checkpoint(doc)?;
        Ok(self.opened(doc.clone(), false))
    }
    /// Resolves a picture path to its original file, which must exist.
    pub fn attachment(&self, relative: &str) -> Result<PathBuf> {
        validate_picture_path(relative)?;
        let path = self.base_dir.join(relative);
        if !path.is_file() {
            return Err("图片附件缺失，请检查附件文件夹".into());
        }
        Ok(path)
    }
    // Copies the originals the document references; missing or already present files are skipped.
    fn copy_referenced(&self, doc: &Diary, destination: &Path) -> Result<()> {
        if fs::canonicalize(&self.base_dir).ok().as_deref() == Some(destination) {
            return Ok(());
        }
        let target = destination.join(ATTACHMENTS);
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        for pic in doc.pictures() {
            let Ok(source) = self.attachment(&pic.path) else {
                continue;
            };
            let out = target.join(source.file_name().ok_or("图片文件名无效")?);
            if !out.exists() {
                fs::copy(&source, &out).map_err(|e| format!("无法复制图片：{e}"))?;
            }
        }
        Ok(())
    }
    pub fn export(&self, path: &Path, content: &str, html: bool, document: &Diary) -> Result<()> {
        let path = ensure_extension(path, if html { "html" } else { "txt" });
        if html {
            let directory = fs::canonicalize(path.parent().ok_or("导出路径无效")?)
                .map_err(|e| e.to_string())?;
            self.copy_referenced(document, &directory)?;
        }
        atomic_write(&path, content.as_bytes())
    }
}
