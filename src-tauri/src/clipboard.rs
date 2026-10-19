//! Copying images to the Windows clipboard as they are.
//!
//! One copy puts on the clipboard, all at once:
//! - the originals as files (CF_HDROP), written byte for byte to a temporary
//!   folder as `<first 12 hex digits of the id>-<original name>`, so Explorer
//!   pastes the very same files;
//! - an HTML fragment with one `<img>` per image: its `file:` URL for programs
//!   such as Word, and `data-linehush-*` attributes from which LineHush pastes the
//!   same images (same ids) without importing them again;
//! - for a single image, its pixels as CF_DIB and PNG, for Paint, chat programs
//!   and the like.
//!
//! WebView2 shows a paste with files only as those files (no HTML), so LineHush
//! also remembers its last copy by the clipboard's sequence number: pasting
//! while that copy is still on the clipboard uses the same images directly.
//!
//! No plain text: programs that prefer text would paste a placeholder instead of
//! the image.
use crate::errors::describe;
use crate::fsx::shown;
use crate::images;
use crate::model::{Picture, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// How many hex digits of the id prefix a staged file name.
const ID_PREFIX: usize = 12;

/// `name` with the characters Windows forbids in file names replaced.
fn safe_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let name = name.trim_end_matches(['.', ' ']).trim();
    if name.is_empty() { "图片" } else { name }.to_owned()
}
/// Where `stage` puts the original of `pic`. A name without an extension gets
/// one from the content, so the file opens in the right program.
pub fn staged_path(dir: &Path, pic: &Picture, bytes: &[u8]) -> PathBuf {
    let mut name = safe_name(&pic.name);
    if Path::new(&name).extension().is_none() {
        if let Some(ext) = image::guess_format(bytes)
            .ok()
            .and_then(|format| format.extensions_str().first())
        {
            name = format!("{name}.{ext}");
        }
    }
    let prefix = pic.id.get(..ID_PREFIX).unwrap_or(&pic.id);
    dir.join(format!("{prefix}-{name}"))
}
/// Writes the original of `pic` into `dir`, unless it is already there.
pub fn stage(dir: &Path, pic: &Picture, bytes: &[u8]) -> Result<PathBuf> {
    let path = staged_path(dir, pic, bytes);
    let present = fs::metadata(&path).is_ok_and(|meta| meta.len() == bytes.len() as u64);
    if !present {
        fs::create_dir_all(dir)
            .map_err(|e| format!("无法创建 {}：{}", shown(dir), describe(e)))?;
        fs::write(&path, bytes)
            .map_err(|e| format!("无法写入 {}：{}", shown(&path), describe(e)))?;
    }
    Ok(path)
}
/// The original of `id` from a file `stage` wrote, whatever its name, as long as
/// its content still matches the id.
pub fn staged(dir: &Path, id: &str) -> Option<Vec<u8>> {
    let prefix = format!("{}-", id.get(..ID_PREFIX)?);
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .filter_map(|entry| fs::read(entry.path()).ok())
        .find(|bytes| images::hash(bytes) == id)
}
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
/// `file:///C:/...`; characters with a meaning in URLs are percent-encoded,
/// other non-ASCII text is left as is (the HTML is UTF-8).
fn file_url(path: &Path) -> String {
    let text = shown(path).replace('\\', "/");
    let mut url = String::from(if text.starts_with("//") { "file:" } else { "file:///" });
    for c in text.chars() {
        match c {
            ' ' | '#' | '%' | '?' | '"' | '<' | '>' | '\'' => url.push_str(&format!("%{:02X}", c as u32)),
            c => url.push(c),
        }
    }
    url
}
/// The fragment LineHush reads back when pasting (see `linehushImages` in the editor).
pub fn html(items: &[(Picture, PathBuf)]) -> String {
    items
        .iter()
        .map(|(pic, path)| {
            format!(
                r#"<img src="{}" alt="{}" data-linehush-id="{}" data-linehush-name="{}" data-linehush-width="{}" data-linehush-height="{}">"#,
                escape(&file_url(path)),
                escape(&pic.name),
                escape(&pic.id),
                escape(&pic.name),
                pic.width,
                pic.height
            )
        })
        .collect()
}
/// Everything one copy puts on the clipboard.
pub struct Content {
    pub files: Vec<PathBuf>,
    pub html: String,
    /// DIB and PNG of a single image (see `images::clipboard_pixels`).
    pub pixels: Option<(Vec<u8>, Vec<u8>)>,
}

