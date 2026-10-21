//! Path helpers.
use std::path::{Path, PathBuf};

pub fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}
pub fn ensure_extension(path: &Path, ext: &str) -> PathBuf {
    let suffix = format!(".{ext}");
    let has = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.to_ascii_lowercase()
                .ends_with(&suffix.to_ascii_lowercase())
        });
    if has {
        path.to_path_buf()
    } else {
        sidecar(path, &suffix)
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
    use super::{ensure_extension, shown};
    use std::path::{Path, PathBuf};
    #[test]
    fn ensure_extension_matches_the_file_name_suffix() {
        let ensure = |p: &str| ensure_extension(Path::new(p), "hush");
        assert_eq!(ensure(r"D:\a.hush"), PathBuf::from(r"D:\a.hush"));
        assert_eq!(ensure(r"D:\a.HUSH"), PathBuf::from(r"D:\a.HUSH"));
        assert_eq!(ensure(r"D:\.hush"), PathBuf::from(r"D:\.hush"));
        assert_eq!(ensure(r"D:\a.txt"), PathBuf::from(r"D:\a.txt.hush"));
        assert_eq!(ensure(r"D:\a"), PathBuf::from(r"D:\a.hush"));
    }
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
