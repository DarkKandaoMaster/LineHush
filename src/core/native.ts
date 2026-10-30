// Every Rust command the frontend calls. Command and argument names are part of
// the IPC contract with src-tauri and with the test doubles; do not rename them.
// Commands that act on a document name its tab; window commands act on the
// calling window (Tauri passes it to Rust).
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Diary, Picture } from "./document.ts";
import type { CaretMetrics } from "../editor/caret-math.ts";
import type { Settings } from "./settings.ts";

/** Serialized `store::Opened`. */
export interface Opened {
  document: Diary;
  path: string | null;
  recovered: boolean;
  /**
   * With `recovered`: replaces the plain "recovered" notice, e.g. when the recorded
   * file could not be reopened. Otherwise a warning, e.g. that the previous file's
   * unreferenced images could not be cleaned up.
   */
  notice: string | null;
}
/** One tab as Rust hands it out. */
export interface TabOpened {
  tab: string;
  opened: Opened;
  /** The tab's file could not be opened; the tab is a new unnamed document. */
  error: string | null;
}
/** All tabs of this window and its current tab. */
export interface WindowOpened {
  tabs: TabOpened[];
  active: string;
}
/** `open_file`: opened in a tab, or already open in `tab` of `window`. */
export type OpenOutcome =
  | ({ kind: "opened" } & TabOpened)
  | { kind: "existing"; window: string; tab: string };

/** Rust emits this to one window when a file is waiting in `takeOpenRequest` (e.g. double-clicked while running). */
export const OPEN_REQUESTED = "open-requested";
/** Rust emits this (`{ tab }`) to one window when a file asked for is already open in that tab. */
export const ACTIVATE_TAB = "activate-tab";
/** 设置写入后 Rust 发给所有窗口（载荷为 `Settings`）。 */
export const SETTINGS_CHANGED = "settings-changed";

/**
 * Rust 向本窗口报告最大化按钮的悬停 / 按下（`{ button: "maximize" | null, pressed }`）：
 * 鼠标在按钮上时由 Rust 的覆盖窗口接收（为了 Win11 贴靠布局），网页收不到鼠标事件。
 */
export const CAPTION_HOVER = "caption-hover";

/** This window's tabs: crash leftovers with their unsaved changes, or a new unnamed tab. */
export const restoreWindow = () => invoke<WindowOpened>("restore_window");
/** A new unnamed tab at the end of this window. */
export const newTab = () => invoke<TabOpened>("new_tab");
/**
 * Opens `path` in `replace` (an unnamed, unchanged tab) or in a new tab right of
 * `after`; a file already open somewhere comes back as "existing".
 */
export const openFile = (
  path: string,
  replace: string | null,
  after: string | null,
) => invoke<OpenOutcome>("open_file", { path, replace, after });
/** Records this window's current tab (restored after a crash). */
export const activateTab = (tab: string) =>
  invoke<void>("activate_tab", { tab });
/**
 * Discards the tab's unsaved changes and drops its unreferenced images; called
 * right before the tab closes. Best effort: cleanup failures come back as text.
 */
export const closeTab = (tab: string) =>
  invoke<string | null>("close_tab", { tab });
/** Ctrl+Shift+N：新窗口，带一个空标签页（窗口位置相对本窗口错开）。 */
export const newWindow = () => invoke<void>("new_window");
/** 本窗口是否是最后一个编辑窗口（关掉它就退出 LineHush）。 */
export const isLastWindow = () => invoke<boolean>("is_last_window");
/** The `.hush` file the user asked this window to open from outside, handed out once. */
export const takeOpenRequest = () => invoke<string | null>("take_open_request");
/** Stashes unsaved edits to the crash-recovery working copy; the user's file is unchanged. */
export const stashDocument = (tab: string, document: Diary) =>
  invoke<void>("stash_document", { tab, document });
/**
 * 丢掉标签页工作副本里的暂存正文（图片不动）：内容与已保存的相同，下次启动不应
 * 当作未保存的修改恢复。
 */
export const discardStash = (tab: string) =>
  invoke<void>("discard_stash", { tab });
/** Writes the tab's (named) file. */
export const saveDocument = (tab: string, document: Diary) =>
  invoke<void>("save_document", { tab, document });
export const saveAs = (tab: string, path: string, document: Diary) =>
  invoke<Opened>("save_as", { tab, path, document });
/**
 * 无标题笔记保存对话框的默认路径：`<上次打开 / 另存为的文件夹，没有则“文档”>\<base>.hush`，
 * 名字已被占用时照资源管理器改为 `<base> (2).hush`、`<base> (3).hush`…
 */
export const suggestSavePath = (base: string) =>
  invoke<string>("suggest_save_path", { base });
