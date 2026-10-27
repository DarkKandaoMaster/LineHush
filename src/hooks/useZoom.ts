import { useEffect, useLayoutEffect, useState } from "react";
import { ZOOM_DEFAULT, clampZoom, wheelZoomSteps, zoomBy, zoomKeyAction } from "../core/zoom";
import { redrawCarets } from "../editor/caret";

/**
 * 正文缩放（照 Win11 记事本）：Ctrl+滚轮、Ctrl+= / Ctrl++（含小键盘 +）放大，Ctrl+- 缩小，
 * Ctrl+0 恢复 100%；10%–500%，每步 10%。每个窗口一个值，不持久化（重启回 100%）。
 * 写到 <html> 的 --editor-zoom（App.css 里乘到 .tiptap 的字号上，只缩放文字，图片缩略图不变；
 * 导出 / 打印页不受影响）。这些键与 Ctrl+滚轮一律 preventDefault（不让 WebView2 缩放整个页面），
 * 有对话框开着或输入法组字中时不响应，与其他快捷键一致（useWindowGuards）。
 */
export function useZoom(): number {
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);

  useEffect(() => {
    const blocked = () => !!document.querySelector("dialog[open]");
    const keydown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const action = zoomKeyAction(event);
      if (!action) return;
      event.preventDefault();
      if (event.isComposing || blocked()) return;
      setZoom((current) =>
        action === "reset" ? ZOOM_DEFAULT : zoomBy(current, action === "in" ? 1 : -1),
      );
    };
    let pending = 0;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (blocked()) return;
      const result = wheelZoomSteps(pending, event.deltaY, event.deltaMode);
      pending = result.pending;
      if (result.steps) setZoom((current) => zoomBy(current, result.steps));
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("wheel", wheel);
    };
  }, []);

  // 在绘制前改字号，并立即按新的文字位置重画自绘光标与选区（字号变了编辑器高度通常也变，
  // ResizeObserver 会再画一次；文字少、高度不变时靠这一次）。
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    if (zoom === ZOOM_DEFAULT) style.removeProperty("--editor-zoom");
    else style.setProperty("--editor-zoom", String(clampZoom(zoom) / 100));
    redrawCarets();
  }, [zoom]);

  return zoom;
}
