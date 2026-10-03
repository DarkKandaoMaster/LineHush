import test from "node:test";
import assert from "node:assert/strict";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { createSession } from "../src/core/session.ts";
import { fromText } from "../src/core/document.ts";

/**
 * A session over a fake Rust boundary. `answers` are handed out in order to the
 * "save changes?" prompt; `savePath` / `openPath` answer the file dialogs.
 */
function setup({
  path = "D:/测试.hush",
  recovered = false,
  notice = null,
  answers = [],
} = {}) {
  globalThis.window = {};
  globalThis.isTauri = true;
  const fake = {
    calls: [],
    asked: [],
    savePath: null,
    openPath: null,
    failSave: false,
  };
  mockIPC(async (cmd, args) => {
    fake.calls.push(cmd);
    if (cmd === "restore")
      return { document: fromText("旧日记\n\n"), path, recovered, notice };
    if (cmd === "save_document" && fake.failSave) throw Error("测试写入失败");
    if (cmd === "plugin:dialog|save") return fake.savePath;
    if (cmd === "plugin:dialog|open") return fake.openPath;
    if (cmd === "save_as")
      return { document: args.document, path: args.path, recovered: false };
    if (cmd === "new_document" || cmd === "open_document")
      return {
        document: fromText(cmd === "new_document" ? "" : "打开的内容"),
        path: cmd === "new_document" ? null : args.path,
        recovered: false,
      };
  });
  mockWindows("main");
  const session = createSession(async (name) => {
    fake.asked.push(name);
    return answers.shift();
  });
  return { session, fake, state: () => session.getSnapshot() };
}
/** Lands any debounced stash first so its timer cannot fire into the next test's mocks. */
async function teardown(session) {
  await session.flush().catch(() => {});
  clearMocks();
  delete globalThis.window;
  delete globalThis.isTauri;
}
const fileCommands = (fake) =>
  fake.calls.filter((cmd) => !cmd.startsWith("plugin:"));

test("会话初始化只恢复一次，订阅快照稳定，暂存不清除未保存标记", async () => {
  const { session, fake, state } = setup();
  try {
    const initial = state();
    assert.equal(state(), initial);
    await Promise.all([session.initialize(), session.initialize()]);
    assert.deepEqual(fake.calls, ["restore"]);
    assert.equal(state().ready, true);
    assert.equal(state().generation, 1);
    assert.equal(state().dirty, false);
    assert.equal(state().status, "已保存");
    assert.equal(state().notice, "");
    let notifications = 0;
    session.subscribe(() => notifications++);
    session.update(fromText("新日记\n\n"));
    assert.equal(state().dirty, true);
    await session.flush();
    assert.deepEqual(fileCommands(fake), ["restore", "stash_document"]);
    assert.equal(state().dirty, true);
    assert.equal(state().status, "尚未保存");
    assert.notEqual(state(), initial);
    assert.ok(notifications > 0);
  } finally {
    await teardown(session);
  }
});

test("保存写入当前文件并清除未保存标记，失败时保留标记", async () => {
  const { session, fake, state } = setup();
  try {
    await session.initialize();
    session.update(fromText("新日记"));
    fake.failSave = true;
    await session.saveDocument();
    assert.equal(state().dirty, true);
    assert.equal(state().status, "保存失败");
    assert.match(state().error, /测试写入失败/);
    fake.failSave = false;
    await session.saveDocument();
    assert.equal(state().dirty, false);
    assert.equal(state().status, "已保存");
    assert.equal(state().error, "");
    // The pending stash lands before each save, never after it.
    assert.deepEqual(fileCommands(fake), [
      "restore",
      "stash_document",
      "save_document",
      "save_document",
    ]);
  } finally {
    await teardown(session);
  }
});

test("未命名文档保存走另存为，取消对话框则保持未保存", async () => {
  const { session, fake, state } = setup({ path: null });
  try {
    await session.initialize();
    assert.equal(state().status, "准备就绪");
    session.update(fromText("草稿"));
    await session.saveDocument(); // dialog cancelled
    assert.equal(state().dirty, true);
    assert.equal(state().path, null);
    fake.savePath = "D:/新文件.hush";
    await session.saveDocument();
    assert.equal(state().dirty, false);
    assert.equal(state().path, "D:/新文件.hush");
    assert.ok(!fake.calls.includes("save_document"));
    assert.equal(fake.calls.filter((cmd) => cmd === "save_as").length, 1);
  } finally {
    await teardown(session);
  }
});

test("恢复了未保存的修改时标记为未保存并提示", async () => {
  const { session, fake, state } = setup({ recovered: true, answers: ["cancel"] });
  try {
    await session.initialize();
    assert.equal(state().dirty, true);
    assert.equal(state().status, "尚未保存");
    assert.equal(state().notice, "已恢复未保存的修改。");
    await session.newDocument();
    assert.deepEqual(fake.asked, ["测试.hush"]);
    assert.equal(state().generation, 1);
  } finally {
    await teardown(session);
  }
});

test("恢复提示在保存成功后清除，保存失败时保留，其他提示不受影响", async () => {
  const { session, fake, state } = setup({ recovered: true });
  try {
    await session.initialize();
    assert.equal(state().notice, "已恢复未保存的修改。");
    fake.failSave = true;
    await session.saveDocument();
    assert.equal(state().status, "保存失败");
    assert.equal(state().notice, "已恢复未保存的修改。");
    fake.failSave = false;
    await session.saveDocument();
    assert.equal(state().dirty, false);
    assert.equal(state().notice, "");
    // Any other notice survives a later save.
    session.setNotice("已导出。");
    session.update(fromText("再改"));
    await session.saveDocument();
    assert.equal(state().notice, "已导出。");
  } finally {
    await teardown(session);
  }
});

