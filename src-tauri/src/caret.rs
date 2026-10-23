//! The system's text caret settings, so the editor's own caret (src/editor/caret.ts)
//! looks like Notepad's: as wide as "Text cursor thickness" in Windows settings
//! (in screen pixels, not scaled with the display scale), blinking at the
//! system's rate and, like Notepad, standing still after a while.
use serde::Serialize;

/// Serialized for `caret_metrics`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaretMetrics {
    /// Width in screen pixels.
    pub width: u32,
    /// Half a blink cycle in milliseconds; 0 when the caret does not blink.
    pub blink_ms: u32,
    /// How long it blinks before it stands still; 0 for always.
    pub timeout_ms: u32,
}
impl Default for CaretMetrics {
    /// Windows' defaults (also used where a setting cannot be read).
    fn default() -> Self {
        Self {
            width: 1,
            blink_ms: 530,
            timeout_ms: 5000,
        }
    }
}

/// `GetCaretBlinkTime` returns INFINITE (or, failing, 0) for a caret that does not blink.
fn blink(raw: u32) -> u32 {
    if raw == u32::MAX {
        0
    } else {
        raw
    }
}

#[cfg(windows)]
fn read() -> CaretMetrics {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCaretBlinkTime, SystemParametersInfoW, SPI_GETCARETTIMEOUT, SPI_GETCARETWIDTH,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    let get = |action| {
        let mut value = 0u32;
        // SAFETY: both actions write one u32 (a DWORD) to the pointer.
        unsafe {
            SystemParametersInfoW(
                action,
                0,
                Some(&mut value as *mut u32 as *mut core::ffi::c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .ok()
        .map(|()| value)
    };
    CaretMetrics {
        width: get(SPI_GETCARETWIDTH).filter(|w| *w > 0).unwrap_or(1),
        // SAFETY: no arguments.
        blink_ms: blink(unsafe { GetCaretBlinkTime() }),
        timeout_ms: get(SPI_GETCARETTIMEOUT).unwrap_or(0),
    }
}
#[cfg(not(windows))]
fn read() -> CaretMetrics {
    CaretMetrics::default()
}

/// Read on every call: the frontend asks again when a window gets the focus,
/// so a change in Windows settings applies when the user comes back.
#[tauri::command]
pub fn caret_metrics() -> CaretMetrics {
    read()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_metrics_are_sane_and_serialize_in_camel_case() {
        assert_eq!(blink(u32::MAX), 0);
        assert_eq!(blink(530), 530);
        let metrics = caret_metrics();
        assert!(metrics.width >= 1);
        let json = serde_json::to_value(CaretMetrics::default()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "width": 1, "blinkMs": 530, "timeoutMs": 5000 })
        );
    }
}