/** Writes `content` to `path` and each original to `<its folder>/附件/<file>`. */
export const exportDocument = (
  tab: string,
  path: string,
  content: string,
  images: { id: string; file: string }[],
) => invoke<void>("export_document", { tab, path, content, images });
/**
 * 在隐藏窗口里加载打印页 `html`（见 `toPrintHtml`），用 WebView2 打印成 PDF 写到 `path`；
 * 页面中的 `/image/<id>` 由 Rust 按该标签页文档的原图提供。
 */
export const exportPdf = (tab: string, path: string, html: string) =>
  invoke<void>("export_pdf", { tab, path, html });
/**
 * The file bytes are sent as the raw request body, so the tab goes in a header;
 * the returned name is empty.
 */
export const importImage = (tab: string, bytes: ArrayBuffer) =>
  invoke<Picture>("import_image", bytes, {
    headers: { "x-linehush-tab": tab },
  });
/** What the page learned of a video or recording before importing it (core/media-probe.ts). */
export interface MediaMeta {
  kind: "video" | "audio";
  /** The video's frame in pixels; 0 for audio. */
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
}
/**
 * Stores a video or recording unchanged in the tab's document (Rust does not
 * decode it); as with `importImage` the bytes are the raw body, the rest goes
 * in headers, and the returned name is empty.
 */
export const importMedia = (tab: string, bytes: ArrayBuffer, meta: MediaMeta) =>
  invoke<Picture>("import_media", bytes, {
    headers: {
      "x-linehush-tab": tab,
      "x-linehush-kind": meta.kind,
      "x-linehush-width": String(meta.width),
      "x-linehush-height": String(meta.height),
      "x-linehush-duration": String(meta.duration),
    },
  });
/** Stores a video's cover frame (PNG or JPEG bytes as the raw body), shown as its thumbnail. */
export const mediaPoster = (tab: string, id: string, bytes: ArrayBuffer) =>
  invoke<void>("media_poster", bytes, {
    headers: { "x-linehush-tab": tab, "x-linehush-id": id },
  });
/**
 * Where the media element plays a video or recording of the tab's document
 * from: Rust's `linehush-media` protocol, which answers range requests.
 */
export const mediaUrl = (tab: string, id: string) =>
  `http://linehush-media.localhost/${tab}/${id}`;
/** Writes the original bytes of an image unchanged to `path`. */
export const exportImage = (tab: string, id: string, path: string) =>
  invoke<void>("export_image", { tab, id, path });
/**
 * Puts the originals on the system clipboard: as files and, for one image, as
 * pixels; Rust remembers the copy and its rows (`rows` marks the pictures that
 * start a new row) for `copiedImages`.
 */
export const copyImages = (tab: string, pictures: Picture[], rows: boolean[]) =>
  invoke<void>("copy_images", { tab, pictures, rows });
/**
 * The images of LineHush's last copy and their rows, made available to the
 * tab's document, while the clipboard still holds exactly that copy; otherwise
 * null. WebView2 shows such a paste only as files, so this is how it keeps the
 * same images.
 */
export const copiedImages = (tab: string) =>
  invoke<{ pictures: Picture[]; rows: boolean[] } | null>("copied_images", {
    tab,
  });
/**
 * Makes copied images (from any document) available to the tab's document
 * before they are pasted; returns the ids of those no longer to be found.
 */
export const pasteImages = (tab: string, ids: string[]) =>
  invoke<string[]>("paste_images", { tab, ids });
/**
 * Keeps copies of the originals of images copied with text lines (the browser
 * writes that clipboard), so another document can paste them.
 */
export const stageImages = (tab: string, pictures: Picture[]) =>
  invoke<void>("stage_images", { tab, pictures });
/** 客户区物理像素中的矩形。 */
interface PhysicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** 元素在客户区中的位置（物理像素，各边分别取整）。 */
export function physicalRect(element: Element): PhysicalRect {
  const box = element.getBoundingClientRect();
  const scale = window.devicePixelRatio;
  const x = Math.round(box.left * scale);
  const y = Math.round(box.top * scale);
  return {
    x,
    y,
    w: Math.round(box.right * scale) - x,
    h: Math.round(box.bottom * scale) - y,
  };
}
/** 上报最大化按钮的位置（客户区物理像素），Rust 在那里放贴靠布局用的覆盖窗口；宽或高为 0 时撤掉。 */
export const setCaptionButtons = (maximize: PhysicalRect) =>
  invoke<void>("set_caption_buttons", { maximize });
/**
 * 应用内对话框打开后报上它的位置（客户区物理像素）：窗口有一部分在屏幕外、对话框露不全时，
 * Rust 把窗口挪进屏幕（照 Win11 记事本），之后不挪回。
 */
export const revealRect = (rect: PhysicalRect) =>
  invoke<void>("reveal_rect", { rect });
