//! 自动检查更新（自己实现，不用 tauri-plugin-updater，不校验签名）。更新信息是仓库
//! 根目录的 `latest.json`（经 raw.githubusercontent.com 取），安装包是 GitHub Release 上的
//! NSIS setup.exe。设计见 docs/design/auto-update-2026-10-29.md。
//!
//! - 每个进程只检查一次：第一个窗口建好后约 3 秒，设置“自动检查更新”开着才查
//!   （`schedule_check`）；测试模式（`LINEHUSH_TEST_DATA_DIR`）从不检查。没有新版本、
//!   网络不通、更新信息读不懂一律只记日志，不打扰。
//! - 有新版本时把它留在 `UpdateState`，给最近使用的窗口发 `update-available`；
//!   页面用 `take_update` 取走说明（只交出一次，第一个来取的窗口弹对话框）。
//! - “立即更新”（`install_update`）：把安装包下载到临时文件夹（连接超时 10 秒、两次收到数据
//!   之间超过 30 秒算失败，不设总超时）→ 请所有窗口把待暂存的修改
//!   立刻写进工作副本并等它们答复（`flush-requested` / `stash_flushed`）→ 记下窗口位置、
//!   收尾，启动安装程序（passive）并退出进程。安装程序装好后重启 LineHush，未保存的修改
//!   按程序意外退出时的规则从 session.json 与工作副本恢复。
use crate::errors::{describe, UpdateError};
use crate::model::Result;
use crate::{blocking, focused_window, live_windows, lock, AppState, WINDOW_STATE};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, WebviewWindow};

/// 更新信息：仓库 main 分支根目录的 latest.json（raw 有约 5 分钟 CDN 缓存）。
const LATEST_URL: &str =
    "https://raw.githubusercontent.com/DarkKandaoMaster/LineHush/main/latest.json";
/// 请求头里的 User-Agent。
const USER_AGENT: &str = concat!("LineHush/", env!("CARGO_PKG_VERSION"));
/// 发给一个窗口：有新版本，用 `take_update` 取说明（载荷也是 `UpdateInfo`）。
const UPDATE_AVAILABLE: &str = "update-available";
/// 发给所有窗口（`{ round }`）：立刻暂存所有标签页的修改，完成后以 `stash_flushed` 答复。
const FLUSH_REQUESTED: &str = "flush-requested";
/// 窗口建好后等这么久再检查，不和启动抢网络与磁盘。
const CHECK_DELAY: Duration = Duration::from_secs(3);
/// 检查请求（取 latest.json）的整体超时。
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// 下载安装包时建立连接的超时。下载本身不设总超时（慢网下可能要好几分钟）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 下载安装包的空闲读超时：两次收到数据之间超过 30 秒算失败（“网络连接超时”），可以重试。
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 等各窗口暂存完的最长时间；超时不安装。
const FLUSH_TIMEOUT: Duration = Duration::from_secs(15);

/// latest.json：`{ version, notes, pub_date, url }`（`scripts/release-json.mjs` 生成）。
#[derive(Deserialize)]
struct Latest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    /// NSIS 安装包（setup.exe）的下载地址。
    url: String,
}
/// 对话框显示的新版本说明。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UpdateInfo {
    /// 新版本号，如 "0.9.1"。
    version: String,
    /// 正在运行的版本号。
    current: String,
    /// latest.json 的 `notes`，没有时为空串。
    notes: String,
    /// latest.json 的 `pub_date`（RFC 3339），没有时为 null。
    date: Option<String>,
}
/// 检查到的新版本：安装包从哪里下载。
#[derive(Clone, Debug, PartialEq)]
struct Release {
    version: String,
    url: String,
}
/// `install_update` 经 Channel 报给页面的进度。
#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Progress {
    /// 已下载的字节数；`total` 为服务器给的总长度（可能没有）。
    Downloading { downloaded: u64, total: Option<u64> },
    /// 下载完，正在等各窗口暂存修改。
    Stashing,
    /// 正在启动安装程序（随后进程退出）。
    Installing,
}
#[derive(Clone, Serialize)]
struct FlushRequested {
    round: u64,
}
/// 一轮“立刻暂存”：还没答复的窗口与第一个失败原因。
#[derive(Default)]
struct FlushRound {
    round: u64,
    waiting: HashSet<String>,
    failure: Option<String>,
}

#[derive(Default)]
pub struct UpdateState {
    /// 检查到的新版本，供 `install_update` 使用（失败后可重试）。
    release: Mutex<Option<Release>>,
    /// 还没有窗口取走的说明（`take_update` 只交出一次）。
    unannounced: Mutex<Option<UpdateInfo>>,
    flush: Mutex<FlushRound>,
}

