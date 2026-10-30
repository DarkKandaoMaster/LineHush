//! Image decoding and thumbnails, and the type of a video or audio clip (never
//! decoded: the front end measures it and draws its cover). Pure functions: the originals are stored
//! byte-for-byte by db.rs, thumbnails only live in memory (store.rs).
use crate::model::{MediaKind, Picture, Result};
use image::{
    codecs::{
        jpeg::JpegEncoder,
        png::{CompressionType, FilterType, PngEncoder},
    },
    error::{ImageError, LimitErrorKind},
    DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat, ImageReader,
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
/// The same limit for a video or audio clip.
pub fn check_media_size(len: usize) -> Result<()> {
    check_file_size(len).map_err(|_| "媒体文件过大（上限 256 MB）".into())
}
/// MIME type of a video or audio clip from its first bytes (16 are enough), for
/// the `linehush-media` protocol, which only knows the id. Covers the formats
/// WebView2 plays; anything else is `application/octet-stream`.
pub fn sniff_media_mime(head: &[u8]) -> &'static str {
    match head {
        [_, _, _, _, b'f', b't', b'y', b'p', b'M', b'4', b'A', ..] => "audio/mp4",
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => "video/mp4",
        [0x1A, 0x45, 0xDF, 0xA3, ..] => "video/webm",
        [b'I', b'D', b'3', ..] => "audio/mpeg",
        // Frame sync; layer bits 00 mark an ADTS (AAC) header, the rest MPEG audio.
        [0xFF, b, ..] if b & 0xF6 == 0xF0 => "audio/aac",
        [0xFF, b, ..] if b & 0xE0 == 0xE0 => "audio/mpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => "audio/wav",
        [b'O', b'g', b'g', b'S', ..] => "audio/ogg",
        [b'f', b'L', b'a', b'C', ..] => "audio/flac",
        _ => "application/octet-stream",
    }
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
        kind: MediaKind::Image,
        duration: None,
    };
    Ok((picture, encode_thumbnail(&img)?))
}
/// The pixels of an original for other programs (one copied image): a packed DIB
/// (24-bit, bottom-up, transparency flattened onto white, since most programs
/// ignore DIB alpha) and a PNG (the original itself when it is one, so it keeps
/// its transparency). Slow for large photos: call without holding the store lock.
pub fn clipboard_pixels(original: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let img = decode(original)?;
    let png = if image::guess_format(original).ok() == Some(ImageFormat::Png) {
        original.to_vec()
    } else {
        let mut out = Vec::new();
        let encoder =
            PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive);
        if img.color().has_alpha() {
            let rgba = img.to_rgba8();
            encoder.write_image(&rgba, rgba.width(), rgba.height(), ExtendedColorType::Rgba8)
        } else {
            let rgb = img.to_rgb8();
            encoder.write_image(&rgb, rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        }
        .map_err(|e| e.to_string())?;
        out
    };
    Ok((dib(&img), png))
}
/// BITMAPINFOHEADER, then 24-bit BGR rows, bottom row first, each padded to 4 bytes.
fn dib(img: &DynamicImage) -> Vec<u8> {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let stride = (width as usize * 3).div_ceil(4) * 4;
    let mut out = Vec::with_capacity(40 + stride * height as usize);
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(height as i32).to_le_bytes()); // positive: bottom-up
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&24u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&((stride * height as usize) as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes()); // 72 dpi
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
    for y in (0..height).rev() {
        let start = out.len();
        for x in 0..width {
            let [r, g, b, a] = rgba.get_pixel(x, y).0;
            let a = a as u32;
            // Over white: c·a + 255·(1 − a).
            let over = |c: u8| ((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
            out.extend_from_slice(&[over(b), over(g), over(r)]);
        }
        out.resize(start + stride, 0);
    }
    out
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
    fn clipboard_pixels_are_a_white_backed_dib_and_a_png() {
        let mut img = image::RgbaImage::new(3, 2);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255])); // top left: red
        img.put_pixel(2, 1, image::Rgba([0, 0, 255, 0])); // bottom right: transparent
        let png = encoded(DynamicImage::ImageRgba8(img), ImageFormat::Png);
        let (dib, out) = clipboard_pixels(&png).unwrap();
        // A PNG original is handed over unchanged.
        assert_eq!(out, png);
        assert_eq!(&dib[4..8], &3i32.to_le_bytes());
        assert_eq!(&dib[8..12], &2i32.to_le_bytes());
        assert_eq!(&dib[14..16], &24u16.to_le_bytes());
        // Rows of 3 × 3 bytes padded to 12; the bottom row comes first.
        assert_eq!(dib.len(), 40 + 12 * 2);
        assert_eq!(&dib[40 + 6..40 + 9], &[255, 255, 255]); // transparent → white
        assert_eq!(&dib[52..55], &[0, 0, 255]); // red as BGR
        let jpeg = encoded(DynamicImage::new_rgb8(5, 4), ImageFormat::Jpeg);
        let (_, out) = clipboard_pixels(&jpeg).unwrap();
        assert_eq!(image::guess_format(&out).unwrap(), ImageFormat::Png);
        assert_eq!(size(&out), (5, 4));
    }
    #[test]
    fn files_over_256_mb_are_rejected_before_decoding() {
        assert!(check_file_size(MAX_FILE_BYTES).is_ok());
        assert_eq!(
            check_file_size(MAX_FILE_BYTES + 1).unwrap_err(),
            "图片文件过大（上限 256 MB）"
        );
        assert!(check_media_size(MAX_FILE_BYTES).is_ok());
        assert_eq!(
            check_media_size(MAX_FILE_BYTES + 1).unwrap_err(),
            "媒体文件过大（上限 256 MB）"
        );
    }
    #[test]
    fn media_types_are_sniffed_from_the_first_bytes() {
        let cases: [(&[u8], &str); 14] = [
            (b"\0\0\0\x20ftypisom\0\0\x02\0", "video/mp4"),
            (b"\0\0\0\x18ftypmp42", "video/mp4"),
            (b"\0\0\0\x20ftypM4V \0\0\0\0", "video/mp4"),
            (b"\0\0\0\x20ftypM4A \0\0\0\0", "audio/mp4"),
            (b"\x1A\x45\xDF\xA3\x9F\x42\x86\x81", "video/webm"),
            (b"ID3\x04\0\0\0\0\0\0", "audio/mpeg"),
            (b"\xFF\xFB\x90\x64", "audio/mpeg"),
            (b"\xFF\xF3\x90\x64", "audio/mpeg"),
            (b"\xFF\xF1\x50\x80", "audio/aac"),
            (b"RIFF\x24\0\0\0WAVEfmt ", "audio/wav"),
            (b"RIFF\x24\0\0\0AVI LIST", "application/octet-stream"),
            (b"OggS\0\x02\0\0", "audio/ogg"),
            (b"fLaC\0\0\0\x22", "audio/flac"),
            (b"\x89PNG\r\n\x1a\n", "application/octet-stream"),
        ];
        for (head, mime) in cases {
            assert_eq!(sniff_media_mime(head), mime, "{head:?}");
        }
        assert_eq!(sniff_media_mime(b""), "application/octet-stream");
        assert_eq!(sniff_media_mime(b"\0\0\0"), "application/octet-stream");
    }
}
