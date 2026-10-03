import { useEffect, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session } from "../core/session";

/**
 * Starts the session, then registers Ctrl+N/O/S(+Shift) and the close guard.
 * Registration waits for initialize(); `active` makes the StrictMode
 * mount → unmount → mount cycle register each listener exactly once.
 */
export function useWindowGuards(
  session: Session,
  preview: RefObject<HTMLDialogElement | null>,
) {
  const { desktop } = session;
  useEffect(() => {
    let active = true;
    let removeClose: (() => void) | undefined;
    function keydown(event: KeyboardEvent) {
      if (
        event.isComposing ||
        !(event.ctrlKey || event.metaKey) ||
        session.getSnapshot().importing ||
        preview.current?.open
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
    });
    return () => {
      active = false;
      window.removeEventListener("keydown", keydown);
      removeClose?.();
    };
  }, [desktop, session, preview]);
}