/// 第一个窗口建好后调用：约 3 秒后，设置“自动检查更新”开着就检查一次。
pub fn schedule_check(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CHECK_DELAY);
        // 等待期间用户可能刚关掉这一项。
        if !app
            .state::<crate::settings::SettingsFile>()
            .preferences()
            .check_updates
        {
            return;
        }
        tauri::async_runtime::block_on(check(&app));
    });
}

/// HTTP 客户端：rustls（ring）+ Windows 系统证书库 + 系统代理。
pub(crate) fn client(
    configure: impl FnOnce(reqwest::ClientBuilder) -> reqwest::ClientBuilder,
) -> std::result::Result<reqwest::Client, UpdateError> {
    // reqwest 用的是不带加密实现的 rustls，进程里第一次建客户端前装上 ring。
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // 只会在别处刚装好时失败，那也能用。
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Ok(configure(reqwest::Client::builder().user_agent(USER_AGENT)).build()?)
}

/// 读 latest.json：版本号严格大于正在运行的版本才算新版本。
fn newer(
    json: &[u8],
    current: &semver::Version,
) -> std::result::Result<Option<(UpdateInfo, Release)>, UpdateError> {
    let latest: Latest = serde_json::from_slice(json)?;
    let version = semver::Version::parse(latest.version.trim_start_matches('v'))?;
    if version <= *current {
        return Ok(None);
    }
    let info = UpdateInfo {
        version: version.to_string(),
        current: current.to_string(),
        notes: latest.notes.unwrap_or_default(),
        date: latest.pub_date,
    };
    let release = Release {
        version: version.to_string(),
        url: latest.url,
    };
    Ok(Some((info, release)))
}

/// 取 latest.json（整体 10 秒超时）并比较版本。
async fn fetch(
    current: &semver::Version,
) -> std::result::Result<Option<(UpdateInfo, Release)>, UpdateError> {
    let response = client(|builder| builder.timeout(CHECK_TIMEOUT))?
        .get(LATEST_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(UpdateError::Status(status.as_u16()));
    }
    newer(&response.bytes().await?, current)
}

async fn check(app: &AppHandle) {
    let (info, release) = match fetch(&app.package_info().version).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            eprintln!("检查更新：已是最新版本");
            return;
        }
        Err(e) => {
            eprintln!("检查更新失败：{}", describe(e));
            return;
        }
    };
    eprintln!("检查更新：发现新版本 {}", info.version);
    let state = app.state::<UpdateState>();
    *lock(&state.release) = Some(release);
    *lock(&state.unannounced) = Some(info.clone());
    // 最近使用的窗口；它还没开始监听也不要紧，页面载入后会自己来取（`take_update`）。
    if let Some(target) = focused_window(app, &live_windows(app)) {
        if let Err(e) = app.emit_to(target.as_str(), UPDATE_AVAILABLE, &info) {
            eprintln!("无法通知窗口有新版本：{e}");
        }
    }
}

/// 有新版本且还没有窗口显示过时交出说明，之后为 null：本次运行只提示一次。
#[tauri::command]
pub fn take_update(state: tauri::State<'_, UpdateState>) -> Option<UpdateInfo> {
    lock(&state.unannounced).take()
}

/// 窗口答复一轮“立刻暂存”；`error` 为它有标签页暂存失败的原因。
#[tauri::command]
pub fn stash_flushed(
    round: u64,
    error: Option<String>,
    window: WebviewWindow,
    state: tauri::State<'_, UpdateState>,
) {
    let mut flush = lock(&state.flush);
    if flush.round != round {
        return;
    }
    flush.waiting.remove(window.label());
    if let Some(error) = error {
        flush.failure.get_or_insert(error);
    }
}

