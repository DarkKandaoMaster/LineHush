use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Picture {
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Block {
    Line { text: String },
    Images { images: Vec<Picture> },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Diary {
    pub version: u32,
    pub blocks: Vec<Block>,
}
impl Diary {
    pub fn empty() -> Self {
        Self {
            version: 1,
            blocks: vec![Block::Line {
                text: String::new(),
            }],
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 || self.blocks.is_empty() {
            return Err("文件格式无效或版本不受支持".into());
        }
        for block in &self.blocks {
            match block {
                Block::Line { text } => {
                    if text.contains(['\r', '\n']) {
                        return Err("文本行中存在非法换行".into());
                    }
                }
                Block::Images { images } => {
                    for pic in images {
                        validate_picture_path(&pic.path)?;
                    }
                }
            }
        }
        Ok(())
    }
    fn pictures(&self) -> impl Iterator<Item = &Picture> {
        self.blocks.iter().flat_map(|block| match block {
            Block::Images { images } => images.as_slice(),
            Block::Line { .. } => [].as_slice(),
        })
    }
}
// A picture path is `附件/` plus one plain file name; names come from unique_id().
pub fn validate_picture_path(path: &str) -> Result<()> {
    let name = path.strip_prefix("附件/").ok_or("图片必须位于附件目录")?;
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("图片路径无效".into());
    }
    Ok(())
}
pub fn unique_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{:x}-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
pub fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}
fn ensure_extension(path: &Path, ext: &str) -> PathBuf {
    if path.extension().is_some_and(|e| e == ext) {
        path.to_path_buf()
    } else {
        sidecar(path, &format!(".{ext}"))
    }
}
pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))
}
pub fn read_diary(path: &Path) -> Result<Diary> {
    let doc: Diary = serde_json::from_slice(&read_file(path)?)
        .map_err(|_| "无法解析日记；文件可能损坏，可尝试打开同名 .bak 备份")?;
    doc.validate()?;
    Ok(doc)
}
// Write in the destination directory so rename never crosses a filesystem.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = sidecar(path, &format!(".{}.tmp", unique_id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&tmp, path).map_err(|e| format!("保存失败，原文件保留：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
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
    pub directory: PathBuf,
    root: PathBuf,
    path: Option<PathBuf>,
}
impl Store {
    pub fn new(root: PathBuf) -> Result<Self> {
        let directory = root.join("drafts");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        Ok(Self {
            root,
            directory,
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
    pub fn restore(&mut self) -> Result<Opened> {
        let file = self.root.join("recovery.json");
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
        self.directory = r.directory;
        Ok(self.opened(document, true))
    }
    pub fn checkpoint(&self, doc: &Diary) -> Result<()> {
        let r = Recovery {
            path: self.path.clone(),
            directory: self.directory.clone(),
            document: self.path.is_none().then(|| doc.clone()),
        };
        let bytes = serde_json::to_vec(&r).map_err(|e| e.to_string())?;
        atomic_write(&self.root.join("recovery.json"), &bytes)
    }
    pub fn new_document(&mut self) -> Result<Opened> {
        self.path = None;
        self.directory = self.root.join("drafts");
        self.checkpoint(&Diary::empty())?;
        Ok(self.opened(Diary::empty(), false))
    }
    pub fn open(&mut self, path: &Path) -> Result<Opened> {
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let document = read_diary(&path)?;
        self.directory = path.parent().ok_or("文档路径无效")?.to_path_buf();
        if path.extension().is_some_and(|ext| ext == "bak") {
            self.path = None;
        } else {
            // .bak is the version this session started from.
            fs::copy(&path, sidecar(&path, ".bak")).map_err(|e| format!("无法写入备份：{e}"))?;
            self.path = Some(path);
        }
        self.checkpoint(&document)?;
        Ok(self.opened(document, false))
    }
    pub fn save(&mut self, doc: &Diary) -> Result<()> {
        doc.validate()?;
        match &self.path {
            None => self.checkpoint(doc),
            Some(path) => {
                let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
                atomic_write(path, &bytes)
            }
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
                fs::copy(&path, sidecar(&path, ".bak"))
                    .map_err(|e| format!("无法写入备份：{e}"))?;
            }
        }
        let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
        atomic_write(&path, &bytes)?;
        self.directory = directory;
        self.path = Some(path);
        self.checkpoint(doc)?;
        Ok(self.opened(doc.clone(), false))
    }
    pub fn attachment(&self, relative: &str) -> Result<PathBuf> {
        validate_picture_path(relative)?;
        let path = self.directory.join(relative);
        if !path.is_file() {
            return Err("图片附件缺失，请检查附件文件夹".into());
        }
        Ok(path)
    }
    // Copies the originals the document references; missing or already present files are skipped.
    fn copy_referenced(&self, doc: &Diary, destination: &Path) -> Result<()> {
        if fs::canonicalize(&self.directory).ok().as_deref() == Some(destination) {
            return Ok(());
        }
        let target = destination.join("附件");
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
#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
