import { useCallback, useMemo, type RefObject } from "react";
import type { Picture } from "../core/document";
import {
  copiedImages,
  copyImages,
  importImage,
  pasteImages,
} from "../core/native";
import type { Session } from "../core/session";
import type { DiaryEditorHandle } from "../editor/DiaryEditor";

/** `<12 hex digits of the id>-<name>`: how a LineHush copy names its files. */
const STAGED = /^([0-9a-f]{12})-(.+)$/;

/**
 * Image import, paste and copy for one tab:
 * - `importFiles` imports files one by one through Rust; pasted files that are
 *   still LineHush's last copy are not imported but used as they are;
 * - `pasteCopied` pastes images copied in LineHush under the same ids and in
 *   the same rows, after Rust has made sure this document holds their originals;
 * - `copy` puts selected images on the system clipboard.
 * Imported and pasted images go where the selection was when the work started.
 */
export function useImageImport(
  session: Session,
  editor: RefObject<DiaryEditorHandle | null>,
) {
  /** Runs `load` under the import lock, then inserts what it produced. */
  const insertAfter = useCallback(
    async (
      count: number,
      load: (images: Picture[], rows: boolean[]) => Promise<void>,
      failure: (e: unknown) => string,
    ) => {
      // The session snapshot updates synchronously, so overlapping paste events see the lock.
      if (session.getSnapshot().importing || !count) return;
      if (!session.desktop) {
        session.setError("请在桌面版导入图片。");
        return;
      }
      const insertion = editor.current?.reserveInsertion();
      if (!insertion) return;
      session.setImporting(true);
      const images: Picture[] = [];
      // Which images start a new row; only a paste of copied rows has any.
      const rows: boolean[] = [];
      try {
        await load(images, rows);
      } catch (e) {
        session.setError(failure(e));
      } finally {
        // Unlock first so a throwing insertion cannot leave the lock held.
        session.setImporting(false);
        // Keep successfully imported images visible if a later file fails.
        try {
          if (images.length) insertion.insert(images, rows);
          else insertion.cancel();
        } catch (e) {
          session.setError(String(e));
        }
      }
    },
    [session, editor],
  );
  const importFiles = useCallback(
    (files: File[], fromClipboard = false) => {
      let current = "";
      return insertAfter(
        files.length,
        async (images, rows) => {
          if (fromClipboard) {
            const copied = await copiedImages(session.tab);
            if (copied) {
              images.push(...copied.pictures);
              rows.push(...copied.rows);
              return;
            }
          }
          for (const file of files) {
            current = file.name;
            const pic = await importImage(session.tab, await file.arrayBuffer());
            // A file a LineHush copy left (e.g. from an earlier session) keeps
            // its original name.
            const staged = STAGED.exec(file.name);
            const name =
              staged && pic.id.startsWith(staged[1]) ? staged[2] : file.name;
            images.push({ ...pic, name });
          }
        },
        // Rust says why (format, damage, size); the name says which file.
        (e) =>
          current ? `无法插入图片“${current}”：${e}` : `无法插入图片：${e}`,
      );
    },
    [insertAfter, session],
  );
  const pasteCopied = useCallback(
    (pictures: Picture[], copiedRows: boolean[]) =>
      insertAfter(
        pictures.length,
        async (images, rows) => {
          await pasteImages(
            session.tab,
            pictures.map((pic) => pic.id),
          );
          images.push(...pictures);
          rows.push(...copiedRows);
        },
        (e) => `无法粘贴图片：${e}`,
      ),
    [insertAfter, session],
  );
  const copy = useCallback(
    (pictures: Picture[], rows: boolean[], afterBrowser: boolean) => {
      if (!session.desktop) return false;
      copyImages(session.tab, pictures, rows, afterBrowser).catch((e) =>
        session.setError(`复制图片失败：${e}`),
      );
      return true;
    },
    [session],
  );
  return useMemo(
    () => ({ importFiles, pasteCopied, copy }),
    [importFiles, pasteCopied, copy],
  );
}
