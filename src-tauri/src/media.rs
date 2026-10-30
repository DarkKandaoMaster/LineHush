//! Playback of the videos and audio clips of an open tab: the custom protocol
//! `linehush-media` (on Windows `http://linehush-media.localhost/<tab>/<id>`).
//! It answers byte ranges straight from SQLite (`Store::image_range`), so a
//! video is never read into memory as a whole while it plays or seeks.
use crate::{images, lock, lock_tab, model::Result};
use tauri::{
    http::{header, Response, StatusCode},
    AppHandle, UriSchemeContext, UriSchemeResponder, Wry,
};

/// Custom protocol name, registered in lib.rs.
pub const SCHEME: &str = "linehush-media";
/// Most bytes one range response carries; the media element asks again for the rest.
const MAX_CHUNK: u64 = 2 * 1024 * 1024;
/// Enough of the start of a clip for `images::sniff_media_mime`.
const SNIFF_BYTES: usize = 16;

/// `linehush-media` protocol: `/<tab>/<id>` is the original `id` of the tab
/// `tab`, whole (200) or the single range asked for (206); 404 when the tab or
/// the id is not there, 416 for a range that cannot be served.
pub fn protocol(
    ctx: UriSchemeContext<'_, Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_owned();
    let range = request
        .headers()
        .get(header::RANGE)
        .map(|value| value.to_str().unwrap_or_default().to_owned());
    // Reading takes the store lock: not on the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(serve(&app, &path, range.as_deref()))
    });
}
fn serve(app: &AppHandle, path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let Some((tab, id)) = path.strip_prefix('/').and_then(|path| path.split_once('/')) else {
        return status(StatusCode::NOT_FOUND);
    };
    respond(app, tab, id, range).unwrap_or_else(|e| {
        eprintln!("无法读取媒体 {id}：{e}");
        status(StatusCode::INTERNAL_SERVER_ERROR)
    })
}
fn respond(app: &AppHandle, tab: &str, id: &str, range: Option<&str>) -> Result<Response<Vec<u8>>> {
    let Ok(store) = lock_tab(app, tab) else {
        return Ok(status(StatusCode::NOT_FOUND));
    };
    let store = lock(&store);
    let Some(len) = store.image_len(id)? else {
        return Ok(status(StatusCode::NOT_FOUND));
    };
    let head = store.image_range(id, 0, SNIFF_BYTES)?.unwrap_or_default();
    let response = Response::builder()
        .header(header::CONTENT_TYPE, images::sniff_media_mime(&head))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let Some(range) = range else {
        let bytes = store.image(id)?;
        return response
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(bytes)
            .map_err(|e| e.to_string());
    };
    let Some(wanted) = parse_range(range, len) else {
        return response
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())
            .map_err(|e| e.to_string());
    };
    let (start, end) = capped(wanted, MAX_CHUNK);
    let Some(bytes) = store.image_range(id, start, (end - start + 1) as usize)? else {
        return Ok(status(StatusCode::NOT_FOUND));
    };
    let end = start + bytes.len() as u64 - 1;
    response
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(bytes)
        .map_err(|e| e.to_string())
}
fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}
/// The first and last byte a `Range` header asks for of a clip of `len` bytes,
/// the last limited to the end of the clip. Only a single range is understood:
/// `bytes=a-b`, `bytes=a-` or `bytes=-n` (the last n bytes). None for anything
/// else, and for a range that starts past the end (416).
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?.trim();
    let (first, last) = spec.split_once('-')?;
    let (first, last) = (first.trim(), last.trim());
    let digits = |text: &str| -> Option<u64> {
        text.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| text.parse().ok())?
    };
    let final_byte = len.checked_sub(1)?;
    let (start, end) = match (first.is_empty(), last.is_empty()) {
        (true, true) => return None,
        (true, false) => {
            let suffix = digits(last).filter(|&n| n > 0)?;
            (len.saturating_sub(suffix), final_byte)
        }
        (false, true) => (digits(first)?, final_byte),
        (false, false) => (digits(first)?, digits(last)?.min(final_byte)),
    };
    (start <= end).then_some((start, end))
}
/// `range` cut to at most `max` bytes from its start.
fn capped((start, end): (u64, u64), max: u64) -> (u64, u64) {
    (start, end.min(start + max - 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_ranges_are_parsed_and_limited_to_the_clip() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=990-2000", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=999-999", 1000), Some((999, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range(" bytes= 10 - 19 ", 1000), Some((10, 19)));
    }
    #[test]
    fn other_ranges_are_unsatisfiable() {
        for header in [
            "bytes=1000-",
            "bytes=1000-1001",
            "bytes=20-10",
            "bytes=-0",
            "bytes=-",
            "bytes=0-1,5-9",
            "bytes=a-b",
            "bytes=+1-2",
            "items=0-1",
            "0-1",
            "",
        ] {
            assert_eq!(parse_range(header, 1000), None, "{header}");
        }
        // Nothing can be served of an empty clip.
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("bytes=-1", 0), None);
    }
    #[test]
    fn responses_carry_at_most_one_chunk() {
        assert_eq!(capped((0, 999), 4096), (0, 999));
        assert_eq!(capped((0, u64::MAX - 1), 4096), (0, 4095));
        assert_eq!(capped((10, 20), 5), (10, 14));
    }
}