/// 请所有窗口立刻暂存修改，等它们都答复（已关掉的窗口不再等）。
async fn stash_everywhere(app: &AppHandle) -> Result<()> {
    let round = {
        let state = app.state::<UpdateState>();
        let mut flush = lock(&state.flush);
        flush.round += 1;
        flush.waiting = live_windows(app).into_iter().collect();
        flush.failure = None;
        flush.round
    };
    app.emit(FLUSH_REQUESTED, FlushRequested { round })
        .map_err(|e| format!("无法通知各窗口暂存修改：{e}"))?;
    let app = app.clone();
    blocking(move || {
        let state = app.state::<UpdateState>();
        let deadline = Instant::now() + FLUSH_TIMEOUT;
        loop {
            let live = live_windows(&app);
            {
                let mut flush = lock(&state.flush);
                flush.waiting.retain(|label| live.contains(label));
                if let Some(failure) = flush.failure.take() {
                    return Err(failure);
                }
                if flush.waiting.is_empty() {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return Err("有窗口没有及时暂存修改".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    })
    .await
}

/// 把安装包边下载边写到 `%TEMP%\LineHush-<版本>-updater\LineHush-<版本>-installer.exe`
/// （文件名照 tauri-plugin-updater），经 Channel 报进度。只限制连接时间与两次收到数据的间隔，
/// 不设总超时。重试时覆盖上次的文件。
async fn download(
    release: &Release,
    on_progress: &Channel<Progress>,
) -> std::result::Result<PathBuf, UpdateError> {
    let mut response = client(|builder| {
        builder
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
    })?
    .get(&release.url)
    .header(reqwest::header::ACCEPT, "application/octet-stream")
    .send()
    .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(UpdateError::Status(status.as_u16()));
    }
    let total = response.content_length();
    let dir = std::env::temp_dir().join(format!("LineHush-{}-updater", release.version));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("LineHush-{}-installer.exe", release.version));
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path)?);
    let mut downloaded = 0u64;
    let mut reported: Option<u64> = None;
    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;
        // 总长度已知时每变一个百分点报一次，未知时每 256 KB 报一次。
        let mark = match total {
            Some(total) if total > 0 => downloaded * 100 / total,
            _ => downloaded / (256 * 1024),
        };
        if reported != Some(mark) {
            reported = Some(mark);
            let _ = on_progress.send(Progress::Downloading { downloaded, total });
        }
    }
    file.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    Ok(path)
}

/// “立即更新”：下载 → 各窗口暂存修改 → 启动安装程序并退出（成功时不返回）。
/// 失败时返回中文原因，检查到的新版本留着，可以重试。
#[tauri::command]
pub async fn install_update(app: AppHandle, on_progress: Channel<Progress>) -> Result<()> {
    let release = lock(&app.state::<UpdateState>().release)
        .clone()
        .ok_or("没有可安装的更新")?;
    let installer = download(&release, &on_progress)
        .await
        .map_err(|e| format!("下载更新失败：{}", describe(e)))?;
    let _ = on_progress.send(Progress::Stashing);
    stash_everywhere(&app)
        .await
        .map_err(|e| format!("未保存的修改暂存失败，没有安装更新：{e}"))?;
    let _ = on_progress.send(Progress::Installing);
    Err(describe(run_installer(&app, &installer)))
}

/// 照 tauri-plugin-updater 2.12.0 Windows NSIS、`installMode: "passive"`、
/// `restart_after_install = true`（默认）的做法（updater.rs `install_inner` /
/// `updater_parameters`，config.rs `nsis_args` / `nsis_restart_after_install_args`）：
/// 先做退出前的收尾，再用 ShellExecuteW("open", 安装包, 参数, SW_SHOW) 启动安装程序，
/// 成功就 `process::exit(0)`。只在启动失败时返回。
fn run_installer(app: &AppHandle, installer: &Path) -> UpdateError {
    use windows::{
        core::{w, HSTRING, PCWSTR},
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOW},
    };
    // 进程直接退出、不经过正常的关窗流程：先记下窗口位置，再做 Tauri 的收尾
    // （插件的 on_before_exit 默认只调 cleanup_before_exit）。
    if app
        .try_state::<AppState>()
        .is_some_and(|state| state.remember_window)
    {
        use tauri_plugin_window_state::AppHandleExt;
        if let Err(e) = app.save_window_state(WINDOW_STATE) {
            eprintln!("无法记下窗口位置：{e}");
        }
    }
    app.cleanup_before_exit();
    let parameters = nsis_parameters(std::env::args_os().skip(1));
    let file = HSTRING::from(installer.as_os_str());
    let parameters = HSTRING::from(parameters.as_os_str());
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &file,
            &parameters,
            PCWSTR::null(),
            SW_SHOW,
        )
    };
    if result.0 as isize <= 32 {
        return UpdateError::Launch(std::io::Error::last_os_error());
    }
    std::process::exit(0);
}

/// NSIS 安装程序的参数：`/P`（passive，只显示进度条）`/UPDATE`（更新模式）`/R`（装完重新打开）
/// `/ARGS` 后接本进程的命令行参数（重开时带上，每个按 `escape_nsis_arg` 转义），以空格连接。
fn nsis_parameters(current_args: impl IntoIterator<Item = OsString>) -> OsString {
    let mut parameters: Vec<OsString> = ["/P", "/UPDATE", "/R", "/ARGS"]
        .into_iter()
        .map(OsString::from)
        .collect();
    parameters.extend(current_args.into_iter().map(escape_nsis_arg));
    parameters.join(OsStr::new(" "))
}

