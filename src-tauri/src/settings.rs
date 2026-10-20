//! User preferences in `settings.json` next to the working copy. The frontend
//! clamps the values and turns the font name into a CSS font list (see
//! src/core/settings.ts); here they are only stored. Rust itself reads
//! `open_file` when a file is opened from outside (see `open_from_outside`
//! in lib.rs) and `startup` when it starts (see `Session::plan_launch`).
use crate::errors::describe;
use crate::fsx::shown;
use crate::model::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const SETTINGS_FILE: &str = "settings.json";
/// 设置写入后发给所有窗口（载荷为 `Settings`），各窗口立即应用。
pub const SETTINGS_CHANGED: &str = "settings-changed";

/// 打开文件：双击 `.hush`、再次启动时带文件，在最近使用的窗口里开新标签页，还是开新窗口。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpenFile {
    #[default]
    Tab,
    Window,
}
impl OpenFile {
    /// 不认识的值取默认。
    fn parse(value: &serde_json::Value) -> Option<Self> {
        match value.as_str()? {
            "tab" => Some(Self::Tab),
            "window" => Some(Self::Window),
            _ => None,
        }
    }
}
/// 启动时：像记事本，新建一个窗口（只恢复程序意外退出时留下的未保存修改），
/// 还是恢复上次关闭时的全部窗口与标签页。它也决定关闭最后一个窗口时是否询问保存。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Startup {
    #[default]
    NewWindow,
    LastSession,
}
impl Startup {
    /// 不认识的值取默认。
    fn parse(value: &serde_json::Value) -> Option<Self> {
        match value.as_str()? {
            "newWindow" => Some(Self::NewWindow),
            "lastSession" => Some(Self::LastSession),
            _ => None,
        }
    }
}

/// Missing fields (an older file) take their defaults; keep these in step with
/// `DEFAULT_SETTINGS` in src/core/settings.ts. "微软雅黑" is Microsoft YaHei
/// (not the UI variant); WebView2 finds fonts by their Chinese names. The size
/// is in pt (1 pt = 4/3 CSS px); 10 pt matches Notepad's 10 pt (13.33 px).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub font_family: String,
    #[serde(rename = "fontSizePt")]
    pub font_size_pt: f64,
    pub open_file: OpenFile,
    pub startup: Startup,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            font_family: "微软雅黑".into(),
            font_size_pt: 10.0,
            open_file: OpenFile::Tab,
            startup: Startup::NewWindow,
        }
    }
}

/// What a file may hold: older files stored `fontSize` in px instead of
/// `fontSizePt`; an unknown `openFile` or `startup` takes the default without losing the
/// other fields. Only read; writes use `Settings`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    font_family: Option<String>,
    #[serde(rename = "fontSizePt")]
    font_size_pt: Option<f64>,
    font_size: Option<f64>,
    open_file: Option<serde_json::Value>,
    startup: Option<serde_json::Value>,
}
impl From<Stored> for Settings {
    fn from(stored: Stored) -> Self {
        let default = Settings::default();
        Self {
            font_family: stored.font_family.unwrap_or(default.font_family),
            font_size_pt: stored
                .font_size_pt
                .or(stored.font_size.map(|px| px * 0.75))
                .unwrap_or(default.font_size_pt),
            open_file: stored
                .open_file
                .as_ref()
                .and_then(OpenFile::parse)
                .unwrap_or(default.open_file),
            startup: stored
                .startup
                .as_ref()
                .and_then(Startup::parse)
                .unwrap_or(default.startup),
        }
    }
}

/// Where the settings live; managed by `run()`'s setup.
pub struct SettingsFile(pub PathBuf);

/// A missing or damaged file gives the defaults: settings are never worth an error.
pub fn read(path: &Path) -> Settings {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
        .map(Settings::from)
        .unwrap_or_default()
}
/// Writes a temporary file first, so a failed write never leaves a truncated one.
pub fn write(path: &Path, settings: &Settings) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes)
        .and_then(|()| fs::rename(&temp, path))
        .map_err(|e| format!("无法写入 {}：{}", shown(path), describe(e)))
}

