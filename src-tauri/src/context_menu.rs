//! 编辑区与标签页的右键菜单（照 Win11 记事本）由前端自己画（components/ContextMenu.tsx），
//! 这里接管 WebView2 的 `ContextMenuRequested`，不让它弹出自带的菜单。
//!
//! 网页脚本粘贴不了（`execCommand("paste")` 无效，`navigator.clipboard` 读不到文件与
//! 自定义格式），所以照微软文档里自定义上下文菜单的做法：事件来时取一个 deferral 挂起，
//! 记下 WebView2 自带菜单里各项的命令编号，向该窗口发 `context-menu-requested`
//! （`{ id, canPaste }`：请求编号、自带“粘贴”项是否可用）；前端画好菜单，用户选“粘贴”时调
//! `context_menu_command(id, "paste")`，这里 `SetSelectedCommandId` 后完成 deferral，由
//! WebView2 照它自己的粘贴执行（浏览器的 paste 事件，与 Ctrl+V 相同）。选别的项或关掉
//! 菜单时 `context_menu_dismiss`：不选命令、不弹菜单地完成。输入框里右键时前端调
//! `context_menu_native`：照常弹出自带菜单（输入框要用它剪切、复制、粘贴）。
//!
//! 前端只在需要菜单的地方让 `contextmenu` 事件通过（其余地方 `preventDefault`，
//! WebView2 不会再发这个事件），见 hooks/useContextMenu.ts。COM 对象只在 UI 线程里用，
//! 挂起的请求放在 UI 线程的线程局部变量里，命令经 `run_on_main_thread` 处理。
use crate::model::Result;
use serde::Serialize;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};
use tauri::{Emitter, WebviewWindow};
use webview2_com::{
    take_pwstr, ContextMenuRequestedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Deferral, ICoreWebView2_11,
    },
};
use windows::core::{Interface, BOOL, PWSTR};

/// 向一个窗口报告一次右键菜单请求（`Requested`）。
pub const CONTEXT_MENU_REQUESTED: &str = "context-menu-requested";

/// `context-menu-requested` 的载荷。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Requested {
    /// 这次请求的编号，完成时由前端带回（旧请求的回应不会了结新请求）。
    id: u64,
    /// WebView2 自带菜单里的“粘贴”可用（剪贴板里有能粘贴的内容）。
    can_paste: bool,
}

/// 一次挂起的请求：事件参数、它的 deferral 与自带菜单里各项名称对应的命令编号。
struct Pending {
    id: u64,
    args: ICoreWebView2ContextMenuRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
    commands: HashMap<String, i32>,
}

/// 怎样完成一次请求。
enum Finish {
    /// 执行自带菜单里名为这个的命令（如 "paste"）。
    Command(String),
    /// 不执行命令，也不弹菜单。
    Dismiss,
    /// 弹出 WebView2 自带的菜单。
    Native,
}

thread_local! {
    /// 窗口标签 → 挂起的请求（只在 UI 线程里读写）。
    static PENDING: RefCell<HashMap<String, Pending>> = RefCell::new(HashMap::new());
    /// 上一次请求的编号。
    static LAST_ID: Cell<u64> = const { Cell::new(0) };
}

/// 在窗口的 WebView2 上注册 `ContextMenuRequested`（窗口创建后调用一次）。
pub fn attach(window: &WebviewWindow) {
    let target = window.clone();
    let result = window.with_webview(move |webview| {
        // SAFETY：with_webview 的闭包在 UI 线程运行，接口来自这个活着的 WebView。
        if let Err(e) = unsafe { register(&webview, target) } {
            eprintln!("无法接管右键菜单：{e}");
        }
    });
    if let Err(e) = result {
        eprintln!("无法接管右键菜单：{e}");
    }
}

unsafe fn register(
    webview: &tauri::webview::PlatformWebview,
    window: WebviewWindow,
) -> windows::core::Result<()> {
    let core: ICoreWebView2_11 = webview.controller().CoreWebView2()?.cast()?;
    let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        requested(&window, args)
    }));
    let mut token = 0;
    core.add_ContextMenuRequested(&handler, &mut token)
}

