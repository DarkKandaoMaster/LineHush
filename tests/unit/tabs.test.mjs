import test from "node:test";
import assert from "node:assert/strict";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import {
  createTabs,
  displayName,
  neighbourAfterClose,
  nextUntitled,
  tabsToClose,
} from "../../src/core/tabs.ts";
import { fromText } from "../../src/core/document.ts";

const blank = () => ({
  document: fromText(""),
  path: null,
  recovered: false,
  notice: null,
});
const named = (path, text = "内容") => ({
  document: fromText(text),
  path,
  recovered: false,
  notice: null,
});

/**
 * A window's tabs over a fake Rust boundary. `restored` is what restore_window
 * hands out ([id, opened] pairs); `answers` go to the "save changes?" prompt in
 * order; `fake.openPath` answers the open dialog. `startup` is the “启动时”
 * setting; `fake.last` is what is_last_window answers.
 */
function setup({
  restored = [["a", blank()]],
  active,
  answers = [],
  startup = "newWindow",
} = {}) {
  // crypto: the event mock registers listeners as callbacks with random ids.
  globalThis.window = { crypto: globalThis.crypto };
  const fake = {
    calls: [],
    args: [],
    asked: [],
    openPath: null,
    request: null,
    /** What open_file answers instead of opening, e.g. an "existing" outcome. */
    outcome: null,
    failOpen: null,
    /** Whether this is the last editor window. */
    last: true,
    /** stash_document fails with this. */
    failStash: null,
    next: 0,
  };
  mockIPC(async (cmd, args) => {
    fake.calls.push(cmd);
    fake.args.push([cmd, args]);
    if (cmd === "restore_window")
      return {
        tabs: restored.map(([tab, opened]) => ({ tab, opened, error: null })),
        active: active ?? restored[0][0],
      };
    if (cmd === "new_tab")
      return { tab: `new${++fake.next}`, opened: blank(), error: null };
    if (cmd === "open_file") {
      if (fake.failOpen) throw fake.failOpen;
      if (fake.outcome) return fake.outcome;
      return {
        kind: "opened",
        tab: args.replace ?? `opened${++fake.next}`,
        opened: named(args.path, "打开的内容"),
        error: null,
      };
    }
    if (cmd === "take_open_request") {
      const request = fake.request;
      fake.request = null;
      return request;
    }
    if (cmd === "close_tab") return null;
    if (cmd === "is_last_window") return fake.last;
    if (cmd === "stash_document" && fake.failStash) throw fake.failStash;
    if (cmd === "reveal_in_explorer" && fake.failReveal) throw fake.failReveal;
    if (cmd === "new_window") {
      if (fake.failWindow) throw fake.failWindow;
      return null;
    }
    if (cmd === "plugin:dialog|open") return fake.openPath;
    if (cmd === "plugin:dialog|save") return fake.savePath ?? null;
    if (cmd === "suggest_save_path") return `${args.base}.hush`;
    if (cmd === "save_as")
      return { document: args.document, path: args.path, recovered: false };
  }, { shouldMockEvents: true });
  mockWindows("win-1");
  const tabs = createTabs(
    async (name) => {
      fake.asked.push(name);
      return answers.shift();
    },
    () => startup,
  );
  const state = () => tabs.getSnapshot();
  const names = () => state().tabs.map(displayName);
  const tab = (id) => state().tabs.find((t) => t.id === id);
  return { tabs, fake, state, names, tab };
}
async function teardown(tabs) {
  for (const tab of tabs.getSnapshot().tabs)
    await tab.session.flush().catch(() => {});
  clearMocks();
  delete globalThis.window;
}
const rustCalls = (fake) =>
  fake.calls.filter((cmd) => !cmd.startsWith("plugin:"));
async function until(condition) {
  for (let i = 0; i < 100 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition());
}

test("纯函数：关闭后激活右邻，无右邻则左邻", () => {
  assert.equal(neighbourAfterClose(["a", "b", "c"], 1), "c");
  assert.equal(neighbourAfterClose(["a", "b", "c"], 2), "b");
  assert.equal(neighbourAfterClose(["a", "b", "c"], 0), "b");
  assert.equal(neighbourAfterClose(["a"], 0), undefined);
});

