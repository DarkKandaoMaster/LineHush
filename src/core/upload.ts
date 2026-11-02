// Large files go to Rust in pieces (2026-11-02, see
// docs/design/chunked-import-2026-11-02.md): under WebView2 the raw body of an
// `invoke` is read on the window's UI thread, so a file of a few hundred MB sent
// whole froze the window for seconds. A file larger than one piece is sent with
// `uploadBegin` / `uploadChunk` (one piece in memory at a time) and stored by the
// `import*Upload` command; smaller ones still go whole. A batch of imports that
// holds such a file or a folder shows the import banner (`showsProgress`). Pure
// functions, run under Node as well.
import { isFolderItem, type ImportItem } from "./folder.ts";

/** One piece of a file sent to Rust; a file of at most this size is sent whole. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** The most an imported file may hold (Rust checks it too). */
export const FILE_LIMIT = 256 * 1024 * 1024;
/** As Rust words it (`images::check_file_size`). */
export const FILE_TOO_LARGE = "文件过大（上限 256 MB）";

/** Turns a file away before anything is sent when it is over the limit. */
export function checkFileSize(size: number) {
  if (size > FILE_LIMIT) throw new Error(FILE_TOO_LARGE);
}

/** Whether a file of `size` bytes is sent in pieces. */
export const isChunked = (size: number) => size > CHUNK_BYTES;

/** The `[start, end)` byte ranges of the pieces of a file of `size` bytes; none when empty. */
export function chunkRanges(size: number, chunk = CHUNK_BYTES): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = 0; start < size; start += chunk)
    ranges.push([start, Math.min(start + chunk, size)]);
  return ranges;
}

/** Whole percent of `total` bytes sent once `done` are: 100 only when all are. */
export const uploadPercent = (done: number, total: number) =>
  total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : 100;

/**
 * Whether a batch of imports (everything one drop, paste or file dialog
 * brings) shows the import banner, from its start to its end (2026-11-03): when
 * it holds a file sent in pieces (`isChunked`, whatever its kind) or a folder
 * (dropped or pasted, whatever its size); small files alone show nothing.
 */
export const showsProgress = (items: ImportItem[]) =>
  items.some((item) => isFolderItem(item) || isChunked(item.size));

/** What the import banner shows: the item of the batch being inserted. */
export interface ImportProgress {
  /** The file's name; for a folder, `<folder>.zip`. */
  name: string;
  /** Which item of the batch (from 1) and how many it holds (a folder counts once). */
  index: number;
  total: number;
  /**
   * How far this item has got: of a large file's bytes sent (100 while Rust
   * stores it), of a dropped folder's bytes zipped; null for an item sent in
   * one go (a small file, a pasted folder) or one not yet under way, which
   * shows no percent and no bar.
   */
  percent: number | null;
}

/** `正在插入“name”… 45%`, or `正在插入 2 / 5：“name”… 45%` within a batch; no percent when it is null. */
export function progressText({ name, index, total, percent }: ImportProgress) {
  const what = total > 1 ? `正在插入 ${index} / ${total}：“${name}”…` : `正在插入“${name}”…`;
  return percent === null ? what : `${what} ${percent}%`;
}

/**
 * How far a dropped folder has been zipped: by bytes once `doneBytes` of
 * `totalBytes` are in; when its files hold no bytes at all, by files
 * (`doneFiles` of `totalFiles`); 100 when it has no files either.
 */
export const folderPercent = (
  doneBytes: number,
  totalBytes: number,
  doneFiles: number,
  totalFiles: number,
) => (totalBytes > 0 ? uploadPercent(doneBytes, totalBytes) : uploadPercent(doneFiles, totalFiles));

/** Whether two banner states show the same (so the session need not change). */
export const sameProgress = (a: ImportProgress | null, b: ImportProgress | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.name === b.name &&
    a.index === b.index &&
    a.total === b.total &&
    a.percent === b.percent);
