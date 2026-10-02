//! File-system helpers: unique names, sidecar paths, atomic writes and backups.
use crate::model::{Diary, Result};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

/// Extension of the backup written next to a document when a session opens it.
pub const BACKUP_EXTENSION: &str = "bak";

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
pub fn ensure_extension(path: &Path, ext: &str) -> PathBuf {
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
pub fn write_diary(path: &Path, doc: &Diary) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    atomic_write(path, &bytes)
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
/// Copies `path` to `<path>.bak`, replacing any earlier backup.
pub fn backup(path: &Path) -> Result<()> {
    fs::copy(path, sidecar(path, &format!(".{BACKUP_EXTENSION}")))
        .map(drop)
        .map_err(|e| format!("无法写入备份：{e}"))
}
