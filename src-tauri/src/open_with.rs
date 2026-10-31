//! 附件块的“打开”：把文件原样写到临时文件夹 `%TEMP%\linehush-open\`（文件名同复制暂存：
//! `<id 前 12 位>-<原名>`，见 `clipboard::staged_path`），再用系统默认程序打开它
//! （Shell 的 `ShellExecuteExW`）；没有关联程序时弹出系统的“选择打开方式”。
//! 临时文件只给别的程序看，改了也不回写笔记；启动时清掉放了 7 天以上的（lib.rs `sweep_staged`）。
//! 命令 `open_attachment` 在 lib.rs（要用标签页表），这里是写文件与启动两步。
use crate::{
    clipboard,
    errors::describe,
    fsx,
    model::{MediaKind, Picture, Result},
};
use std::{
    fs,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};
use windows::{
    core::{HRESULT, PCWSTR},
    Win32::{
        Foundation::{ERROR_CANCELLED, ERROR_NO_ASSOCIATION, HWND},
        System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
        },
        UI::{
            Shell::{
                ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SE_ERR_NOASSOC,
                SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    },
};

/// 临时文件夹在系统临时目录下的名字（测试模式在测试数据目录下，见 lib.rs）。
pub const OPEN_FOLDER: &str = "linehush-open";

/// 打开附件用的临时文件夹（lib.rs 启动时 `manage`）。
pub struct OpenDir(pub PathBuf);

/// 附件 `id`（名为 `name`）写到 `dir` 里的路径：与复制暂存同名，`<id 前 12 位>-<原名>`，
/// 原名里 Windows 不允许的字符换成 `_`，没有名字时叫“文件”。
pub fn temp_path(dir: &Path, id: &str, name: &str) -> PathBuf {
    let pic = Picture {
        id: id.to_owned(),
        name: name.to_owned(),
        width: 0,
        height: 0,
        kind: MediaKind::File,
        duration: None,
        size: None,
    };
    // 附件不按内容补扩展名，用不到字节。
    clipboard::staged_path(dir, &pic, &[])
}
/// 已有的临时文件（长度 `existing`，不存在为 None）要不要重写成 `len` 字节的原文件：
/// 长度相同就不重写（多半是上次打开留下的，可能还被别的程序开着）。
pub fn needs_write(existing: Option<u64>, len: usize) -> bool {
    existing != Some(len as u64)
}
/// 把附件写到 `dir` 里待打开的位置（已有同长度的文件则只刷新修改时间，免得被按时间清掉），
/// 返回路径。
pub fn write_temp(dir: &Path, id: &str, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    let path = temp_path(dir, id, name);
    let existing = fs::metadata(&path)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len());
    if needs_write(existing, bytes.len()) {
        fs::create_dir_all(dir)
            .and_then(|()| fs::write(&path, bytes))
            .map_err(|e| format!("写入临时文件失败：{}", describe(e)))?;
    } else {
        let _ = fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_modified(std::time::SystemTime::now()));
    }
    Ok(path)
}
/// 用系统默认程序打开 `path`（verb `open`）；没有关联程序时改用 `openas`，弹出
/// “选择打开方式”。用户在那里取消不算失败。`owner` 是对话框的父窗口（HWND 数值，0 为无）。
/// Shell 可能要等别的程序响应，调用方放在阻塞线程里；这里自己初始化 COM。
pub fn launch(path: &Path, owner: isize) -> Result<()> {
    let file: Vec<u16> = Path::new(&fsx::shown(path))
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let verb = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (open, open_as) = (verb("open"), verb("openas"));
    let no_association = HRESULT::from_win32(ERROR_NO_ASSOCIATION.0);
    let cancelled = HRESULT::from_win32(ERROR_CANCELLED.0);
    // SAFETY：COM 初始化与反初始化成对出现在这个线程里；结构体里的字符串在调用期间有效。
    unsafe {
        // S_OK / S_FALSE 都要配一次 CoUninitialize；线程已是别的套间时 COM 已可用，不配。
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let run = |verb: &[u16], mask: u32| {
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_NOASYNC | mask,
                hwnd: HWND(owner as _),
                lpVerb: PCWSTR(verb.as_ptr()),
                lpFile: PCWSTR(file.as_ptr()),
                nShow: SW_SHOWNORMAL.0,
                ..Default::default()
            };
            let result = ShellExecuteExW(&mut info);
            // 出错时 hInstApp 是 SE_ERR_* 代码。
            let noassoc = info.hInstApp.0 as usize == SE_ERR_NOASSOC as usize;
            (result, noassoc)
        };
        let mut result = match run(&open, SEE_MASK_FLAG_NO_UI) {
            (Err(e), noassoc) if noassoc || e.code() == no_association => run(&open_as, 0).0,
            (result, _) => result,
        };
        if matches!(&result, Err(e) if e.code() == cancelled) {
            result = Ok(());
        }
        if com {
            CoUninitialize();
        }
        result.map_err(|e| format!("系统拒绝打开：{}", e.message()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_paths_are_named_like_copied_files() {
        let dir = Path::new(r"C:\T\linehush-open");
        let id = "0123456789abcdef0123";
        assert_eq!(temp_path(dir, id, "报告.docx"), dir.join("0123456789ab-报告.docx"));
        assert_eq!(temp_path(dir, id, "a:b?.txt"), dir.join("0123456789ab-a_b_.txt"));
        assert_eq!(temp_path(dir, id, ""), dir.join("0123456789ab-文件"));
        // 没有扩展名的不补（附件不看内容）。
        assert_eq!(temp_path(dir, id, "Makefile"), dir.join("0123456789ab-Makefile"));
        assert_eq!(temp_path(dir, "abc", "x.bin"), dir.join("abc-x.bin"));
    }
    #[test]
    fn a_file_of_the_same_length_is_not_written_again() {
        assert!(needs_write(None, 0));
        assert!(needs_write(None, 10));
        assert!(needs_write(Some(9), 10));
        assert!(!needs_write(Some(10), 10));
        assert!(!needs_write(Some(0), 0));
    }
    #[test]
    fn write_temp_writes_the_original_once() {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "linehush-test-open-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let bytes = b"PK\x03\x04 not really a docx".to_vec();
        let id = crate::images::hash(&bytes);
        // 文件夹不存在时建出来。
        let path = write_temp(&dir.join("子"), &id, "报告.docx", &bytes).unwrap();
        assert_eq!(path, dir.join("子").join(format!("{}-报告.docx", &id[..12])));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        // 同长度的不重写（内容不同也不动）；长度不同则换回原文件。
        let same_length = vec![b'x'; bytes.len()];
        fs::write(&path, &same_length).unwrap();
        assert_eq!(write_temp(&dir.join("子"), &id, "报告.docx", &bytes).unwrap(), path);
        assert_eq!(fs::read(&path).unwrap(), same_length);
        fs::write(&path, b"edited elsewhere").unwrap();
        write_temp(&dir.join("子"), &id, "报告.docx", &bytes).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        // 0 字节的附件也能写出。
        let empty = write_temp(&dir, &crate::images::hash(b""), "空.txt", b"").unwrap();
        assert_eq!(fs::read(&empty).unwrap(), b"");
        // 同名的是个文件夹时报中文原因。
        let blocked = temp_path(&dir, "ffffffffffffffff", "夹.txt");
        fs::create_dir_all(&blocked).unwrap();
        let error = write_temp(&dir, "ffffffffffffffff", "夹.txt", b"abc").unwrap_err();
        assert!(error.starts_with("写入临时文件失败："), "{error}");
        fs::remove_dir_all(dir).unwrap();
    }
}
