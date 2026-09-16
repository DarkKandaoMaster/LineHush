use crate::storage::{self, Picture, Result, Store};
use image::{ImageFormat, ImageReader};
use std::{fs, io::Cursor, path::PathBuf};

fn decode(bytes: &[u8]) -> Result<(image::DynamicImage, ImageFormat)> {
    let format = image::guess_format(bytes)
        .map_err(|_| "不支持此图片，请使用 JPG、PNG、GIF、WebP 或 BMP")?;
    if !matches!(
        format,
        ImageFormat::Jpeg
            | ImageFormat::Png
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
    ) {
        return Err("不支持此图片格式".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    // Keeps one decode from exhausting memory; nothing else limits image size.
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16000);
    limits.max_image_height = Some(16000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let img = reader
        .decode()
        .map_err(|_| "图片损坏或尺寸过大（上限 16000 像素 / 256 MB 解码内存）")?;
    Ok((img, format))
}
fn thumbnail(img: &image::DynamicImage) -> Result<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    img.thumbnail(560, 400)
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
fn write_in(folder: PathBuf, name: &str, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    storage::atomic_write(&folder.join(name), bytes)
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
    let name = format!("{}.{}", storage::unique_id(), ext);
    write_in(store.directory.join("附件"), &name, bytes)?;
    write_in(
        store.directory.join(".linehush-cache"),
        &format!("{name}.png"),
        &thumbnail(&img)?,
    )?;
    Ok(Picture {
        path: format!("附件/{name}"),
        name: format!("图片.{ext}"),
        width: img.width(),
        height: img.height(),
    })
}
pub fn read(store: &Store, relative: &str, original: bool) -> Result<Vec<u8>> {
    let path = store.attachment(relative)?;
    if original {
        return storage::read_file(&path);
    }
    let cache_name = format!(
        "{}.png",
        path.file_name().ok_or("图片文件名无效")?.to_string_lossy()
    );
    let cache_dir = store.directory.join(".linehush-cache");
    let cache = cache_dir.join(&cache_name);
    if cache.exists() {
        return storage::read_file(&cache);
    }
    let (img, _) = decode(&storage::read_file(&path)?)?;
    let thumb = thumbnail(&img)?;
    write_in(cache_dir, &cache_name, &thumb)?;
    Ok(thumb)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_preserved_and_thumbnail_rebuildable() {
        let root =
            std::env::temp_dir().join(format!("linehush-image-test-{}", storage::unique_id()));
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
        fs::remove_dir_all(store.directory.join(".linehush-cache")).unwrap();
        assert_eq!(read(&store, &pic.path, false).unwrap(), thumb);
        assert!(import(&store, b"not image").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
