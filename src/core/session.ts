import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportImages,
  fileName,
  fromText,
  toHtml,
  toText,
  type Diary,
} from "./document.ts";
import * as native from "./native.ts";
import type { Opened } from "./native.ts";
import { SaveQueue } from "./save-queue.ts";

const filter = [{ name: "LineHush 笔记", extensions: ["hush"] }];
const recoveredNotice = "已恢复未保存的修改。";
type ExportFormat = "txt" | "html";
/** The answer to "save changes to <name>?" before the document is replaced or closed. */
export type UnsavedChoice = "save" | "discard" | "cancel";
export interface SessionState {
  document: Diary;
  path: string | null;
  generation: number;
  ready: boolean;
  busy: boolean;
  importing: boolean;
  /** Changed since the last save to the user's file (stashing does not count). */
  dirty: boolean;
  error: string;
  notice: string;
  status: string;
}
export type Session = ReturnType<typeof createSession>;

/**
 * One document session owns its stash queue; React only subscribes to snapshots.
 * `confirmUnsaved` asks the user what to do with unsaved changes to the named file.
 */
export function createSession(
  confirmUnsaved: (name: string) => Promise<UnsavedChoice>,
) {
  let state: SessionState = {
    document: fromText(""),
    path: null,
    generation: 0,
    ready: false,
    busy: false,
    importing: false,
    dirty: false,
    error: "",
    notice: "",
    status: "准备就绪",
  };
  const listeners = new Set<() => void>();
  function set(patch: Partial<SessionState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  const desktop = isTauri();
  let initialization: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = makeQueue();
  /** The stash error banner is cleared by the next successful stash. */
  let stashFailed = false;
  /** The notice about recovered changes, cleared once they are saved. */
  let recoveryNotice = "";
  /** A file asked for from outside the window, waiting for the running operation to end. */
  let requested: string | null = null;
  /**
   * JSON of the content in the user's file (or of a fresh untitled document), so
   * undoing back to it clears `dirty`. Null when unknown: recovered changes.
   */
  let savedSnapshot: string | null = JSON.stringify(state.document);
  /** Status of a document with nothing to save. */
  const cleanStatus = () => (state.path ? "已保存" : "准备就绪");
  /** Edits go to the crash-recovery working copy; the user's file is left alone. */
  function makeQueue() {
    return new SaveQueue<Diary>(async (snapshot) => {
      if (!desktop) {
        set({ status: "浏览器预览 · 不写入磁盘" });
        return;
      }
      await native.stashDocument(snapshot);
    });
  }
  async function flush() {
    clearTimeout(timer);
    try {
      await queue.flush();
      if (stashFailed) {
        stashFailed = false;
        set({ error: "", status: state.dirty ? "尚未保存" : cleanStatus() });
      }
    } catch (e) {
      stashFailed = true;
      set({
        error: `暂存失败，程序意外退出时可能无法恢复最近的修改：${e}`,
        status: "暂存失败",
      });
      throw e;
    }
  }
  /** Lets the pending stash land first so it can never overwrite a later save, switch or close. */
  async function settleStash() {
    await flush().catch(() => {});
  }
  function update(doc: Diary) {
    queue.update(doc);
    const clean = savedSnapshot !== null && JSON.stringify(doc) === savedSnapshot;
    set({
      document: doc,
      dirty: !clean,
      status: clean ? cleanStatus() : "尚未保存",
    });
    clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(() => {}), 650);
  }
  function adopt(result: Opened) {
    clearTimeout(timer);
    queue = makeQueue();
    stashFailed = false;
    recoveryNotice = result.recovered
      ? (result.notice ?? recoveredNotice)
      : "";
    savedSnapshot = result.recovered ? null : JSON.stringify(result.document);
    set({
      document: result.document,
      path: result.path,
      generation: state.generation + 1,
      dirty: result.recovered,
      error: "",
      status: result.recovered
        ? "尚未保存"
        : result.path
          ? "已保存"
          : "准备就绪",
      // Otherwise Rust's notice is a warning, e.g. the previous file could not be cleaned.
      notice: result.recovered ? recoveryNotice : (result.notice ?? ""),
    });
  }
  function initialize() {
    return (initialization ??= restore());
  }
  async function restore() {
    try {
      if (desktop) adopt(await native.restore());
      else set({ status: "浏览器预览 · 不写入磁盘" });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ ready: true });
    }
  }
  /** File operations are desktop-only and never overlap. `failure` words the error banner. */
  async function guarded(
    action: () => Promise<void>,
    failure: (e: unknown) => string = String,
  ) {
    if (state.busy || !desktop) return;
    set({ busy: true });
    try {
      await action();
    } catch (e) {
      set({ error: failure(e) });
    } finally {
      set({ busy: false });
      void openPending();
    }
  }
  /** Writes the user's file; an untitled document (or `dialog`) asks for a target. False if that is cancelled. */
  async function saveFile(dialog: boolean) {
    let path = state.path;
    const pick = dialog || !path;
    if (pick) {
      path = await save({
        title: "保存日记",
        filters: filter,
        defaultPath:
          state.path ?? `${new Date().toLocaleDateString("sv-SE")}.hush`,
      });
      if (!path) return false;
    }
    await settleStash();
    const saved = state.document;
    try {
      // Save As stays available after a failed write to the current file.
      if (pick) path = (await native.saveAs(path!, saved)).path;
      else await native.saveDocument(saved);
    } catch (e) {
      set({ status: "保存失败" });
      throw `保存失败：${e}`;
    }
    queue = makeQueue();
    stashFailed = false;
    savedSnapshot = JSON.stringify(saved);
    set({
      path,
      dirty: false,
      error: "",
      status: "已保存",
      // The recovered changes are now in the user's file; other notices stay.
      notice: state.notice === recoveryNotice ? "" : state.notice,
    });
    return true;
  }
  /** Asks about unsaved changes before they are replaced or closed; false means stop. */
  async function resolveUnsaved() {
    if (state.dirty) {
      const choice = await confirmUnsaved(fileName(state.path));
      if (choice === "cancel") return false;
      if (choice === "save") return saveFile(false);
    }
    await settleStash();
    return true;
  }
  function newDocument() {
    return guarded(async () => {
      if (await resolveUnsaved()) adopt(await native.newDocument());
    });
  }
  function openDocument() {
    return guarded(async () => {
      if (!(await resolveUnsaved())) return;
      const target = await open({
        title: "打开日记",
        multiple: false,
        filters: filter,
      });
      if (typeof target === "string") adopt(await native.openDocument(target));
    });
  }
  function persist(dialog: boolean) {
    return guarded(async () => {
      await saveFile(dialog);
    });
  }
  function exportDocument(format: ExportFormat) {
    return guarded(async () => {
      const target = await save({
        title: "导出日记",
        defaultPath: `${fileName(state.path).replace(/\.hush$/, "")}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (target) {
        const doc = state.document;
        await (format === "html"
          ? native.exportDocument(target, toHtml(doc), exportImages(doc))
          : native.exportDocument(target, toText(doc), []));
      }
    }, (e) => `导出失败：${e}`);
  }
  /**
   * Asks about unsaved changes, lets Rust drop the working copy and unreferenced
   * images, then closes. That cleanup is best effort and never keeps the window;
   * only a failed save (or a failed close) does.
   */
  function close() {
    return guarded(
      async () => {
        if (!(await resolveUnsaved())) return;
        await native.closeDocument().catch(() => {});
        await getCurrentWindow().destroy();
      },
      (e) => `${e}，窗口未关闭。`,
    );
  }
  /**
   * Takes the file Rust holds for us (passed at launch, or double-clicked while
   * running) and opens it like 打开, asking about unsaved changes first.
   */
  async function openRequested() {
    if (!desktop) return;
    try {
      requested = (await native.takeOpenRequest()) ?? requested;
    } catch (e) {
      set({ error: String(e) });
    }
    await openPending();
  }
  /** Opens the requested file once no file operation or import is running. */
  async function openPending() {
    const path = requested;
    if (path === null || state.busy || state.importing) return;
    requested = null;
    await guarded(async () => {
      if (await resolveUnsaved()) adopt(await native.openDocument(path));
    });
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setError: (error: string) => set({ error }),
    setNotice: (notice: string) => set({ notice }),
    setImporting: (importing: boolean) => {
      set({ importing });
      if (!importing) void openPending();
    },
    desktop,
    update,
    /** Stashes pending edits to the working copy now instead of after the debounce. */
    flush,
    initialize,
    newDocument,
    openDocument,
    openRequested,
    /** Saves to the current file, or asks for one if the document is untitled. */
    saveDocument: () => persist(false),
    /** Always asks for a target. */
    saveDocumentAs: () => persist(true),
    exportDocument,
    close,
  };
}
