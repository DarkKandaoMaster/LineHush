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
  importLock: RefObject<boolean>,
  preview: RefObject<HTMLDialogElement | null>,
  closePreview: () => void,
) {
  const { desktop } = session;
  useEffect(() => {
    let active = true;
    let removeClose: (() => void) | undefined;
    function keydown(event: KeyboardEvent) {
      if (
        event.isComposing ||
        !(event.ctrlKey || event.metaKey) ||
        session.getSnapshot().busy ||
        importLock.current ||
        preview.current?.open
      )
        return;
      const key = event.key.toLowerCase();
      if (!["n", "o", "s"].includes(key) || !desktop) return;
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
            if (!active) return;
            event.preventDefault();
            if (session.getSnapshot().busy || importLock.current) {
              session.setNotice("操作仍在进行，完成后可关闭窗口。");
              return;
            }
            session.setBusy(true);
            try {
              await session.flush();
              await getCurrentWindow().destroy();
            } catch (e) {
              session.setError(`未关闭窗口：${e}`);
            } finally {
              session.setBusy(false);
            }
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
      session.dispose();
      closePreview();
    };
  }, [desktop, session, importLock, preview, closePreview]);
}

/** Window title: "● " marks unsaved changes. */
export function useWindowTitle(
  session: Session,
  title: string,
  dirty: boolean,
) {
  const { desktop } = session;
  useEffect(() => {
    if (desktop)
      void getCurrentWindow()
        .setTitle(`${dirty ? "● " : ""}${title} — LineHush`)
        .catch((e) => session.setError(String(e)));
  }, [desktop, title, dirty, session]);
}
