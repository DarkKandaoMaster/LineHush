mod caption;
mod caret;
mod clipboard;
mod db;
mod errors;
mod fsx;
mod images;
mod model;
mod pdf;
mod session;
mod settings;
mod store;
#[cfg(test)]
mod store_tests;

use model::{Diary, ExportImage, Picture, Result};
use serde::Serialize;
use session::{Session, TabEntry, WINDOW_PREFIX};
use settings::OpenFile;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::Duration,
};
use store::{Opened, Store};
use tauri::{
    ipc::Response, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// Tells one window that `take_open_request` holds a file for it.
const OPEN_REQUESTED: &str = "open-requested";
/// Tells one window to switch to a tab (`{ tab }`): the file asked for is open there.
const ACTIVATE_TAB: &str = "activate-tab";
/// `import_image` sends the image as the raw body, so its tab comes in this header.
const TAB_HEADER: &str = "x-linehush-tab";
/// What the window-state plugin remembers. Not VISIBLE: `create_window` shows the
/// window itself once the rest is restored.
const WINDOW_STATE: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);
/// The window-state plugin skips its own restore only for exact labels, so this
/// many `win-<n>` labels are listed up front.
const MAX_WINDOWS: u32 = 64;
/// 新窗口相对最近使用的窗口向右下错开的距离（逻辑像素），像记事本。
const CASCADE: f64 = 32.0;
/// 启动时清掉复制暂存文件夹里放了这么久的文件。
const STAGED_KEPT_AT_START: Duration = Duration::from_secs(7 * 24 * 3600);
/// 每次复制后清掉放了这么久的文件：连续复制时，别的程序可能还要粘贴的上一次内容不会立刻被删。
const STAGED_KEPT_AFTER_COPY: Duration = Duration::from_secs(3600);

