// Every Rust command the frontend calls. Command and argument names are part of
// the IPC contract with src-tauri and with the test doubles; do not rename them.
import { invoke } from "@tauri-apps/api/core";
import type { Diary, Picture } from "./document.ts";

/** Serialized `storage::Opened`. */
export interface Opened {
  document: Diary;
  path: string | null;
  recovered: boolean;
}

export const restore = () => invoke<Opened>("restore");
export const newDocument = () => invoke<Opened>("new_document");
export const openDocument = (path: string) =>
  invoke<Opened>("open_document", { path });
export const saveDocument = (document: Diary) =>
  invoke<void>("save_document", { document });
export const saveAs = (path: string, document: Diary) =>
  invoke<Opened>("save_as", { path, document });
/** `content` is the rendered export; `document` lets Rust copy referenced images for HTML. */
export const exportDocument = (
  path: string,
  content: string,
  html: boolean,
  document: Diary,
) => invoke<void>("export_document", { path, content, html, document });
/** The file bytes are sent as the raw request body. */
export const importImage = (bytes: ArrayBuffer) =>
  invoke<Picture>("import_image", bytes);

/** Reads a thumbnail (or the original) into a Blob URL the caller must revoke. */
export async function imageUrl(
  pic: Picture,
  original = false,
): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_image", {
    path: pic.path,
    original,
  });
  return URL.createObjectURL(new Blob([bytes]));
}
