// A folder dropped or pasted into a note goes in as one attached file,
// `<folder name>.zip`, packed by Rust (store, no compression; see
// docs/proposals/folder-zip-2026-11-01.md). A dropped folder is read here, in
// the page (the browser hands out entries, not paths), and sent to Rust file by
// file; a pasted one Rust reads from disk itself (`importFolder`). Everything
// below runs under Node as well (the entries are duck-typed).

/** The most a folder may hold, as for any attached file (Rust checks it too). */
export const FOLDER_LIMIT = 256 * 1024 * 1024;
export const FOLDER_TOO_LARGE = "文件夹过大（上限 256 MB）";

/** A file inside a folder: its path below the folder, `/`-separated, without the folder's own name. */
export interface FolderFile {
  path: string;
  file: File;
}
/** A dropped folder as read in the page. */
export interface DroppedFolder {
  name: string;
  /** Every file, in the order the entries came. */
  files: FolderFile[];
  /** Every folder below it (empty ones too), parents before their children. */
  dirs: string[];
}
/**
 * A folder to insert: dropped (`read` lists its content, in the page) or
 * pasted (Rust reads `path` from disk).
 */
export type FolderItem =
  | { folder: string; read: () => Promise<DroppedFolder> }
  | { folder: string; path: string };
/** What a drop, a paste or the file input hands to the import, in its order. */
export type ImportItem = File | FolderItem;

export const isFolderItem = (item: ImportItem): item is FolderItem =>
  typeof (item as { folder?: unknown }).folder === "string";

/** The attached file a folder becomes. */
export const zipName = (folder: string) => `${folder}.zip`;

/** `name` inside the folder at `parent` ("" for the folder itself). */
export const childPath = (parent: string, name: string) =>
  parent ? `${parent}/${name}` : name;

/** The sum of the folder's file sizes. */
export const folderSize = (folder: DroppedFolder) =>
  folder.files.reduce((sum, { file }) => sum + file.size, 0);

/** Turns a folder away before anything is sent when it holds more than the limit. */
export function checkFolderSize(folder: DroppedFolder) {
  if (folderSize(folder) > FOLDER_LIMIT) throw new Error(FOLDER_TOO_LARGE);
}

/**
 * The files of a paste without the folders Rust found on the clipboard:
 * Chromium may hand a copied folder over as an empty file of the same name and
 * no type.
 */
export function withoutFolderStubs<F extends { name: string; size: number; type: string }>(
  files: F[],
  folders: { name: string }[],
): F[] {
  const names = new Set(folders.map((folder) => folder.name));
  return files.filter(
    (file) => !(names.has(file.name) && file.size === 0 && file.type === ""),
  );
}

// What `FileSystemEntry` and its kinds offer (webkitGetAsEntry), as far as used here.
export interface EntryLike {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}
export interface FileEntryLike extends EntryLike {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}
export interface DirectoryEntryLike extends EntryLike {
  createReader(): DirectoryReaderLike;
}
export interface DirectoryReaderLike {
  readEntries(
    success: (entries: EntryLike[]) => void,
    failure?: (error: unknown) => void,
  ): void;
}

/** All entries of a folder: each call hands out a part (Chromium: up to 100), an empty one at the end. */
async function readAll(dir: DirectoryEntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader();
  const all: EntryLike[] = [];
  for (;;) {
    const part = await new Promise<EntryLike[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!part.length) return all;
    all.push(...part);
  }
}

/**
 * Lists a dropped folder, depth first in the order the entries come (not
 * sorted). Fails with `无法读取“path”` naming what could not be read (no
 * permission, gone since the drop).
 */
export async function readFolder(entry: DirectoryEntryLike): Promise<DroppedFolder> {
  const folder: DroppedFolder = { name: entry.name, files: [], dirs: [] };
  const unreadable = (path: string) => new Error(`无法读取“${path || entry.name}”`);
  async function walk(dir: DirectoryEntryLike, parent: string) {
    let entries: EntryLike[];
    try {
      entries = await readAll(dir);
    } catch {
      throw unreadable(parent);
    }
    for (const child of entries) {
      const path = childPath(parent, child.name);
      if (child.isDirectory) {
        folder.dirs.push(path);
        await walk(child as DirectoryEntryLike, path);
      } else if (child.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (child as FileEntryLike).file(resolve, reject),
        ).catch(() => {
          throw unreadable(path);
        });
        folder.files.push({ path, file });
      }
    }
  }
  await walk(entry, "");
  return folder;
}

/** A file's bytes, failing with `无法读取“path”` (changed or gone since the drop). */
export const readBytes = ({ path, file }: FolderFile) =>
  file.arrayBuffer().catch(() => {
    throw new Error(`无法读取“${path}”`);
  });
