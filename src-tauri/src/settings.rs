//! User preferences in `settings.json` next to the working copies. Rust stores
//! the JSON as the frontend sends it; the frontend fills in defaults and checks
//! every value (`normalizeSettings` in src/core/settings.ts). Rust itself reads
//! only `openFile` when a file is opened from outside (see `open_from_outside`
//! in lib.rs) and `startup` when it starts (see `Session::plan_launch`).
use crate::errors::describe;
use crate::fsx::shown;
use crate::model::Result;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const SETTINGS_FILE: &str = "settings.json";
/// 设置写入后发给所有窗口（载荷为写入的设置），各窗口立即应用。
pub const SETTINGS_CHANGED: &str = "settings-changed";

/// 打开文件：双击 `.hush`、再次启动时带文件，在最近使用的窗口里开新标签页，还是开新窗口。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFile {
    Tab,
    Window,
}
/// 启动时：像记事本，新建一个窗口（只恢复程序意外退出时留下的未保存修改），
/// 还是恢复上次关闭时的全部窗口与标签页。它也决定关闭最后一个窗口时是否询问保存。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Startup {
    NewWindow,
    LastSession,
}
/// The two settings Rust acts on; a missing or unknown value takes the default
/// (`tab` / `newWindow`, as `DEFAULT_SETTINGS` in src/core/settings.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preferences {
    pub open_file: OpenFile,
    pub startup: Startup,
}
impl Preferences {
    pub fn of(settings: &Value) -> Self {
        let field = |name: &str| settings.get(name).and_then(Value::as_str);
        Self {
            open_file: match field("openFile") {
                Some("window") => OpenFile::Window,
                _ => OpenFile::Tab,
            },
            startup: match field("startup") {
                Some("lastSession") => Startup::LastSession,
                _ => Startup::NewWindow,
            },
        }
    }
}

/// Where the settings live; managed by `run()`'s setup.
pub struct SettingsFile(pub PathBuf);
impl SettingsFile {
    pub fn preferences(&self) -> Preferences {
        Preferences::of(&read(&self.0))
    }
}

/// The file as stored; a missing or damaged one is `{}`: settings are never
/// worth an error.
pub fn read(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}
/// Writes a temporary file first, so a failed write never leaves a truncated one.
pub fn write(path: &Path, settings: &Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes)
        .and_then(|()| fs::rename(&temp, path))
        .map_err(|e| format!("无法写入 {}：{}", shown(path), describe(e)))
}

#[tauri::command]
pub fn read_settings(file: tauri::State<'_, SettingsFile>) -> Value {
    read(&file.0)
}
/// 写入后通知所有窗口（`settings-changed`），设置在每个窗口立即生效。
#[tauri::command]
pub fn write_settings(
    settings: Value,
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
    use super::{read, write, OpenFile, Preferences, Startup, SETTINGS_FILE};
    use serde_json::json;
    use std::fs;

    #[test]
    fn settings_are_stored_as_sent_and_damaged_files_read_as_empty() {
        let root =
            std::env::temp_dir().join(format!("linehush-test-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join(SETTINGS_FILE);

        assert_eq!(read(&path), json!({}));
        fs::write(&path, "{ 不是 json").unwrap();
        assert_eq!(read(&path), json!({}));
        // Whatever the frontend sends is written and read back unchanged.
        let settings = json!({
            "fontFamily": "Consolas",
            "fontSizePt": 13.5,
            "openFile": "window",
            "startup": "lastSession",
            "caretWidth": "thick",
            "selectionCorners": "square",
        });
        write(&path, &settings).unwrap();
        assert_eq!(read(&path), settings);
        assert!(!root.join("settings.json.tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_file_and_startup_take_their_defaults_unless_known() {
        let defaults = Preferences {
            open_file: OpenFile::Tab,
            startup: Startup::NewWindow,
        };
        assert_eq!(Preferences::of(&json!({})), defaults);
        assert_eq!(Preferences::of(&json!(null)), defaults);
        assert_eq!(Preferences::of(&json!([1])), defaults);
        assert_eq!(
            Preferences::of(&json!({ "openFile": "window", "startup": "lastSession" })),
            Preferences {
                open_file: OpenFile::Window,
                startup: Startup::LastSession,
            }
        );
        // An unknown value of one does not affect the other.
        for bad in [json!("Window"), json!("侧边栏"), json!(3), json!(null), json!([])] {
            let settings = json!({ "openFile": bad, "startup": "lastSession" });
            assert_eq!(
                Preferences::of(&settings),
                Preferences {
                    open_file: OpenFile::Tab,
                    startup: Startup::LastSession,
                }
            );
            let settings = json!({ "openFile": "window", "startup": bad });
            assert_eq!(
                Preferences::of(&settings),
                Preferences {
                    open_file: OpenFile::Window,
                    startup: Startup::NewWindow,
                }
            );
        }
    }
}
