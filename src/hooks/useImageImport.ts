import { useCallback, type RefObject } from "react";
import type { Picture } from "../core/document";
import { importImage } from "../core/native";
import type { Session } from "../core/session";
import type { DiaryEditorHandle } from "../editor/DiaryEditor";

/** Imports files one by one through Rust, then inserts them where the selection was when the import started. */
export function useImageImport(
  session: Session,
  editor: RefObject<DiaryEditorHandle | null>,
) {
  return useCallback(
    async (files: File[]) => {
      // The session snapshot updates synchronously, so overlapping paste events see the lock.
      if (session.getSnapshot().importing || !files.length) return;
      if (!session.desktop) {
        session.setError("请在桌面版导入图片。");
        return;
      }
      const insertion = editor.current?.reserveInsertion();
      if (!insertion) return;
      session.setImporting(true);
      const images: Picture[] = [];
      let current = "";
      try {
        for (const file of files) {
          current = file.name;
          session.setNotice(
            `正在处理图片 ${images.length + 1} / ${files.length}…`,
          );
          const pic = await importImage(await file.arrayBuffer());
          images.push({ ...pic, name: file.name });
        }
      } catch (e) {
        // Rust says why (format, damage, size); the name says which file.
        session.setError(
          current ? `无法插入图片“${current}”：${e}` : `无法插入图片：${e}`,
        );
      } finally {
        // Unlock first so a throwing insertion cannot leave the lock held.
        session.setImporting(false);
        session.setNotice("");
        // Keep successfully imported images visible if a later file fails.
        try {
          if (images.length) insertion.insert(images);
          else insertion.cancel();
        } catch (e) {
          session.setError(String(e));
        }
      }
    },
    [session, editor],
  );
}