/**
 * Rust 接管了 WebView2 的右键菜单请求（src-tauri/src/context_menu.rs）：页面让编辑区的
 * contextmenu 事件通过，Rust 挂起请求后向本窗口发这个事件（`ContextMenuRequested`），
 * 页面画自己的菜单，再以下面三个命令之一带着 `id` 完成请求。
 */
export const CONTEXT_MENU_REQUESTED = "context-menu-requested";
export interface ContextMenuRequested {
  /** 请求编号，完成时带回。 */
  id: number;
  /** WebView2 自带菜单里的“粘贴”可用（剪贴板里有能粘贴的内容）。 */
  canPaste: boolean;
}
/**
 * 本窗口的右键菜单请求由 Rust 接管（真实的 LineHush 窗口，Rust 在页面加载前设好标记）；
 * 否则（浏览器测试的替身）页面自己响应 contextmenu 事件，没有粘贴。
 */
export const nativeContextMenu = () =>
  (globalThis as { __LINEHUSH_CONTEXT_MENU__?: unknown }).__LINEHUSH_CONTEXT_MENU__ === true;
/** 由 WebView2 执行它自带菜单里的这个命令（剪贴板操作，如 "paste"），完成请求 `id`。 */
export const contextMenuCommand = (id: number, command: "cut" | "copy" | "paste") =>
  invoke<void>("context_menu_command", { id, command });
/** 不执行命令、不弹菜单地完成请求 `id`（页面的菜单关掉了，或选了页面自己处理的项）。 */
export const contextMenuDismiss = (id: number) =>
  invoke<void>("context_menu_dismiss", { id });
/** 弹出 WebView2 自带的菜单来完成请求 `id`（在输入框里右键）。 */
export const contextMenuNative = (id: number) =>
  invoke<void>("context_menu_native", { id });
/** 在资源管理器里打开 `path` 所在的文件夹并选中它（标签页菜单“打开文件所在位置”）；文件不存在时失败。 */
export const revealInExplorer = (path: string) =>
  invoke<void>("reveal_in_explorer", { path });
/** The stored settings, or the defaults when the file is missing or damaged; normalize before use. */
export const readSettings = () => invoke<Settings>("read_settings");
export const writeSettings = (settings: Settings) =>
  invoke<void>("write_settings", { settings });
/**
 * 自动检查更新（src-tauri/src/update.rs）：Rust 在启动约 3 秒后检查一次，有新版本时给最近使用的
 * 窗口发这个事件（载荷为 `UpdateInfo`）；页面一律经 `takeUpdate` 取说明，只交出一次。
 */
export const UPDATE_AVAILABLE = "update-available";
/**
 * “立即更新”安装前 Rust 发给所有窗口（`{ round }`）：立刻暂存所有标签页的修改，完成后以
 * `stashFlushed` 答复（安装会退出进程，重启后靠工作副本恢复未保存的修改）。
 */
export const FLUSH_REQUESTED = "flush-requested";
/** 新版本说明。 */
export interface UpdateInfo {
  /** 新版本号，如 "0.9.0"。 */
  version: string;
  /** 正在运行的版本号。 */
  current: string;
  /** 更新说明（latest.json 的 notes），没有时为空串。 */
  notes: string;
  /** 发布时间（RFC 3339），没有时为 null。 */
  date: string | null;
}
/** `installUpdate` 的进度：下载中（总长度可能未知）、等各窗口暂存、启动安装程序。 */
export type UpdateProgress =
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "stashing" }
  | { phase: "installing" };
/** 有新版本且还没有窗口显示过时交出说明，之后为 null（本次运行只提示一次）。 */
export const takeUpdate = () => invoke<UpdateInfo | null>("take_update");
/**
 * 下载新版本安装包 → 请所有窗口暂存修改 → 启动安装程序并退出进程（成功时不会返回）。
 * 失败时以中文原因 reject，可以重试。
 */
export function installUpdate(onProgress: (progress: UpdateProgress) => void) {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return invoke<void>("install_update", { onProgress: channel });
}
/** 答复一轮 `FLUSH_REQUESTED`：本窗口的标签页都暂存完了；`error` 为暂存失败的原因。 */
export const stashFlushed = (round: number, error: string | null) =>
  invoke<void>("stash_flushed", { round, error });
/**
 * Windows' text caret settings: width in screen pixels, blink rate and timeout
 * (see src/editor/caret.ts).
 */
export const caretMetrics = () => invoke<CaretMetrics>("caret_metrics");

/**
 * Reads a thumbnail (or the original) of the tab's document into a Blob URL the
 * caller must revoke. A video's thumbnail is its cover frame; audio has none.
 */
export async function imageUrl(
  tab: string,
  pic: Picture,
  original = false,
): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_image", {
    tab,
    id: pic.id,
    original,
  });
  return URL.createObjectURL(new Blob([bytes]));
}