struct AppState {
    /// session.json: windows, their tabs and which file each tab belongs to.
    session: Mutex<Session>,
    /// The loaded tabs. The outer lock is held only to look a tab up.
    tabs: Mutex<HashMap<String, Arc<Mutex<Store>>>>,
    /// `.hush` files (double-click, command line, second launch) waiting for a
    /// window to open them, by window label. A newer request replaces an older one.
    requests: Mutex<HashMap<String, PathBuf>>,
    /// Window size and position are remembered (not in tests).
    remember_window: bool,
    /// 窗口位置插件（`.window-state.json`）已有记录的窗口编号，加上本次运行建过的
    /// 窗口：有记录的窗口由插件恢复位置，没有的相对最近使用的窗口错开（`cascade_from`）。
    /// 测试模式不记窗口位置，开始时为空。
    window_records: Mutex<HashSet<String>>,
    /// 最后一个编辑窗口已销毁，进程正在退出。
    exiting: AtomicBool,
    _lock: File,
}
/// Image copies to the system clipboard (see clipboard.rs).
struct ClipboardState {
    /// Where copied originals are written as files.
    dir: PathBuf,
    /// Number of the latest copy; an older copy still being prepared is dropped.
    latest: AtomicU64,
    /// The images of the last copy and the clipboard sequence number right after
    /// it: while the number is unchanged, the clipboard still holds them.
    last: Mutex<Option<(u32, Copied)>>,
}
/// The images of a copy and, for each, whether it starts a new row of images
/// after the one before it (a line break between them in the editor).
#[derive(Clone, Serialize)]
struct Copied {
    pictures: Vec<Picture>,
    rows: Vec<bool>,
}
/// What pasting images no longer to be found reports.
const COPIED_IMAGES_GONE: &str = "剪贴板中的图片已不可用，请重新复制";
impl ClipboardState {
    /// Makes sure the document in `tab` holds each image (see `adopt_images`);
    /// returns the ids of those no longer to be found.
    fn adopt(&self, app: &AppHandle, tab: &str, ids: impl IntoIterator<Item = String>) -> Result<Vec<String>> {
        let target = lock_tab(app, tab)?;
        let others: Vec<Arc<Mutex<Store>>> = lock(&app.state::<AppState>().tabs)
            .iter()
            .filter(|(id, _)| id.as_str() != tab)
            .map(|(_, store)| store.clone())
            .collect();
        adopt_images(&self.dir, &target, &others, ids)
    }
}
/// Makes sure `target` holds each image: an image from another document is read
/// back from the file its copy left in `dir` (also from an earlier session) or,
/// failing that, from another open tab that holds it. Only one store is locked
/// at a time. Returns the ids found nowhere.
fn adopt_images(
    dir: &Path,
    target: &Mutex<Store>,
    others: &[Arc<Mutex<Store>>],
    ids: impl IntoIterator<Item = String>,
) -> Result<Vec<String>> {
    let mut missing = Vec::new();
    for id in ids {
        if lock(target).has_image(&id)? {
            continue;
        }
        let bytes = clipboard::staged(dir, &id).or_else(|| {
            others.iter().find_map(|store| {
                let source = lock(store);
                if !source.has_image(&id).ok()? {
                    return None;
                }
                source.image(&id).ok()
            })
        });
        match bytes {
            Some(bytes) => lock(target).add_image(&id, &bytes, None)?,
            None if !missing.contains(&id) => missing.push(id),
            None => {}
        }
    }
    Ok(missing)
}
/// Writes the originals of `pictures` from `store` into `dir`, as a copy does.
fn stage_pictures(dir: &Path, store: &Mutex<Store>, pictures: &[Picture]) -> Result<()> {
    for pic in pictures {
        let bytes = lock(store).image(&pic.id)?;
        clipboard::stage(dir, pic, &bytes)?;
    }
    Ok(())
}
/// Cleans the copy folder `dir`, best effort (failures are ignored): removes
/// the files last written more than `max_age` ago, except those of the images
/// in `keep`, whose names start with the id or, as `clipboard::stage` names
/// them, with its first 12 digits and a hyphen.
fn sweep_staged(dir: &Path, keep: &HashSet<String>, max_age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let kept: Vec<String> = keep
        .iter()
        .flat_map(|id| {
            let prefix = id.get(..clipboard::ID_PREFIX).unwrap_or(id);
            [id.clone(), format!("{prefix}-")]
        })
        .collect();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if kept.iter().any(|prefix| name.starts_with(prefix.as_str())) {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .filter(|meta| meta.is_file())
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}
/// One tab as the frontend gets it.
#[derive(Serialize)]
struct TabOpened {
    tab: String,
    opened: Opened,
    /// The file the tab belonged to could not be opened; the tab is a new unnamed document.
    error: Option<String>,
}
/// All tabs of a window and its current tab.
#[derive(Serialize)]
struct WindowOpened {
    tabs: Vec<TabOpened>,
    active: String,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum OpenOutcome {
    Opened(TabOpened),
    /// The file is already open in that tab; another window is brought to the front.
    Existing { window: String, tab: String },
}
#[derive(Clone, Serialize)]
struct ActivateTab {
    tab: String,
}

/// Locks a mutex. A panic while holding one ends the process in release builds
/// (`panic = "abort"`), so a poisoned lock is only seen in debug builds and
/// tests, where the data is used as it is.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
/// Writes session.json where a failure must not stop the action; it is only logged.
fn save_session(session: &Session) {
    if let Err(e) = session.save() {
        eprintln!("{e}");
    }
}
/// The first `.hush` argument, made absolute against `cwd` and canonical when it
/// exists (so it compares equal to the open file). A missing file is kept as is,
/// so opening it reports the error.
fn hush_argument(args: impl IntoIterator<Item = String>, cwd: &Path) -> Option<PathBuf> {
    let suffix = format!(".{}", store::EXTENSION);
    let path = args
        .into_iter()
        .map(|arg| PathBuf::from(arg.trim().trim_matches('"')))
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.to_ascii_lowercase().ends_with(&suffix))
        })?;
    let path = cwd.join(path);
    Some(fs::canonicalize(&path).unwrap_or(path))
}
/// Labels of the editor windows that exist now.
fn live_windows(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| label.starts_with(WINDOW_PREFIX))
        .collect();
    labels.sort();
    labels
}
/// Brings a window to the front, restoring it if minimized.
fn reveal(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
/// 最近获得焦点的活窗口，没有就取编号最小的活窗口。
fn focused_window(app: &AppHandle, live: &[String]) -> Option<String> {
    let state = app.try_state::<AppState>()?;
    let focused = lock(&state.session).focused().map(str::to_owned);
    focused
        .filter(|label| live.contains(label))
        .or_else(|| live.first().cloned())
}
/// A second launch handed its arguments over and quit. Runs on the main thread,
/// inside the single-instance plugin's WM_COPYDATA handling; windows are created
/// from a worker thread instead (`run_on_main_thread` would run them right here,
/// since this already is the main thread), and Tauri hands the creation back to
/// the main thread's event loop.
fn second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    // args[0] is the second instance's executable.
    let path = hush_argument(args.into_iter().skip(1), Path::new(&cwd));
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = open_from_outside(&app, path) {
            eprintln!("{e}");
        }
    });
}
/// 从外部来的打开请求（再次启动 LineHush，含双击 `.hush`）：
/// 不带文件 → 新窗口；文件已在某个窗口打开 → 置顶那个窗口并切到那个标签页；
/// 否则按设置“打开文件”：在最近使用的窗口里开新标签页（那个窗口按“打开”的规则
/// 处理，见 tabs.ts 的 openPath），或开一个新窗口来打开。
fn open_from_outside(app: &AppHandle, path: Option<PathBuf>) -> Result<()> {
    let state = app.try_state::<AppState>().ok_or("LineHush 尚未启动完成")?;
    let Some(path) = path else {
        return open_new_window(app, None).map(drop);
    };
    let live = live_windows(app);
    let open = lock(&state.session).find_path(&path);
    if let Some((label, tab)) = open.filter(|(label, _)| live.contains(label)) {
        reveal(app, &label);
        let _ = app.emit_to(label.as_str(), ACTIVATE_TAB, ActivateTab { tab });
        return Ok(());
    }
    let open_file = app.state::<settings::SettingsFile>().preferences().open_file;
    match focused_window(app, &live).filter(|_| open_file == OpenFile::Tab) {
        Some(target) => {
            lock(&state.requests).insert(target.clone(), path);
            reveal(app, &target);
            app.emit_to(target.as_str(), OPEN_REQUESTED, ())
                .map_err(|e| e.to_string())
        }
        // 新窗口加载完标签页后自己取走这个请求（useWindowGuards）。
        None => open_new_window(app, Some(path)).map(drop),
    }
}
/// 开一个新窗口（编号取最小的空位）。它的空标签页在前端 `restore_window` 时建；
/// `request` 是等它打开的文件。
fn open_new_window(app: &AppHandle, request: Option<PathBuf>) -> Result<String> {
    let state = app.state::<AppState>();
    let live = live_windows(app);
    let label = {
        let mut session = lock(&state.session);
        let label = session.new_label(&live);
        session.add_window(&label);
        save_session(&session);
        label
    };
    if let Some(path) = request {
        lock(&state.requests).insert(label.clone(), path);
    }
    if let Err(e) = create_window(app, &label) {
        lock(&state.requests).remove(&label);
        let mut session = lock(&state.session);
        if session.window_closed(&label).1 {
            save_session(&session);
        }
        return Err(format!("无法打开新窗口：{e}"));
    }
    Ok(label)
}
/// Ctrl+Shift+N：新窗口，带一个空的“无标题”标签页。窗口必须在异步命令里创建：
/// 同步命令在主线程上运行，在 Windows 上创建窗口会死锁。
#[tauri::command]
async fn new_window(app: AppHandle) -> Result<()> {
    blocking(move || open_new_window(&app, None).map(drop)).await
}
/// The store of a tab; the tab map is locked only for the lookup.
fn lock_tab(app: &AppHandle, tab: &str) -> Result<Arc<Mutex<Store>>> {
    lock(&app.state::<AppState>().tabs)
        .get(tab)
        .cloned()
        .ok_or_else(|| "标签页已关闭".into())
}
/// Runs blocking work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}
/// Runs a storage action of one tab off the async runtime, one at a time per tab.
async fn with_tab<T: Send + 'static>(
    app: AppHandle,
    tab: String,
    action: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
) -> Result<T> {
    blocking(move || action(&mut lock(&*lock_tab(&app, &tab)?))).await
}
/// What tab `id` of session.json shows: a loaded tab as it is now; otherwise
/// it is loaded (see `Store::load`, `path` is its file) and kept. The caller
/// holds `tabs` throughout, so a working copy is never opened twice.
fn load_tab(
    tabs: &mut HashMap<String, Arc<Mutex<Store>>>,
    session: &Mutex<Session>,
    id: &str,
    path: Option<&Path>,
) -> Result<(Opened, Option<String>)> {
    if let Some(store) = tabs.get(id) {
        return Ok((lock(store).current()?, None));
    }
    let work = lock(session).work_file(id);
    let (store, opened, error) = Store::load(work, path)?;
    tabs.insert(id.to_owned(), Arc::new(Mutex::new(store)));
    Ok((opened, error))
}
/// An id for a new tab and its working copy.
fn new_tab_id(state: &AppState) -> (String, PathBuf) {
    let session = lock(&state.session);
    let id = session.new_id();
    let work = session.work_file(&id);
    (id, work)
}
/// Puts a new tab, loaded as `store`, into window `label` right of `after` (else
/// at the end) as its current tab. session.json is written first; when that
/// fails the tab and its working copy are dropped again.
fn add_tab(
    state: &AppState,
    label: &str,
    entry: TabEntry,
    after: Option<&str>,
    store: Store,
) -> Result<()> {
    let id = entry.id.clone();
    let mut session = lock(&state.session);
    session.add_tab(label, entry, after);
    session.set_active(label, &id);
    if let Err(e) = session.save() {
        session.remove_tab(&id);
        let work = session.work_file(&id);
        drop(session);
        drop(store);
        let _ = store::remove_if_exists(&work);
        return Err(e);
    }
    drop(session);
    lock(&state.tabs).insert(id, Arc::new(Mutex::new(store)));
    Ok(())
}
/// The tabs of the calling window and its current tab. The first call loads
/// them; a later one (the page was reloaded) returns what they hold now.
#[tauri::command]
async fn restore_window(window: WebviewWindow, app: AppHandle) -> Result<WindowOpened> {
    let label = window.label().to_owned();
    blocking(move || {
        let state = app.state::<AppState>();
        let (entries, active) = {
            let mut session = lock(&state.session);
            if session.window_tabs(&label).is_empty() {
                let id = session.new_id();
                session.add_tab(&label, TabEntry { id: id.clone(), path: None }, None);
                session.set_active(&label, &id);
                session.save()?;
            }
            let window = session.window(&label).ok_or("窗口不存在")?;
            (window.tabs.clone(), window.active.clone())
        };
        let mut loaded = Vec::new();
        {
            let mut tabs = lock(&state.tabs);
            for entry in &entries {
                let (opened, error) =
                    load_tab(&mut tabs, &state.session, &entry.id, entry.path.as_deref())?;
                loaded.push(TabOpened {
                    tab: entry.id.clone(),
                    opened,
                    error,
                });
            }
        }
        // A file that could not be reopened leaves an unnamed tab.
        let mut session = lock(&state.session);
        let mut changed = false;
        for (entry, tab) in entries.iter().zip(&loaded) {
            if entry.path != tab.opened.path {
                session.set_path(&entry.id, tab.opened.path.clone());
                changed = true;
            }
        }
        if changed {
            save_session(&session);
        }
        let active = active
            .filter(|id| entries.iter().any(|entry| entry.id == *id))
            .unwrap_or_else(|| entries[0].id.clone());
        Ok(WindowOpened {
            tabs: loaded,
            active,
        })
    })
    .await
}
/// A new unnamed tab at the end of the calling window, made current.
#[tauri::command]
async fn new_tab(window: WebviewWindow, app: AppHandle) -> Result<TabOpened> {
    let label = window.label().to_owned();
    blocking(move || {
        let state = app.state::<AppState>();
        let (id, work) = new_tab_id(&state);
        let store = Store::create(work)?;
        add_tab(&state, &label, TabEntry { id: id.clone(), path: None }, None, store)?;
        Ok(TabOpened {
            tab: id,
            opened: Opened::blank(),
            error: None,
        })
    })
    .await
}
/// Opens `path` (打开, or a file asked for from outside). A file already open in
/// some tab is not opened twice: its tab is named instead, and another window
/// holding it is brought to the front and told to switch to it. Otherwise the
/// file opens in `replace` (an unnamed, unchanged tab) or in a new tab right of
/// `after`, made current.
#[tauri::command]
async fn open_file(
    window: WebviewWindow,
    path: PathBuf,
    replace: Option<String>,
    after: Option<String>,
    app: AppHandle,
) -> Result<OpenOutcome> {
    let label = window.label().to_owned();
    blocking(move || {
        let state = app.state::<AppState>();
        let path = fs::canonicalize(&path).unwrap_or(path);
        let open = lock(&state.session).find_path(&path);
        if let Some((owner, tab)) = open {
            if !live_windows(&app).contains(&owner) {
                // 那个窗口没关标签页就被销毁了（休眠）：标签页连同未保存的修改搬过来。
                return adopt_tab(&state, &label, tab, &path, after.as_deref())
                    .map(OpenOutcome::Opened);
            }
            if owner != label {
                reveal(&app, &owner);
                let _ = app.emit_to(owner.as_str(), ACTIVATE_TAB, ActivateTab { tab: tab.clone() });
            }
            return Ok(OpenOutcome::Existing { window: owner, tab });
        }
        let opened = match replace {
            Some(id) => {
                let opened = lock(&*lock_tab(&app, &id)?).open(&path)?;
                // The tab already shows the file; a failed record only affects
                // recovery after a crash, so it is not reported as a failed open.
                let mut session = lock(&state.session);
                session.set_path(&id, opened.path.clone());
                save_session(&session);
                TabOpened {
                    tab: id,
                    opened,
                    error: None,
                }
            }
            None => {
                let (id, work) = new_tab_id(&state);
                let (store, opened) = Store::open_new(work, &path)?;
                let entry = TabEntry {
                    id: id.clone(),
                    path: opened.path.clone(),
                };
                add_tab(&state, &label, entry, after.as_deref(), store)?;
                TabOpened {
                    tab: id,
                    opened,
                    error: None,
                }
            }
        };
        Ok(OpenOutcome::Opened(opened))
    })
    .await
}
/// 把已销毁窗口留下的标签页 `tab`（属于 `path`）搬到窗口 `label` 的 `after` 右侧并
/// 载入：有暂存就接上暂存，否则重新打开文件。
fn adopt_tab(
    state: &AppState,
    label: &str,
    tab: String,
    path: &Path,
    after: Option<&str>,
) -> Result<TabOpened> {
    let (opened, error) = load_tab(&mut lock(&state.tabs), &state.session, &tab, Some(path))?;
    let mut session = lock(&state.session);
    session.move_tab(&tab, label, after);
    session.set_path(&tab, opened.path.clone());
    session.set_active(label, &tab);
    save_session(&session);
    Ok(TabOpened { tab, opened, error })
}
/// Records the calling window's current tab; a failed write is only logged.
#[tauri::command]
async fn activate_tab(window: WebviewWindow, tab: String, app: AppHandle) -> Result<()> {
    let label = window.label().to_owned();
    blocking(move || {
        let state = app.state::<AppState>();
        let mut session = lock(&state.session);
        if session.set_active(&label, &tab) {
            save_session(&session);
        }
        Ok(())
    })
    .await
}
/// Called after the user saved or chose to discard: drops the tab's unsaved
/// changes and the images its file no longer uses. Never fails because of that
/// cleanup; the text says what could not be cleaned.
#[tauri::command]
async fn close_tab(tab: String, app: AppHandle) -> Result<Option<String>> {
    blocking(move || {
        let state = app.state::<AppState>();
        let store = lock(&state.tabs).remove(&tab);
        let warning = match store {
            Some(store) => lock(&store).close(),
            None => None,
        };
        let mut session = lock(&state.session);
        if session.remove_tab(&tab).is_some() {
            save_session(&session);
        }
        Ok(warning)
    })
    .await
}
/// 调用的窗口是否是最后一个编辑窗口（导出 PDF 的隐藏窗口不算）。“启动时”为
/// “打开上一会话中的内容”时，关闭最后一个窗口（退出）不询问、保留全部标签页。
#[tauri::command]
fn is_last_window(window: WebviewWindow, app: AppHandle) -> bool {
    live_windows(&app)
        .iter()
        .all(|label| label == window.label())
}
/// The file waiting for the calling window, if any; each request is handed out once.
#[tauri::command]
fn take_open_request(window: WebviewWindow, app: AppHandle) -> Option<PathBuf> {
    let state = app.state::<AppState>();
    let request = lock(&state.requests).remove(window.label());
    request
}
#[tauri::command]
async fn stash_document(tab: String, document: Diary, app: AppHandle) -> Result<()> {
    with_tab(app, tab, move |store| store.stash(&document)).await
}
/// 丢掉标签页的暂存正文：“启动时”为“打开上一会话中的内容”时关闭最后一个窗口，
/// 内容与已保存的相同（例如改了又撤销回原样）的标签页下次启动不应带未保存标记。
#[tauri::command]
async fn discard_stash(tab: String, app: AppHandle) -> Result<()> {
    with_tab(app, tab, |store| store.discard_stash()).await
}
#[tauri::command]
async fn save_document(tab: String, document: Diary, app: AppHandle) -> Result<()> {
    with_tab(app, tab, move |store| store.save(&document)).await
}
/// session.json names the new file before it is written: a crash in between
/// then recovers the unsaved changes into the new file, or as an unnamed
/// document if it was never written.
#[tauri::command]
async fn save_as(tab: String, path: PathBuf, document: Diary, app: AppHandle) -> Result<Opened> {
    blocking(move || {
        let state = app.state::<AppState>();
        let store = lock_tab(&app, &tab)?;
        let target = Store::save_as_target(&path)?;
        let previous = lock(&store).path().map(Path::to_path_buf);
        {
            let mut session = lock(&state.session);
            session.set_path(&tab, Some(target.clone()));
            if let Err(e) = session.save() {
                session.set_path(&tab, previous);
                return Err(e);
            }
        }
        let result = lock(&store).save_as(&target, &document);
        if result.is_err() {
            let mut session = lock(&state.session);
            session.set_path(&tab, previous);
            save_session(&session);
        }
        result
    })
    .await
}
#[tauri::command]
async fn export_document(
    tab: String,
    path: PathBuf,
    content: String,
    images: Vec<ExportImage>,
    app: AppHandle,
) -> Result<()> {
    with_tab(app, tab, move |store| store.export(&path, &content, &images)).await
}
#[tauri::command]
async fn import_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Picture> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("图片数据无效".into());
    };
    let tab = request
        .headers()
        .get(TAB_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("图片数据缺少所属标签页")?
        .to_owned();
    images::check_file_size(bytes.len())?;
    let bytes = bytes.clone();
    blocking(move || {
        // Decoding happens outside the lock so stashing is never held up by it.
        let (picture, thumbnail) = images::prepare(&bytes)?;
        let store = lock_tab(&app, &tab)?;
        lock(&store).add_image(&picture.id, &bytes, Some(thumbnail))?;
        Ok(picture)
    })
    .await
}
#[tauri::command]
async fn read_image(tab: String, id: String, original: bool, app: AppHandle) -> Result<Response> {
    blocking(move || {
        let store = lock_tab(&app, &tab)?;
        if original {
            return lock(&store).image(&id).map(Response::new);
        }
        Store::thumbnail(&store, &id, images::thumbnail).map(Response::new)
    })
    .await
}
#[tauri::command]
async fn export_image(tab: String, id: String, path: PathBuf, app: AppHandle) -> Result<()> {
    with_tab(app, tab, move |store| store.export_image(&id, &path)).await
}
/// Puts the originals of `pictures` on the system clipboard (files, HTML and, for
/// one image, its pixels) and remembers them with their `rows` for pasting in
/// LineHush (`copied_images`). A copy is dropped when a newer one starts or
/// anything else is copied while it is being prepared.
#[tauri::command]
async fn copy_images(
    tab: String,
    pictures: Vec<Picture>,
    rows: Vec<bool>,
    app: AppHandle,
) -> Result<()> {
    let job = app.state::<ClipboardState>().latest.fetch_add(1, Ordering::SeqCst) + 1;
    let since = clipboard::sequence();
    blocking(move || {
        let state = app.state::<ClipboardState>();
        let store = lock_tab(&app, &tab)?;
        let single = pictures.len() == 1;
        let mut items = Vec::new();
        let mut pixels = None;
        for pic in pictures {
            let bytes = lock(&store).image(&pic.id)?;
            let path = clipboard::stage(&state.dir, &pic, &bytes)?;
            // An image that cannot be decoded still goes out as a file.
            if single {
                pixels = images::clipboard_pixels(&bytes).ok();
            }
            items.push((pic, path));
        }
        if state.latest.load(Ordering::SeqCst) != job {
            return Ok(());
        }
        let written = clipboard::write(
            &clipboard::Content {
                files: items.iter().map(|(_, path)| path.clone()).collect(),
                html: clipboard::html(&items),
                pixels,
            },
            since,
        )?;
        let pictures: Vec<Picture> = items.into_iter().map(|(pic, _)| pic).collect();
        let keep = pictures.iter().map(|pic| pic.id.clone()).collect();
        if let Some(sequence) = written {
            *lock(&state.last) = Some((sequence, Copied { pictures, rows }));
        }
        sweep_staged(&state.dir, &keep, STAGED_KEPT_AFTER_COPY);
        Ok(())
    })
    .await
}
/// The images of LineHush's last copy if the clipboard still holds exactly that
/// copy, made available to the document in `tab`; None otherwise (the files on
/// the clipboard are then imported like any others).
#[tauri::command]
async fn copied_images(tab: String, app: AppHandle) -> Result<Option<Copied>> {
    blocking(move || {
        let state = app.state::<ClipboardState>();
        let last = lock(&state.last).clone();
        let Some((_, copied)) = last.filter(|(seq, _)| *seq == clipboard::sequence()) else {
            return Ok(None);
        };
        let missing = state.adopt(&app, &tab, copied.pictures.iter().map(|pic| pic.id.clone()))?;
        if !missing.is_empty() {
            return Err(COPIED_IMAGES_GONE.into());
        }
        Ok(Some(copied))
    })
    .await
}
/// Makes copied images available to the document in `tab` before they are
/// pasted: images from another document (or an earlier session) are read back
/// from the files the copy left, or from another open tab, and stored in its
/// working copy under the same ids. Returns the ids of images found nowhere.
#[tauri::command]
async fn paste_images(tab: String, ids: Vec<String>, app: AppHandle) -> Result<Vec<String>> {
    blocking(move || app.state::<ClipboardState>().adopt(&app, &tab, ids)).await
}
/// Images copied with text lines: the browser writes that clipboard, and the
/// originals are only written to the copy folder (as `copy_images` does), for a
/// paste into another document. The clipboard and the last image copy are left
/// alone; an image copy still being prepared is dropped, as this copy is newer.
#[tauri::command]
async fn stage_images(tab: String, pictures: Vec<Picture>, app: AppHandle) -> Result<()> {
    app.state::<ClipboardState>().latest.fetch_add(1, Ordering::SeqCst);
    blocking(move || {
        let state = app.state::<ClipboardState>();
        let store = lock_tab(&app, &tab)?;
        stage_pictures(&state.dir, &store, &pictures)?;
        let keep = pictures.iter().map(|pic| pic.id.clone()).collect();
        sweep_staged(&state.dir, &keep, STAGED_KEPT_AFTER_COPY);
        Ok(())
    })
    .await
}

