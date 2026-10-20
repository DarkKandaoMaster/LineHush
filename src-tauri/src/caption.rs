//! 自绘标题栏的最大化按钮与 Windows 11 贴靠布局（Snap layouts）。
//!
//! 贴靠布局只在鼠标悬停于“非客户区命中测试返回 HTMAXBUTTON 的位置”时弹出。窗口无边框后，
//! 整个客户区被 WebView2 的子窗口盖住，鼠标消息与 WM_NCHITTEST 都发给那个子窗口
//! （其中接收鼠标的窗口属于浏览器进程，无法子类化），主窗口的窗口过程收不到。所以这里在
//! 前端最大化按钮的位置放一个同线程、不绘制的子窗口（“覆盖窗口”），叠在 WebView2 之上：
//!
//! - `WM_NCHITTEST`：先把同一点交给主窗口（tao）判断；结果为 HTCLIENT 时返回 HTMAXBUTTON，
//!   否则（例如未最大化时顶边的调整大小带）返回 HTTRANSPARENT，让下面的窗口处理，
//!   不干预 tao / Tauri 的边缘调整大小。
//! - `WM_NCLBUTTONDOWN` / `WM_NCLBUTTONUP`（HTMAXBUTTON）：吞掉，不交给系统默认处理
//!   （否则会画出经典按钮），在抬起时切换最大化 / 还原。
//! - `WM_NCMOUSEMOVE` / `WM_NCMOUSELEAVE`：命中 HTMAXBUTTON 后网页收不到鼠标事件，
//!   因此向该窗口发 `caption-hover` 事件，由前端画悬停 / 按下底色。
//!
//! 覆盖窗口的位置由前端经 `set_caption_buttons` 上报（客户区物理像素），未上报前隐藏，
//! 此时前端按钮照常响应点击。覆盖窗口是主窗口的子窗口，随主窗口一起销毁。
use crate::model::Result;
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

/// 向一个窗口报告最大化按钮的悬停 / 按下状态（`CaptionHover`）。
pub const CAPTION_HOVER: &str = "caption-hover";

/// 客户区坐标中的矩形（物理像素）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// `caption-hover` 的载荷：`button` 为 `"maximize"` 或 null。
#[derive(Clone, Serialize)]
pub struct CaptionHover {
    pub button: Option<&'static str>,
    pub pressed: bool,
}

// 命中测试结果（WinUser.h）。纯函数与单元测试用，不依赖 Win32 类型。
const HT_TRANSPARENT: isize = -1;
const HT_CLIENT: isize = 1;
const HT_MAXBUTTON: isize = 9;

/// 覆盖窗口的命中测试：主窗口认为是客户区（没有落在调整大小的边上）时才算最大化按钮。
fn overlay_hit(parent_hit: isize) -> isize {
    if parent_hit == HT_CLIENT {
        HT_MAXBUTTON
    } else {
        HT_TRANSPARENT
    }
}

