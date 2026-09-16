import { ref, computed } from "vue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { fromText, toHtml, toText, type Diary } from "./document";
import { SaveQueue } from "./save-queue";
interface Opened {
  document: Diary;
  path: string | null;
  recovered: boolean;
}
const filter = [{ name: "LineHush 日记", extensions: ["linehush"] }];
export function useSession() {
  const document = ref<Diary>(fromText("")),
    path = ref<string | null>(null);
  const generation = ref(0),
    ready = ref(false),
    busy = ref(false),
    dirty = ref(false);
  const error = ref(""),
    notice = ref(""),
    status = ref("准备就绪");
  const desktop = isTauri();
  const title = computed(() => path.value?.split(/[\\/]/).pop() ?? "未命名");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = makeQueue();
  function makeQueue() {
    return new SaveQueue<Diary>(async (snapshot) => {
      if (!desktop) {
        status.value = "浏览器预览 · 不写入磁盘";
        return;
      }
      status.value = "正在保存…";
      await invoke("save_document", { document: snapshot });
    });
  }
  async function flush() {
    clearTimeout(timer);
    try {
      await queue.flush();
      dirty.value = queue.dirty;
      if (desktop) status.value = path.value ? "已保存" : "草稿已保留";
    } catch (e) {
      error.value = String(e);
      status.value = "保存失败";
      throw e;
    }
  }
  function update(doc: Diary) {
    document.value = doc;
    queue.update(doc);
    dirty.value = true;
    status.value = "尚未保存";
    clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(() => {}), 650);
  }
  function adopt(result: Opened) {
    clearTimeout(timer);
    queue = makeQueue();
    document.value = result.document;
    path.value = result.path;
    generation.value++;
    dirty.value = false;
    error.value = "";
    status.value = result.path ? "已保存" : "草稿已保留";
    notice.value = result.recovered ? "已恢复上次编辑内容。" : "";
  }
  async function initialize() {
    try {
      if (desktop) adopt(await invoke<Opened>("restore"));
      else status.value = "浏览器预览 · 不写入磁盘";
    } catch (e) {
      error.value = String(e);
    } finally {
      ready.value = true;
    }
  }
  async function guarded(action: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true;
    try {
      await action();
    } catch (e) {
      error.value = String(e);
    } finally {
      busy.value = false;
    }
  }
  async function saveAs() {
    const target = await save({
      title: "保存日记",
      filters: filter,
      defaultPath:
        path.value ?? `${new Date().toLocaleDateString("sv-SE")}.linehush`,
    });
    if (!target) return false;
    // Save As must remain available after a failed write to the current file.
    const result = await invoke<Opened>("save_as", {
      path: target,
      document: document.value,
    });
    path.value = result.path;
    queue = makeQueue();
    dirty.value = false;
    error.value = "";
    status.value = "已保存";
    return true;
  }
  async function persistBeforeSwitch() {
    await flush();
    if (
      !path.value &&
      (document.value.blocks.length > 1 || toText(document.value) !== "")
    ) {
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
      if (await persistBeforeSwitch())
        adopt(await invoke<Opened>("new_document"));
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
      if (typeof target === "string")
        adopt(await invoke<Opened>("open_document", { path: target }));
    });
  }
  function saveDocument(as = false) {
    return guarded(async () => {
      clearTimeout(timer);
      // Finish any in-flight write before changing the backend document directory.
      try {
        await flush();
      } catch (e) {
        if (!as) throw e;
      }
      if (as || !path.value) await saveAs();
    });
  }
  function exportDocument(html: boolean) {
    return guarded(async () => {
      const ext = html ? "html" : "txt";
      const target = await save({
        title: "导出日记",
        defaultPath: `${title.value.replace(/\.linehush$/, "")}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (target) {
        await invoke("export_document", {
          path: target,
          content: html ? toHtml(document.value) : toText(document.value),
          html,
          document: document.value,
        });
        notice.value = "已导出。";
      }
    });
  }
  return {
    document,
    path,
    generation,
    ready,
    busy,
    dirty,
    error,
    notice,
    status,
    desktop,
    title,
    update,
    flush,
    initialize,
    guarded,
    newDocument,
    openDocument,
    saveDocument,
    exportDocument,
  };
}
