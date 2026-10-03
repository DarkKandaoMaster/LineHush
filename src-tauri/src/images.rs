//! Image import and thumbnails. Originals are kept byte-for-byte; thumbnails are
//! PNGs in a rebuildable cache folder next to `附件/`.
use crate::fsx::{atomic_write, read_file, unique_id};
use crate::model::{Picture, Result, ATTACHMENTS};
use crate::store::Store;
use image::{ImageFormat, ImageReader};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

const THUMBNAIL_CACHE: &str = ".linehush-cache";
const THUMBNAIL_WIDTH: u32 = 560;
const THUMBNAIL_HEIGHT: u32 = 400;

fn cache_dir(store: &Store) -> PathBuf {
    store.base_dir.join(THUMBNAIL_CACHE)
}
/// Thumbnail file name for an attachment: `<attachment file name>.png`.
fn cache_name(attachment: &str) -> String {
    format!("{attachment}.png")
}
// Only the five formats enabled in Cargo.toml can decode; anything else fails here.
const UNREADABLE: &str =
    "无法读取此图片：仅支持 JPG/PNG/GIF/WebP/BMP，且文件需完好、不超过 16000 像素 / 256 MB 解码内存";
fn decode(bytes: &[u8]) -> Result<(image::DynamicImage, ImageFormat)> {
    let format = image::guess_format(bytes).map_err(|_| UNREADABLE)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    // Keeps one decode from exhausting memory; nothing else limits image size.
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16000);
    limits.max_image_height = Some(16000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| UNREADABLE)?;
    Ok((img, format))
}
fn thumbnail(img: &image::DynamicImage) -> Result<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    img.thumbnail(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
fn write_in(folder: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    atomic_write(&folder.join(name), bytes)
}
pub fn import(store: &Store, bytes: &[u8]) -> Result<Picture> {
    let (img, format) = decode(bytes)?;
    let ext = match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        ImageFormat::Bmp => "bmp",
        _ => "png",
    };
    let name = format!("{}.{}", unique_id(), ext);
    write_in(&store.base_dir.join(ATTACHMENTS), &name, bytes)?;
    write_in(&cache_dir(store), &cache_name(&name), &thumbnail(&img)?)?;
    Ok(Picture {
        path: format!("{ATTACHMENTS}/{name}"),
        name: String::new(),
        width: img.width(),
        height: img.height(),
    })
}
pub fn read(store: &Store, relative: &str, original: bool) -> Result<Vec<u8>> {
    let path = store.base_dir.join(relative);
    if !path.is_file() {
        return Err("图片附件缺失，请检查附件文件夹".into());
    }
    if original {
        return read_file(&path);
    }
    let cache_name = cache_name(&path.file_name().unwrap_or_default().to_string_lossy());
    let cache_dir = cache_dir(store);
    let cache = cache_dir.join(&cache_name);
    if cache.exists() {
        return read_file(&cache);
    }
    let (img, _) = decode(&read_file(&path)?)?;
    let thumb = thumbnail(&img)?;
    write_in(&cache_dir, &cache_name, &thumb)?;
    Ok(thumb)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_preserved_and_thumbnail_rebuildable() {
        let root = std::env::temp_dir().join(format!("linehush-image-test-{}", unique_id()));
        let store = Store::new(root.clone()).unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1000, 800)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let pic = import(&store, bytes.get_ref()).unwrap();
        assert_eq!(read(&store, &pic.path, true).unwrap(), *bytes.get_ref());
        let thumb = read(&store, &pic.path, false).unwrap();
        let img = image::load_from_memory(&thumb).unwrap();
        assert!(img.width() <= 560 && img.height() <= 400);
        fs::remove_dir_all(store.base_dir.join(".linehush-cache")).unwrap();
        assert_eq!(read(&store, &pic.path, false).unwrap(), thumb);
        assert!(import(&store, b"not image").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
