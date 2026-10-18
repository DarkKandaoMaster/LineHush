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
/// A path for messages, without the `\\?\` prefix `canonicalize` adds on Windows.
pub fn shown(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{share}");
    }
    match text.strip_prefix(r"\\?\") {
        Some(plain) => plain.to_owned(),
        None => text,
    }
}
#[cfg(test)]
mod tests {
    use super::shown;
    use std::path::Path;
    #[test]
    fn shown_drops_the_verbatim_prefix() {
        assert_eq!(shown(Path::new(r"\\?\C:\日记\a.hush")), r"C:\日记\a.hush");
        assert_eq!(
            shown(Path::new(r"\\?\UNC\pc\share\a.hush")),
            r"\\pc\share\a.hush"
        );
        assert_eq!(shown(Path::new(r"D:\a.hush")), r"D:\a.hush");
    }
}
