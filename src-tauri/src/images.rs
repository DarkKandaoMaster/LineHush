//! Image decoding and thumbnails. Pure functions: the originals are stored
//! byte-for-byte by db.rs, thumbnails only live in memory (store.rs).
use crate::model::{Picture, Result};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat, ImageReader};
use sha2::{Digest, Sha256};
use std::io::Cursor;

const THUMBNAIL_WIDTH: u32 = 560;
const THUMBNAIL_HEIGHT: u32 = 400;
const JPEG_QUALITY: u8 = 85;

// Only the five formats enabled in Cargo.toml can decode; anything else fails here.
const UNREADABLE: &str =
    "无法读取此图片：仅支持 JPG/PNG/GIF/WebP/BMP，且文件需完好、不超过 16000 像素 / 256 MB 解码内存";

/// Lowercase hex SHA-256: the image's id inside a document.
pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn decode(bytes: &[u8]) -> Result<DynamicImage> {
    let format = image::guess_format(bytes).map_err(|_| UNREADABLE)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    // Keeps one decode from exhausting memory; nothing else limits image size.
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16000);
    limits.max_image_height = Some(16000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| UNREADABLE.into())
}
/// Fits within 560×400 (never enlarged); PNG when the image has alpha, else JPEG.
fn encode_thumbnail(img: &DynamicImage) -> Result<Vec<u8>> {
    let small = if img.width() > THUMBNAIL_WIDTH || img.height() > THUMBNAIL_HEIGHT {
        img.thumbnail(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
    } else {
        img.clone()
    };
    let mut out = Cursor::new(Vec::new());
    if small.color().has_alpha() {
        small.write_to(&mut out, ImageFormat::Png)
    } else {
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
            .encode_image(&DynamicImage::ImageRgb8(small.to_rgb8()))
    }
    .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
/// Thumbnail of an original. Slow for large photos: call without holding the store lock.
pub fn thumbnail(original: &[u8]) -> Result<Vec<u8>> {
    encode_thumbnail(&decode(original)?)
}
/// Identifies and measures a new image; also returns its thumbnail, since the
/// decode needed for the size is the expensive part. `name` is left to the caller.
pub fn prepare(bytes: &[u8]) -> Result<(Picture, Vec<u8>)> {
    let img = decode(bytes)?;
    let picture = Picture {
        id: hash(bytes),
        name: String::new(),
        width: img.width(),
        height: img.height(),
    };
    Ok((picture, encode_thumbnail(&img)?))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn encoded(img: DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, format).unwrap();
        out.into_inner()
    }
    fn size(bytes: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory(bytes).unwrap();
        (img.width(), img.height())
    }
    #[test]
    fn thumbnails_fit_560_by_400_and_keep_alpha() {
        let wide = encoded(DynamicImage::new_rgb8(2000, 800), ImageFormat::Png);
        let (pic, thumb) = prepare(&wide).unwrap();
        assert_eq!((pic.width, pic.height), (2000, 800));
        assert_eq!(pic.id, hash(&wide));
        assert_eq!(pic.id.len(), 64);
        assert_eq!(size(&thumb), (560, 224));
        assert_eq!(image::guess_format(&thumb).unwrap(), ImageFormat::Jpeg);
        assert_eq!(thumbnail(&wide).unwrap(), thumb);

        let tall = encoded(DynamicImage::new_rgba8(900, 1800), ImageFormat::Png);
        let thumb = thumbnail(&tall).unwrap();
        assert_eq!(size(&thumb), (200, 400));
        assert_eq!(image::guess_format(&thumb).unwrap(), ImageFormat::Png);

        let small = encoded(DynamicImage::new_rgb8(30, 20), ImageFormat::Bmp);
        assert_eq!(size(&thumbnail(&small).unwrap()), (30, 20));
    }
    #[test]
    fn undecodable_bytes_are_rejected() {
        assert!(prepare(b"not image").is_err());
        assert!(thumbnail(b"\x89PNG\r\n\x1a\nbroken").is_err());
    }
}
