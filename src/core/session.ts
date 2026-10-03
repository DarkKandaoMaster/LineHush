import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import {
  fileName,
  fromText,
  isEmpty,
  toHtml,
  toText,
  type Diary,
} from "./document.ts";
import * as native from "./native.ts";
import type { Opened } from "./native.ts";
import { SaveQueue } from "./save-queue.ts";

const filter = [{ name: "LineHush 日记", extensions: ["linehush"] }];
type ExportFormat = "txt" | "html";
export interface SessionState {
  document: Diary;
  path: string | null;
  generation: number;
  ready: boolean;
  busy: boolean;
  importing: boolean;
  dirty: boolean;
  error: string;
  notice: string;
  status: string;
}
export type Session = ReturnType<typeof createSession>;

/** One document session owns its queue; React only subscribes to snapshots. */
export function createSession() {
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
  const savedStatus = (path: string | null) =>
    path ? "已保存" : "草稿已保留";
  let initialization: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = makeQueue();
  function makeQueue() {
    return new SaveQueue<Diary>(async (snapshot) => {
      if (!desktop) {
        set({ status: "浏览器预览 · 不写入磁盘" });
        return;
      }
      set({ status: "正在保存…" });
      await native.saveDocument(snapshot);
    });
  }
  async function flush() {
    clearTimeout(timer);
    try {
      await queue.flush();
      set({
        dirty: queue.dirty,
        ...(desktop ? { status: savedStatus(state.path) } : {}),
      });
    } catch (e) {
      set({ error: String(e), status: "保存失败" });
      throw e;
    }
  }
  function update(doc: Diary) {
    queue.update(doc);
    set({ document: doc, dirty: true, status: "尚未保存" });
    clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(() => {}), 650);
  }
  function adopt(result: Opened) {
    clearTimeout(timer);
    queue = makeQueue();
    set({
      document: result.document,
      path: result.path,
      generation: state.generation + 1,
      dirty: false,
      error: "",
      status: savedStatus(result.path),
      notice: result.recovered ? "已恢复上次编辑内容。" : "",
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
  /** File operations are desktop-only and never overlap. */
  async function guarded(action: () => Promise<void>, failure = "") {
    if (state.busy || !desktop) return;
    set({ busy: true });
    try {
      await action();
    } catch (e) {
      set({ error: `${failure}${e}` });
    } finally {
      set({ busy: false });
    }
  }
  async function saveAs() {
    const target = await save({
      title: "保存日记",
      filters: filter,
      defaultPath:
        state.path ?? `${new Date().toLocaleDateString("sv-SE")}.linehush`,
    });
    if (!target) return false;
    // Save As must remain available after a failed write to the current file.
    const result = await native.saveAs(target, state.document);
    queue = makeQueue();
    set({
      path: result.path,
      dirty: false,
      error: "",
      status: savedStatus(result.path),
    });
    return true;
  }
  async function persistBeforeSwitch() {
    await flush();
    if (!state.path && !isEmpty(state.document)) {
      const shouldSave = await ask(
        "当前草稿尚未保存为文件。是否先保存？选择“取消”将保留当前草稿并停止切换。",
        {
          title: "保存草稿",
          kind: "info",
          okLabel: "保存",
          cancelLabel: "取消",
        },
      );
      if (!shouldSave || !(await saveAs())) return false;
    }
    return true;
  }
  function newDocument() {
    return guarded(async () => {
      if (await persistBeforeSwitch()) adopt(await native.newDocument());
    });
  }
  function openDocument() {
    return guarded(async () => {
      if (!(await persistBeforeSwitch())) return;
      const target = await open({
        title: "打开日记",
        multiple: false,
        filters: [...filter, { name: "日记备份", extensions: ["bak"] }],
      });
      if (typeof target === "string") adopt(await native.openDocument(target));
    });
  }
  function persist(forceDialog: boolean) {
    return guarded(async () => {
      // Finish any in-flight write before changing the backend document directory.
      try {
        await flush();
      } catch (e) {
        if (!forceDialog) throw e;
      }
      if (forceDialog || !state.path) await saveAs();
    });
  }
  function exportDocument(format: ExportFormat) {
    return guarded(async () => {
      const target = await save({
        title: "导出日记",
        defaultPath: `${fileName(state.path).replace(/\.linehush$/, "")}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (target) {
        const html = format === "html";
        await native.exportDocument(
          target,
          html ? toHtml(state.document) : toText(state.document),
          html,
          state.document,
        );
        set({ notice: "已导出。" });
      }
    });
  }
  /** Saves pending edits, then closes the window; a failure keeps it open. */
  function close() {
    return guarded(async () => {
      await flush();
      await getCurrentWindow().destroy();
    }, "未关闭窗口：");
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
    setImporting: (importing: boolean) => set({ importing }),
    desktop,
    update,
    flush,
    initialize,
    newDocument,
    openDocument,
    /** Saves to the current file, or asks for one if this is a draft. */
    saveDocument: () => persist(false),
    /** Always asks for a target, even if flushing the current file failed. */
    saveDocumentAs: () => persist(true),
    exportDocument,
    close,
  };
}
