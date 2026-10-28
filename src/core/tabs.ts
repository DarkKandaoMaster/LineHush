import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { fileName, type Diary } from "./document.ts";
import * as native from "./native.ts";
import type { TabOpened } from "./native.ts";
import {
  createSession,
  HUSH_FILTER,
  type Session,
  type UnsavedChoice,
} from "./session.ts";
import type { Startup } from "./settings.ts";

/** One tab of the window: its document session and, while unnamed, its number. */
export interface Tab {
  id: string;
  session: Session;
  /** "无标题 n" while the document has no file; null for a tab opened from a file. */
  untitled: number | null;
}
export interface TabsState {
  tabs: Tab[];
  active: string;
  /** The window's tabs have been loaded (or loading failed). */
  ready: boolean;
  /** Loading the window failed; there is no tab to show the error in. */
  error: string;
  /** Bumped to move the keyboard focus back into the current tab's editor. */
  focus: number;
}
export type Tabs = ReturnType<typeof createTabs>;

/** The smallest number no unnamed tab of the window uses; numbers of saved tabs are free again. */
export function nextUntitled(tabs: readonly Tab[]): number {
  const used = new Set(
    tabs
      .filter((tab) => tab.session.getSnapshot().path === null)
      .map((tab) => tab.untitled),
  );
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
/** "x.hush", or "无标题" / "无标题 2" for an unnamed document. */
export function displayName(tab: Tab): string {
  return fileName(tab.session.getSnapshot().path, tab.untitled ?? 1);
}
/** The tab that becomes current when the one at `index` closes: its right neighbour, else its left. */
export function neighbourAfterClose<T>(
  tabs: readonly T[],
  index: number,
): T | undefined {
  return tabs[index + 1] ?? tabs[index - 1];
}
/** A document with nothing in it: one empty line. */
function isBlank(doc: Diary) {
  const [first] = doc.blocks;
  return (
    doc.blocks.length === 1 && first.type === "line" && first.text === ""
  );
}

/**
 * The tabs of this window, each with its own document session and editor.
 * `confirmUnsaved` (the window's "save changes?" dialog) is shared by all tabs.
 * `startup` gives the “启动时” setting when the window closes, once the
 * settings are read (never the default in their place).
 */
export function createTabs(
  confirmUnsaved: (name: string) => Promise<UnsavedChoice>,
  startup: () => Startup | Promise<Startup> = () => "newWindow",
) {
  let state: TabsState = {
    tabs: [],
    active: "",
    ready: false,
    error: "",
    focus: 0,
  };
  const listeners = new Set<() => void>();
  function set(patch: Partial<TabsState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  let initialization: Promise<void> | undefined;
  /** A file asked for from outside the window, waiting for running operations to end. */
  let requested: string | null = null;
  /** 打开 (dialog and open) is running; a second one is ignored. */
  let opening = false;
  /** The window is asking about its tabs before it closes. */
  let closingWindow = false;
  /** The tabs are released; the next close request closes the window. */
  let closing = false;
  const label = () => getCurrentWindow().label;

  const activeTab = () => state.tabs.find((tab) => tab.id === state.active);
  /** Shows an error in the current tab, or for the window when it has none. */
  function report(error: string) {
    const tab = activeTab();
    if (tab) tab.session.setError(error);
    else set({ error });
  }
  function makeTab(result: TabOpened, others: readonly Tab[]): Tab {
    const tab = {
      id: result.tab,
      untitled: result.opened.path === null ? nextUntitled(others) : null,
    } as Tab;
    tab.session = createSession(result.tab, confirmUnsaved, () =>
      displayName(tab),
    );
    tab.session.adopt(result.opened);
    if (result.error) tab.session.setError(result.error);
    // A request waiting for a busy tab is opened once it is free again.
    tab.session.subscribe(() => {
      if (requested !== null) void openPending();
    });
    return tab;
  }
  const busy = () =>
    opening ||
    closingWindow ||
    state.tabs.some((tab) => {
      const snapshot = tab.session.getSnapshot();
      return snapshot.busy || snapshot.importing;
    });

  function initialize() {
    return (initialization ??= restore());
  }
  async function restore() {
    try {
      const opened = await native.restoreWindow();
      const tabs: Tab[] = [];
      for (const result of opened.tabs) tabs.push(makeTab(result, tabs));
      set({ tabs, active: opened.active });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ ready: true });
    }
  }
  /** Makes `id` the current tab (Rust records it) and focuses its editor. */
  function activate(id: string) {
    if (!state.tabs.some((tab) => tab.id === id)) return;
    const changed = id !== state.active;
    set({ active: id, focus: state.focus + 1 });
    if (changed) native.activateTab(id).catch((e) => console.error(e));
  }
  /** Ctrl+Tab / Ctrl+Shift+Tab: the next or previous tab, wrapping around. */
  function cycle(delta: number) {
    const { tabs } = state;
    if (tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.id === state.active);
    activate(tabs[(index + delta + tabs.length) % tabs.length].id);
  }
  /** Ctrl+1…8: that tab; Ctrl+9: the last one. */
  function activateIndex(n: number) {
    const { tabs } = state;
    const tab = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (tab) activate(tab.id);
  }
  /** Adds a loaded tab right of `after` (or at the end) and makes it current. */
  function insert(tab: Tab, after: string | null) {
    const tabs = [...state.tabs];
    const index = tabs.findIndex((other) => other.id === after);
    tabs.splice(index < 0 ? tabs.length : index + 1, 0, tab);
    // Rust already made the new tab current.
    set({ tabs, active: tab.id, focus: state.focus + 1 });
  }
  /** Ctrl+N: a new unnamed tab at the end. */
  async function newTab() {
    try {
      insert(makeTab(await native.newTab(), state.tabs), null);
    } catch (e) {
      report(`无法新建标签页：${e}`);
    }
  }
  /**
   * Opens `path` like Ctrl+O: in the current tab when it is an unnamed, unchanged
   * empty document, otherwise in a new tab right of it. A file already open is
   * not opened again: its tab becomes current (Rust brings another window to the
   * front itself).
   */
  async function openPath(path: string) {
    const current = activeTab();
    const snapshot = current?.session.getSnapshot();
    const replace =
      current &&
      snapshot &&
      snapshot.path === null &&
      !snapshot.dirty &&
      !snapshot.busy &&
      !snapshot.importing &&
      isBlank(snapshot.document)
        ? current.id
        : null;
    try {
      const outcome = await native.openFile(path, replace, current?.id ?? null);
      if (outcome.kind === "existing") {
        if (outcome.window === label()) activate(outcome.tab);
        return;
      }
      const reused = state.tabs.find((tab) => tab.id === outcome.tab);
      if (reused) {
        reused.session.adopt(outcome.opened);
        activate(reused.id);
      } else
        insert(
          makeTab(
            { tab: outcome.tab, opened: outcome.opened, error: outcome.error },
            state.tabs,
          ),
          current?.id ?? null,
        );
    } catch (e) {
      report(String(e));
    }
  }
  /** Ctrl+O: picks a file and opens it (see `openPath`). */
  async function openFile() {
    if (opening) return;
    opening = true;
    try {
      const target = await open({
        title: "打开笔记",
        multiple: false,
        filters: HUSH_FILTER,
      });
      if (typeof target === "string") await openPath(target);
    } catch (e) {
      report(String(e));
    } finally {
      opening = false;
      void openPending();
    }
  }
  /**
   * Takes the file Rust holds for this window (passed at launch, or
   * double-clicked while running) and opens it like 打开.
   */
  async function openRequested() {
    try {
      requested = (await native.takeOpenRequest()) ?? requested;
    } catch (e) {
      report(String(e));
    }
    await openPending();
  }
  /** Opens the requested file once no file operation or import is running. */
  async function openPending() {
    const path = requested;
    if (path === null || !state.ready || busy()) return;
    requested = null;
    opening = true;
    try {
      await openPath(path);
    } finally {
      opening = false;
    }
  }
  /**
   * Requests Rust sends to this window only: a file to open (double-clicked or
   * passed to a second launch), or the tab that already shows a file asked for
   * (its window was brought to the front). Returns the unsubscribe function.
   */
  async function listen(): Promise<() => void> {
    const current = getCurrentWindow();
    const removers = [
      await current.listen(native.OPEN_REQUESTED, () => void openRequested()),
    ];
    try {
      removers.push(
        await current.listen<{ tab: string }>(native.ACTIVATE_TAB, (event) =>
          activate(event.payload.tab),
        ),
      );
    } catch (e) {
      removers.forEach((remove) => remove());
      throw e;
    }
    return () => removers.forEach((remove) => remove());
  }
  /** Ctrl+Shift+N: a new window with one new unnamed tab. */
  async function newWindow() {
    try {
      await native.newWindow();
    } catch (e) {
      report(String(e));
    }
  }
  /**
   * Ctrl+W, ×, middle click: asks about unsaved changes, then closes the tab and
   * makes its right neighbour (else its left one) current. The last tab closes
   * the window.
   */
  async function closeTab(id: string) {
    const tab = state.tabs.find((other) => other.id === id);
    if (!tab || closingWindow) return;
    if (state.tabs.length === 1) return closeWindow();
    activate(id);
    if (!(await tab.session.closeTab((e) => `${e}，标签页未关闭。`))) return;
    const index = state.tabs.indexOf(tab);
    const next =
      state.active === id ? neighbourAfterClose(state.tabs, index) : activeTab();
    set({ tabs: state.tabs.filter((other) => other !== tab) });
    if (next) activate(next.id);
  }
  /**
   * Closing the window asks about each tab with unsaved changes in turn, like
   * Notepad; cancelling or a failed save keeps the window. Then every tab is
   * released and the window closes.
   *
   * “启动时”为“打开上一会话中的内容”且这是最后一个窗口（关掉即退出）时不询问：
   * 各标签页的修改落盘到工作副本后直接关窗，标签页不释放（不清理图片、不删
   * 工作副本），session.json 保留这个窗口，下次启动原样恢复。暂存失败则不关。
   * 没有修改的标签页（含改了又撤销回原样的）丢掉暂存，下次启动不带未保存标记。
   */
  async function closeWindow() {
    if (closing || closingWindow) return;
    if (busy()) {
      activeTab()?.session.setNotice("操作仍在进行，完成后可关闭窗口。");
      return;
    }
    closingWindow = true;
    try {
      const keep =
        (await startup()) === "lastSession" &&
        (await native.isLastWindow().catch(() => false));
      if (keep) {
        for (const tab of state.tabs)
          try {
            await tab.session.flush();
          } catch (e) {
            activate(tab.id);
            tab.session.setError(`暂存失败：${e}，窗口未关闭。`);
            return;
          }
        // 尽力而为：丢不掉只是下次启动多一个未保存标记。
        for (const tab of state.tabs)
          if (!tab.session.getSnapshot().dirty)
            await native
              .discardStash(tab.id)
              .catch((e) => console.error("无法丢弃暂存：", e));
      } else {
        for (const tab of state.tabs) {
          if (tab.session.getSnapshot().dirty) activate(tab.id);
          if (!(await tab.session.resolveUnsaved((e) => `${e}，窗口未关闭。`)))
            return;
        }
        for (const tab of state.tabs) await tab.session.release();
      }
      closing = true;
      await getCurrentWindow().close();
    } catch (e) {
      closing = false;
      report(`${e}，窗口未关闭。`);
    } finally {
      closingWindow = false;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activeTab,
    report,
    initialize,
    newTab,
    newWindow,
    listen,
    openFile,
    openPath,
    openRequested,
    activate,
    cycle,
    activateIndex,
    closeTab,
    closeWindow,
    /** Moves the keyboard focus back into the current tab's editor. */
    focus: () => set({ focus: state.focus + 1 }),
    /** The window is closing for good: its close request must go through. */
    closing: () => closing,
  };
}
