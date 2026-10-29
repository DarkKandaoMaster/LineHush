//! Turns SQLite, file-system and update errors into the Chinese text shown to the user.
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
/// 检查、下载、安装更新时的错误（update.rs）。
#[derive(Debug)]
pub enum UpdateError {
    /// 连不上、超时（含下载时的空闲读超时）、读响应中途断开。
    Network(reqwest::Error),
    /// 服务器回了 2xx 以外的状态码。
    Status(u16),
    /// latest.json 不是预期的 JSON。
    Json(serde_json::Error),
    /// latest.json 里的版本号不是 semver。
    Version(semver::Error),
    /// 写临时安装包。
    Io(std::io::Error),
    /// ShellExecuteW 启动安装程序失败。
    Launch(std::io::Error),
}
impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(e) => e.fmt(f),
            Self::Status(code) => write!(f, "HTTP {code}"),
            Self::Json(e) => e.fmt(f),
            Self::Version(e) => e.fmt(f),
            Self::Io(e) | Self::Launch(e) => e.fmt(f),
        }
    }
}
impl From<reqwest::Error> for UpdateError {
    fn from(e: reqwest::Error) -> Self {
        Self::Network(e)
    }
}
impl From<serde_json::Error> for UpdateError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
impl From<semver::Error> for UpdateError {
    fn from(e: semver::Error) -> Self {
        Self::Version(e)
    }
}
impl From<std::io::Error> for UpdateError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl Describe for UpdateError {
    fn reason(&self) -> &'static str {
        match self {
            Self::Network(e) if e.is_timeout() => "网络连接超时",
            Self::Network(_) => "网络连接失败",
            Self::Status(404) => "服务器上找不到更新文件",
            Self::Status(_) => "服务器返回错误",
            Self::Json(_) => "更新信息无效",
            Self::Version(_) => "更新信息里的版本号无效",
            Self::Io(e) => e.reason(),
            Self::Launch(_) => "无法启动安装程序",
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
    fn update_errors_are_described_in_chinese() {
        use crate::errors::UpdateError;
        assert_eq!(
            describe(UpdateError::Status(404)),
            "服务器上找不到更新文件（HTTP 404）"
        );
        assert_eq!(
            describe(UpdateError::Status(503)),
            "服务器返回错误（HTTP 503）"
        );
        let json = serde_json::from_str::<serde_json::Value>("<html>").unwrap_err();
        assert!(describe(UpdateError::Json(json)).starts_with("更新信息无效（"));
        let version = semver::Version::parse("0.9").unwrap_err();
        assert!(describe(UpdateError::Version(version)).starts_with("更新信息里的版本号无效（"));
        assert!(describe(UpdateError::Io(Error::from_raw_os_error(112))).starts_with("磁盘已满（"));
        assert!(describe(UpdateError::Launch(Error::from_raw_os_error(5)))
            .starts_with("无法启动安装程序（"));
        // 地址无效时 reqwest 在发请求前就报错，算作网络错误。
        let network = crate::update::client(|builder| builder)
            .unwrap()
            .get("not a url")
            .build()
            .unwrap_err();
        assert!(describe(UpdateError::Network(network)).starts_with("网络连接失败（"));
    }

    /// 下载时的空闲读超时（`read_timeout`）也是“网络连接超时”：本机起一个只发一半响应体就不动的服务器。
    #[test]
    fn a_stalled_download_is_a_timeout() {
        use crate::errors::UpdateError;
        use std::io::{Read, Write};
        use std::time::Duration;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab")
                .unwrap();
            std::thread::sleep(Duration::from_secs(2));
        });
        let error = tauri::async_runtime::block_on(async move {
            let client = crate::update::client(|builder| {
                builder.no_proxy().read_timeout(Duration::from_millis(300))
            })
            .unwrap();
            let mut response = client
                .get(format!("http://{address}/"))
                .send()
                .await
                .unwrap();
            loop {
                match response.chunk().await {
                    Ok(Some(_)) => continue,
                    Ok(None) => panic!("响应体不该读完"),
                    Err(e) => break e,
                }
            }
        });
        assert!(describe(UpdateError::Network(error)).starts_with("网络连接超时（"));
        server.join().unwrap();
    }
}
