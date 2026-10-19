//! User preferences in `settings.json` next to the working copy. The frontend
//! clamps the values and turns the font name into a CSS font list (see
//! src/core/settings.ts); here they are only stored.
use crate::errors::describe;
use crate::fsx::shown;
use crate::model::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const SETTINGS_FILE: &str = "settings.json";

/// Missing fields (an older file) take their defaults; keep these in step with
/// `DEFAULT_SETTINGS` in src/core/settings.ts. "微软雅黑" is Microsoft YaHei
/// (not the UI variant); WebView2 finds fonts by their Chinese names.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub font_family: String,
    pub font_size: f64,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            font_family: "微软雅黑".into(),
            font_size: 14.0,
        }
    }
}

/// Where the settings live; managed by `run()`'s setup.
pub struct SettingsFile(pub PathBuf);

/// A missing or damaged file gives the defaults: settings are never worth an error.
pub fn read(path: &Path) -> Settings {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
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
#[tauri::command]
pub fn write_settings(settings: Settings, file: tauri::State<'_, SettingsFile>) -> Result<()> {
    write(&file.0, &settings)
}

#[cfg(test)]
mod tests {
    use super::{read, write, Settings, SETTINGS_FILE};
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
        fs::write(&path, r#"{"fontSize": 20}"#).unwrap();
        assert_eq!(
            read(&path),
            Settings {
                font_size: 20.0,
                ..Settings::default()
            }
        );

        let custom = Settings {
            font_family: "Consolas".into(),
            font_size: 18.0,
        };
        write(&path, &custom).unwrap();
        assert_eq!(read(&path), custom);
        fs::remove_dir_all(root).unwrap();
    }
}