test("恢复窗口只调用一次，按 Rust 给出的顺序与当前标签页载入，打开失败的标签页显示原因", async () => {
  const { tabs, fake, state, names } = setup({
    restored: [
      ["a", named("D:/日记/甲.hush")],
      ["b", { ...blank(), document: fromText("草稿"), recovered: true }],
      ["c", blank()],
    ],
    active: "b",
  });
  try {
    assert.equal(state().ready, false);
    await Promise.all([tabs.initialize(), tabs.initialize()]);
    assert.deepEqual(rustCalls(fake), ["restore_window"]);
    assert.equal(state().ready, true);
    assert.equal(state().active, "b");
    assert.deepEqual(names(), ["甲.hush", "无标题", "无标题 2"]);
    assert.equal(tabs.activeTab().session.getSnapshot().dirty, true);
    assert.equal(tabs.activeTab().session.getSnapshot().notice, "");
  } finally {
    await teardown(tabs);
  }
  {
    globalThis.window = {};
    mockIPC(async (cmd) => {
      if (cmd === "restore_window")
        return {
          tabs: [{ tab: "x", opened: blank(), error: "无法打开 D:/甲.hush：文件不存在" }],
          active: "x",
        };
    });
    mockWindows("win-1");
    const tabs = createTabs(async () => "cancel");
    await tabs.initialize();
    assert.equal(
      tabs.activeTab().session.getSnapshot().error,
      "无法打开 D:/甲.hush：文件不存在",
    );
    await teardown(tabs);
  }
});

test("无标题编号：取窗口内未占用的最小正整数，另存为后释放", async () => {
  const { tabs, fake, state, names, tab } = setup({
    restored: [
      ["a", blank()],
      ["b", blank()],
    ],
  });
  try {
    await tabs.initialize();
    assert.deepEqual(names(), ["无标题", "无标题 2"]);
    await tabs.newTab();
    assert.deepEqual(names(), ["无标题", "无标题 2", "无标题 3"]);
    assert.equal(state().active, "new1");
    // Closing "无标题 2" frees 2.
    await tabs.closeTab("b");
    await tabs.newTab();
    assert.deepEqual(names(), ["无标题", "无标题 3", "无标题 2"]);
    // Saving "无标题" frees 1.
    fake.savePath = "D:/存好.hush";
    tab("a").session.update(fromText("写点东西"));
    await tab("a").session.saveDocument();
    await tabs.newTab();
    assert.deepEqual(names(), ["存好.hush", "无标题 3", "无标题 2", "无标题"]);
    assert.equal(nextUntitled(state().tabs), 4);
  } finally {
    await teardown(tabs);
  }
});

test("Ctrl+O：当前是空的未命名且未修改则在当前标签页打开，否则在右侧新标签页打开", async () => {
  const { tabs, fake, state, names } = setup({
    restored: [
      ["a", blank()],
      ["b", named("D:/乙.hush")],
    ],
  });
  try {
    await tabs.initialize();
    fake.openPath = "D:/甲.hush";
    await tabs.openFile();
    const first = fake.args.find(([cmd]) => cmd === "open_file")[1];
    assert.deepEqual(first, { path: "D:/甲.hush", replace: "a", after: "a" });
    assert.deepEqual(names(), ["甲.hush", "乙.hush"]);
    assert.equal(state().active, "a");
    assert.equal(tabs.activeTab().session.getSnapshot().generation, 2);

    // A named tab: the file goes into a new tab right of it.
    fake.openPath = "D:/丙.hush";
    await tabs.openFile();
    assert.deepEqual(names(), ["甲.hush", "丙.hush", "乙.hush"]);
    assert.equal(state().active, "opened1");

    // An unnamed tab with changes is not replaced either.
    await tabs.newTab();
    tabs.activeTab().session.update(fromText("改过"));
    fake.openPath = "D:/丁.hush";
    await tabs.openFile();
    const last = fake.args.filter(([cmd]) => cmd === "open_file").at(-1)[1];
    assert.equal(last.replace, null);
    assert.equal(last.after, "new2");
    assert.deepEqual(names(), ["甲.hush", "丙.hush", "乙.hush", "无标题", "丁.hush"]);
    // Cancelling the dialog opens nothing.
    fake.openPath = null;
    const before = fake.calls.length;
    await tabs.openFile();
    assert.deepEqual(fake.calls.slice(before), ["plugin:dialog|open"]);
  } finally {
    await teardown(tabs);
  }
});