test("恢复的未命名草稿经另存为保存后清除恢复提示", async () => {
  const { session, fake, state } = setup({ path: null, recovered: true });
  try {
    await session.initialize();
    assert.equal(state().notice, "已恢复未保存的修改。");
    fake.savePath = "D:/恢复.hush";
    await session.saveDocumentAs();
    assert.equal(state().dirty, false);
    assert.equal(state().notice, "");
  } finally {
    await teardown(session);
  }
});

test("原文件无法打开时恢复为未命名文档：显示 Rust 的提示，保存后清除", async () => {
  const notice =
    "原文件无法打开，未保存的修改已作为未命名文档恢复。无法打开 D:/搬走.hush：unable to open database file";
  const { session, fake, state } = setup({ path: null, recovered: true, notice });
  try {
    await session.initialize();
    assert.equal(state().path, null);
    assert.equal(state().dirty, true);
    assert.equal(state().error, "");
    assert.equal(state().notice, notice);
    fake.savePath = "D:/恢复.hush";
    await session.saveDocument();
    assert.equal(state().path, "D:/恢复.hush");
    assert.equal(state().dirty, false);
    assert.equal(state().notice, "");
  } finally {
    await teardown(session);
  }
});

test("恢复后在关闭弹窗选保存：保存成功清除恢复提示", async () => {
  const { session, state } = setup({ recovered: true, answers: ["save"] });
  try {
    await session.initialize();
    await session.close();
    assert.equal(state().notice, "");
  } finally {
    await teardown(session);
  }
});

test("没有修改时新建、打开、关闭都不询问", async () => {
  const { session, fake, state } = setup();
  try {
    await session.initialize();
    await session.newDocument();
    assert.equal(state().path, null);
    fake.openPath = "D:/打开.hush";
    await session.openDocument();
    assert.equal(state().path, "D:/打开.hush");
    await session.close();
    assert.deepEqual(fake.asked, []);
    assert.deepEqual(fake.calls.slice(-2), [
      "close_document",
      "plugin:window|destroy",
    ]);
  } finally {
    await teardown(session);
  }
});

test("新建前询问：取消不动，不保存直接新建，保存先写文件", async () => {
  const { session, fake, state } = setup({
    answers: ["cancel", "discard", "save"],
  });
  try {
    await session.initialize();
    const edited = fromText("改过");
    session.update(edited);
    await session.newDocument();
    assert.equal(state().document, edited);
    assert.equal(state().dirty, true);
    assert.ok(!fake.calls.includes("new_document"));

    await session.newDocument();
    assert.equal(state().generation, 2);
    assert.equal(state().dirty, false);
    assert.ok(!fake.calls.includes("save_document"));

    session.update(fromText("新草稿"));
    fake.savePath = "D:/草稿.hush";
    await session.newDocument(); // untitled: "save" goes through Save As
    assert.deepEqual(fake.asked, ["测试.hush", "测试.hush", "未命名"]);
    const tail = fileCommands(fake).slice(-3);
    assert.deepEqual(tail, ["stash_document", "save_as", "new_document"]);
    assert.equal(state().generation, 3);
  } finally {
    await teardown(session);
  }
});

test("未命名文档选保存但取消另存为时，不打开也不关闭", async () => {
  const { session, fake, state } = setup({
    path: null,
    answers: ["save", "save"],
  });
  try {
    await session.initialize();
    session.update(fromText("草稿"));
    fake.openPath = "D:/打开.hush";
    await session.openDocument();
    await session.close();
    assert.equal(state().path, null);
    assert.equal(state().dirty, true);
    assert.equal(state().error, "");
    for (const cmd of [
      "plugin:dialog|open",
      "open_document",
      "close_document",
      "plugin:window|destroy",
    ])
      assert.ok(!fake.calls.includes(cmd), cmd);
  } finally {
    await teardown(session);
  }
});

test("打开前询问：不保存后选文件打开，保存则先写当前文件", async () => {
  const { session, fake, state } = setup({ answers: ["discard", "save"] });
  try {
    await session.initialize();
    session.update(fromText("改过"));
    fake.openPath = "D:/甲.hush";
    await session.openDocument();
    assert.equal(state().path, "D:/甲.hush");
    assert.ok(!fake.calls.includes("save_document"));
    session.update(fromText("又改过"));
    fake.openPath = "D:/乙.hush";
    await session.openDocument();
    assert.equal(state().path, "D:/乙.hush");
    assert.deepEqual(fake.calls.slice(-4), [
      "stash_document",
      "save_document",
      "plugin:dialog|open",
      "open_document",
    ]);
  } finally {
    await teardown(session);
  }
});

test("关闭前询问：取消保留窗口，保存失败保留窗口，不保存则清理后关闭", async () => {
  const { session, fake, state } = setup({
    answers: ["cancel", "save", "discard"],
  });
  try {
    await session.initialize();
    session.update(fromText("改过"));
    await session.close();
    assert.ok(!fake.calls.includes("close_document"));

    fake.failSave = true;
    await session.close();
    assert.match(state().error, /^未关闭窗口：.*测试写入失败/);
    assert.equal(state().status, "保存失败");
    assert.ok(!fake.calls.includes("close_document"));

    await session.close();
    assert.equal(fake.asked.length, 3);
    assert.deepEqual(fake.calls.slice(-2), [
      "close_document",
      "plugin:window|destroy",
    ]);
    assert.equal(fake.calls.filter((cmd) => cmd === "save_document").length, 1);
  } finally {
    await teardown(session);
  }
});
