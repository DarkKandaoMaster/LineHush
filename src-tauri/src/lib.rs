mod images;
mod storage;
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    sync::Mutex,
};
use storage::{Diary, Opened, Store};
use tauri::Manager;
struct AppState {
    store: Mutex<Store>,
    _lock: File,
}
async fn with_store<T: Send + 'static>(
    app: tauri::AppHandle,
    action: impl FnOnce(&mut Store) -> storage::Result<T> + Send + 'static,
) -> storage::Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut store = state.store.lock().map_err(|e| e.to_string())?;
        action(&mut store)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn restore(app: tauri::AppHandle) -> storage::Result<Opened> {
    with_store(app, |store| store.restore()).await
}
#[tauri::command]
async fn new_document(app: tauri::AppHandle) -> storage::Result<Opened> {
    with_store(app, |store| store.new_document()).await
}
#[tauri::command]
async fn open_document(path: PathBuf, app: tauri::AppHandle) -> storage::Result<Opened> {
    with_store(app, move |store| store.open(&path)).await
}
#[tauri::command]
async fn save_document(document: Diary, app: tauri::AppHandle) -> storage::Result<()> {
    with_store(app, move |store| store.save(&document)).await
}
#[tauri::command]
async fn save_as(path: PathBuf, document: Diary, app: tauri::AppHandle) -> storage::Result<Opened> {
    with_store(app, move |store| store.save_as(&path, &document)).await
}
#[tauri::command]
async fn export_document(
    path: PathBuf,
    content: String,
    html: bool,
    document: Diary,
    app: tauri::AppHandle,
) -> storage::Result<()> {
    with_store(app, move |store| {
        store.export(&path, &content, html, &document)
    })
    .await
}
#[tauri::command]
async fn import_image(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> storage::Result<storage::Picture> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("图片数据无效".into());
    };
    let bytes = bytes.clone();
    with_store(app, move |store| images::import(store, &bytes)).await
}
#[tauri::command]
async fn read_image(
    app: tauri::AppHandle,
    path: String,
    original: bool,
) -> storage::Result<tauri::ipc::Response> {
    with_store(app, move |store| {
        images::read(store, &path, original).map(tauri::ipc::Response::new)
    })
    .await
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Lets automated desktop tests keep their data away from personal drafts.
            let root = match std::env::var_os("LINEHUSH_TEST_DATA_DIR") {
                Some(dir) => PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&root)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join("session.lock"))?;
            lock.try_lock()
                .map_err(|_| std::io::Error::other("LineHush 已在运行，请使用已打开的窗口"))?;
            let store = Store::new(root).map_err(std::io::Error::other)?;
            app.manage(AppState {
                store: Mutex::new(store),
                _lock: lock,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restore,
            new_document,
            open_document,
            save_document,
            save_as,
            export_document,
            import_image,
            read_image
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 LineHush");
}
