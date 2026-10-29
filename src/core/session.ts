import { save } from "@tauri-apps/plugin-dialog";
import {
  exportImages,
  fromText,
  suggestedName,
  toHtml,
  toPrintHtml,
  toText,
  type Diary,
} from "./document.ts";
import * as native from "./native.ts";
import type { Opened } from "./native.ts";
import { SaveQueue } from "./save-queue.ts";
import {
  cssFontFamily,
  type DefaultFileName,
  type Settings,
} from "./settings.ts";

/** File dialog filter for `.hush` documents. */
export const HUSH_FILTER = [{ name: "LineHush 笔记", extensions: ["hush"] }];
export type ExportFormat = "txt" | "html" | "pdf";
/** The answer to "save changes to <name>?" before the document is replaced or closed. */
export type UnsavedChoice = "save" | "discard" | "cancel";
export interface SessionState {
  document: Diary;
  path: string | null;
  /** Bumped whenever another document is loaded into the tab; the editor remounts. */
  generation: number;
  /** A file operation is running; another one is not started (`guarded`). */
  busy: boolean;
  /**
   * The editor is disabled and the file buttons greyed: a dialog is up or a long
   * operation runs. Saving a named file (Ctrl+S) is busy but never locked, so the
   * editor keeps its focus and the page does not flicker.
   */
  locked: boolean;
  importing: boolean;
  /** Changed since the last save to the user's file (stashing does not count). */
  dirty: boolean;
  error: string;
  notice: string;
  /** The last save failed (the error banner offers 重试保存) and nothing changed since. */
  saveFailed: boolean;
}
export type Session = ReturnType<typeof createSession>;
/** JSON of a new untitled document (Rust's `Diary::empty`): one empty line. */
const EMPTY = JSON.stringify(fromText(""));

/**
 * The document of one tab. It owns its stash queue; React only subscribes to
 * snapshots. `confirmUnsaved` asks the user what to do with unsaved changes to
 * the named document; `displayName` names this tab ("x.hush", "无标题 2");
 * `defaultFileName` gives the “默认文件名” setting when an untitled document is
 * saved. The caller loads the first document with `adopt`.
 */
