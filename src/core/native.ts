// Every Rust command the frontend calls. Command and argument names are part of
// the IPC contract with src-tauri and with the test doubles; do not rename them.
import { invoke } from "@tauri-apps/api/core";
import type { Diary, Picture } from "./document.ts";

/** Serialized `store::Opened`. */
export interface Opened {
  document: Diary;
  path: string | null;
  recovered: boolean;
  /**
   * With `recovered`: replaces the plain "recovered" notice, e.g. when the recorded
   * file could not be reopened. Otherwise a warning, e.g. that the previous file's
   * unreferenced images could not be cleaned up.
   */
  notice: string | null;
}

/** Resumes the last session, or opens the `.hush` file LineHush was launched with. */
export const restore = () => invoke<Opened>("restore");
/** Rust emits this when a file is waiting in `takeOpenRequest` (e.g. double-clicked while running). */
export const OPEN_REQUESTED = "open-requested";
/** The `.hush` file the user asked to open from outside the window, handed out once. */
export const takeOpenRequest = () => invoke<string | null>("take_open_request");
export const newDocument = () => invoke<Opened>("new_document");
export const openDocument = (path: string) =>
  invoke<Opened>("open_document", { path });
/** Stashes unsaved edits to the crash-recovery working copy; the user's file is unchanged. */
export const stashDocument = (document: Diary) =>
  invoke<void>("stash_document", { document });
/** Writes the current (named) file. */
export const saveDocument = (document: Diary) =>
  invoke<void>("save_document", { document });
export const saveAs = (path: string, document: Diary) =>
  invoke<Opened>("save_as", { path, document });
/** Writes `content` to `path` and each original to `<its folder>/附件/<file>`. */
export const exportDocument = (
  path: string,
  content: string,
  images: { id: string; file: string }[],
) => invoke<void>("export_document", { path, content, images });
/** The file bytes are sent as the raw request body; the returned name is empty. */
export const importImage = (bytes: ArrayBuffer) =>
  invoke<Picture>("import_image", bytes);
/** Writes the original bytes of an image unchanged to `path`. */
export const exportImage = (id: string, path: string) =>
  invoke<void>("export_image", { id, path });
/**
 * Puts the originals on the system clipboard: as files, as HTML that LineHush
 * pastes back under the same ids and, for one image, as pixels. With
 * `afterBrowser` (a copy event the browser also writes) Rust lets the browser's
 * write land first and replaces it.
 */
export const copyImages = (pictures: Picture[], afterBrowser: boolean) =>
  invoke<void>("copy_images", { pictures, afterBrowser });
/**
 * The images of LineHush's last copy, made available to this document, while
 * the clipboard still holds exactly that copy; otherwise null. WebView2 shows
 * such a paste only as files, so this is how it keeps the same images.
 */
export const copiedImages = () => invoke<Picture[] | null>("copied_images");
/** Makes copied images (from any document) available to this one before they are pasted. */
export const pasteImages = (ids: string[]) =>
  invoke<void>("paste_images", { ids });
/**
 * Discards unsaved changes and drops unreferenced images; called right before the
 * window closes. Best effort: cleanup failures come back as text, not as an error.
 */
export const closeDocument = () => invoke<string | null>("close_document");

/** Reads a thumbnail (or the original) into a Blob URL the caller must revoke. */
export async function imageUrl(
  pic: Picture,
  original = false,
): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_image", {
    id: pic.id,
    original,
  });
  return URL.createObjectURL(new Blob([bytes]));
}
