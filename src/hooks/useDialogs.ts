import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { physicalRect, revealRect } from "../core/native";

/** 应用内的四个对话框。 */
type DialogKind = "unsaved" | "update" | "settings" | "preview";
/**
 * 上面的在前：保存询问可能出现在别的对话框之上（例如从任务栏关窗）。发现新版本只在没有别的
 * 对话框开着时弹出（App），排在保存询问之下。
 */
const ORDER: DialogKind[] = ["unsaved", "update", "settings", "preview"];

interface Options {
  /**
   * Esc、点遮罩、标题栏 × 时以 `close("cancel")` 关掉（保存询问即“取消”），各对话框
   * 在自己的 close 事件里收尾。
   */
  dialogs: Record<DialogKind, RefObject<HTMLDialogElement | null>>;
  /** 对话框全部关掉后把焦点还给编辑器。 */
  focus: () => void;
  /** 更新对话框正在下载 / 安装：它在最上面时 Esc、标题栏 × 都不响应。 */
  updateBusy?: boolean;
}

/**
 * 四个对话框都用非模态的 `show()` 打开：模态对话框会让整个页面 inert，自绘标题栏也就
 * 拖不动、按不了，窗口大半在屏幕外时拖不回来。这里代替模态做的事：
 *
 * - `top`：打开着的最上面那个（跟踪各 `<dialog>` 的 `open` 属性，同步提交，
 *   页面其余部分的 inert 与 DOM 一致，关掉后立刻能拿回焦点）；
 * - 打开后下一帧把它的位置报给 Rust（`revealRect`），露不全时把窗口挪进屏幕；
 * - Esc（挂在 window 上：点过标题栏、焦点不在对话框里也有效）关掉最上面那个；
 * - `mask`：点遮罩关掉设置 / 预览，保存询问与发现新版本不响应（都是要回答的问题）；双击的
 *   第二下不算（第一下可能正是打开它的那一下）；
 * - `closeWindow`：标题栏 ×，保存询问开着时等于“取消”，否则先关掉对话框再走关窗流程；
 * - 更新对话框下载 / 安装期间（`updateBusy`）Esc 与标题栏 × 都不响应。
 */
export function useDialogs(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [top, setTop] = useState<DialogKind | null>(null);
  const dismiss = (kind: DialogKind) =>
    latest.current.dialogs[kind].current?.close("cancel");

  const reveal = useCallback((kind: DialogKind) => {
    requestAnimationFrame(() => {
      const element = latest.current.dialogs[kind].current;
      if (!element?.open) return;
      const rect = physicalRect(element);
      if (rect.w > 0 && rect.h > 0) revealRect(rect).catch(console.error);
    });
  }, []);

  useEffect(() => {
    const { dialogs } = latest.current;
    const read = () => ORDER.filter((kind) => dialogs[kind].current?.open);
    let last = read();
    setTop(last[0] ?? null);
    const observer = new MutationObserver(() => {
      const now = read();
      for (const kind of now) if (!last.includes(kind)) reveal(kind);
      const closedAll = last.length > 0 && now.length === 0;
      last = now;
      flushSync(() => setTop(now[0] ?? null));
      if (closedAll) latest.current.focus();
    });
    for (const kind of ORDER) {
      const element = dialogs[kind].current;
      if (element)
        observer.observe(element, { attributes: true, attributeFilter: ["open"] });
    }
    // 非模态对话框没有 Esc 的 cancel 事件。
    function keydown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      const kind = ORDER.find((kind) => dialogs[kind].current?.open);
      if (!kind) return;
      event.preventDefault();
      if (kind === "update" && latest.current.updateBusy) return;
      dismiss(kind);
    }
    window.addEventListener("keydown", keydown);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", keydown);
    };
  }, [reveal]);

  const mask = (event?: { detail: number }) => {
    // 双击的第二下：第一下刚打开了对话框（如视频的播放角标，单击即打开预览），不是要关掉它。
    if (event && event.detail > 1) return;
    const { dialogs } = latest.current;
    const kind = ORDER.find((kind) => dialogs[kind].current?.open);
    if (kind && kind !== "unsaved" && kind !== "update") dismiss(kind);
  };

  const closeWindow = () => {
    const { dialogs } = latest.current;
    // 关窗流程本来就在等这个回答（tabs.closeWindow 会忽略重入），不能再发起一次。
    if (dialogs.unsaved.current?.open) {
      dismiss("unsaved");
      return;
    }
    // 正在下载 / 安装更新：不中断，也不关窗。
    if (dialogs.update.current?.open && latest.current.updateBusy) return;
    for (const kind of ORDER) if (dialogs[kind].current?.open) dismiss(kind);
    // 走 onCloseRequested 的关窗流程（逐个询问未保存的标签页），不直接销毁。
    void getCurrentWindow().close();
  };

  return { top, reveal, mask, closeWindow };
}
