//! Path helpers.
use std::{
    fs,
    path::{Path, PathBuf},
};

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
/// `<dir>\<base>.<ext>`, or, when that name is taken, the first free one of
/// `<base> (2).<ext>`, `<base> (3).<ext>`… as Explorer names copies. Anything at
/// the path (a file, a folder, a broken link) takes the name.
pub fn unique_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let taken = |path: &Path| fs::symlink_metadata(path).is_ok();
    let first = dir.join(format!("{base}.{ext}"));
    if !taken(&first) {
        return first;
    }
    (2u64..)
        .map(|n| dir.join(format!("{base} ({n}).{ext}")))
        .find(|path| !taken(path))
        .unwrap_or(first)
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
    use super::{ensure_extension, shown, unique_path};
    use std::fs;
    use std::path::{Path, PathBuf};
    #[test]
    fn unique_path_numbers_taken_names_like_explorer() {
        let dir = std::env::temp_dir().join(format!(
            "linehush-test-unique-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let unique = |base: &str| unique_path(&dir, base, "hush");
        assert_eq!(unique("2026-10-28"), dir.join("2026-10-28.hush"));
        fs::write(dir.join("2026-10-28.hush"), b"x").unwrap();
        assert_eq!(unique("2026-10-28"), dir.join("2026-10-28 (2).hush"));
        fs::write(dir.join("2026-10-28 (2).hush"), b"x").unwrap();
        assert_eq!(unique("2026-10-28"), dir.join("2026-10-28 (3).hush"));
        // 中间空出来的编号先用；文件夹也占名字；大小写不同在 Windows 上是同一个名字。
        fs::write(dir.join("2026-10-28 (4).hush"), b"x").unwrap();
        assert_eq!(unique("2026-10-28"), dir.join("2026-10-28 (3).hush"));
        fs::create_dir(dir.join("十月.hush")).unwrap();
        assert_eq!(unique("十月"), dir.join("十月 (2).hush"));
        fs::write(dir.join("Note.HUSH"), b"x").unwrap();
        assert_eq!(unique("note"), dir.join("note (2).hush"));
        // 别的扩展名不算。
        fs::write(dir.join("甲.txt"), b"x").unwrap();
        assert_eq!(unique("甲"), dir.join("甲.hush"));
        fs::remove_dir_all(&dir).unwrap();
    }
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
