//! Path helpers.
use std::path::{Path, PathBuf};

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