test("Ctrl+O：文件已在本窗口打开则切过去，在其他窗口则不动，失败显示错误", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", named("D:/甲.hush")],
      ["b", blank()],
    ],
    active: "b",
  });
  try {
    await tabs.initialize();
    fake.outcome = { kind: "existing", window: "win-1", tab: "a" };
    await tabs.openPath("D:/甲.hush");
    assert.equal(state().active, "a");
    assert.equal(state().tabs.length, 2);
    tabs.activate("b");
    fake.outcome = { kind: "existing", window: "win-2", tab: "z" };
    await tabs.openPath("D:/别处.hush");
    assert.equal(state().active, "b");
    assert.equal(state().tabs.length, 2);
    fake.outcome = null;
    fake.failOpen = "无法打开 D:/坏.hush：不是有效的 .hush 文件或文件已损坏";
    await tabs.openPath("D:/坏.hush");
    assert.equal(
      tabs.activeTab().session.getSnapshot().error,
      "无法打开 D:/坏.hush：不是有效的 .hush 文件或文件已损坏",
    );
    assert.equal(state().tabs.length, 2);
  } finally {
    await teardown(tabs);
  }
});

test("Rust 的 activate-tab 切到那个标签页（不认识的忽略），open-requested 取走请求按 Ctrl+O 规则打开", async () => {
  const { tabs, fake, state, names } = setup({
    restored: [
      ["a", named("D:/甲.hush")],
      ["b", named("D:/乙.hush")],
    ],
    active: "b",
  });
  try {
    await tabs.initialize();
    const unlisten = await tabs.listen();
    await emit("activate-tab", { tab: "a" });
    assert.equal(state().active, "a");
    assert.ok(fake.args.some(([cmd, args]) => cmd === "activate_tab" && args.tab === "a"));
    await emit("activate-tab", { tab: "不存在" });
    assert.equal(state().active, "a");

    fake.request = "D:/丙.hush";
    await emit("open-requested");
    await until(() => state().tabs.length === 3);
    assert.deepEqual(names(), ["甲.hush", "丙.hush", "乙.hush"]);
    assert.equal(state().active, "opened1");
    assert.ok(!fake.request);

    unlisten();
  } finally {
    await teardown(tabs);
  }
});

test("Ctrl+O 遇到已打开的文件：在本窗口切过去不新开；在其他窗口时本窗口不变（Rust 置顶那个窗口）", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", named("D:/甲.hush")],
      ["b", blank()],
    ],
    active: "b",
  });
  try {
    await tabs.initialize();
    // 当前是空的未命名标签页：仍把它作为 replace 交给 Rust，Rust 发现文件已打开。
    fake.outcome = { kind: "existing", window: "win-1", tab: "a" };
    await tabs.openPath("D:/甲.hush");
    const [, args] = fake.args.findLast(([cmd]) => cmd === "open_file");
    assert.deepEqual(args, { path: "D:/甲.hush", replace: "b", after: "b" });
    assert.equal(state().active, "a");
    assert.deepEqual(state().tabs.map((t) => t.id), ["a", "b"]);
    assert.equal(tab_path(state(), "b"), null);

    tabs.activate("b");
    fake.outcome = { kind: "existing", window: "win-2", tab: "a" };
    await tabs.openPath("D:/甲.hush");
    assert.equal(state().active, "b");
    assert.deepEqual(state().tabs.map((t) => t.id), ["a", "b"]);
    assert.equal(tabs.activeTab().session.getSnapshot().error, "");
  } finally {
    await teardown(tabs);
  }
});
function tab_path(state, id) {
  return state.tabs.find((t) => t.id === id).session.getSnapshot().path;
}

test("Ctrl+Shift+N：请 Rust 开新窗口，本窗口标签页不变；失败显示在当前标签页", async () => {
  const { tabs, fake, state } = setup();
  try {
    await tabs.initialize();
    await tabs.newWindow();
    assert.deepEqual(rustCalls(fake), ["restore_window", "new_window"]);
    assert.equal(state().tabs.length, 1);
    fake.failWindow = "无法打开新窗口：拒绝访问";
    await tabs.newWindow();
    assert.equal(
      tabs.activeTab().session.getSnapshot().error,
      "无法打开新窗口：拒绝访问",
    );
  } finally {
    await teardown(tabs);
  }
});

