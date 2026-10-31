import { useCallback, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { kindOf, type Picture } from "../core/document";
import { exportImage, imageUrl, mediaUrl, openAttachment } from "../core/native";
import type { Session } from "../core/session";

/**
 * Original-image preview in a <dialog> (non-modal, see useDialogs), one per window; `show` names the
 * tab (session) the image belongs to. Stale reads are dropped and every Blob URL
 * is revoked. A video plays there instead, straight from the media protocol
 * (`mediaUrl`), its bytes never read into the page. A file shows only its name
 * and size, with 打开 (its default program) and 保存原文件; nothing is read.
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
      if (kindOf(pic) === "file") return;
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
  /** A file: opens it with its default program; the dialog closes either way, a failure shows in the tab. */
  const openOriginal = useCallback(async () => {
    if (!shown) return;
    const { session, picture } = shown;
    close();
    try {
      await openAttachment(session.tab, picture.id, picture.name);
    } catch (e) {
      session.setError(`无法打开文件“${picture.name}”：${e}`);
    }
  }, [shown, close]);
  return {
    dialog,
    source,
    name: shown?.picture.name ?? "",
    kind: shown ? kindOf(shown.picture) : "image",
    size: shown?.picture.size,
    openOriginal,
    show,
    close,
    closed,
    saveOriginal,
  };
}
