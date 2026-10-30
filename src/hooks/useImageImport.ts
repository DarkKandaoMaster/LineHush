import { useCallback, useMemo, type RefObject } from "react";
import type { Block, Picture } from "../core/document";
import {
  copiedImages,
  copyImages,
  importImage,
  importMedia,
  mediaPoster,
  pasteImages,
  stageImages,
} from "../core/native";
import { isMediaFile, probeMedia } from "../core/media-probe";
import { blockPictures, withoutPictures } from "../editor/image-view";
import type { Session } from "../core/session";
import type { DiaryEditorHandle, EditorImages } from "../editor/DiaryEditor";

/** `<12 hex digits of the id>-<name>`: how a LineHush copy names its files. */
const STAGED = /^([0-9a-f]{12})-(.+)$/;

type Insertion = ReturnType<DiaryEditorHandle["reserveInsertion"]>;

/**
 * Image import, paste and copy for one tab:
 * - `importFiles` imports files one by one through Rust; pasted files that are
 *   still LineHush's last copy are not imported but used as they are. Videos
 *   and recordings are read in the page first (`probeMedia`: length, frame
 *   size, a video's cover frame), which turns away what WebView2 cannot play;
 * - `pasteBlocks` pastes images with text lines copied in LineHush, also from
 *   another document, once Rust has made those images available here;
 * - `copy` puts selected images on the system clipboard, `stage` keeps copies
 *   of images copied with text lines.
 * Imported and pasted images go where the selection was when the work started.
 */
export function useImageImport(
  session: Session,
  editor: RefObject<DiaryEditorHandle | null>,
): EditorImages {
  /**
   * Runs `work` under the import lock, then `finish` inserts what it produced
   * at the place reserved before it started (also after a failure).
   */
  const locked = useCallback(
    async (
      work: () => Promise<void>,
      failure: (e: unknown) => string,
      finish: (insertion: Insertion) => void,
    ) => {
      // The session snapshot updates synchronously, so overlapping paste events see the lock.
      if (session.getSnapshot().importing) return;
      const insertion = editor.current?.reserveInsertion();
      if (!insertion) return;
      session.setImporting(true);
      try {
        await work();
      } catch (e) {
        session.setError(failure(e));
      } finally {
        // Unlock first so a throwing insertion cannot leave the lock held.
        session.setImporting(false);
        try {
          finish(insertion);
        } catch (e) {
          session.setError(String(e));
        }
      }
    },
    [session, editor],
  );
  const importFiles = useCallback(
    (files: File[], fromClipboard = false) => {
      if (!files.length) return;
      let current = "";
      let media = false;
      const images: Picture[] = [];
      // Which images start a new row; only a paste of copied rows has any.
      const rows: boolean[] = [];
      return locked(
        async () => {
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
            media = isMediaFile(file);
            let pic: Picture;
            if (media) {
              const probe = await probeMedia(file);
              const { poster, ...meta } = probe;
              const stored = await importMedia(
                session.tab,
                await file.arrayBuffer(),
                meta,
              );
              pic = {
                ...stored,
                kind: stored.kind ?? meta.kind,
                duration: stored.duration ?? meta.duration,
              };
              // Before the node is made, which reads it as the thumbnail.
              if (poster)
                await mediaPoster(session.tab, pic.id, await poster.arrayBuffer());
            } else pic = await importImage(session.tab, await file.arrayBuffer());
            // A file a LineHush copy left (e.g. from an earlier session) keeps
            // its original name.
            const staged = STAGED.exec(file.name);
            const name =
              staged && pic.id.startsWith(staged[1]) ? staged[2] : file.name;
            images.push({ ...pic, name });
          }
        },
        // Rust (or the probe) says why (format, damage, size); the name says
        // which file.
        (e) => {
          const reason = e instanceof Error ? e.message : String(e);
          const what = media ? "" : "图片";
          return current
            ? `无法插入${what}“${current}”：${reason}`
            : `无法插入${what}：${reason}`;
        },
        // Successfully imported images stay if a later file fails.
        (insertion) =>
          images.length ? insertion.insert(images, rows) : insertion.cancel(),
      );
    },
    [locked, session],
  );
  const pasteBlocks = useCallback(
    (blocks: Block[]) => {
      let missing: string[] | null = null;
      return locked(
        async () => {
          missing = await pasteImages(
            session.tab,
            blockPictures(blocks).map((pic) => pic.id),
          );
        },
        (e) => `无法粘贴图片：${e}`,
        (insertion) => {
          if (missing === null) return insertion.cancel();
          // Images that are gone are left out; the text goes in all the same.
          insertion.insertBlocks(withoutPictures(blocks, missing));
          if (missing.length) session.setError("剪贴板中的部分图片已不可用");
        },
      );
    },
    [locked, session],
  );
  const stage = useCallback(
    (pictures: Picture[]) => {
      if (!pictures.length) return;
      stageImages(session.tab, pictures).catch((e) =>
        session.setError(`复制图片失败：${e}`),
      );
    },
    [session],
  );
  const copy = useCallback(
    (pictures: Picture[], rows: boolean[]) => {
      copyImages(session.tab, pictures, rows).catch((e) =>
        session.setError(`复制图片失败：${e}`),
      );
    },
    [session],
  );
  return useMemo(
    () => ({ importFiles, pasteBlocks, copy, stage }),
    [importFiles, pasteBlocks, copy, stage],
  );
}