#[cfg(windows)]
mod system {
    use super::Content;
    use crate::fsx::shown;
    use crate::model::Result;
    use clipboard_win::{formats, raw, Clipboard};
    use std::time::{Duration, Instant};

    /// Changes whenever any program writes the clipboard.
    pub fn sequence() -> u32 {
        raw::seq_num().map_or(0, |n| n.get())
    }
    /// Waits (at most `limit`) for the clipboard to change from `since`.
    pub fn wait_for_change(since: u32, limit: Duration) {
        let start = Instant::now();
        while sequence() == since && start.elapsed() < limit {
            std::thread::sleep(Duration::from_millis(15));
        }
    }
    /// Replaces the clipboard with `content`, unless something else was copied
    /// after `since`. Returns the clipboard's sequence number once it is closed,
    /// or None when it was left alone.
    pub fn write(content: &Content, since: u32) -> Result<Option<u32>> {
        let open = Clipboard::new_attempts(10).map_err(fail)?;
        if sequence() != since {
            return Ok(None);
        }
        fill(content)?;
        drop(open);
        Ok(Some(sequence()))
    }
    fn fail(e: clipboard_win::ErrorCode) -> String {
        format!("无法写入剪贴板（{e}）")
    }
    fn fill(content: &Content) -> Result<()> {
        raw::empty().map_err(fail)?;
        let files: Vec<String> = content.files.iter().map(|path| shown(path)).collect();
        raw::set_file_list(&files).map_err(fail)?;
        // Explorer copies rather than moves the files, even after Ctrl+X.
        if let Some(effect) = raw::register_format("Preferred DropEffect") {
            raw::set_without_clear(effect.get(), &1u32.to_le_bytes()).map_err(fail)?;
        }
        if let Some(html) = formats::Html::new() {
            raw::set_html(html.code(), &content.html).map_err(fail)?;
        }
        if let Some((dib, png)) = &content.pixels {
            raw::set_without_clear(formats::CF_DIB, dib).map_err(fail)?;
            if let Some(format) = raw::register_format("PNG") {
                raw::set_without_clear(format.get(), png).map_err(fail)?;
            }
        }
        Ok(())
    }
}
#[cfg(not(windows))]
mod system {
    use super::Content;
    use crate::model::Result;
    use std::time::Duration;
    pub fn sequence() -> u32 {
        0
    }
    pub fn wait_for_change(_since: u32, _limit: Duration) {}
    pub fn write(_content: &Content, _since: u32) -> Result<Option<u32>> {
        Err("仅 Windows 版支持复制图片".into())
    }
}
pub use system::{sequence, wait_for_change, write};

#[cfg(test)]
mod tests {
    use super::*;
    fn picture(id: &str, name: &str) -> Picture {
        Picture {
            id: id.into(),
            name: name.into(),
            width: 3,
            height: 2,
        }
    }
    #[test]
    fn staged_originals_are_found_again_by_id() {
        let dir = std::env::temp_dir().join(format!("linehush-test-clipboard-{}", std::process::id()));
        let bytes = b"\x89PNG\r\n\x1a\nnot really".to_vec();
        let id = images::hash(&bytes);
        // Forbidden characters are replaced; a missing extension comes from the content.
        let pic = picture(&id, "a:b?");
        let path = stage(&dir, &pic, &bytes).unwrap();
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            format!("{}-a_b_.png", &id[..12])
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        // Staging again keeps the file; another name for the same image is a second file.
        assert_eq!(stage(&dir, &pic, &bytes).unwrap(), path);
        let other = stage(&dir, &picture(&id, "照片.png"), &bytes).unwrap();
        assert_ne!(other, path);
        assert_eq!(staged(&dir, &id), Some(bytes.clone()));
        // A file whose content no longer matches its id is not used.
        fs::write(&path, b"changed").unwrap();
        fs::write(&other, b"changed").unwrap();
        assert_eq!(staged(&dir, &id), None);
        assert_eq!(staged(&dir, "short"), None);
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn html_carries_the_ids_and_file_urls() {
        let html = html(&[(
            picture("ab", "a \"b\".png"),
            PathBuf::from(r"C:\Temp\linehush-clipboard\ab-a #b.png"),
        )]);
        assert_eq!(
            html,
            r#"<img src="file:///C:/Temp/linehush-clipboard/ab-a%20%23b.png" alt="a &quot;b&quot;.png" data-linehush-id="ab" data-linehush-name="a &quot;b&quot;.png" data-linehush-width="3" data-linehush-height="2">"#
        );
    }
}
