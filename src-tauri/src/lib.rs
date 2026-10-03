mod db;
mod fsx;
mod images;
mod model;
mod store;
#[cfg(test)]
mod store_tests;

use model::{Diary, ExportImage, Picture, Result};
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use store::{Opened, Store};
use tauri::{ipc::Response, AppHandle, Manager};

struct AppState {
    store: Mutex<Store>,
    _lock: File,
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
#[tauri::command]
async fn restore(app: AppHandle) -> Result<Opened> {
    with_store(app, |store| store.restore()).await
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
#[tauri::command]
async fn close_document(app: AppHandle) -> Result<()> {
    with_store(app, |store| store.close()).await
}

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
            stash_document,
            save_document,
            save_as,
            export_document,
            import_image,
            read_image,
            export_image,
            close_document
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 LineHush");
}