/// 挂起这次请求，把是否能粘贴报给前端，由前端决定怎样完成。
fn requested(
    window: &WebviewWindow,
    args: ICoreWebView2ContextMenuRequestedEventArgs,
) -> windows::core::Result<()> {
    // SAFETY：事件处理在 UI 线程里，args 在完成前一直有效。
    let deferral = unsafe { args.GetDeferral()? };
    // 读不出自带菜单的项时照样弹出页面的菜单，只是不能粘贴。
    let (commands, can_paste) = unsafe { menu_items(&args) }.unwrap_or_else(|e| {
        eprintln!("无法读取右键菜单项：{e}");
        (HashMap::new(), false)
    });
    let label = window.label().to_owned();
    let id = LAST_ID.with(|last| {
        last.set(last.get() + 1);
        last.get()
    });
    let pending = Pending {
        id,
        args,
        deferral,
        commands,
    };
    // 上一次还没完成（前端没回应）就来了新的：先把旧的了结。
    if let Some(old) = PENDING.with(|all| all.borrow_mut().insert(label.clone(), pending)) {
        complete(old, Finish::Dismiss);
    }
    if let Err(e) = window.emit_to(
        label.as_str(),
        CONTEXT_MENU_REQUESTED,
        Requested { id, can_paste },
    ) {
        eprintln!("无法通知右键菜单：{e}");
        finish(&label, id, Finish::Dismiss);
    }
    Ok(())
}

/// WebView2 自带菜单里各项名称对应的命令编号，与其中的“粘贴”是否可用。
unsafe fn menu_items(
    args: &ICoreWebView2ContextMenuRequestedEventArgs,
) -> windows::core::Result<(HashMap<String, i32>, bool)> {
    let mut commands = HashMap::new();
    let mut can_paste = false;
    let items = args.MenuItems()?;
    let mut count = 0;
    items.Count(&mut count)?;
    for i in 0..count {
        let item = items.GetValueAtIndex(i)?;
        let mut name = PWSTR::null();
        item.Name(&mut name)?;
        let name = take_pwstr(name);
        let mut id = 0;
        item.CommandId(&mut id)?;
        if name == "paste" {
            let mut enabled = BOOL::default();
            item.IsEnabled(&mut enabled)?;
            can_paste = enabled.as_bool();
        }
        commands.insert(name, id);
    }
    Ok((commands, can_paste))
}

fn complete(pending: Pending, how: Finish) {
    let Pending {
        args,
        deferral,
        commands,
        ..
    } = pending;
    let command = match &how {
        Finish::Command(name) => commands.get(name).copied(),
        _ => None,
    };
    // SAFETY：只在 UI 线程里调用（事件处理或 run_on_main_thread）。
    let result = unsafe {
        args.SetHandled(!matches!(how, Finish::Native))
            .and_then(|()| match command {
                Some(id) => args.SetSelectedCommandId(id),
                None => Ok(()),
            })
            .and_then(|()| deferral.Complete())
    };
    if let Err(e) = result {
        eprintln!("无法完成右键菜单：{e}");
    }
}

/// 完成窗口 `label` 挂起的第 `id` 次请求；它已经了结（被更新的请求顶掉）时什么也不做。
fn finish(label: &str, id: u64, how: Finish) {
    let taken = PENDING.with(|pending| {
        let mut pending = pending.borrow_mut();
        match pending.get(label) {
            Some(request) if request.id == id => pending.remove(label),
            _ => None,
        }
    });
    if let Some(pending) = taken {
        complete(pending, how);
    }
}

/// 窗口销毁时丢掉它挂起的请求（UI 线程里调用）。
pub fn forget(label: &str) {
    PENDING.with(|pending| pending.borrow_mut().remove(label));
}

fn finish_on_main(window: &WebviewWindow, id: u64, how: Finish) -> Result<()> {
    let label = window.label().to_owned();
    window
        .run_on_main_thread(move || finish(&label, id, how))
        .map_err(|e| e.to_string())
}

/// 用户在前端的菜单里选了“剪切” / “复制” / “粘贴”（`command` 为 WebView2 自带菜单项的名称）：
/// 由 WebView2 执行它自带的这个命令。自带菜单里没有这一项时什么也不做。
#[tauri::command]
pub fn context_menu_command(window: WebviewWindow, id: u64, command: String) -> Result<()> {
    finish_on_main(&window, id, Finish::Command(command))
}

/// 前端的菜单关掉了，或选了不经 WebView2 的项：不执行命令、不弹菜单地完成请求。
#[tauri::command]
pub fn context_menu_dismiss(window: WebviewWindow, id: u64) -> Result<()> {
    finish_on_main(&window, id, Finish::Dismiss)
}

/// 在输入框里右键：弹出 WebView2 自带的菜单。
#[tauri::command]
pub fn context_menu_native(window: WebviewWindow, id: u64) -> Result<()> {
    finish_on_main(&window, id, Finish::Native)
}
