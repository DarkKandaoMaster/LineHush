import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealRect, type PhysicalRect } from "../core/native";

/** 应用内的三个对话框。 */
export type DialogKind = "unsaved" | "settings" | "preview";
/** 上面的在前：保存询问可能出现在设置 / 预览之上（例如从任务栏关窗）。 */
const ORDER: DialogKind[] = ["unsaved", "settings", "preview"];

interface Options {
  dialogs: Record<DialogKind, RefObject<HTMLDialogElement | null>>;
  /** Esc、点遮罩、标题栏 × 时关掉这个对话框（保存询问为“取消”）。 */
  dismiss: Record<DialogKind, () => void>;
  /** 对话框全部关掉后把焦点还给编辑器。 */
  focus: () => void;
}

/**
 * 三个对话框都用非模态的 `show()` 打开：模态对话框会让整个页面 inert，自绘标题栏也就
 * 拖不动、按不了，窗口大半在屏幕外时拖不回来。这里代替模态做的事：
 *
 * - `top`：打开着的最上面那个（跟踪各 `<dialog>` 的 `open` 属性，同步提交，
 *   页面其余部分的 inert 与 DOM 一致，关掉后立刻能拿回焦点）；
 * - 打开后下一帧把它的位置报给 Rust（`revealRect`），露不全时把窗口挪进屏幕；
 * - Esc（挂在 window 上：点过标题栏、焦点不在对话框里也有效）关掉最上面那个；
 * - `mask`：点遮罩关掉设置 / 预览，保存询问不响应；
 * - `closeWindow`：标题栏 ×，保存询问开着时等于“取消”，否则先关掉对话框再走关窗流程。
 */
export function useDialogs(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [top, setTop] = useState<DialogKind | null>(null);

  const reveal = useCallback((kind: DialogKind) => {
    requestAnimationFrame(() => {
      const element = latest.current.dialogs[kind].current;
      if (element?.open) revealElement(element);
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
      latest.current.dismiss[kind]();
    }
    window.addEventListener("keydown", keydown);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", keydown);
    };
  }, [reveal]);

  const mask = useCallback(() => {
    const { dialogs, dismiss } = latest.current;
    const kind = ORDER.find((kind) => dialogs[kind].current?.open);
    if (kind && kind !== "unsaved") dismiss[kind]();
  }, []);

  const closeWindow = useCallback(() => {
    const { dialogs, dismiss } = latest.current;
    // 关窗流程本来就在等这个回答（tabs.closeWindow 会忽略重入），不能再发起一次。
    if (dialogs.unsaved.current?.open) {
      dismiss.unsaved();
      return;
    }
    for (const kind of ORDER) if (dialogs[kind].current?.open) dismiss[kind]();
    // 走 onCloseRequested 的关窗流程（逐个询问未保存的标签页），不直接销毁。
    void getCurrentWindow().close();
  }, []);

  return { top, reveal, mask, closeWindow };
}

/** 元素在客户区中的位置（物理像素），交给 Rust 看要不要挪窗口。 */
function revealElement(element: Element) {
  const box = element.getBoundingClientRect();
  const scale = window.devicePixelRatio;
  const x = Math.round(box.left * scale);
  const y = Math.round(box.top * scale);
  const rect: PhysicalRect = {
    x,
    y,
    w: Math.round(box.right * scale) - x,
    h: Math.round(box.bottom * scale) - y,
  };
  if (rect.w > 0 && rect.h > 0) revealRect(rect).catch(console.error);
}
