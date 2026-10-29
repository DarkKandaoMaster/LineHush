//! 自动检查更新（tauri-plugin-updater）。更新源是 GitHub Releases 上最新正式版的
//! `latest.json`（tauri.conf.json 的 `plugins.updater`），安装包由 minisign 签名、
//! 公钥写在同一处。设计见 docs/design/auto-update-2026-10-29.md。
//!
//! - 每个进程只检查一次：第一个窗口建好后约 3 秒，设置“自动检查更新”开着才查
//!   （`schedule_check`）；测试模式（`LINEHUSH_TEST_DATA_DIR`）从不检查。没有新版本、
//!   网络不通、更新信息读不懂一律只记日志，不打扰。
//! - 有新版本时把 `Update` 留在 `UpdateState`，给最近使用的窗口发 `update-available`；
//!   页面用 `take_update` 取走说明（只交出一次，第一个来取的窗口弹对话框）。
//! - “立即更新”（`install_update`）：下载并校验签名 → 请所有窗口把待暂存的修改立刻写进
//!   工作副本并等它们答复（`flush-requested` / `stash_flushed`）→ 运行安装程序并退出进程。
//!   安装程序（passive）装好后重启 LineHush，未保存的修改按程序意外退出时的规则从
//!   session.json 与工作副本恢复。
use crate::errors::describe;
use crate::model::Result;
use crate::{blocking, focused_window, live_windows, lock, AppState, WINDOW_STATE};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 发给一个窗口：有新版本，用 `take_update` 取说明（载荷也是 `UpdateInfo`）。
const UPDATE_AVAILABLE: &str = "update-available";
/// 发给所有窗口（`{ round }`）：立刻暂存所有标签页的修改，完成后以 `stash_flushed` 答复。
const FLUSH_REQUESTED: &str = "flush-requested";
/// 窗口建好后等这么久再检查，不和启动抢网络与磁盘。
const CHECK_DELAY: Duration = Duration::from_secs(3);
/// 检查请求（取 latest.json）的超时。
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// 下载安装包的超时（reqwest 的超时含读完响应体，不能沿用检查的 10 秒）。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// 等各窗口暂存完的最长时间；超时不安装。
const FLUSH_TIMEOUT: Duration = Duration::from_secs(15);

/// 对话框显示的新版本说明。
#[derive(Clone, Debug, Serialize)]
pub struct UpdateInfo {
    /// 新版本号，如 "0.9.0"。
    version: String,
    /// 正在运行的版本号。
    current: String,
    /// latest.json 的 `notes`，没有时为空串。
    notes: String,
    /// latest.json 的 `pub_date`（RFC 3339），没有时为 null。
    date: Option<String>,
}
/// `install_update` 经 Channel 报给页面的进度。
#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Progress {
    /// 已下载的字节数；`total` 为服务器给的总长度（可能没有）。
    Downloading { downloaded: u64, total: Option<u64> },
    /// 下载完、签名已校验，正在等各窗口暂存修改。
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
    update: Mutex<Option<Update>>,
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
        if !app.state::<crate::settings::SettingsFile>().preferences().check_updates {
            return;
        }
        tauri::async_runtime::block_on(check(&app));
    });
}

async fn check(app: &AppHandle) {
    let remember_window = app
        .try_state::<AppState>()
        .is_some_and(|state| state.remember_window);
    let handle = app.clone();
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        // 安装程序启动后插件直接 `process::exit(0)`，不经过正常退出：先记下窗口位置，
        // 再做插件默认的收尾。
        .on_before_exit(move || {
            if remember_window {
                use tauri_plugin_window_state::AppHandleExt;
                if let Err(e) = handle.save_window_state(WINDOW_STATE) {
                    eprintln!("无法记下窗口位置：{e}");
                }
            }
            handle.cleanup_before_exit();
        })
        .build();
    let found = match updater {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let mut update = match found {
        Ok(Some(update)) => update,
        Ok(None) => {
            eprintln!("检查更新：已是最新版本");
            return;
        }
        Err(e) => {
            eprintln!("检查更新失败：{}", describe(e));
            return;
        }
    };
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let info = UpdateInfo {
        version: update.version.clone(),
        current: update.current_version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|date| date.as_str())
            .map(str::to_owned),
    };
    eprintln!("检查更新：发现新版本 {}", info.version);
    let state = app.state::<UpdateState>();
    *lock(&state.update) = Some(update);
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

/// “立即更新”：下载并校验 → 各窗口暂存修改 → 启动安装程序并退出（Windows 上不返回）。
/// 失败时返回中文原因，检查到的新版本留着，可以重试。
#[tauri::command]
pub async fn install_update(app: AppHandle, on_progress: Channel<Progress>) -> Result<()> {
    let update = lock(&app.state::<UpdateState>().update)
        .clone()
        .ok_or("没有可安装的更新")?;
    let mut downloaded = 0u64;
    let mut reported: Option<u64> = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // 总长度已知时每变一个百分点报一次，未知时每 256 KB 报一次。
                let mark = match total {
                    Some(total) if total > 0 => downloaded * 100 / total,
                    _ => downloaded / (256 * 1024),
                };
                if reported != Some(mark) {
                    reported = Some(mark);
                    let _ = on_progress.send(Progress::Downloading { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载更新失败：{}", describe(e)))?;
    let _ = on_progress.send(Progress::Stashing);
    stash_everywhere(&app)
        .await
        .map_err(|e| format!("未保存的修改暂存失败，没有安装更新：{e}"))?;
    let _ = on_progress.send(Progress::Installing);
    update
        .install(bytes)
        .map_err(|e| format!("无法启动安装程序：{}", describe(e)))?;
    // 只有非 Windows 平台会走到这里：安装完需要自己重启。
    app.restart();
}
