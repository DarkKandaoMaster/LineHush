import { useCallback, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { Picture } from "../core/document";
import { exportImage, imageUrl } from "../core/native";
import type { Session } from "../core/session";

/** Original-image preview in a modal <dialog>; stale reads are dropped and every Blob URL is revoked. */
export function useImagePreview(session: Session) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState("");
  const [picture, setPicture] = useState<Picture | null>(null);
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
    async (pic: Picture) => {
      const current = request.current;
      const version = ++current.version;
      setPicture(pic);
      dialog.current?.showModal();
      try {
        const url = await imageUrl(pic, true);
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
    [close, session],
  );
  /** Writes the stored original bytes, unchanged, to a file the user picks. */
  const saveOriginal = useCallback(async () => {
    if (!picture) return;
    try {
      const target = await save({
        title: "保存原图",
        defaultPath: picture.name || picture.id.slice(0, 12),
      });
      if (!target) return;
      await exportImage(picture.id, target);
      session.setNotice("已保存原图。");
    } catch (e) {
      session.setError(`保存原图失败：${e}`);
    }
  }, [picture, session]);
  return {
    dialog,
    source,
    name: picture?.name ?? "",
    show,
    close,
    saveOriginal,
  };
}
