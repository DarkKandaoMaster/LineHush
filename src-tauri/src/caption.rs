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
//!
//! 另有 `reveal_rect`：应用内对话框打开时，前端报上对话框的位置（客户区物理像素），
//! 窗口有一部分在屏幕外、对话框露不全时把窗口挪进工作区（照 Win11 记事本）。
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
    let parent = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    window
        .run_on_main_thread(move || win::place(parent, maximize))
        .map_err(|e| e.to_string())
}

/// 屏幕坐标中的矩形（物理像素），左上含、右下不含。纯函数用，不依赖 Win32 类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Edges {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

/// 对话框与工作区边缘之间至少留出的距离（物理像素）。
const REVEAL_MARGIN: i32 = 8;

/// 一个方向上要挪多少：`[lo, hi)` 放不进 `[work_lo, work_hi)` 时挪最小距离，
/// 比工作区还长则让 `lo` 对齐 `work_lo`；放得下为 0。
fn shift_into(lo: i32, hi: i32, work_lo: i32, work_hi: i32) -> i32 {
    if hi - lo > work_hi - work_lo || lo < work_lo {
        work_lo - lo
    } else if hi > work_hi {
        work_hi - hi
    } else {
        0
    }
}

/// 让 `rect`（外加 `margin`）进入工作区 `work` 时窗口要挪的 (dx, dy)；不出界为 (0, 0)。
fn reveal_shift(rect: Edges, work: Edges, margin: i32) -> (i32, i32) {
    (
        shift_into(rect.left - margin, rect.right + margin, work.left, work.right),
        shift_into(rect.top - margin, rect.bottom + margin, work.top, work.bottom),
    )
}

/// 应用内对话框打开时调用：`rect` 为对话框在客户区中的位置（物理像素）。它（外加 8 像素）
/// 超出窗口所在显示器的工作区（不含任务栏）时，把窗口挪最小距离让它露全；窗口大小、
/// Z 序与激活状态不变。最大化或最小化时不动。之后不挪回。
#[tauri::command]
pub fn reveal_rect(window: WebviewWindow, rect: Rect) -> Result<()> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    window
        .run_on_main_thread(move || win::reveal(hwnd, rect))
        .map_err(|e| e.to_string())
}

/// 为编辑器窗口建立（隐藏的）覆盖窗口。可在任意线程调用，实际在 UI 线程上创建。
pub fn attach(window: &WebviewWindow) {
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

mod win {
    use super::{overlay_hit, reveal_shift, CaptionHover, Edges, Rect, CAPTION_HOVER, REVEAL_MARGIN};
    use std::{cell::Cell, sync::Once};
    use tauri::{AppHandle, Emitter};
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::Gdi::{
                ClientToScreen, GetMonitorInfoW, GetStockObject, MonitorFromWindow, ValidateRect,
                HBRUSH, MONITORINFO, MONITOR_DEFAULTTONEAREST, NULL_BRUSH,
            },
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

    /// 见 `reveal_rect`。
    pub fn reveal(hwnd: isize, rect: Rect) {
        let hwnd = HWND(hwnd as _);
        unsafe {
            if IsZoomed(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return;
            }
            let mut frame = RECT::default();
            if GetWindowRect(hwnd, &mut frame).is_err() {
                return;
            }
            let mut origin = POINT::default();
            if !ClientToScreen(hwnd, &mut origin).as_bool() {
                return;
            }
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return;
            }
            let work = info.rcWork;
            let (dx, dy) = reveal_shift(
                Edges {
                    left: origin.x + rect.x,
                    top: origin.y + rect.y,
                    right: origin.x + rect.x + rect.w,
                    bottom: origin.y + rect.y + rect.h,
                },
                Edges {
                    left: work.left,
                    top: work.top,
                    right: work.right,
                    bottom: work.bottom,
                },
                REVEAL_MARGIN,
            );
            if (dx, dy) == (0, 0) {
                return;
            }
            let _ = SetWindowPos(
                hwnd,
                None,
                frame.left + dx,
                frame.top + dy,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
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
    use super::{overlay_hit, reveal_shift, Edges, HT_CLIENT, HT_MAXBUTTON, HT_TRANSPARENT};

    #[test]
    fn only_client_area_becomes_the_maximize_button() {
        assert_eq!(overlay_hit(HT_CLIENT), HT_MAXBUTTON);
        // 未最大化时顶边的调整大小带（HTTOP = 12）、HTCAPTION（2）等交还给下面的窗口。
        for other in [0, 2, 10, 12, 13, 14, HT_TRANSPARENT] {
            assert_eq!(overlay_hit(other), HT_TRANSPARENT);
        }
    }

    /// 1920×1040 的工作区（下方 40 像素是任务栏）。
    const WORK: Edges = Edges {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1040,
    };
    const fn at(left: i32, top: i32, w: i32, h: i32) -> Edges {
        Edges {
            left,
            top,
            right: left + w,
            bottom: top + h,
        }
    }

    #[test]
    fn a_dialog_inside_the_work_area_does_not_move_the_window() {
        assert_eq!(reveal_shift(at(500, 300, 480, 200), WORK, 8), (0, 0));
        // 恰好留出 8 像素也不动。
        assert_eq!(reveal_shift(at(8, 8, 1904, 1024), WORK, 8), (0, 0));
    }

    #[test]
    fn a_dialog_below_the_work_area_moves_the_window_up_just_enough() {
        // 下边在 1300：上移到 1040 - 8。
        assert_eq!(reveal_shift(at(500, 1100, 480, 200), WORK, 8), (0, -268));
        // 只露出一点点也一样，左右不动。
        assert_eq!(reveal_shift(at(500, 1035, 480, 200), WORK, 8), (0, -203));
    }

    #[test]
    fn a_dialog_above_the_work_area_moves_the_window_down() {
        assert_eq!(reveal_shift(at(500, -150, 480, 200), WORK, 8), (0, 158));
    }

    #[test]
    fn a_dialog_taller_or_wider_than_the_work_area_aligns_its_top_left() {
        // 比工作区高：上边对齐（外加边距），不管下边。
        assert_eq!(reveal_shift(at(500, 300, 480, 1200), WORK, 8), (0, -292));
        assert_eq!(reveal_shift(at(500, -300, 480, 1200), WORK, 8), (0, 308));
        // 比工作区宽：左边对齐。
        assert_eq!(reveal_shift(at(200, 300, 2000, 200), WORK, 8), (-192, 0));
    }

    #[test]
    fn a_dialog_left_or_right_of_the_work_area_moves_the_window_sideways() {
        assert_eq!(reveal_shift(at(-300, 300, 480, 200), WORK, 8), (308, 0));
        assert_eq!(reveal_shift(at(1700, 300, 480, 200), WORK, 8), (-268, 0));
        // 两个方向都出界：各挪各的。
        assert_eq!(reveal_shift(at(1700, 1000, 480, 200), WORK, 8), (-268, -168));
        // 工作区不从 0 开始（第二台显示器在左边、任务栏在顶上）。
        let work = Edges {
            left: -1600,
            top: 48,
            right: 0,
            bottom: 900,
        };
        assert_eq!(reveal_shift(at(-500, 20, 300, 100), work, 8), (0, 36));
    }
}
