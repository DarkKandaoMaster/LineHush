import { useCallback, useRef, useState, type RefObject } from "react";
import type { Picture } from "../core/document";
import { importImage } from "../core/native";
import type { Session } from "../core/session";
import type { DiaryEditorHandle } from "../editor/DiaryEditor";

/** Imports files one by one through Rust, then inserts them where the selection was when the import started. */
export function useImageImport(
  session: Session,
  editor: RefObject<DiaryEditorHandle | null>,
) {
  const [importing, setImporting] = useState(false);
  // Native callbacks and overlapping paste events must see the lock immediately.
  const importLock = useRef(false);
  const importFiles = useCallback(
    async (files: File[]) => {
      if (session.getSnapshot().busy || importLock.current || !files.length)
        return;
      if (!session.desktop) {
        session.setError("请在桌面版导入图片。");
        return;
      }
      const insertion = editor.current?.reserveInsertion();
      if (!insertion) return;
      importLock.current = true;
      setImporting(true);
      const images: Picture[] = [];
      try {
        for (const file of files) {
          session.setNotice(
            `正在处理图片 ${images.length + 1} / ${files.length}…`,
          );
          const pic = await importImage(await file.arrayBuffer());
          images.push({ ...pic, name: file.name });
        }
      } catch (e) {
        session.setError(String(e));
        session.setNotice("");
      }
      try {
        // Keep successfully imported images visible if a later file fails.
        if (images.length) insertion.insert(images);
        else insertion.cancel();
      } catch (e) {
        insertion.cancel();
        session.setError(String(e));
      } finally {
        importLock.current = false;
        setImporting(false);
        session.setNotice("");
      }
    },
    [session, editor],
  );
  return { importing, importLock, importFiles };
}
