//! Copying images (and videos and audio clips) to the Windows clipboard as they are.
//!
//! One copy puts on the clipboard, all at once:
//! - the originals as files (CF_HDROP), written byte for byte to a temporary
//!   folder as `<first 12 hex digits of the id>-<original name>`, so Explorer
//!   pastes the very same files;
//! - when all of them are images, an HTML fragment with one `<img>` per image,
//!   its `file:` URL, for programs such as Word;
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
use crate::model::{MediaKind, Picture, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// How many hex digits of the id prefix a staged file name.
pub const ID_PREFIX: usize = 12;

/// The name of `pic` with the characters Windows forbids in file names replaced.
fn safe_name(pic: &Picture) -> String {
    let name: String = pic
        .name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let name = name.trim_end_matches(['.', ' ']).trim();
    if !name.is_empty() {
        return name.to_owned();
    }
    match pic.kind {
        MediaKind::Image => "图片",
        MediaKind::Video => "视频",
        MediaKind::Audio => "音频",
    }
    .to_owned()
}
/// Where `stage` puts the original of `pic`. An image named without an
/// extension gets one from its content, so the file opens in the right program;
/// a video or audio clip keeps the extension of its name, if any.
pub fn staged_path(dir: &Path, pic: &Picture, bytes: &[u8]) -> PathBuf {
    let mut name = safe_name(pic);
    if pic.kind.is_image() && Path::new(&name).extension().is_none() {
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
/// Writes the original of `pic` into `dir`, unless it is already there; then
/// its time is only brought up to date (best effort), so cleaning the folder
/// by age (`sweep_staged` in lib.rs) leaves it alone.
pub fn stage(dir: &Path, pic: &Picture, bytes: &[u8]) -> Result<PathBuf> {
    let path = staged_path(dir, pic, bytes);
    let present = fs::metadata(&path).is_ok_and(|meta| meta.len() == bytes.len() as u64);
    if present {
        let _ = fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_modified(std::time::SystemTime::now()));
    } else {
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
/// One `<img>` per staged original, for programs that paste HTML; None when a
/// video or audio clip is among them. LineHush itself never sees it: WebView2
/// offers a paste that has files only as those files (see `copied_images` in
/// lib.rs for how LineHush pastes its own copy).
pub fn html(items: &[(Picture, PathBuf)]) -> Option<String> {
    if !items.iter().all(|(pic, _)| pic.kind.is_image()) {
        return None;
    }
    Some(
        items
            .iter()
            .map(|(pic, path)| {
                format!(
                    r#"<img src="{}" alt="{}">"#,
                    escape(&file_url(path)),
                    escape(&pic.name),
                )
            })
            .collect(),
    )
}
/// Everything one copy puts on the clipboard.
pub struct Content {
    pub files: Vec<PathBuf>,
    pub html: Option<String>,
    /// DIB and PNG of a single image (see `images::clipboard_pixels`).
    pub pixels: Option<(Vec<u8>, Vec<u8>)>,
}

mod system {
    use super::Content;
    use crate::fsx::shown;
    use crate::model::Result;
    use clipboard_win::{formats, raw, Clipboard};
    use std::time::Duration;

    /// How often, and how long apart, opening the clipboard is tried again while
    /// another program holds it (some open it to read every change at once).
    const OPEN_RETRIES: u32 = 20;
    const OPEN_PAUSE: Duration = Duration::from_millis(10);

    /// Changes whenever any program writes the clipboard.
    pub fn sequence() -> u32 {
        raw::seq_num().map_or(0, |n| n.get())
    }
    fn open() -> Result<Clipboard> {
        let mut retries = 0;
        loop {
            match Clipboard::new() {
                Ok(open) => return Ok(open),
                Err(e) if retries == OPEN_RETRIES => return Err(fail(e)),
                Err(_) => {
                    retries += 1;
                    std::thread::sleep(OPEN_PAUSE);
                }
            }
        }
    }
    /// Replaces the clipboard with `content`, unless something else was copied
    /// after `since`. Returns the clipboard's sequence number once it is closed,
    /// or None when it was left alone.
    pub fn write(content: &Content, since: u32) -> Result<Option<u32>> {
        let open = open()?;
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
        if let (Some(format), Some(html)) = (formats::Html::new(), &content.html) {
            raw::set_html(format.code(), html).map_err(fail)?;
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
pub use system::{sequence, write};

#[cfg(test)]
mod tests {
    use super::*;
    fn picture(id: &str, name: &str) -> Picture {
        Picture {
            id: id.into(),
            name: name.into(),
            width: 3,
            height: 2,
            kind: MediaKind::Image,
            duration: None,
        }
    }
    fn media(id: &str, name: &str, kind: MediaKind) -> Picture {
        Picture {
            kind,
            duration: Some(1.5),
            ..picture(id, name)
        }
    }
    #[test]
    fn media_keep_the_extension_of_their_name() {
        let dir = Path::new(r"C:\T");
        let id = "0123456789abcdef";
        // An MP4 is never named after what the image decoder makes of it.
        let mp4 = b"\0\0\0\x20ftypisom\0\0\x02\0";
        let video = media(id, "旅行.mp4", MediaKind::Video);
        assert_eq!(staged_path(dir, &video, mp4), dir.join("0123456789ab-旅行.mp4"));
        let unnamed = media(id, "", MediaKind::Audio);
        assert_eq!(staged_path(dir, &unnamed, b"ID3"), dir.join("0123456789ab-音频"));
        let bare = media(id, "语音", MediaKind::Audio);
        assert_eq!(staged_path(dir, &bare, b"\x89PNG\r\n\x1a\n"), dir.join("0123456789ab-语音"));
    }
    #[test]
    fn html_is_left_out_when_media_are_copied() {
        let path = PathBuf::from(r"C:\T\x.mp4");
        assert_eq!(
            html(&[
                (picture("ab", "a.png"), path.clone()),
                (media("cd", "x.mp4", MediaKind::Video), path),
            ]),
            None
        );
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
    fn html_names_the_staged_files() {
        let html = html(&[
            (
                picture("ab", "a \"b\".png"),
                PathBuf::from(r"C:\Temp\linehush-clipboard\ab-a #b.png"),
            ),
            (picture("cd", "c.png"), PathBuf::from(r"C:\T\cd-c.png")),
        ]);
        assert_eq!(
            html.unwrap(),
            concat!(
                r#"<img src="file:///C:/Temp/linehush-clipboard/ab-a%20%23b.png" alt="a &quot;b&quot;.png">"#,
                r#"<img src="file:///C:/T/cd-c.png" alt="c.png">"#
            )
        );
    }
}