/// 照抄 tauri-plugin-updater 的 `escape_nsis_current_exe_arg`（改编自 Rust 标准库 Windows
/// 命令行参数的转义）：含空格、制表符、`/` 或为空时加引号（`/` 也要引起来，免得 NSIS 当成
/// 自己的参数），引号前的反斜杠按规则加倍。
fn escape_nsis_arg(arg: impl AsRef<OsStr>) -> OsString {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let arg = arg.as_ref();
    let mut cmd: Vec<u16> = Vec::new();
    let quote = arg
        .as_encoded_bytes()
        .iter()
        .any(|c| *c == b' ' || *c == b'\t' || *c == b'/')
        || arg.is_empty();
    if quote {
        cmd.push('"' as u16);
    }
    let mut backslashes: usize = 0;
    for x in arg.encode_wide() {
        if x == '\\' as u16 {
            backslashes += 1;
        } else {
            if x == '"' as u16 {
                // Add n+1 backslashes to total 2n+1 before internal '"'.
                cmd.extend((0..=backslashes).map(|_| '\\' as u16));
            }
            backslashes = 0;
        }
        cmd.push(x);
    }
    if quote {
        // Add n backslashes to total 2n before ending '"'.
        cmd.extend((0..backslashes).map(|_| '\\' as u16));
        cmd.push('"' as u16);
    }
    OsString::from_wide(&cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(text: &str) -> semver::Version {
        semver::Version::parse(text).unwrap()
    }
    const LATEST: &str = r#"{
        "version": "0.9.1",
        "notes": "修了一些问题",
        "pub_date": "2026-10-30T08:00:00Z",
        "url": "https://github.com/DarkKandaoMaster/LineHush/releases/download/LineHush_v0.9.1/LineHush_0.9.1_x64-setup.exe"
    }"#;

    #[test]
    fn only_a_strictly_newer_version_is_an_update() {
        let (info, release) = newer(LATEST.as_bytes(), &version("0.9.0"))
            .unwrap()
            .unwrap();
        assert_eq!(
            info,
            UpdateInfo {
                version: "0.9.1".into(),
                current: "0.9.0".into(),
                notes: "修了一些问题".into(),
                date: Some("2026-10-30T08:00:00Z".into()),
            }
        );
        assert_eq!(release.version, "0.9.1");
        assert!(release
            .url
            .ends_with("/LineHush_v0.9.1/LineHush_0.9.1_x64-setup.exe"));
        assert_eq!(newer(LATEST.as_bytes(), &version("0.9.1")).unwrap(), None);
        assert_eq!(newer(LATEST.as_bytes(), &version("0.10.0")).unwrap(), None);
        // 预发布版本低于同号正式版。
        assert!(newer(LATEST.as_bytes(), &version("0.9.1-beta.1"))
            .unwrap()
            .is_some());
    }

    #[test]
    fn notes_and_date_are_optional_and_a_leading_v_is_allowed() {
        let json = r#"{ "version": "v1.0.0", "url": "https://example.com/a.exe" }"#;
        let (info, _) = newer(json.as_bytes(), &version("0.9.0")).unwrap().unwrap();
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.notes, "");
        assert_eq!(info.date, None);
    }

    #[test]
    fn bad_latest_json_is_an_error() {
        let current = version("0.9.0");
        assert!(matches!(
            newer(b"<html>", &current),
            Err(UpdateError::Json(_))
        ));
        // 旧格式（tauri-plugin-updater 的 platforms）没有 url。
        let old = r#"{ "version": "0.9.1", "platforms": {} }"#;
        assert!(matches!(
            newer(old.as_bytes(), &current),
            Err(UpdateError::Json(_))
        ));
        let json = r#"{ "version": "0.9", "url": "https://example.com/a.exe" }"#;
        assert!(matches!(
            newer(json.as_bytes(), &current),
            Err(UpdateError::Version(_))
        ));
    }

    #[test]
    fn nsis_parameters_follow_the_plugin() {
        let none = nsis_parameters(Vec::new());
        assert_eq!(none, OsString::from("/P /UPDATE /R /ARGS"));
        let args = [
            r"D:\日记\a b.hush",
            "x",
            "",
            r#"say "hi"\"#,
            "/flag",
            r"C:\dir\",
        ]
        .map(OsString::from);
        assert_eq!(
            nsis_parameters(args),
            OsString::from(
                r#"/P /UPDATE /R /ARGS "D:\日记\a b.hush" x "" "say \"hi\"\\" "/flag" C:\dir\"#
            )
        );
    }
}