export function createSession(
  tab: string,
  confirmUnsaved: (name: string) => Promise<UnsavedChoice>,
  displayName: () => string,
  defaultFileName: () => DefaultFileName = () => "date",
) {
  let state: SessionState = {
    document: fromText(""),
    path: null,
    generation: 0,
    busy: false,
    locked: false,
    importing: false,
    dirty: false,
    error: "",
    notice: "",
    saveFailed: false,
  };
  const listeners = new Set<() => void>();
  function set(patch: Partial<SessionState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = makeQueue();
  /** The stash error banner is cleared by the next successful stash. */
  let stashFailed = false;
  /** Rust's notice about recovered changes (if any), cleared once they are saved. */
  let recoveryNotice = "";
  /** Set once Rust has dropped the tab; nothing is stashed after that. */
  let released = false;
  /**
   * The user's file is being written. Edits still go into the queue but are not
   * stashed until it is done: Rust empties the working copy when the save lands,
   * which would lose a stash that landed just before it.
   */
  let saving = false;
  /**
   * JSON of the content in the user's file (or of a fresh untitled document), so
   * undoing back to it clears `dirty`. Null when unknown: recovered changes to a
   * file. Recovered changes to an untitled document count against the empty
   * document (Rust recovers an untitled stash only when it is not empty), so
   * deleting everything leaves nothing to save.
   */
  let savedSnapshot: string | null = EMPTY;
  /** Edits go to the crash-recovery working copy; the user's file is left alone. */
  function makeQueue() {
    return new SaveQueue<Diary>(async (snapshot) => {
      if (!released) await native.stashDocument(tab, snapshot);
    });
  }
  async function flush() {
    clearTimeout(timer);
    // Edits made during a save are stashed once it has landed (`saveFile`).
    if (saving) return;
    try {
      await queue.flush();
      if (stashFailed) {
        stashFailed = false;
        set({ error: "", saveFailed: false });
      }
    } catch (e) {
      stashFailed = true;
      set({
        error: `暂存失败，程序意外退出时可能无法恢复最近的修改：${e}`,
        saveFailed: false,
      });
      throw e;
    }
  }
  /** Lets the pending stash land first so it can never overwrite a later save, switch or close. */
  async function settleStash() {
    await flush().catch(() => {});
  }
  /** Stashes the queued edits once the editor has been quiet for a moment. */
  function scheduleStash() {
    clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(() => {}), 650);
  }
  function isClean(doc: Diary) {
    return savedSnapshot !== null && JSON.stringify(doc) === savedSnapshot;
  }
  function update(doc: Diary) {
    if (released) return;
    queue.update(doc);
    set({ document: doc, dirty: !isClean(doc), saveFailed: false });
    if (!saving) scheduleStash();
  }
  /** Shows a document Rust loaded into this tab (new, opened or recovered). */
  function adopt(result: Opened) {
    clearTimeout(timer);
    queue = makeQueue();
    stashFailed = false;
    recoveryNotice = result.recovered ? (result.notice ?? "") : "";
    savedSnapshot = !result.recovered
      ? JSON.stringify(result.document)
      : result.path === null
        ? EMPTY
        : null;
    set({
      document: result.document,
      path: result.path,
      generation: state.generation + 1,
      dirty: result.recovered,
      error: "",
      saveFailed: false,
      // Otherwise Rust's notice is a warning, e.g. the previous file could not be cleaned.
      notice: result.recovered ? recoveryNotice : (result.notice ?? ""),
    });
  }
  /**
   * File operations never overlap. `failure` words the error banner. The action
   * calls `lock` when it puts up a dialog or takes long; both flags clear at the end.
   */
  async function guarded(
    action: () => Promise<void>,
    failure: (e: unknown) => string = String,
  ) {
    if (state.busy) return;
    set({ busy: true });
    try {
      await action();
    } catch (e) {
      set({ error: failure(e) });
    } finally {
      set({ busy: false, locked: false });
    }
  }
  /** Disables the editor and greys the file buttons until the operation ends. */
  function lock() {
    if (!state.locked) set({ locked: true });
  }
  /**
   * Writes the user's file; an untitled document (or `dialog`) asks for a target.
   * False if that is cancelled. An untitled document's dialog starts at a free
   * name (`suggestedName`) in the folder last opened or saved to (Rust).
   *
   * Only the dialog locks the page: writing to the current file takes a few tens
   * of milliseconds and the editor stays editable and focused through it. What is
   * typed meanwhile is dirty afterwards and stashed as usual.
   */
  async function saveFile(dialog: boolean) {
    let path = state.path;
    const pick = dialog || !path;
    if (pick) {
      lock();
      path = await save({
        title: "保存笔记",
        filters: HUSH_FILTER,
        defaultPath:
          state.path ??
          (await native.suggestSavePath(
            suggestedName(state.document, defaultFileName()),
          )),
      });
      if (!path) return false;
    }
    await settleStash();
    const saved = state.document;
    saving = true;
    try {
      // Save As stays available after a failed write to the current file.
      if (pick) path = (await native.saveAs(tab, path!, saved)).path;
      else await native.saveDocument(tab, saved);
    } catch (e) {
      saving = false;
      // Edits made meanwhile are stashed now; 重试保存 only while nothing changed.
      if (queue.dirty) scheduleStash();
      set({ saveFailed: state.document === saved });
      throw `保存失败：${e}`;
    }
    saving = false;
    queue = makeQueue();
    stashFailed = false;
    savedSnapshot = JSON.stringify(saved);
    // Edits made during the save go to the (now emptied) working copy as usual.
    const current = state.document;
    if (current !== saved) {
      queue.update(current);
      scheduleStash();
    }
    set({
      path,
      dirty: !isClean(current),
      error: "",
      saveFailed: false,
      // The recovered changes are now in the user's file; other notices stay.
      notice: state.notice === recoveryNotice ? "" : state.notice,
    });
    return true;
  }
  /**
   * Before the tab closes: asks about unsaved changes and saves them if the user
   * says so. False means stop: cancelled, a cancelled Save As, a failed save
   * (shown through `failure`) or another operation still running.
   */
  async function resolveUnsaved(failure: (e: unknown) => string = String) {
    if (state.busy) return false;
    set({ busy: true });
    try {
      if (state.dirty) {
        lock();
        const choice = await confirmUnsaved(displayName());
        if (choice === "cancel") return false;
        if (choice === "save" && !(await saveFile(false))) return false;
      }
      await settleStash();
      return true;
    } catch (e) {
      set({ error: failure(e) });
      return false;
    } finally {
      set({ busy: false, locked: false });
    }
  }
  /**
   * Lets Rust drop the working copy and the unreferenced images; the tab is gone
   * afterwards. That cleanup is best effort and never keeps the tab.
   */
  async function release() {
    clearTimeout(timer);
    released = true;
    return native.closeTab(tab).catch(() => null);
  }
  /** Asks about unsaved changes, then releases the tab; false when it stays. */
  async function closeTab(failure?: (e: unknown) => string) {
    if (!(await resolveUnsaved(failure))) return false;
    await release();
    return true;
  }
  function persist(dialog: boolean) {
    return guarded(async () => {
      await saveFile(dialog);
    });
  }
  /** `settings`: the font and size a PDF is printed in, as the editor shows them. */
  function exportDocument(format: ExportFormat, settings: Settings) {
    return guarded(async () => {
      lock();
      const name = displayName().replace(/\.hush$/, "");
      const target = await save({
        title: "导出笔记",
        defaultPath: `${name}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!target) return;
      const doc = state.document;
      if (format === "pdf")
        await native.exportPdf(
          tab,
          target,
          toPrintHtml(doc, {
            fontFamily: cssFontFamily(settings.fontFamily),
            fontSizePt: settings.fontSizePt,
            title: name,
          }),
        );
      else if (format === "html")
        await native.exportDocument(tab, target, toHtml(doc), exportImages(doc));
      else await native.exportDocument(tab, target, toText(doc), []);
    }, (e) => `导出失败：${e}`);
  }
  return {
    tab,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setError: (error: string) => set({ error }),
    setNotice: (notice: string) => set({ notice }),
    setImporting: (importing: boolean) => set({ importing }),
    update,
    /** Stashes pending edits to the working copy now instead of after the debounce. */
    flush,
    adopt,
    resolveUnsaved,
    release,
    closeTab,
    /** Saves to the current file, or asks for one if the document is untitled. */
    saveDocument: () => persist(false),
    /** Always asks for a target. */
    saveDocumentAs: () => persist(true),
    exportDocument,
  };
}
