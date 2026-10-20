// Every Rust command the frontend calls. Command and argument names are part of
// the IPC contract with src-tauri and with the test doubles; do not rename them.
// Commands that act on a document name its tab; window commands act on the
// calling window (Tauri passes it to Rust).
import { invoke } from "@tauri-apps/api/core";
import type { Diary, Picture } from "./document.ts";
import type { Settings } from "./settings.ts";
export type { Settings } from "./settings.ts";

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
/** Writes the original bytes of an image unchanged to `path`. */
export const exportImage = (tab: string, id: string, path: string) =>
  invoke<void>("export_image", { tab, id, path });
/**
 * Puts the originals on the system clipboard: as files, as HTML that LineHush
 * pastes back under the same ids and, for one image, as pixels. With
 * `afterBrowser` (a copy event the browser also writes) Rust lets the browser's
 * write land first and replaces it.
 */
export const copyImages = (
  tab: string,
  pictures: Picture[],
  afterBrowser: boolean,
) => invoke<void>("copy_images", { tab, pictures, afterBrowser });
/**
 * The images of LineHush's last copy, made available to the tab's document,
 * while the clipboard still holds exactly that copy; otherwise null. WebView2
 * shows such a paste only as files, so this is how it keeps the same images.
 */
export const copiedImages = (tab: string) =>
  invoke<Picture[] | null>("copied_images", { tab });
/** Makes copied images (from any document) available to the tab's document before they are pasted. */
export const pasteImages = (tab: string, ids: string[]) =>
  invoke<void>("paste_images", { tab, ids });
/** 客户区物理像素中的矩形。 */
export interface PhysicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** 上报最大化按钮的位置（客户区物理像素），Rust 在那里放贴靠布局用的覆盖窗口；宽或高为 0 时撤掉。 */
export const setCaptionButtons = (maximize: PhysicalRect) =>
  invoke<void>("set_caption_buttons", { maximize });
/** The stored settings, or the defaults when the file is missing or damaged; normalize before use. */
export const readSettings = () => invoke<Settings>("read_settings");
export const writeSettings = (settings: Settings) =>
  invoke<void>("write_settings", { settings });

/** Reads a thumbnail (or the original) of the tab's document into a Blob URL the caller must revoke. */
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
