//! Image decoding and thumbnails. Pure functions: the originals are stored
//! byte-for-byte by db.rs, thumbnails only live in memory (store.rs).
use crate::model::{Picture, Result};
use image::{
    codecs::jpeg::JpegEncoder,
    error::{ImageError, LimitErrorKind},
    DynamicImage, ImageFormat, ImageReader,
};
use sha2::{Digest, Sha256};
use std::io::Cursor;

const THUMBNAIL_WIDTH: u32 = 560;
const THUMBNAIL_HEIGHT: u32 = 400;
const JPEG_QUALITY: u8 = 85;
/// Longest side a decode accepts.
const MAX_SIDE: u32 = 16000;
/// Largest buffer one decode may allocate.
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
/// Largest file accepted for import, checked before anything is decoded.
const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;

// Only the five formats enabled in Cargo.toml can decode; anything else fails here.
const UNSUPPORTED: &str = "不支持的图片格式（仅支持 JPG、PNG、GIF、WebP、BMP）";
const TOO_LARGE: &str = "图片尺寸过大（上限 16000 像素）";
const TOO_MUCH_MEMORY: &str = "图片尺寸过大（解码所需内存超过 256 MB）";

/// Rejects a file too large to import, before it is copied or decoded.
pub fn check_file_size(len: usize) -> Result<()> {
    if len > MAX_FILE_BYTES {
        return Err("图片文件过大（上限 256 MB）".into());
    }
    Ok(())
}
/// Unsupported format, over a limit, or damaged.
fn describe(e: ImageError) -> String {
    match e {
        ImageError::Unsupported(_) => UNSUPPORTED.into(),
        ImageError::Limits(limit) => match limit.kind() {
            LimitErrorKind::InsufficientMemory => TOO_MUCH_MEMORY.into(),
            _ => TOO_LARGE.into(),
        },
        e => format!("图片已损坏或无法解码（{e}）"),
    }
}

/// Lowercase hex SHA-256: the image's id inside a document.
pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn decode(bytes: &[u8]) -> Result<DynamicImage> {
    let format = image::guess_format(bytes).map_err(|_| UNSUPPORTED)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    // Keeps one decode from exhausting memory; nothing else limits image size.
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    reader.decode().map_err(describe)
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
    /// A 1×1 BMP whose header claims `width`×`height`; limits are checked on the
    /// header, before any pixel is read.
    fn bmp_claiming(width: i32, height: i32) -> Vec<u8> {
        let mut bytes = encoded(DynamicImage::new_rgb8(1, 1), ImageFormat::Bmp);
        bytes[18..22].copy_from_slice(&width.to_le_bytes());
        bytes[22..26].copy_from_slice(&height.to_le_bytes());
        bytes
    }
    fn error(bytes: &[u8]) -> String {
        prepare(bytes).unwrap_err()
    }
    #[test]
    fn undecodable_bytes_are_rejected_with_the_reason() {
        assert_eq!(error(b"not image"), UNSUPPORTED);
        // A TIFF header is recognized, but its decoder is not enabled in Cargo.toml.
        assert_eq!(error(b"II*\0\x08\0\0\0\0\0\0\0\0\0\0\0"), UNSUPPORTED);
        let broken = error(b"\x89PNG\r\n\x1a\nbroken");
        assert!(broken.starts_with("图片已损坏或无法解码（"), "{broken}");
        assert!(thumbnail(b"\x89PNG\r\n\x1a\nbroken").is_err());
        let mut truncated = encoded(DynamicImage::new_rgb8(64, 64), ImageFormat::Png);
        truncated.truncate(truncated.len() / 2);
        let truncated = error(&truncated);
        assert!(
            truncated.starts_with("图片已损坏或无法解码（"),
            "{truncated}"
        );

        assert_eq!(error(&bmp_claiming(16001, 1)), TOO_LARGE);
        assert_eq!(error(&bmp_claiming(1, 20000)), TOO_LARGE);
        // Within 16000 px, but 15000×15000×3 bytes exceed the decode budget.
        assert_eq!(error(&bmp_claiming(15000, 15000)), TOO_MUCH_MEMORY);
    }
    #[test]
    fn files_over_256_mb_are_rejected_before_decoding() {
        assert!(check_file_size(MAX_FILE_BYTES).is_ok());
        assert_eq!(
            check_file_size(MAX_FILE_BYTES + 1).unwrap_err(),
            "图片文件过大（上限 256 MB）"
        );
    }
}