/// A window gained focus: remembered as the target for files opened from outside.
fn window_focused(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let mut session = lock(&state.session);
    if session.set_focused(label) {
        save_session(&session);
    }
}
/// A window is gone. Without tabs it leaves session.json; tabs still in it (the
/// window was destroyed without closing them, or it was the last window closed
/// with 启动时 = 打开上一会话中的内容) stay there with their working copies, so
/// they are restored on the next launch. Their
/// stores are only unloaded: no image cleanup, no working copy deleted. The last
/// editor window gone ends the process (a PDF export's hidden window does not
/// count; exiting closes it).
fn window_destroyed(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    lock(&state.requests).remove(label);
    let left = {
        let mut session = lock(&state.session);
        let (left, changed) = session.window_closed(label);
        if changed {
            save_session(&session);
        }
        left
    };
    {
        let mut tabs = lock(&state.tabs);
        for tab in left {
            tabs.remove(&tab.id);
        }
    }
    let others = live_windows(app).into_iter().any(|other| other != label);
    if !others && !state.exiting.swap(true, Ordering::SeqCst) {
        app.exit(0);
    }
}
/// 新窗口相对最近获得焦点的窗口向右下错开、大小相同（像记事本）；错开后超出
/// 那块屏幕的工作区就放到工作区左上角。那个窗口最大化或最小化时不错开，用默认
/// 位置和大小。
fn cascade_from(
    app: &AppHandle,
    label: &str,
) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let focused = lock(&app.try_state::<AppState>()?.session)
        .focused()?
        .to_owned();
    if focused == label {
        return None;
    }
    let source = app.get_webview_window(&focused)?;
    if source.is_maximized().unwrap_or(false) || source.is_minimized().unwrap_or(false) {
        return None;
    }
    let position = source.outer_position().ok()?;
    let outer = source.outer_size().ok()?;
    let offset = (CASCADE * source.scale_factor().unwrap_or(1.0)).round() as i32;
    let mut target = PhysicalPosition::new(position.x + offset, position.y + offset);
    if let Ok(Some(monitor)) = source.current_monitor() {
        let area = monitor.work_area();
        let right = area.position.x + area.size.width as i32;
        let bottom = area.position.y + area.size.height as i32;
        if target.x + outer.width as i32 > right || target.y + outer.height as i32 > bottom {
            target = area.position;
        }
    }
    Some((target, source.inner_size().ok()?))
}
/// Creates an editor window, hidden until the window-state plugin has put it
/// back where it was, then shows and focuses it.
fn create_window(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let state = app.try_state::<AppState>();
    // 窗口位置插件记过这个编号的位置就由它恢复，否则相对最近使用的窗口错开。
    let recorded = state
        .as_ref()
        .is_some_and(|state| !lock(&state.window_records).insert(label.to_owned()));
    let cascade = if recorded {
        None
    } else {
        cascade_from(app, label)
    };
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("LineHush")
        .inner_size(900.0, 680.0)
        .min_inner_size(600.0, 400.0)
        // 自绘标题栏（TitleBar.tsx），像 Win11 记事本：去掉系统标题栏，保留 DWM 阴影、
        // 圆角与边缘调整大小。
        .decorations(false)
        .shadow(true)
        .visible(false)
        // Dropped files are handled by the page (DiaryEditor), not by Tauri.
        .disable_drag_drop_handler()
        .build()?;
    // 最大化按钮的贴靠布局（Snap layouts），见 caption.rs。
    caption::attach(&window);
    let handle = app.clone();
    let name = label.to_owned();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(true) => window_focused(&handle, &name),
        WindowEvent::Destroyed => window_destroyed(&handle, &name),
        _ => {}
    });
    if let Some((position, size)) = cascade {
        if let Err(e) = window
            .set_size(size)
            .and_then(|()| window.set_position(position))
        {
            eprintln!("无法错开新窗口：{e}");
        }
    }
    if state.is_some_and(|state| state.remember_window) {
        if let Err(e) = window.restore_state(WINDOW_STATE) {
            eprintln!("无法恢复窗口位置和大小：{e}");
        }
    }
    // Shown even if restoring failed.
    if let Err(e) = window.show() {
        eprintln!("无法显示窗口：{e}");
    }
    let _ = window.set_focus();
    Ok(window)
}
/// 窗口位置记录 `{ "<label>": {width, height, x, y, …} }` 中有记录的窗口编号；
/// 文件缺失或读不懂时为空。
fn recorded_windows(file: &Path) -> HashSet<String> {
    fs::read(file)
        .ok()
        .and_then(|bytes| {
            serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&bytes).ok()
        })
        .map(|states| states.into_iter().map(|(label, _)| label).collect())
        .unwrap_or_default()
}

