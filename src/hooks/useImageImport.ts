import { useCallback, useMemo, type RefObject } from "react";
import type { Block, Picture } from "../core/document";
import {
  copiedImages,
  copyImages,
  importImage,
  pasteImages,
  stageImages,
} from "../core/native";
import { blockPictures, withoutPictures } from "../editor/image-view";
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
 * - `pasteBlocks` pastes images with text lines copied in LineHush, also from
 *   another document, once Rust has made those images available here;
 * - `copy` puts selected images on the system clipboard, `stage` keeps copies
 *   of images copied with text lines.
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
          const missing = await pasteImages(
            session.tab,
            pictures.map((pic) => pic.id),
          );
          if (missing.length) throw "剪贴板中的图片已不可用，请重新复制";
          images.push(...pictures);
          rows.push(...copiedRows);
        },
        (e) => `无法粘贴图片：${e}`,
      ),
    [insertAfter, session],
  );
  const pasteBlocks = useCallback(
    async (blocks: Block[]) => {
      if (session.getSnapshot().importing) return;
      if (!session.desktop) {
        session.setError("请在桌面版导入图片。");
        return;
      }
      const insertion = editor.current?.reserveInsertion();
      if (!insertion) return;
      session.setImporting(true);
      let missing: string[] | null = null;
      try {
        missing = await pasteImages(
          session.tab,
          blockPictures(blocks).map((pic) => pic.id),
        );
      } catch (e) {
        session.setError(`无法粘贴图片：${e}`);
      } finally {
        session.setImporting(false);
        try {
          if (missing === null) insertion.cancel();
          else {
            // Images that are gone are left out; the text goes in all the same.
            insertion.insertBlocks(withoutPictures(blocks, missing));
            if (missing.length) session.setError("剪贴板中的部分图片已不可用");
          }
        } catch (e) {
          session.setError(String(e));
        }
      }
    },
    [session, editor],
  );
  const stage = useCallback(
    (pictures: Picture[]) => {
      if (!session.desktop || !pictures.length) return;
      stageImages(session.tab, pictures).catch((e) =>
        session.setError(`复制图片失败：${e}`),
      );
    },
    [session],
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
    () => ({ importFiles, pasteCopied, pasteBlocks, copy, stage }),
    [importFiles, pasteCopied, pasteBlocks, copy, stage],
  );
}