test("切换标签页：Ctrl+Tab 循环，Ctrl+1–8 直达，Ctrl+9 为最后一个，Rust 记录当前标签页", async () => {
  const { tabs, fake, state } = setup({
    restored: ["a", "b", "c", "d"].map((id) => [id, blank()]),
  });
  try {
    await tabs.initialize();
    tabs.cycle(1);
    assert.equal(state().active, "b");
    tabs.cycle(-1);
    tabs.cycle(-1);
    assert.equal(state().active, "d");
    tabs.cycle(1);
    assert.equal(state().active, "a");
    tabs.activateIndex(3);
    assert.equal(state().active, "c");
    tabs.activateIndex(9);
    assert.equal(state().active, "d");
    tabs.activateIndex(8);
    assert.equal(state().active, "d");
    const focus = state().focus;
    tabs.activate("d");
    assert.equal(state().focus, focus + 1);
    const recorded = fake.args
      .filter(([cmd]) => cmd === "activate_tab")
      .map(([, args]) => args.tab);
    // Re-activating the current tab is not recorded again.
    assert.deepEqual(recorded, ["b", "a", "d", "a", "c", "d"]);
  } finally {
    await teardown(tabs);
  }
});

test("关闭标签页：询问后关闭并激活右邻（无右邻则左邻），取消则保留；最后一个关闭窗口", async () => {
  const { tabs, fake, state } = setup({
    restored: ["a", "b", "c", "d"].map((id) => [id, blank()]),
    answers: ["cancel", "discard"],
  });
  try {
    await tabs.initialize();
    tabs.activate("b");
    await tabs.closeTab("b");
    assert.deepEqual(state().tabs.map((t) => t.id), ["a", "c", "d"]);
    assert.equal(state().active, "c");
    // Closing the last tab activates its left neighbour.
    await tabs.closeTab("d");
    assert.equal(state().active, "c");
    // Closing a tab that is not current makes it current while asking.
    tabs.activate("a");
    const c = state().tabs.find((t) => t.id === "c");
    c.session.update(fromText("改过"));
    await tabs.closeTab("c");
    assert.deepEqual(fake.asked, ["无标题 3"]);
    assert.deepEqual(state().tabs.map((t) => t.id), ["a", "c"]);
    assert.equal(state().active, "c");
    await tabs.closeTab("c");
    assert.deepEqual(state().tabs.map((t) => t.id), ["a"]);
    assert.equal(state().active, "a");
    assert.deepEqual(
      fake.args.filter(([cmd]) => cmd === "close_tab").map(([, a]) => a.tab),
      ["b", "d", "c"],
    );
    // The only tab left closes the window.
    await tabs.closeTab("a");
    assert.equal(fake.calls.at(-1), "plugin:window|close");
    assert.equal(tabs.closing(), true);
  } finally {
    await teardown(tabs);
  }
});

test("关闭窗口：按顺序逐个询问有修改的标签页，取消则停下保留全部", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", named("D:/甲.hush")],
      ["b", blank()],
      ["c", blank()],
    ],
    active: "b",
    answers: ["discard", "cancel"],
  });
  try {
    await tabs.initialize();
    state().tabs[0].session.update(fromText("改甲"));
    state().tabs[2].session.update(fromText("改丙"));
    await tabs.closeWindow();
    assert.deepEqual(fake.asked, ["甲.hush", "无标题 2"]);
    // Each tab is shown while it is asked about.
    assert.equal(state().active, "c");
    assert.ok(!fake.calls.includes("close_tab"));
    assert.ok(!fake.calls.includes("plugin:window|close"));
    assert.equal(tabs.closing(), false);
  } finally {
    await teardown(tabs);
  }
});