#[tauri::command]
pub fn read_settings(file: tauri::State<'_, SettingsFile>) -> Settings {
    read(&file.0)
}
/// 写入后通知所有窗口（`settings-changed`），设置在每个窗口立即生效。
#[tauri::command]
pub fn write_settings(
    settings: Settings,
    file: tauri::State<'_, SettingsFile>,
    app: tauri::AppHandle,
) -> Result<()> {
    write(&file.0, &settings)?;
    use tauri::Emitter;
    if let Err(e) = app.emit(SETTINGS_CHANGED, &settings) {
        eprintln!("无法通知各窗口设置已修改：{e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{read, write, OpenFile, Settings, Startup, SETTINGS_FILE};
    use std::fs;

    #[test]
    fn damaged_or_partial_files_fall_back_to_defaults_and_writes_round_trip() {
        let root =
            std::env::temp_dir().join(format!("linehush-test-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join(SETTINGS_FILE);

        assert_eq!(read(&path), Settings::default());
        fs::write(&path, "{ 不是 json").unwrap();
        assert_eq!(read(&path), Settings::default());
        fs::write(&path, r#"{"fontSizePt": 12}"#).unwrap();
        assert_eq!(
            read(&path),
            Settings {
                font_size_pt: 12.0,
                ..Settings::default()
            }
        );
        // Older files stored the size in px.
        fs::write(&path, r#"{"fontFamily": "宋体", "fontSize": 20}"#).unwrap();
        assert_eq!(
            read(&path),
            Settings {
                font_family: "宋体".into(),
                font_size_pt: 15.0,
                ..Settings::default()
            }
        );
        fs::write(&path, r#"{"fontSizePt": 10, "fontSize": 14}"#).unwrap();
        assert_eq!(read(&path).font_size_pt, 10.0);

        // 打开文件：认识的值照用，不认识的取默认，且不影响其他字段。
        fs::write(&path, r#"{"fontSizePt": 12, "openFile": "window"}"#).unwrap();
        assert_eq!(read(&path).open_file, OpenFile::Window);
        fs::write(&path, r#"{"fontSizePt": 12, "openFile": "侧边栏"}"#).unwrap();
        assert_eq!((read(&path).font_size_pt, read(&path).open_file), (12.0, OpenFile::Tab));
        fs::write(&path, r#"{"fontSizePt": 12, "openFile": 3}"#).unwrap();
        assert_eq!((read(&path).font_size_pt, read(&path).open_file), (12.0, OpenFile::Tab));

        // 启动时：同上。
        fs::write(&path, r#"{"fontSizePt": 12, "startup": "lastSession"}"#).unwrap();
        assert_eq!(read(&path).startup, Startup::LastSession);
        assert_eq!(read(&path).open_file, OpenFile::Tab);
        for bad in [r#""LastSession""#, r#""上次""#, "1", "null", "[]"] {
            fs::write(&path, format!(r#"{{"fontSizePt": 12, "openFile": "window", "startup": {bad}}}"#))
                .unwrap();
            let settings = read(&path);
            assert_eq!(
                (settings.font_size_pt, settings.open_file, settings.startup),
                (12.0, OpenFile::Window, Startup::NewWindow)
            );
        }

        let custom = Settings {
            font_family: "Consolas".into(),
            font_size_pt: 13.5,
            open_file: OpenFile::Window,
            startup: Startup::LastSession,
        };
        write(&path, &custom).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"fontSizePt\": 13.5") && !written.contains("\"fontSize\""));
        assert!(written.contains("\"openFile\": \"window\""));
        assert!(written.contains("\"startup\": \"lastSession\""));
        assert_eq!(read(&path), custom);
        fs::remove_dir_all(root).unwrap();
    }
}
