import { useCallback, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { kindOf, type Picture } from "../core/document";
import { exportImage, imageUrl, mediaUrl } from "../core/native";
import type { Session } from "../core/session";

/**
 * Original-image preview in a <dialog> (non-modal, see useDialogs), one per window; `show` names the
 * tab (session) the image belongs to. Stale reads are dropped and every Blob URL
 * is revoked. A video plays there instead, straight from the media protocol
 * (`mediaUrl`), its bytes never read into the page.
 */
export function useImagePreview() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState("");
  const [shown, setShown] = useState<{
    session: Session;
    picture: Picture;
  } | null>(null);
  const request = useRef({ version: 0, url: "" });
  const close = useCallback(() => dialog.current?.close("cancel"), []);
  /** After the dialog closed, whichever way (its button, Esc, the mask, the title bar ×). */
  const closed = useCallback(() => {
    const current = request.current;
    current.version++;
    if (current.url) URL.revokeObjectURL(current.url);
    current.url = "";
    setSource("");
  }, []);
  const show = useCallback(
    async (session: Session, pic: Picture) => {
      const current = request.current;
      const version = ++current.version;
      setShown({ session, picture: pic });
      dialog.current?.show();
      // The dialog itself takes focus, not a button (see ImagePreviewDialog).
      dialog.current?.focus({ preventScroll: true });
      if (kindOf(pic) === "video") {
        setSource(mediaUrl(session.tab, pic.id));
        return;
      }
      try {
        const url = await imageUrl(session.tab, pic, true);
        if (version !== current.version) URL.revokeObjectURL(url);
        else {
          current.url = url;
          setSource(url);
        }
      } catch (e) {
        if (version !== current.version) return;
        close();
        session.setError(`无法读取原图：${e}`);
      }
    },
    [close],
  );
  /** Writes the stored original bytes, unchanged, to a file the user picks. */
  const saveOriginal = useCallback(async () => {
    if (!shown) return;
    const { session, picture } = shown;
    const action = kindOf(picture) === "image" ? "保存原图" : "保存原文件";
    try {
      const target = await save({
        title: action,
        defaultPath: picture.name || picture.id.slice(0, 12),
      });
      if (!target) return;
      await exportImage(session.tab, picture.id, target);
    } catch (e) {
      session.setError(`${action}失败：${e}`);
    }
  }, [shown]);
  return {
    dialog,
    source,
    name: shown?.picture.name ?? "",
    video: !!shown && kindOf(shown.picture) === "video",
    show,
    close,
    closed,
    saveOriginal,
  };
}
