//! 标签页右键菜单的“打开文件所在位置”：在资源管理器里打开文件所在的文件夹并选中它
//! （Shell 的 `SHOpenFolderAndSelectItems`，与资源管理器、记事本的做法相同）。
use crate::{fsx, model::Result};
use std::{os::windows::ffi::OsStrExt, path::Path};
use windows::{
    core::PCWSTR,
    Win32::{
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems},
    },
};

/// 在资源管理器里打开 `path` 所在的文件夹并选中它；文件不存在时返回中文原因。
/// Shell 调用可能要等资源管理器响应，放在单独的阻塞线程里（自己初始化 COM），不卡界面。
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || reveal(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

fn reveal(path: &Path) -> Result<()> {
    // Shell 不认 `\\?\` 前缀的路径。
    let shown = fsx::shown(path);
    if !path.is_file() {
        return Err(format!("文件不存在：{shown}"));
    }
    let wide: Vec<u16> = Path::new(&shown)
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY：COM 初始化与反初始化成对出现在这个线程里；pidl 用完即释放。
    unsafe {
        // S_OK / S_FALSE 都要配一次 CoUninitialize；线程已是别的套间（RPC_E_CHANGED_MODE）时
        // COM 已可用，不配。
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let pidl = ILCreateFromPathW(PCWSTR(wide.as_ptr()));
        let result = if pidl.is_null() {
            Err(format!("无法定位文件：{shown}"))
        } else {
            // 不给子项时 pidl 本身就是要选中的项：打开它的父文件夹并选中。
            let opened = SHOpenFolderAndSelectItems(pidl, None, 0)
                .map_err(|e| format!("无法打开资源管理器（{}）", e.message()));
            ILFree(Some(pidl.cast_const()));
            opened
        };
        if com {
            CoUninitialize();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::reveal;
    use std::path::Path;

    #[test]
    fn a_missing_file_is_reported_in_chinese() {
        let path = std::env::temp_dir().join("linehush-reveal-missing").join("无.hush");
        let error = reveal(&path).unwrap_err();
        assert!(error.starts_with("文件不存在："), "{error}");
        assert!(reveal(Path::new(r"\\?\C:\linehush-no-such\a.hush"))
            .unwrap_err()
            .ends_with(r"C:\linehush-no-such\a.hush"));
    }
}
