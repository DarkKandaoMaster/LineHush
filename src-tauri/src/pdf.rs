//! 导出 PDF：在隐藏窗口里加载前端生成的打印页（`toPrintHtml`），用 WebView2 自带的
//! `ICoreWebView2_7::PrintToPdf` 写到用户选的路径。打印页与其中的原图都由自定义协议
//! `linehush-print` 提供（Windows 上实际 URL 为 `http://linehush-print.localhost/...`）。
use crate::{errors::describe, fsx::shown, lock_store, model::Result};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};
use tauri::{
    http::{header, Request, Response, StatusCode},
    webview::PageLoadEvent,
    AppHandle, Manager, UriSchemeContext, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder,
    WindowEvent, Wry,
};

/// 自定义协议名，lib.rs 注册。
pub const SCHEME: &str = "linehush-print";
/// 隐藏打印窗口的标签；window-state 插件把它列入 denylist。
pub const LABEL: &str = "print";
const PAGE: &str = "http://linehush-print.localhost/doc.html";
/// 加载与打印的总时限，防止页面始终加载不完时命令永不返回。
const TIMEOUT: Duration = Duration::from_secs(120);
/// A4 纸（英寸）与四边 15 mm 页边距，与打印页的 `@page{size:A4;margin:15mm}` 一致。
const PAGE_WIDTH: f64 = 8.27;
const PAGE_HEIGHT: f64 = 11.69;
const MARGIN: f64 = 0.59;

/// 正在导出的打印页 HTML；Some 表示有一次导出尚未结束。
#[derive(Default)]
pub struct PrintJob(Mutex<Option<String>>);

/// `linehush-print` 协议：只回答打印窗口的请求。`/doc.html` 为待打印页面，
/// `/image/<id>` 为当前文档的原图，其他路径 404。
pub fn protocol(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if ctx.webview_label() != LABEL {
        return responder.respond(status(StatusCode::FORBIDDEN));
    }
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_owned();
    // 读原图要拿 Store 的锁，不放在 UI 线程上做。
    tauri::async_runtime::spawn_blocking(move || responder.respond(serve(&app, &path)));
}
fn serve(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    if path == "/doc.html" {
        let html = app
            .state::<PrintJob>()
            .0
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        return match html {
            Some(html) => Response::builder()
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                // 每次导出的页面都不同，不能用缓存。
                .header(header::CACHE_CONTROL, "no-store")
                .body(html.into_bytes())
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
            None => status(StatusCode::NOT_FOUND),
        };
    }
    let Some(id) = path.strip_prefix("/image/") else {
        return status(StatusCode::NOT_FOUND);
    };
    let bytes = match lock_store(app).and_then(|store| store.image(id)) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("导出 PDF 时无法读取图片 {id}：{e}");
            return status(StatusCode::NOT_FOUND);
        }
    };
    let mime = image::guess_format(&bytes)
        .map(|format| format.to_mime_type())
        .unwrap_or("application/octet-stream");
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .body(bytes)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}
fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