test("关闭窗口：全部通过后逐个丢弃再关闭；保存失败时窗口不关", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", named("D:/甲.hush")],
      ["b", blank()],
      ["c", blank()],
    ],
    answers: ["save", "discard", "discard"],
  });
  try {
    await tabs.initialize();
    const [a, , c] = state().tabs;
    a.session.update(fromText("改甲"));
    c.session.update(fromText("改丙"));
    fake.failSave = true;
    mockIPC(async (cmd, args) => {
      fake.calls.push(cmd);
      fake.args.push([cmd, args]);
      if (cmd === "save_document" && fake.failSave) throw "磁盘已满";
      if (cmd === "close_tab") return null;
    });
    await tabs.closeWindow();
    assert.equal(a.session.getSnapshot().error, "保存失败：磁盘已满，窗口未关闭。");
    assert.ok(!fake.calls.includes("close_tab"));
    fake.failSave = false;
    await tabs.closeWindow();
    assert.deepEqual(fake.asked, ["甲.hush", "甲.hush", "无标题 2"]);
    assert.deepEqual(
      fake.args.filter(([cmd]) => cmd === "close_tab").map(([, a]) => a.tab),
      ["a", "b", "c"],
    );
    assert.equal(fake.calls.at(-1), "plugin:window|close");
    assert.equal(tabs.closing(), true);
  } finally {
    await teardown(tabs);
  }
});

test("关闭窗口：有操作在进行时静默忽略", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", blank()],
      ["b", blank()],
    ],
  });
  try {
    await tabs.initialize();
    state().tabs[1].session.setImporting(true);
    await tabs.closeWindow();
    assert.equal(tabs.activeTab().session.getSnapshot().notice, "");
    assert.ok(!fake.calls.includes("plugin:window|close"));
    state().tabs[1].session.setImporting(false);
  } finally {
    await teardown(tabs);
  }
});

test("外部请求打开文件：按 Ctrl+O 规则打开，导入中等结束后再打开", async () => {
  const { tabs, fake, state, names } = setup({
    restored: [["a", named("D:/甲.hush")]],
  });
  try {
    await tabs.initialize();
    // Nothing waiting: nothing opens.
    await tabs.openRequested();
    assert.ok(!fake.calls.includes("open_file"));

    fake.request = "D:/乙.hush";
    await tabs.openRequested();
    assert.deepEqual(names(), ["甲.hush", "乙.hush"]);
    assert.ok(!fake.calls.includes("plugin:dialog|open"));
    assert.deepEqual(fake.asked, []);

    // A request during an import waits for it.
    const importing = tabs.activeTab().session;
    importing.setImporting(true);
    fake.request = "D:/丙.hush";
    await tabs.openRequested();
    assert.equal(state().tabs.length, 2);
    importing.setImporting(false);
    await until(() => state().tabs.length === 3);
    assert.deepEqual(names(), ["甲.hush", "乙.hush", "丙.hush"]);
  } finally {
    await teardown(tabs);
  }
});

test("启动时为“打开上一会话中的内容”：关闭最后一个窗口不询问，只把修改暂存落盘后关窗，不释放标签页", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", named("D:/甲.hush")],
      ["b", blank()],
      ["c", named("D:/乙.hush")],
    ],
    active: "c",
    startup: "lastSession",
  });
  try {
    await tabs.initialize();
    const [a, b] = state().tabs;
    a.session.update(fromText("改甲"));
    b.session.update(fromText("草稿"));
    await tabs.closeWindow();
    assert.deepEqual(fake.asked, []);
    // 有修改的两个标签页立即暂存（不等 650 ms），没修改的不写。
    const stashed = fake.args
      .filter(([cmd]) => cmd === "stash_document")
      .map(([, args]) => args.tab);
    assert.deepEqual(stashed, ["a", "b"]);
    assert.ok(!fake.calls.includes("close_tab"));
    assert.equal(fake.calls.at(-1), "plugin:window|close");
    assert.equal(tabs.closing(), true);
    // 当前标签页不变，修改标记仍在（session.json 照此恢复）。
    assert.equal(state().active, "c");
    assert.equal(a.session.getSnapshot().dirty, true);
  } finally {
    await teardown(tabs);
  }
});

