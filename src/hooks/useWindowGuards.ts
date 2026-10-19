import { useEffect, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { OPEN_REQUESTED } from "../core/native";
import type { Session } from "../core/session";

/**
 * Starts the session, then registers Ctrl+N/O/S(+Shift), the close guard and
 * the "open this file" requests from Rust (double-click, second launch).
 * Registration waits for initialize(); `active` makes the StrictMode
 * mount → unmount → mount cycle register each listener exactly once.
 */
export function useWindowGuards(
  session: Session,
  preview: RefObject<HTMLDialogElement | null>,
  /** File shortcuts are ignored while the settings dialog is open, as during a preview. */
  settings: RefObject<HTMLDialogElement | null>,
) {
  const { desktop } = session;
  useEffect(() => {
    let active = true;
    let removeClose: (() => void) | undefined;
    let removeOpen: (() => void) | undefined;
    function keydown(event: KeyboardEvent) {
      if (
        event.isComposing ||
        !(event.ctrlKey || event.metaKey) ||
        session.getSnapshot().importing ||
        preview.current?.open ||
        settings.current?.open
      )
        return;
      const key = event.key.toLowerCase();
      if (!["n", "o", "s"].includes(key)) return;
      event.preventDefault();
      if (key === "n") void session.newDocument();
      if (key === "o") void session.openDocument();
      if (key === "s")
        void (event.shiftKey
          ? session.saveDocumentAs()
          : session.saveDocument());
    }
    void session.initialize().then(async () => {
      if (!active) return;
      window.addEventListener("keydown", keydown);
      if (!desktop) return;
      try {
        const unlisten = await getCurrentWindow().onCloseRequested(
          async (event) => {
            event.preventDefault();
            const { busy, importing } = session.getSnapshot();
            if (busy || importing) {
              session.setNotice("操作仍在进行，完成后可关闭窗口。");
              return;
            }
            await session.close();
          },
        );
        if (active) removeClose = unlisten;
        else unlisten();
      } catch (e) {
        if (active) session.setError(`无法启用关闭保护：${e}`);
      }
      // Files double-clicked while running; then the one LineHush was launched
      // with, if restore left it for after the unsaved-changes question.
      try {
        const unlisten = await listen(OPEN_REQUESTED, () => {
          void session.openRequested();
        });
        if (active) removeOpen = unlisten;
        else unlisten();
      } catch (e) {
        if (active) session.setError(`无法接收要打开的文件：${e}`);
      }
      if (active) void session.openRequested();
    });
    return () => {
      active = false;
      window.removeEventListener("keydown", keydown);
      removeClose?.();
      removeOpen?.();
    };
  }, [desktop, session, preview, settings]);
}