/// 把打印页 `html` 导出为 `path` 处的 PDF。无论成败，结束时都关闭隐藏窗口、清空页面。
#[tauri::command]
pub async fn export_pdf(path: PathBuf, html: String, app: AppHandle) -> Result<()> {
    {
        let job = app.state::<PrintJob>();
        let mut slot = job.0.lock().map_err(|e| e.to_string())?;
        if slot.is_some() || app.get_webview_window(LABEL).is_some() {
            return Err("上一次导出尚未完成".into());
        }
        *slot = Some(html);
    }
    let (closed_tx, closed_rx) = mpsc::channel();
    let result = print(&app, &path, closed_tx).await;
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.destroy().is_ok() {
            // 等窗口真正销毁，下一次导出才能再用同一个标签。
            let _ =
                crate::blocking(move || Ok(closed_rx.recv_timeout(Duration::from_secs(5)))).await;
        }
    }
    if let Ok(mut slot) = app.state::<PrintJob>().0.lock() {
        *slot = None;
    }
    result
}
async fn print(app: &AppHandle, path: &Path, closed: mpsc::Sender<()>) -> Result<()> {
    check_target(path)?;
    let (done, outcome) = mpsc::channel::<Result<()>>();
    let started = AtomicBool::new(false);
    let target = path.to_path_buf();
    let on_load = done.clone();
    let url = PAGE.parse().map_err(|e| format!("打印页地址无效：{e}"))?;
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::CustomProtocol(url))
        .title("LineHush 导出 PDF")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(800.0, 1000.0)
        // WebView2 的 NavigationCompleted 在 load 事件之后才触发，此时图片已加载。
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished || started.swap(true, Ordering::SeqCst) {
                return;
            }
            let done = on_load.clone();
            let failed = on_load.clone();
            let target = target.clone();
            // 闭包在主线程运行，PrintToPdf 必须在 UI 线程调用；结果经回调送回，不在这里等待。
            if let Err(e) = window.with_webview(move |webview| start(webview, &target, done)) {
                let _ = failed.send(Err(format!("无法导出 PDF：{e}")));
            }
        })
        .build()
        .map_err(|e| format!("无法创建导出窗口：{e}"))?;
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = closed.send(());
        }
    });
    drop(done);
    crate::blocking(move || match outcome.recv_timeout(TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err("导出 PDF 超时".into()),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("导出窗口意外关闭".into()),
    })
    .await
}
/// 打印前先确认目标可写，以便给出具体原因（WebView2 失败时只报告“未成功”）。
fn check_target(path: &Path) -> Result<()> {
    let fail = |e: std::io::Error| format!("无法写入 {}：{}", shown(path), describe(e));
    if path.exists() {
        OpenOptions::new().write(true).open(path).map_err(fail)?;
    } else {
        let parent = path.parent().ok_or("导出路径无效")?;
        fs::metadata(parent).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("无法写入 {}：所在文件夹不存在", shown(path)),
            _ => fail(e),
        })?;
    }
    Ok(())
}

#[cfg(windows)]
fn start(webview: tauri::webview::PlatformWebview, path: &Path, done: mpsc::Sender<Result<()>>) {
    let failed = done.clone();
    // SAFETY：只在 WebView2 所在的 UI 线程调用，接口均来自同一个活着的 WebView。
    if let Err(e) = unsafe { print_to_pdf(&webview, path, done) } {
        let _ = failed.send(Err(format!("无法导出 PDF：{}", hresult(&e))));
    }
}
#[cfg(not(windows))]
fn start(_: tauri::webview::PlatformWebview, _: &Path, done: mpsc::Sender<Result<()>>) {
    let _ = done.send(Err("导出 PDF 仅支持 Windows".into()));
}
#[cfg(windows)]
unsafe fn print_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    path: &Path,
    done: mpsc::Sender<Result<()>>,
) -> windows::core::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
        },
        PrintToPdfCompletedHandler,
    };
    use windows::core::{Interface, HSTRING, PCWSTR};

    let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
    let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
    let settings = environment.CreatePrintSettings()?;
    settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
    settings.SetPageWidth(PAGE_WIDTH)?;
    settings.SetPageHeight(PAGE_HEIGHT)?;
    settings.SetMarginTop(MARGIN)?;
    settings.SetMarginBottom(MARGIN)?;
    settings.SetMarginLeft(MARGIN)?;
    settings.SetMarginRight(MARGIN)?;
    settings.SetShouldPrintBackgrounds(false)?;
    settings.SetShouldPrintHeaderAndFooter(false)?;
    let shown_path = shown(path);
    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, successful| {
        let _ = done.send(match result {
            Err(e) => Err(format!("无法写入 {shown_path}：{}", hresult(&e))),
            Ok(()) if !successful => Err(format!(
                "无法写入 {shown_path}：文件可能正被其他程序占用，或没有写入权限"
            )),
            Ok(()) => Ok(()),
        });
        Ok(())
    }));
    let file = HSTRING::from(path.as_os_str());
    core.PrintToPdf(PCWSTR(file.as_ptr()), &settings, &handler)
}
/// Win32 错误码（0x8007xxxx）按 errors.rs 译成中文，其他 HRESULT 原样显示。
#[cfg(windows)]
fn hresult(e: &windows::core::Error) -> String {
    let code = e.code().0 as u32;
    if code & 0xFFFF_0000 == 0x8007_0000 {
        describe(std::io::Error::from_raw_os_error((code & 0xFFFF) as i32))
    } else {
        e.to_string()
    }
}