test("启动时为“打开上一会话中的内容”：关最后一个窗口时，没有修改的标签页（含改了又撤销回原样）丢掉暂存", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", named("D:/甲.hush", "原样")],
      ["b", named("D:/乙.hush")],
      ["c", blank()],
    ],
    // “启动时”还没读完：closeWindow 等它，不按默认的“打开新窗口”处理。
    startup: Promise.resolve("lastSession"),
  });
  try {
    await tabs.initialize();
    const [a, b] = state().tabs;
    a.session.update(fromText("改过"));
    a.session.update(fromText("原样"));
    b.session.update(fromText("真的改了"));
    assert.equal(a.session.getSnapshot().dirty, false);
    await tabs.closeWindow();
    assert.deepEqual(fake.asked, []);
    assert.ok(!fake.calls.includes("close_tab"));
    // 先把修改落盘，再丢掉没有修改的标签页的暂存，最后关窗。
    const writes = fake.args
      .filter(([cmd]) => ["stash_document", "discard_stash"].includes(cmd))
      .map(([cmd, args]) => `${cmd}:${args.tab}`);
    assert.deepEqual(writes, [
      "stash_document:a",
      "stash_document:b",
      "discard_stash:a",
      "discard_stash:c",
    ]);
    assert.equal(fake.calls.at(-1), "plugin:window|close");
  } finally {
    await teardown(tabs);
  }
});

test("启动时为“打开上一会话中的内容”：暂存失败则显示错误、不关窗，修好后再关", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", blank()],
      ["b", named("D:/甲.hush")],
    ],
    startup: "lastSession",
  });
  try {
    await tabs.initialize();
    const b = state().tabs[1];
    b.session.update(fromText("改甲"));
    fake.failStash = "磁盘已满";
    await tabs.closeWindow();
    assert.equal(state().active, "b");
    assert.equal(b.session.getSnapshot().error, "暂存失败：磁盘已满，窗口未关闭。");
    assert.ok(!fake.calls.includes("plugin:window|close"));
    assert.equal(tabs.closing(), false);
    fake.failStash = null;
    await tabs.closeWindow();
    assert.deepEqual(fake.asked, []);
    assert.equal(fake.calls.at(-1), "plugin:window|close");
  } finally {
    await teardown(tabs);
  }
});

test("启动时为“打开上一会话中的内容”：关闭的不是最后一个窗口时照常询问并释放标签页；Ctrl+W 也询问", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", named("D:/甲.hush")],
      ["b", blank()],
      ["c", blank()],
    ],
    startup: "lastSession",
    answers: ["discard", "discard", "discard"],
  });
  try {
    await tabs.initialize();
    fake.last = false;
    // Ctrl+W 关一个有修改的标签页：询问。
    state().tabs[2].session.update(fromText("丙"));
    await tabs.closeTab("c");
    assert.deepEqual(fake.asked, ["无标题 2"]);
    assert.deepEqual(state().tabs.map((t) => t.id), ["a", "b"]);
    // 关窗口：逐个询问有修改的标签页，再全部释放后关窗。
    state().tabs[0].session.update(fromText("改甲"));
    state().tabs[1].session.update(fromText("草稿"));
    await tabs.closeWindow();
    assert.deepEqual(fake.asked, ["无标题 2", "甲.hush", "无标题"]);
    assert.deepEqual(
      fake.args.filter(([cmd]) => cmd === "close_tab").map(([, a]) => a.tab),
      ["c", "a", "b"],
    );
    assert.equal(fake.calls.at(-1), "plugin:window|close");
  } finally {
    await teardown(tabs);
  }
});

test("启动时为“打开上一会话中的内容”：最后一个窗口里 Ctrl+W 关标签页仍询问，关最后一个标签页即关窗不询问", async () => {
  const { tabs, fake, state } = setup({
    restored: [
      ["a", named("D:/甲.hush")],
      ["b", blank()],
    ],
    startup: "lastSession",
    answers: ["discard"],
  });
  try {
    await tabs.initialize();
    state().tabs[1].session.update(fromText("草稿"));
    await tabs.closeTab("b");
    assert.deepEqual(fake.asked, ["无标题"]);
    assert.deepEqual(state().tabs.map((t) => t.id), ["a"]);
    state().tabs[0].session.update(fromText("改甲"));
    await tabs.closeTab("a");
    assert.deepEqual(fake.asked, ["无标题"]);
    assert.deepEqual(
      fake.args.filter(([cmd]) => cmd === "close_tab").map(([, a]) => a.tab),
      ["b"],
    );
    assert.equal(fake.calls.at(-1), "plugin:window|close");
  } finally {
    await teardown(tabs);
  }
});

