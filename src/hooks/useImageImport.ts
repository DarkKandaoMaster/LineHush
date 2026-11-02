import { useCallback, useMemo, type RefObject } from "react";
import type { Block, Picture } from "../core/document";
import {
  clipboardFolders,
  copiedImages,
  copyImages,
  importFile,
  importFileUpload,
  importFolder,
  importImage,
  importImageUpload,
  importMedia,
  importMediaUpload,
  mediaPoster,
  pasteImages,
  stageImages,
  uploadAbort,
  uploadBegin,
  uploadChunk,
  zipAbort,
  zipAdd,
  zipAddDir,
  zipBegin,
  zipFinish,
} from "../core/native";
import { isImageFile, isMediaFile, probeMedia } from "../core/media-probe";
import {
  checkFolderSize,
  folderSize,
  isFolderItem,
  readBytes,
  withoutFolderStubs,
  zipName,
  type FolderItem,
  type ImportItem,
} from "../core/folder";
import {
  checkFileSize,
  chunkRanges,
  folderPercent,
  isChunked,
  sameProgress,
  showsProgress,
  uploadPercent,
  type ImportProgress,
} from "../core/upload";
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
 *   anything neither an image nor media goes in as a file, unchanged; a
 *   folder (dropped, or found by Rust on the clipboard of a paste) goes in as
 *   one file, `<folder name>.zip`, which Rust packs (`importFolderItem`).
 *   A file over 256 MB is turned away before anything is sent; one larger
 *   than `CHUNK_BYTES` is sent in pieces (`sendFile`). A batch holding such
 *   a file or a folder shows the import banner from its start to its end
 *   (`batchProgress`);
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
    (items: ImportItem[], fromClipboard = false) => {
      // A paste without files may still hold folders (asked of Rust below).
      if (!items.length && !fromClipboard) return;
      let current = "";
      // What the failing item is ("图片", "文件夹" or "" for anything else).
      let what = "";
      const images: Picture[] = [];
      // Which images start a new row; only a paste of copied rows has any.
      const rows: boolean[] = [];
      return locked(
        async () => {
          const progress = batchProgress(session);
          try {
            await importAll(progress);
          } finally {
            progress.end();
          }
        },
        // Rust (or the probe) says why (format, damage, size); the name says
        // which file.
        (e) => {
          const reason = e instanceof Error ? e.message : String(e);
          return current
            ? `无法插入${what}“${current}”：${reason}`
            : `无法插入${what}：${reason}`;
        },
        // Successfully imported images stay if a later file fails.
        (insertion) =>
          images.length ? insertion.insert(images, rows) : insertion.cancel(),
      );
      async function importAll(progress: BatchProgress) {
        if (fromClipboard) {
          const copied = await copiedImages(session.tab);
          if (copied) {
            images.push(...copied.pictures);
            rows.push(...copied.rows);
            return;
          }
          // Copied folders: the page sees them at most as empty files, so
          // Rust reads them from the clipboard and packs them from disk,
          // after the files.
          const folders = await clipboardFolders().catch(() => []);
          items = [
            ...withoutFolderStubs(items as File[], folders),
            ...folders.map(({ name, path }) => ({ folder: name, path })),
          ];
        }
        // Known only now (a paste may add folders): small files alone show nothing.
        progress.start(showsProgress(items));
        for (const [i, item] of items.entries()) {
          // The banner names a folder by the file it becomes.
          progress.item(isFolderItem(item) ? zipName(item.folder) : item.name, i + 1, items.length);
          if (isFolderItem(item)) {
            current = item.folder;
            what = "文件夹";
            const stored = await importFolderItem(session.tab, item, progress.percent);
            images.push({
              ...stored,
              name: zipName(item.folder),
              kind: "file",
            });
            continue;
          }
          const file = item;
          current = file.name;
          const image = isImageFile(file);
          what = image ? "图片" : "";
          checkFileSize(file.size);
          /** Sends the file whole, or in pieces when large (see `sendFile`). */
          const send = (
            whole: (bytes: ArrayBuffer) => Promise<Picture>,
            uploaded: (upload: string) => Promise<Picture>,
          ) =>
            isChunked(file.size)
              ? sendFile(session.tab, file, progress.percent, uploaded)
              : file.arrayBuffer().then(whole);
          const tab = session.tab;
          let pic: Picture;
          if (image)
            pic = await send(
              (bytes) => importImage(tab, bytes),
              (upload) => importImageUpload(tab, upload),
            );
          else if (isMediaFile(file)) {
            // Reads the file through a blob URL, not into memory.
            const probe = await probeMedia(file);
            const { poster, ...meta } = probe;
            const stored = await send(
              (bytes) => importMedia(tab, bytes, meta),
              (upload) => importMediaUpload(tab, upload, meta),
            );
            pic = {
              ...stored,
              kind: stored.kind ?? meta.kind,
              duration: stored.duration ?? meta.duration,
            };
            // Before the node is made, which reads it as the thumbnail.
            if (poster)
              await mediaPoster(session.tab, pic.id, await poster.arrayBuffer());
          } else {
            const stored = await send(
              (bytes) => importFile(tab, bytes),
              (upload) => importFileUpload(tab, upload),
            );
            pic = {
              ...stored,
              kind: "file",
              size: stored.size ?? file.size,
            };
          }
          // A file a LineHush copy left (e.g. from an earlier session) keeps
          // its original name.
          const staged = STAGED.exec(file.name);
          const name =
            staged && pic.id.startsWith(staged[1]) ? staged[2] : file.name;
          images.push({ ...pic, name });
        }
      }
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

interface BatchProgress {
  /** The items are known: whether the banner shows (see `showsProgress`). */
  start(shown: boolean): void;
  /** Item `index` of `total` (from 1), named `name`, starts; it has no percent yet. */
  item(name: string, index: number, total: number): void;
  /** How far the current item has got. */
  percent(percent: number): void;
  /** The batch is over (done or failed): the banner goes. */
  end(): void;
}

/**
 * The import banner of one batch (2026-11-03): when the batch holds a file
 * sent in pieces or a folder (`showsProgress`) it shows the current item from
 * the first one on, small files too, until `end`; otherwise the session is
 * left alone. The session changes only
 * when what the banner shows does.
 */
function batchProgress(session: Session): BatchProgress {
  let state: ImportProgress | null = null;
  let shown = false;
  const publish = () => {
    const next = shown ? state : null;
    if (!sameProgress(session.getSnapshot().importProgress, next))
      session.setImportProgress(next);
  };
  return {
    start(show) {
      shown = show;
    },
    item(name, index, total) {
      state = { name, index, total, percent: null };
      publish();
    },
    percent(percent) {
      if (!state) return;
      state = { ...state, percent };
      publish();
    },
    end() {
      state = null;
      publish();
    },
  };
}

/**
 * Sends a file larger than one piece to Rust piece by piece (only one piece in
 * memory at once), telling `progress` the percent sent (100 while Rust stores
 * it), then has `store` import it. A failure drops the unfinished upload.
 */
async function sendFile(
  tab: string,
  file: File,
  progress: (percent: number) => void,
  store: (upload: string) => Promise<Picture>,
): Promise<Picture> {
  progress(0);
  const upload = await uploadBegin(tab);
  try {
    for (const [start, end] of chunkRanges(file.size)) {
      await uploadChunk(upload, await file.slice(start, end).arrayBuffer());
      progress(uploadPercent(end, file.size));
    }
    return await store(upload);
  } catch (e) {
    await uploadAbort(upload).catch(() => {});
    throw e;
  }
}

/**
 * Packs a folder into `<name>.zip` in the tab's document: a pasted one Rust
 * reads from disk (no percent); a dropped one is listed here, checked against
 * the size limit before anything is sent, and sent to Rust one file at a time
 * (only one file's bytes in memory at once), telling `progress` the percent of
 * its bytes sent (`folderPercent`). A failure drops the unfinished zip.
 */
async function importFolderItem(
  tab: string,
  item: FolderItem,
  progress: (percent: number) => void,
): Promise<Picture> {
  if ("path" in item) return importFolder(tab, item.path);
  const folder = await item.read();
  checkFolderSize(folder);
  const totalBytes = folderSize(folder);
  const totalFiles = folder.files.length;
  let doneBytes = 0;
  let doneFiles = 0;
  const report = () => progress(folderPercent(doneBytes, totalBytes, doneFiles, totalFiles));
  report();
  const zip = await zipBegin(tab, item.folder);
  try {
    for (const dir of folder.dirs) await zipAddDir(zip, dir);
    for (const file of folder.files) {
      await zipAdd(zip, file.path, await readBytes(file));
      doneBytes += file.file.size;
      doneFiles += 1;
      report();
    }
    const stored = await zipFinish(zip);
    return { ...stored, size: stored.size ?? folderSize(folder) };
  } catch (e) {
    await zipAbort(zip).catch(() => {});
    throw e;
  }
}
