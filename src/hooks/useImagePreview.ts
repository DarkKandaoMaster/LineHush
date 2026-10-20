import { useCallback, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { Picture } from "../core/document";
import { exportImage, imageUrl } from "../core/native";
import type { Session } from "../core/session";

/**
 * Original-image preview in a modal <dialog>, one per window; `show` names the
 * tab (session) the image belongs to. Stale reads are dropped and every Blob URL
 * is revoked.
 */
export function useImagePreview() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState("");
  const [shown, setShown] = useState<{
    session: Session;
    picture: Picture;
  } | null>(null);
  const request = useRef({ version: 0, url: "" });
  const close = useCallback(() => {
    const current = request.current;
    current.version++;
    if (current.url) URL.revokeObjectURL(current.url);
    current.url = "";
    setSource("");
    dialog.current?.close();
  }, []);
  const show = useCallback(
    async (session: Session, pic: Picture) => {
      const current = request.current;
      const version = ++current.version;
      setShown({ session, picture: pic });
      dialog.current?.showModal();
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
    try {
      const target = await save({
        title: "保存原图",
        defaultPath: picture.name || picture.id.slice(0, 12),
      });
      if (!target) return;
      await exportImage(session.tab, picture.id, target);
    } catch (e) {
      session.setError(`保存原图失败：${e}`);
    }
  }, [shown]);
  return {
    dialog,
    source,
    name: shown?.picture.name ?? "",
    show,
    close,
    saveOriginal,
  };
}