test("启动时为“打开新窗口”：关闭最后一个窗口也询问，不问 Rust 是否最后一个窗口", async () => {
  const { tabs, fake, state } = setup({
    restored: [["a", named("D:/甲.hush")]],
    answers: ["discard"],
  });
  try {
    await tabs.initialize();
    state().tabs[0].session.update(fromText("改甲"));
    await tabs.closeWindow();
    assert.deepEqual(fake.asked, ["甲.hush"]);
    assert.ok(!fake.calls.includes("is_last_window"));
    assert.deepEqual(
      fake.args.filter(([cmd]) => cmd === "close_tab").map(([, a]) => a.tab),
      ["a"],
    );
  } finally {
    await teardown(tabs);
  }
});

test("纯函数：标签页菜单“关闭其他 / 关闭右侧”要关的标签页", () => {
  const tabs = ["a", "b", "c", "d"].map((id) => ({ id }));
  const ids = (list) => list.map((tab) => tab.id);
  assert.deepEqual(ids(tabsToClose(tabs, "b", "others")), ["a", "c", "d"]);
  assert.deepEqual(ids(tabsToClose(tabs, "b", "right")), ["c", "d"]);
  assert.deepEqual(ids(tabsToClose(tabs, "d", "right")), []);
  assert.deepEqual(ids(tabsToClose([{ id: "a" }], "a", "others")), []);
  assert.deepEqual(ids(tabsToClose(tabs, "x", "others")), []);
});

test("标签页菜单：关闭其他 / 关闭右侧逐个关闭，有修改的切过去询问，取消则停下；关掉当前的由右键的那个接替", async () => {
  const { tabs, fake, state } = setup({
    restored: ["a", "b", "c", "d", "e"].map((id) => [id, blank()]),
    active: "e",
    answers: ["cancel", "discard"],
  });
  const ids = () => state().tabs.map((t) => t.id);
  const closed = () =>
    fake.args.filter(([cmd]) => cmd === "close_tab").map(([, a]) => a.tab);
  try {
    await tabs.initialize();
    state().tabs.find((t) => t.id === "d").session.update(fromText("改丁"));
    // 右侧：c 直接关，d 有修改，询问时取消，e 保留。
    await tabs.closeTabs("b", "right");
    assert.deepEqual(fake.asked, ["无标题 4"]);
    assert.deepEqual(ids(), ["a", "b", "d", "e"]);
    assert.equal(state().active, "d");
    assert.deepEqual(closed(), ["c"]);
    // 其他：a 直接关，d 不保存后关掉（它是当前的，由 b 接替），e 也关。
    await tabs.closeTabs("b", "others");
    assert.deepEqual(ids(), ["b"]);
    assert.equal(state().active, "b");
    assert.deepEqual(closed(), ["c", "a", "d", "e"]);
    // 只剩一个：什么也不关，窗口不关。
    await tabs.closeTabs("b", "others");
    assert.deepEqual(ids(), ["b"]);
    assert.ok(!fake.calls.includes("plugin:window|close"));
  } finally {
    await teardown(tabs);
  }
});

test("标签页菜单：关闭右侧时当前标签页在左边则保持不变", async () => {
  const { tabs, state } = setup({
    restored: ["a", "b", "c"].map((id) => [id, blank()]),
    active: "a",
  });
  try {
    await tabs.initialize();
    await tabs.closeTabs("b", "right");
    assert.deepEqual(state().tabs.map((t) => t.id), ["a", "b"]);
    assert.equal(state().active, "a");
  } finally {
    await teardown(tabs);
  }
});

test("标签页菜单：打开文件所在位置把该标签页的路径交给 Rust，无标题不调用，失败显示在当前标签页", async () => {
  const { tabs, fake, tab } = setup({
    restored: [
      ["a", blank()],
      ["b", named("D:/笔记/乙.hush")],
    ],
  });
  try {
    await tabs.initialize();
    await tabs.revealTab("a");
    await tabs.revealTab("b");
    assert.deepEqual(
      fake.args.filter(([cmd]) => cmd === "reveal_in_explorer").map(([, a]) => a),
      [{ path: "D:/笔记/乙.hush" }],
    );
    fake.failReveal = "文件不存在：D:/笔记/乙.hush";
    await tabs.revealTab("b");
    assert.equal(
      tab("a").session.getSnapshot().error,
      "无法打开文件所在位置：文件不存在：D:/笔记/乙.hush",
    );
  } finally {
    await teardown(tabs);
  }
});
