import { useCallback, useRef, useState } from "react";
import type { Picture } from "../core/document";
import { imageUrl } from "../core/native";
import type { Session } from "../core/session";

/** Original-image preview in a modal <dialog>; stale reads are dropped and every Blob URL is revoked. */
export function useImagePreview(session: Session) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
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
      close();
      const current = request.current;
      const version = ++current.version;
      setName(pic.name);
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
        session.setError(String(e));
      }
    },
    [close, session],
  );
  return { dialog, source, name, show, close };
}