pub fn run() {
    // Lets automated desktop tests keep their data away from personal drafts.
    let test_data_dir = std::env::var_os("LINEHUSH_TEST_DATA_DIR").map(PathBuf::from);
    let mut context = tauri::generate_context!();
    if test_data_dir.is_some() {
        // The single-instance plugin and the WebView2 profile are keyed by the
        // identifier: tests must neither hand over to a LineHush the user has open
        // nor share its browser profile.
        context.config_mut().identifier.push_str(".test");
    }
    let launch = std::env::current_dir()
        .ok()
        .and_then(|cwd| hush_argument(std::env::args().skip(1), &cwd));
    let mut builder = tauri::Builder::default()
        // Must come first: a second launch forwards its arguments here and exits
        // before the other plugins or the window start.
        .plugin(tauri_plugin_single_instance::init(second_instance))
        .manage(pdf::PrintJob::default())
        .register_asynchronous_uri_scheme_protocol(pdf::SCHEME, pdf::protocol)
        .plugin(tauri_plugin_dialog::init());
    // Remembers size, position and maximized state across launches. Tests skip it so
    // they always start at the configured size and never touch the user's saved state.
    // Windows start hidden and `create_window` restores them before showing them,
    // so they never appear at the default place first. The plugin's own restore
    // on window creation is skipped: restoring twice would un-maximize a
    // maximized window (which shows it) and maximize it again.
    let remember_window = test_data_dir.is_none();
    if remember_window {
        let mut state = tauri_plugin_window_state::Builder::new().with_state_flags(WINDOW_STATE);
        for n in 1..=MAX_WINDOWS {
            state = state.skip_initial_state(&format!("{WINDOW_PREFIX}{n}"));
        }
        // 导出 PDF 的隐藏窗口不记忆、也不恢复位置。
        builder = builder.plugin(state.with_denylist(&[pdf::LABEL]).build());
    }
    builder
        .setup(move |app| {
            let test_data_dir_set = test_data_dir.is_some();
            let root = match test_data_dir {
                Some(dir) => dir,
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&root)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join("session.lock"))?;
            // Fallback for when the single-instance hand-over did not happen, e.g.
            // the other instance is still starting or shutting down.
            if lock.try_lock().is_err() {
                app.dialog()
                    .message("LineHush 已在运行。请切换到已打开的 LineHush 窗口；如果找不到它，请稍等片刻再试。")
                    .title("LineHush")
                    .kind(MessageDialogKind::Warning)
                    .blocking_show();
                app.handle().cleanup_before_exit();
                std::process::exit(0);
            }
            // Tests keep copied images out of the user's temporary folder.
            let clipboard_dir = if test_data_dir_set {
                root.join("clipboard")
            } else {
                std::env::temp_dir().join("linehush-clipboard")
            };
            let sweep = clipboard_dir.clone();
            std::thread::spawn(move || sweep_staged(&sweep, &HashSet::new(), STAGED_KEPT_AT_START));
            app.manage(ClipboardState {
                dir: clipboard_dir,
                latest: AtomicU64::new(0),
                last: Mutex::new(None),
            });
            let settings_file = settings::SettingsFile(root.join(settings::SETTINGS_FILE));
            let preferences = settings_file.preferences();
            app.manage(settings_file);
            let window_records = if remember_window {
                match app.path().app_config_dir() {
                    Ok(dir) => {
                        recorded_windows(&dir.join(tauri_plugin_window_state::DEFAULT_FILENAME))
                    }
                    Err(e) => {
                        eprintln!("找不到窗口位置记录：{e}");
                        HashSet::new()
                    }
                }
            } else {
                HashSet::new()
            };
            // “启动时”为“打开新窗口”（默认）时像记事本：一个新窗口、一个新的无标题
            // 标签页，只有程序意外退出时留下的未保存修改回到这个窗口；为“打开上一
            // 会话中的内容”时重开上次的全部窗口与标签页（见 Session::plan_launch）。
            let mut session = Session::load(root);
            let plan = session.plan_launch(preferences.startup, preferences.open_file, launch);
            save_session(&session);
            // A file passed on the command line opens once its window has loaded
            // its tabs, like 打开 (see tabs.ts).
            let requests: HashMap<String, PathBuf> = plan.request.into_iter().collect();
            app.manage(AppState {
                session: Mutex::new(session),
                tabs: Mutex::new(HashMap::new()),
                requests: Mutex::new(requests),
                remember_window,
                window_records: Mutex::new(window_records),
                exiting: AtomicBool::new(false),
                _lock: lock,
            });
            for label in &plan.windows {
                if let Err(e) = create_window(app.handle(), label) {
                    // 第一个窗口都建不出来就无法启动；其余的只记下。
                    if label == &plan.windows[0] {
                        return Err(e.into());
                    }
                    eprintln!("无法恢复窗口 {label}：{e}");
                }
            }
            reveal(app.handle(), &plan.focus);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restore_window,
            new_tab,
            open_file,
            activate_tab,
            close_tab,
            new_window,
            is_last_window,
            take_open_request,
            stash_document,
            discard_stash,
            save_document,
            save_as,
            export_document,
            import_image,
            read_image,
            export_image,
            copy_images,
            copied_images,
            paste_images,
            stage_images,
            pdf::export_pdf,
            caption::set_caption_buttons,
            caption::reveal_rect,
            caret::caret_metrics,
            settings::read_settings,
            settings::write_settings
        ])
        .run(context)
        .expect("无法启动 LineHush");
}

