//! Turns SQLite, file-system and updater errors into the Chinese text shown to the user.
//! The original (usually English) message follows in brackets, for diagnosis.
use rusqlite::ErrorCode;
use std::io::ErrorKind;

/// An error that can explain itself to the user.
pub trait Describe: std::fmt::Display {
    /// What went wrong, in Chinese, without the original message.
    fn reason(&self) -> &'static str;
}
impl Describe for rusqlite::Error {
    fn reason(&self) -> &'static str {
        match self.sqlite_error_code() {
            Some(ErrorCode::DiskFull) => "磁盘已满",
            Some(ErrorCode::ReadOnly | ErrorCode::PermissionDenied | ErrorCode::CannotOpen) => {
                "没有写入权限或文件无法访问"
            }
            Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => {
                "不是有效的 .hush 文件或文件已损坏"
            }
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "文件正被其他程序占用",
            _ => "读写失败",
        }
    }
}
impl Describe for std::io::Error {
    fn reason(&self) -> &'static str {
        // Windows ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION have no ErrorKind of their own.
        if matches!(self.raw_os_error(), Some(32 | 33)) {
            return "文件正被其他程序占用";
        }
        match self.kind() {
            ErrorKind::NotFound => "文件不存在",
            ErrorKind::PermissionDenied => "没有访问权限",
            ErrorKind::StorageFull => "磁盘已满",
            _ => "读写失败",
        }
    }
}
/// 检查、下载、安装更新时的错误（tauri-plugin-updater）。
impl Describe for tauri_plugin_updater::Error {
    fn reason(&self) -> &'static str {
        use tauri_plugin_updater::Error;
        match self {
            Error::Reqwest(_) | Error::Network(_) => "网络连接失败",
            Error::Minisign(_)
            | Error::Base64(_)
            | Error::SignatureUtf8(_)
            | Error::SignedVersionMismatch { .. }
            | Error::MissingSignedVersion => "安装包签名校验失败",
            Error::ReleaseNotFound
            | Error::Serialization(_)
            | Error::Semver(_)
            | Error::UrlParse(_)
            | Error::TargetNotFound(_)
            | Error::TargetsNotFound(_) => "更新信息无效",
            Error::InvalidUpdaterFormat | Error::BinaryNotFoundInArchive => "安装包格式无效",
            Error::Io(e) => e.reason(),
            _ => "更新失败",
        }
    }
}
/// "磁盘已满（database or disk is full）". Takes the error by value so it fits `map_err`.
pub fn describe(err: impl Describe) -> String {
    format!("{}（{err}）", err.reason())
}

#[cfg(test)]
mod tests {
    use super::describe;
    use rusqlite::ffi;
    use std::io::{Error, ErrorKind};

    /// Errors from a real connection carry SQLite's message; here it is "raw".
    fn sqlite(code: i32) -> String {
        describe(rusqlite::Error::SqliteFailure(
            ffi::Error::new(code),
            Some("raw".into()),
        ))
    }
    #[test]
    fn sqlite_and_io_errors_are_described_in_chinese() {
        assert_eq!(sqlite(ffi::SQLITE_FULL), "磁盘已满（raw）");
        assert_eq!(
            sqlite(ffi::SQLITE_READONLY),
            "没有写入权限或文件无法访问（raw）"
        );
        assert!(sqlite(ffi::SQLITE_CANTOPEN).starts_with("没有写入权限或文件无法访问（"));
        assert!(sqlite(ffi::SQLITE_PERM).starts_with("没有写入权限或文件无法访问（"));
        assert_eq!(
            sqlite(ffi::SQLITE_NOTADB),
            "不是有效的 .hush 文件或文件已损坏（raw）"
        );
        assert!(sqlite(ffi::SQLITE_CORRUPT).starts_with("不是有效的 .hush 文件或文件已损坏（"));
        assert!(sqlite(ffi::SQLITE_BUSY).starts_with("文件正被其他程序占用（"));
        assert!(sqlite(ffi::SQLITE_LOCKED).starts_with("文件正被其他程序占用（"));
        assert!(sqlite(ffi::SQLITE_IOERR).starts_with("读写失败（"));
        // Extended codes fall back to their primary code.
        assert!(sqlite(ffi::SQLITE_IOERR_WRITE).starts_with("读写失败（"));
        assert!(sqlite(ffi::SQLITE_READONLY_DBMOVED).starts_with("没有写入权限或文件无法访问（"));

        let io = |kind: ErrorKind| describe(Error::new(kind, "raw"));
        assert_eq!(io(ErrorKind::NotFound), "文件不存在（raw）");
        assert_eq!(io(ErrorKind::PermissionDenied), "没有访问权限（raw）");
        assert_eq!(io(ErrorKind::StorageFull), "磁盘已满（raw）");
        assert_eq!(io(ErrorKind::Other), "读写失败（raw）");
        assert!(describe(Error::from_raw_os_error(32)).starts_with("文件正被其他程序占用（"));
        assert!(describe(Error::from_raw_os_error(112)).starts_with("磁盘已满（"));
        assert!(describe(Error::from_raw_os_error(5)).starts_with("没有访问权限（"));
    }

    #[test]
    fn updater_errors_are_described_in_chinese() {
        use tauri_plugin_updater::Error as Updater;
        assert_eq!(
            describe(Updater::Network("status 404".into())),
            "网络连接失败（`status 404`）"
        );
        assert!(describe(Updater::ReleaseNotFound).starts_with("更新信息无效（"));
        assert!(describe(Updater::TargetNotFound("windows-x86_64".into())).starts_with("更新信息无效（"));
        assert!(describe(Updater::MissingSignedVersion).starts_with("安装包签名校验失败（"));
        assert!(describe(Updater::InvalidUpdaterFormat).starts_with("安装包格式无效（"));
        assert!(describe(Updater::Io(Error::from_raw_os_error(5))).starts_with("没有访问权限（"));
        assert!(describe(Updater::EmptyEndpoints).starts_with("更新失败（"));
    }
}
