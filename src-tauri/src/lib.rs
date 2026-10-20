mod clipboard;
mod db;
mod errors;
mod fsx;
mod images;
mod model;
mod pdf;
mod settings;
mod store;
#[cfg(test)]
mod store_tests;

use model::{Diary, ExportImage, Picture, Result};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
    time::Duration,
};
use store::{Opened, Store};
use tauri::{ipc::Response, AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// Tells the frontend that `OpenRequest` holds a file to open.
const OPEN_REQUESTED: &str = "open-requested";
/// What the window-state plugin remembers. Not VISIBLE: `setup` shows the window
/// itself once the rest is restored.
const WINDOW_STATE: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

struct AppState {
    store: Mutex<Store>,
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
    last: Mutex<Option<(u32, Vec<Picture>)>>,
}
impl ClipboardState {
    /// Makes sure this document holds each image: an image from another document
    /// (or an earlier session) is read back from the file its copy left.
    fn adopt(&self, app: &AppHandle, ids: impl IntoIterator<Item = String>) -> Result<()> {
        for id in ids {
            if lock_store(app)?.has_image(&id)? {
                continue;
            }
            let bytes =
                clipboard::staged(&self.dir, &id).ok_or("剪贴板中的图片已不可用，请重新复制")?;
            lock_store(app)?.adopt_image(&id, &bytes)?;
        }
        Ok(())
    }
}
/// A `.hush` file the user asked for (double-click, command line, or a second
/// launch) that the frontend has not opened yet. A newer request replaces it.
struct OpenRequest(Mutex<Option<PathBuf>>);
impl OpenRequest {
    fn take(&self) -> Option<PathBuf> {
        self.0.lock().ok()?.take()
    }
    fn set(&self, path: PathBuf) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(path);
        }
    }
    /// Hands `path` back for the frontend, unless a newer request arrived meanwhile.
    fn defer(&self, path: PathBuf) {
        if let Ok(mut slot) = self.0.lock() {
            slot.get_or_insert(path);
        }
    }
}
/// The first `.hush` argument, made absolute against `cwd` and canonical when it
/// exists (so it compares equal to the open file). A missing file is kept as is,
/// so opening it reports the error.
fn hush_argument(args: impl IntoIterator<Item = String>, cwd: &Path) -> Option<PathBuf> {
    let path = args
        .into_iter()
        .map(|arg| PathBuf::from(arg.trim().trim_matches('"')))
        .find(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case(store::EXTENSION))
        })?;
    let path = cwd.join(path);
    Some(fs::canonicalize(&path).unwrap_or(path))
}
/// Brings the main window to the front, restoring it if minimized.
fn reveal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
/// A second launch handed its arguments over and quit. Runs on the main thread.
fn second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    reveal(app);
    // args[0] is the second instance's executable.
    let Some(path) = hush_argument(args.into_iter().skip(1), Path::new(&cwd)) else {
        return;
    };
    let open = app
        .try_state::<AppState>()
        .and_then(|state| Some(state.store.lock().ok()?.path()?.to_path_buf()));
    if open.as_deref() == Some(path.as_path()) {
        return;
    }
    app.state::<OpenRequest>().set(path);
    let _ = app.emit(OPEN_REQUESTED, ());
}
fn lock_store(app: &AppHandle) -> Result<MutexGuard<'_, Store>> {
    app.state::<AppState>()
        .inner()
        .store
        .lock()
        .map_err(|e| e.to_string())
}
/// Runs blocking work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}
/// Runs a storage action off the async runtime, one at a time.
async fn with_store<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
) -> Result<T> {
    blocking(move || action(&mut *lock_store(&app)?)).await
}
/// Starts a new document, or restores the unsaved changes a crash left behind.
/// A file passed on the command line replaces the new document; unsaved changes
/// are restored first and the file is left in `OpenRequest`, so the frontend asks
/// about them before opening it.
#[tauri::command]
async fn restore(app: AppHandle) -> Result<Opened> {
    let launch = app.state::<OpenRequest>().take();
    let handle = app.clone();
    with_store(app, move |store| {
        let restored = store.restore();
        let Some(path) = launch else {
            return restored;
        };
        let requests = handle.state::<OpenRequest>();
        match &restored {
            Ok(opened) if opened.path.as_deref() == Some(path.as_path()) => {}
            Ok(opened) if !opened.recovered => match store.open(&path) {
                Ok(opened) => return Ok(opened),
                // The frontend opens it again and shows why it failed.
                Err(_) => requests.defer(path),
            },
            _ => requests.defer(path),
        }
        restored
    })
    .await
}
/// The file waiting to be opened, if any; each request is handed out once.
#[tauri::command]
fn take_open_request(app: AppHandle) -> Option<PathBuf> {
    app.state::<OpenRequest>().take()
}
#[tauri::command]
async fn new_document(app: AppHandle) -> Result<Opened> {
    with_store(app, |store| store.new_document()).await
}
#[tauri::command]
async fn open_document(path: PathBuf, app: AppHandle) -> Result<Opened> {
    with_store(app, move |store| store.open(&path)).await
}
#[tauri::command]
async fn stash_document(document: Diary, app: AppHandle) -> Result<()> {
    with_store(app, move |store| store.stash(&document)).await
}
#[tauri::command]
async fn save_document(document: Diary, app: AppHandle) -> Result<()> {
    with_store(app, move |store| store.save(&document)).await
}
#[tauri::command]
async fn save_as(path: PathBuf, document: Diary, app: AppHandle) -> Result<Opened> {
    with_store(app, move |store| store.save_as(&path, &document)).await
}
#[tauri::command]
async fn export_document(
    path: PathBuf,
    content: String,
    images: Vec<ExportImage>,
    app: AppHandle,
) -> Result<()> {
    with_store(app, move |store| store.export(&path, &content, &images)).await
}
#[tauri::command]
async fn import_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Picture> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("图片数据无效".into());
    };
    images::check_file_size(bytes.len())?;
    let bytes = bytes.clone();
    blocking(move || {
        // Decoding happens outside the lock so stashing is never held up by it.
        let (picture, thumbnail) = images::prepare(&bytes)?;
        lock_store(&app)?.add_image(&picture.id, &bytes, thumbnail)?;
        Ok(picture)
    })
    .await
}
#[tauri::command]
async fn read_image(app: AppHandle, id: String, original: bool) -> Result<Response> {
    blocking(move || {
        if original {
            return lock_store(&app)?.image(&id).map(Response::new);
        }
        let store = &app.state::<AppState>().inner().store;
        Store::thumbnail(store, &id, images::thumbnail).map(Response::new)
    })
    .await
}
#[tauri::command]
async fn export_image(id: String, path: PathBuf, app: AppHandle) -> Result<()> {
    with_store(app, move |store| store.export_image(&id, &path)).await
}
/// Puts the originals of `pictures` on the system clipboard (files, HTML and, for
/// one image, its pixels). With `after_browser` (a copy event the browser also
/// answers) the browser's own clipboard write is let through first, so this one
/// replaces it. A copy is dropped when a newer one starts or anything else is
/// copied while it is being prepared.
#[tauri::command]
async fn copy_images(pictures: Vec<Picture>, after_browser: bool, app: AppHandle) -> Result<()> {
    let job = app.state::<ClipboardState>().latest.fetch_add(1, Ordering::SeqCst) + 1;
    blocking(move || {
        if after_browser {
            clipboard::wait_for_change(clipboard::sequence(), Duration::from_millis(500));
        }
        let since = clipboard::sequence();
        let state = app.state::<ClipboardState>();
        let single = pictures.len() == 1;
        let mut items = Vec::new();
        let mut pixels = None;
        for pic in pictures {
            let bytes = lock_store(&app)?.image(&pic.id)?;
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
        if let (Some(sequence), Ok(mut last)) = (written, state.last.lock()) {
            *last = Some((sequence, items.into_iter().map(|(pic, _)| pic).collect()));
        }
        Ok(())
    })
    .await
}
/// The images of LineHush's last copy if the clipboard still holds exactly that
/// copy, made available to this document; None otherwise (the files on the
/// clipboard are then imported like any others).
#[tauri::command]
async fn copied_images(app: AppHandle) -> Result<Option<Vec<Picture>>> {
    blocking(move || {
        let state = app.state::<ClipboardState>();
        let last = state.last.lock().map_err(|e| e.to_string())?.clone();
        let Some((_, pictures)) = last.filter(|(seq, _)| *seq == clipboard::sequence()) else {
            return Ok(None);
        };
        state.adopt(&app, pictures.iter().map(|pic| pic.id.clone()))?;
        Ok(Some(pictures))
    })
    .await
}
/// Makes copied images available to this document before they are pasted:
/// images from another document (or an earlier session) are read back from the
/// files the copy left and stored in the working copy, under the same ids.
#[tauri::command]
async fn paste_images(ids: Vec<String>, app: AppHandle) -> Result<()> {
    blocking(move || app.state::<ClipboardState>().adopt(&app, ids)).await
}
/// Never fails because of cleanup; the text says what could not be cleaned.
#[tauri::command]
async fn close_document(app: AppHandle) -> Result<Option<String>> {
    with_store(app, |store| Ok(store.close())).await
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
    let mut builder = tauri::Builder::default();
    // Must come first: a second launch forwards its arguments here and exits
    // before the other plugins or the window start.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(second_instance));
    }
    builder = builder
        .manage(OpenRequest(Mutex::new(launch)))
        .manage(pdf::PrintJob::default())
        .register_asynchronous_uri_scheme_protocol(pdf::SCHEME, pdf::protocol)
        .plugin(tauri_plugin_dialog::init());
    // Remembers size, position and maximized state across launches. Tests skip it so
    // they always start at the configured size and never touch the user's saved state.
    // The window starts hidden (tauri.conf.json) and `setup` restores it before
    // showing it, so it never appears at the default place first. The plugin's own
    // restore on window creation is skipped: restoring twice would un-maximize a
    // maximized window (which shows it) and maximize it again.
    let remember_window = test_data_dir.is_none();
    if remember_window {
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE)
                .skip_initial_state("main")
                // 导出 PDF 的隐藏窗口不记忆、也不恢复位置。
                .with_denylist(&[pdf::LABEL])
                .build(),
        );
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
            app.manage(ClipboardState {
                dir: if test_data_dir_set {
                    root.join("clipboard")
                } else {
                    std::env::temp_dir().join("linehush-clipboard")
                },
                latest: AtomicU64::new(0),
                last: Mutex::new(None),
            });
            app.manage(settings::SettingsFile(root.join(settings::SETTINGS_FILE)));
            let store = Store::new(root).map_err(std::io::Error::other)?;
            app.manage(AppState {
                store: Mutex::new(store),
                _lock: lock,
            });
            if let Some(window) = app.get_webview_window("main") {
                if remember_window {
                    if let Err(e) = window.restore_state(WINDOW_STATE) {
                        eprintln!("无法恢复窗口位置和大小：{e}");
                    }
                }
                // Shown even if restoring failed.
                if let Err(e) = window.show() {
                    eprintln!("无法显示窗口：{e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restore,
            take_open_request,
            new_document,
            open_document,
            stash_document,
            save_document,
            save_as,
            export_document,
            import_image,
            read_image,
            export_image,
            copy_images,
            copied_images,
            paste_images,
            close_document,
            pdf::export_pdf,
            settings::read_settings,
            settings::write_settings
        ])
        .run(context)
        .expect("无法启动 LineHush");
}

#[cfg(test)]
mod tests {
    use super::hush_argument;
    use std::path::{Path, PathBuf};

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
        let absolute = PathBuf::from(r"Z:\不存在\a.hush");
        assert_eq!(
            hush_argument(args(&[r"Z:\不存在\a.hush"]), Path::new(r"C:\")),
            Some(absolute)
        );
        assert_eq!(hush_argument(args(&["a.txt", "hush"]), &cwd), None);
        assert_eq!(hush_argument(Vec::new(), &cwd), None);
    }
}