/// 前端上报最大化按钮的位置（客户区物理像素）；宽或高为 0 时隐藏覆盖窗口，
/// 由网页自己的按钮处理点击。
#[tauri::command]
pub fn set_caption_buttons(window: WebviewWindow, maximize: Rect) -> Result<()> {
    #[cfg(windows)]
    {
        let parent = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        window
            .run_on_main_thread(move || win::place(parent, maximize))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (window, maximize);
    Ok(())
}

/// 为编辑器窗口建立（隐藏的）覆盖窗口。可在任意线程调用，实际在 UI 线程上创建。
pub fn attach(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let Ok(parent) = window.hwnd() else {
            return;
        };
        let parent = parent.0 as isize;
        let app = window.app_handle().clone();
        let label = window.label().to_owned();
        if let Err(e) = window.run_on_main_thread(move || win::create(parent, app, label)) {
            eprintln!("无法创建最大化按钮的覆盖窗口：{e}");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod win {
    use super::{overlay_hit, CaptionHover, Rect, CAPTION_HOVER};
    use std::{cell::Cell, sync::Once};
    use tauri::{AppHandle, Emitter};
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::Gdi::{GetStockObject, ValidateRect, HBRUSH, NULL_BRUSH},
            System::LibraryLoader::GetModuleHandleW,
            UI::{
                Input::KeyboardAndMouse::{
                    TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
                },
                WindowsAndMessaging::*,
            },
        },
    };

    const CLASS: PCWSTR = w!("LineHushCaptionMaximize");
    /// 状态变化后发给覆盖窗口自己，回到消息循环里再向前端发事件：窗口过程可能在
    /// Tauri 自己的调用（如移动窗口）中被同步调用，不在那时重入 Tauri。
    const WM_EMIT_HOVER: u32 = WM_APP + 0x31;

    /// 覆盖窗口的数据，指针存在 GWLP_USERDATA，WM_NCDESTROY 时释放。只在 UI 线程上访问。
    struct Overlay {
        app: AppHandle,
        label: String,
        hover: Cell<bool>,
        pressed: Cell<bool>,
        /// 已请求 WM_NCMOUSELEAVE。
        tracking: Cell<bool>,
    }

    fn register() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(window_proc),
                hInstance: GetModuleHandleW(None)
                    .map(|h| HINSTANCE(h.0))
                    .unwrap_or_default(),
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                // 不画任何东西：看到的是下面的网页按钮。
                hbrBackground: HBRUSH(GetStockObject(NULL_BRUSH).0),
                lpszClassName: CLASS,
                ..Default::default()
            };
            RegisterClassExW(&class);
        });
    }

    pub fn create(parent: isize, app: AppHandle, label: String) {
        register();
        let parent = HWND(parent as _);
        unsafe {
            if FindWindowExW(Some(parent), None, CLASS, PCWSTR::null()).is_ok() {
                return;
            }
            let data = Box::into_raw(Box::new(Overlay {
                app,
                label,
                hover: Cell::new(false),
                pressed: Cell::new(false),
                tracking: Cell::new(false),
            }));
            // 先隐藏，前端上报位置后才显示。
            let created = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                CLASS,
                PCWSTR::null(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                Some(parent),
                None,
                GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0)),
                Some(data as _),
            );
            if let Err(e) = created {
                // 失败时数据可能已由 WM_NCDESTROY 释放，也可能没有；宁可留着这一小块
                // 也不冒重复释放的险。此时没有贴靠布局，前端按钮照常可点。
                eprintln!("无法创建最大化按钮的覆盖窗口：{e}");
            }
        }
    }

    pub fn place(parent: isize, rect: Rect) {
        let parent = HWND(parent as _);
        unsafe {
            let Ok(overlay) = FindWindowExW(Some(parent), None, CLASS, PCWSTR::null()) else {
                return;
            };
            if rect.w <= 0 || rect.h <= 0 {
                let _ = ShowWindow(overlay, SW_HIDE);
                return;
            }
            // 每次都放到最上面：WebView2 或 Tauri 的调整大小窗口可能被重新排到它之上。
            let _ = SetWindowPos(
                overlay,
                Some(HWND_TOP),
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER,
            );
            // 按钮移走了（如点击后最大化），光标已不在上面：不等 WM_NCMOUSELEAVE，直接取消悬停。
            let mut cursor = POINT::default();
            let mut moved = RECT::default();
            if GetCursorPos(&mut cursor).is_ok() && GetWindowRect(overlay, &mut moved).is_ok() {
                let inside = cursor.x >= moved.left
                    && cursor.x < moved.right
                    && cursor.y >= moved.top
                    && cursor.y < moved.bottom;
                if let (false, Some(data)) = (inside, overlay_data(overlay)) {
                    set_state(overlay, data, false, false);
                }
            }
        }
    }

    unsafe fn overlay_data<'a>(hwnd: HWND) -> Option<&'a Overlay> {
        let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Overlay;
        data.as_ref()
    }

    /// 状态变了就在消息循环里通知前端（见 WM_EMIT_HOVER）。
    fn set_state(hwnd: HWND, data: &Overlay, hover: bool, pressed: bool) {
        if data.hover.get() == hover && data.pressed.get() == pressed {
            return;
        }
        data.hover.set(hover);
        data.pressed.set(pressed);
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_EMIT_HOVER, WPARAM(0), LPARAM(0));
        }
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let on_button = wparam.0 == HTMAXBUTTON as usize;
        match msg {
            WM_NCCREATE => {
                let create = lparam.0 as *const CREATESTRUCTW;
                if let Some(create) = create.as_ref() {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
                }
            }
            WM_NCHITTEST => {
                let Ok(parent) = GetParent(hwnd) else {
                    return LRESULT(HTTRANSPARENT as isize);
                };
                let parent_hit = SendMessageW(parent, WM_NCHITTEST, None, Some(lparam)).0;
                return LRESULT(overlay_hit(parent_hit));
            }
            WM_NCMOUSEMOVE => {
                if let Some(data) = overlay_data(hwnd) {
                    if !data.tracking.get() {
                        let mut track = TRACKMOUSEEVENT {
                            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                            dwFlags: TME_LEAVE | TME_NONCLIENT,
                            hwndTrack: hwnd,
                            dwHoverTime: 0,
                        };
                        data.tracking.set(TrackMouseEvent(&mut track).is_ok());
                    }
                    set_state(hwnd, data, on_button, on_button && data.pressed.get());
                }
                return LRESULT(0);
            }
            WM_NCMOUSELEAVE => {
                if let Some(data) = overlay_data(hwnd) {
                    data.tracking.set(false);
                    set_state(hwnd, data, false, false);
                }
                return LRESULT(0);
            }
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                if let Some(data) = overlay_data(hwnd) {
                    set_state(hwnd, data, on_button, on_button);
                }
                return LRESULT(0);
            }
            WM_NCLBUTTONUP => {
                if let Some(data) = overlay_data(hwnd) {
                    let clicked = data.pressed.get() && on_button;
                    set_state(hwnd, data, on_button, false);
                    if clicked {
                        if let Ok(parent) = GetParent(hwnd) {
                            // 与系统标题按钮相同，走 WM_SYSCOMMAND，带系统动画。
                            let command = if IsZoomed(parent).as_bool() {
                                SC_RESTORE
                            } else {
                                SC_MAXIMIZE
                            };
                            let _ = PostMessageW(
                                Some(parent),
                                WM_SYSCOMMAND,
                                WPARAM(command as usize),
                                LPARAM(0),
                            );
                        }
                    }
                }
                return LRESULT(0);
            }
            // 右键、中键：记事本的最大化按钮对它们没有反应。
            WM_NCRBUTTONDOWN | WM_NCRBUTTONUP | WM_NCRBUTTONDBLCLK | WM_NCMBUTTONDOWN
            | WM_NCMBUTTONUP | WM_NCMBUTTONDBLCLK => return LRESULT(0),
            WM_EMIT_HOVER => {
                if let Some(data) = overlay_data(hwnd) {
                    let payload = CaptionHover {
                        button: data.hover.get().then_some("maximize"),
                        pressed: data.pressed.get(),
                    };
                    let _ = data.app.emit_to(data.label.as_str(), CAPTION_HOVER, payload);
                }
                return LRESULT(0);
            }
            WM_ERASEBKGND => return LRESULT(1),
            WM_PAINT => {
                let _ = ValidateRect(Some(hwnd), None);
                return LRESULT(0);
            }
            WM_NCDESTROY => {
                let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Overlay;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                if !data.is_null() {
                    drop(Box::from_raw(data));
                }
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::{overlay_hit, HT_CLIENT, HT_MAXBUTTON, HT_TRANSPARENT};

    #[test]
    fn only_client_area_becomes_the_maximize_button() {
        assert_eq!(overlay_hit(HT_CLIENT), HT_MAXBUTTON);
        // 未最大化时顶边的调整大小带（HTTOP = 12）、HTCAPTION（2）等交还给下面的窗口。
        for other in [0, 2, 10, 12, 13, 14, HT_TRANSPARENT] {
            assert_eq!(overlay_hit(other), HT_TRANSPARENT);
        }
    }
}