#[cfg(test)]
mod tests {
    use super::{adopt_images, hush_argument, stage_pictures, sweep_staged};
    use crate::{clipboard, images, store::Store};
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime};

    /// A small PNG that `images::prepare` accepts.
    fn png(shade: u8) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(3, 2, image::Rgb([shade, 0, 0]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn copied_images_are_staged_and_adopted_from_files_or_open_tabs() {
        let dir = std::env::temp_dir().join(format!("linehush-test-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let staging = dir.join("clipboard");
        let tab = |name: &str| Arc::new(Mutex::new(Store::create(dir.join(format!("{name}.hush"))).unwrap()));
        let (source, target, other) = (tab("source"), tab("target"), tab("other"));
        let import = |store: &Mutex<Store>, bytes: &[u8]| {
            let (pic, thumbnail) = images::prepare(bytes).unwrap();
            store.lock().unwrap().add_image(&pic.id, bytes, Some(thumbnail)).unwrap();
            pic
        };
        let (a, b) = (png(1), png(2));
        let staged = import(&source, &a);
        let open = import(&source, &b);
        // Staging writes the originals byte for byte, nothing else.
        stage_pictures(&staging, &source, std::slice::from_ref(&staged)).unwrap();
        assert_eq!(clipboard::staged(&staging, &staged.id), Some(a.clone()));
        assert_eq!(clipboard::staged(&staging, &open.id), None);
        assert!(stage_pictures(&staging, &target, std::slice::from_ref(&staged)).is_err());
        // A staged image comes from its file, another one from the open tab
        // holding it, an unknown one is reported (once).
        let unknown = "0".repeat(64);
        let missing = adopt_images(
            &staging,
            &target,
            &[other.clone(), source.clone()],
            [staged.id.clone(), open.id.clone(), unknown.clone(), unknown.clone()],
        )
        .unwrap();
        assert_eq!(missing, vec![unknown.clone()]);
        let held = target.lock().unwrap();
        assert_eq!(held.image(&staged.id).unwrap(), a);
        assert_eq!(held.image(&open.id).unwrap(), b);
        drop(held);
        // Without the source tab only the staged image is still found.
        let late = tab("late");
        let missing = adopt_images(&staging, &late, &[other], [staged.id.clone(), open.id.clone()]).unwrap();
        assert_eq!(missing, vec![open.id.clone()]);
        assert!(late.lock().unwrap().has_image(&staged.id).unwrap());
        drop((source, target, late));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweeping_the_copy_folder_keeps_recent_files_and_those_of_the_current_copy() {
        let dir = std::env::temp_dir().join(format!("linehush-test-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let kept_id = "c".repeat(64);
        let file = |name: &str, age: u64| {
            let path = dir.join(name);
            std::fs::write(&path, b"x").unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(SystemTime::now() - Duration::from_secs(age))
                .unwrap();
            path
        };
        let recent = file("aaaaaaaaaaaa-新.png", 0);
        let old = file("bbbbbbbbbbbb-旧.png", 7200);
        let kept = file("cccccccccccc-旧但仍在复制中.png", 7200);
        let kept_full = file(&format!("{kept_id}.png"), 7200);
        std::fs::create_dir(dir.join("子文件夹")).unwrap();
        let keep: HashSet<String> = [kept_id].into();
        sweep_staged(&dir, &keep, Duration::from_secs(3600));
        assert!(recent.exists() && kept.exists() && kept_full.exists());
        assert!(!old.exists());
        assert!(dir.join("子文件夹").exists());
        // A folder that does not exist is no error.
        sweep_staged(&dir.join("缺失"), &HashSet::new(), Duration::ZERO);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hush_argument_picks_the_first_hush_file_relative_to_cwd() {
        let cwd = std::env::temp_dir().join(format!("linehush-args-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(cwd.join("日记.HUSH"), b"").unwrap();
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // Quoted, relative and differently cased: resolved to the canonical file.
        assert_eq!(
            hush_argument(args(&["--flag", "\"日记.HUSH\"", "其他.hush"]), &cwd),
            Some(std::fs::canonicalize(cwd.join("日记.HUSH")).unwrap())
        );
        // A missing file stays absolute but uncanonicalized, so opening it reports why.
        assert_eq!(
            hush_argument(args(&["缺失.hush"]), &cwd),
            Some(cwd.join("缺失.hush"))
        );
        // A file named just ".hush" has no `extension()`, but is still a .hush file.
        assert_eq!(
            hush_argument(args(&[".hush"]), &cwd),
            Some(cwd.join(".hush"))
        );
        let absolute = PathBuf::from(r"Z:\不存在\a.hush");
        assert_eq!(
            hush_argument(args(&[r"Z:\不存在\a.hush"]), Path::new(r"C:\")),
            Some(absolute)
        );
        assert_eq!(hush_argument(args(&["a.txt", "hush"]), &cwd), None);
        assert_eq!(hush_argument(Vec::new(), &cwd), None);
    }
}
