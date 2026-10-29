import test from "node:test";
import assert from "node:assert/strict";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { createSession } from "../../src/core/session.ts";
import { fromText } from "../../src/core/document.ts";
import { DEFAULT_SETTINGS } from "../../src/core/settings.ts";

/**
 * One tab's session over a fake Rust boundary, loaded with a document as
 * `restore_window` / `open_file` would hand it out. `answers` are handed out in
 * order to the "save changes?" prompt; `savePath` answers the save dialog.
 */
function setup({
  path = "D:/测试.hush",
  recovered = false,
  notice = null,
  answers = [],
  name = "测试.hush",
  fileNameMode = "date",
} = {}) {
  globalThis.window = {};
  const fake = {
    calls: [],
    /** Arguments of each Rust command, in order. */
    args: [],
    asked: [],
    savePath: null,
    failSave: false,
    failClose: false,
  };
  mockIPC(async (cmd, args) => {
    fake.calls.push(cmd);
    fake.args.push([cmd, args]);
    // `holdSave` keeps the write pending until the test resolves it.
    if (cmd === "save_document" && fake.holdSave) await fake.holdSave;
    if (cmd === "save_document" && fake.failSave) throw Error("测试写入失败");
    if (cmd === "close_tab" && fake.failClose) throw "测试清理失败";
    if (cmd === "export_pdf") {
      fake.pdf = args;
      if (fake.failPdf) throw "无法写入 PDF 文件";
    }
    if (cmd === "plugin:dialog|save") {
      if (fake.holdDialog) await fake.holdDialog;
      fake.dialog = args.options;
      return fake.savePath;
    }
    if (cmd === "save_as")
      return { document: args.document, path: args.path, recovered: false };
    if (cmd === "suggest_save_path") return `D:/笔记/${args.base}.hush`;
  });
  mockWindows("win-1");
  const session = createSession(
    "t1",
    async (name) => {
      fake.asked.push(name);
      if (fake.holdAsk) await fake.holdAsk;
      return answers.shift();
    },
    () => name,
    () => fileNameMode,
  );
  session.adopt({ document: fromText("旧日记\n\n"), path, recovered, notice });
  return { session, fake, state: () => session.getSnapshot() };
}
/** Lands any debounced stash first so its timer cannot fire into the next test's mocks. */
async function teardown(session) {
  await session.flush().catch(() => {});
  clearMocks();
  delete globalThis.window;
}
const fileCommands = (fake) =>
  fake.calls.filter((cmd) => !cmd.startsWith("plugin:"));

test("载入文档后快照稳定，暂存不清除未保存标记", async () => {
  const { session, fake, state } = setup();
  try {
    const initial = state();
    assert.equal(state(), initial);
    assert.equal(state().generation, 1);
    assert.equal(state().dirty, false);
    assert.equal(state().saveFailed, false);
    assert.equal(state().notice, "");
    assert.equal(session.tab, "t1");
    let notifications = 0;
    session.subscribe(() => notifications++);
    session.update(fromText("新日记\n\n"));
    assert.equal(state().dirty, true);
    await session.flush();
    assert.deepEqual(fileCommands(fake), ["stash_document"]);
    assert.equal(state().dirty, true);
    assert.equal(state().saveFailed, false);
    assert.notEqual(state(), initial);
    assert.ok(notifications > 0);
  } finally {
    await teardown(session);
  }
});

test("每个命令都带上本标签页的 id", async () => {
  const { session, fake } = setup({ answers: ["discard"] });
  try {
    session.update(fromText("改过"));
    await session.saveDocument();
    fake.savePath = "D:/另存.hush";
    await session.saveDocumentAs();
    fake.savePath = "D:/导出.txt";
    await session.exportDocument("txt", DEFAULT_SETTINGS);
    session.update(fromText("再改"));
    await session.closeTab();
    const rust = fake.args.filter(([cmd]) => !cmd.startsWith("plugin:"));
    assert.deepEqual(
      rust.map(([cmd]) => cmd),
      [
        "stash_document",
        "save_document",
        "save_as",
        "export_document",
        "stash_document",
        "close_tab",
      ],
    );
    for (const [cmd, args] of rust) assert.equal(args.tab, "t1", cmd);
  } finally {
    await teardown(session);
  }
});

test("改回已保存的内容时清除未保存标记，暂存照常进行", async () => {
  const { session, fake, state } = setup();
  try {
    session.update(fromText("改过"));
    assert.equal(state().dirty, true);
    assert.equal(state().saveFailed, false);
    session.update(fromText("旧日记\n\n"));
    assert.equal(state().dirty, false);
    assert.equal(state().saveFailed, false);
    await session.flush();
    assert.deepEqual(fileCommands(fake), ["stash_document"]);

    session.update(fromText("保存的内容"));
    await session.saveDocument();
    assert.equal(state().dirty, false);
    session.update(fromText("另一内容"));
    assert.equal(state().dirty, true);
    session.update(fromText("保存的内容"));
    assert.equal(state().dirty, false);
    assert.equal(state().saveFailed, false);
  } finally {
    await teardown(session);
  }
});

test("未命名新文档改回空文档时清除未保存标记，恢复的修改改回也仍为未保存", async () => {
  {
    const { session, state } = setup({ path: null });
    try {
      session.adopt({
        document: fromText(""),
        path: null,
        recovered: false,
        notice: null,
      });
      assert.equal(state().generation, 2);
      session.update(fromText("草稿"));
      assert.equal(state().dirty, true);
      session.update(fromText(""));
      assert.equal(state().dirty, false);
      assert.equal(state().saveFailed, false);
    } finally {
      await teardown(session);
    }
  }
  {
    // The saved content behind recovered changes is unknown.
    const { session, state } = setup({ recovered: true });
    try {
      session.update(fromText("改过"));
      session.update(fromText("旧日记\n\n"));
      assert.equal(state().dirty, true);
      assert.equal(state().saveFailed, false);
    } finally {
      await teardown(session);
    }
  }
});

test("恢复的未命名文档删空后清除未保存标记（同新建的空文档），改出别的内容仍为未保存", async () => {
  for (const notice of [null, "原文件无法打开，未保存的修改已作为未命名文档恢复。测试"]) {
    // Crash residue or a reload: Rust recovers an untitled stash only when it is not empty.
    const { session, state } = setup({ path: null, recovered: true, notice });
    try {
      assert.equal(state().dirty, true);
      session.update(fromText("改过"));
      assert.equal(state().dirty, true);
      session.update(fromText(""));
      assert.equal(state().dirty, false);
      // A blank line more is other content than the new document's one empty line.
      session.update(fromText("\n"));
      assert.equal(state().dirty, true);
      session.update(fromText("旧日记\n\n"));
      assert.equal(state().dirty, true);
    } finally {
      await teardown(session);
    }
  }
});

test("保存写入当前文件并清除未保存标记，失败时保留标记并可重试", async () => {
  const { session, fake, state } = setup();
  try {
    session.update(fromText("新日记"));
    fake.failSave = true;
    await session.saveDocument();
    assert.equal(state().dirty, true);
    assert.equal(state().saveFailed, true);
    assert.match(state().error, /^保存失败：.*测试写入失败/);
    fake.failSave = false;
    await session.saveDocument();
    assert.equal(state().dirty, false);
    assert.equal(state().saveFailed, false);
    assert.equal(state().error, "");
    // The pending stash lands before each save, never after it.
    assert.deepEqual(fileCommands(fake), [
      "stash_document",
      "save_document",
      "save_document",
    ]);
  } finally {
    await teardown(session);
  }
});

test("未命名文档保存走另存为（默认文件名为日期），取消对话框则保持未保存", async () => {
  const { session, fake, state } = setup({ path: null, name: "无标题 2" });
  try {
    assert.equal(state().saveFailed, false);
    session.update(fromText("草稿"));
    await session.saveDocument(); // dialog cancelled
    // Rust picks the folder and a free name (suggest_save_path) for the date.
    const [base] = fake.args
      .filter(([cmd]) => cmd === "suggest_save_path")
      .map(([, args]) => args.base);
    assert.match(base, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(fake.dialog.defaultPath, `D:/笔记/${base}.hush`);
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

test("默认文件名为首行文字：取第一行有字的文字，没有时退回日期；已命名的另存为不问 Rust", async () => {
  const { session, fake } = setup({ path: null, fileNameMode: "firstLine" });
  const bases = () =>
    fake.args
      .filter(([cmd]) => cmd === "suggest_save_path")
      .map(([, args]) => args.base);
  try {
    session.update(fromText("\n  \n  十月: 一日 \n第二行"));
    await session.saveDocument(); // dialog cancelled
    assert.deepEqual(bases(), ["十月 一日"]);
    assert.equal(fake.dialog.defaultPath, "D:/笔记/十月 一日.hush");
    session.update(fromText("  \n"));
    await session.saveDocumentAs();
    assert.match(bases()[1], /^\d{4}-\d{2}-\d{2}$/);
    fake.savePath = "D:/笔记/十月 一日.hush";
    session.update(fromText("十月"));
    await session.saveDocument();
    assert.equal(bases().length, 3);
    // A named document's Save As starts at its own path.
    fake.savePath = null;
    await session.saveDocumentAs();
    assert.equal(bases().length, 3);
    assert.equal(fake.dialog.defaultPath, "D:/笔记/十月 一日.hush");
  } finally {
    await teardown(session);
  }
});

test("恢复了未保存的修改时标记为未保存，不显示提示", async () => {
  const { session, fake, state } = setup({ recovered: true, answers: ["cancel"] });
  try {
    assert.equal(state().dirty, true);
    assert.equal(state().saveFailed, false);
    assert.equal(state().notice, "");
    assert.equal(await session.closeTab(), false);
    assert.deepEqual(fake.asked, ["测试.hush"]);
    assert.ok(!fake.calls.includes("close_tab"));
  } finally {
    await teardown(session);
  }
});

test("Rust 的恢复提示在保存成功后清除，保存失败时保留，其他提示不受影响", async () => {
  const notice = "原文件无法打开，未保存的修改已作为未命名文档恢复。测试";
  const { session, fake, state } = setup({ recovered: true, notice });
  try {
    assert.equal(state().notice, notice);
    fake.failSave = true;
    await session.saveDocument();
    assert.equal(state().saveFailed, true);
    assert.equal(state().notice, notice);
    fake.failSave = false;
    await session.saveDocument();
    assert.equal(state().dirty, false);
    assert.equal(state().notice, "");
    // Any other notice survives a later save.
    session.setNotice("其他提示");
    session.update(fromText("再改"));
    await session.saveDocument();
    assert.equal(state().notice, "其他提示");
  } finally {
    await teardown(session);
  }
});

test("恢复的未命名草稿不显示提示，经另存为保存后不再有修改", async () => {
  const { session, fake, state } = setup({ path: null, recovered: true });
  try {
    assert.equal(state().notice, "");
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
    "原文件无法打开，未保存的修改已作为未命名文档恢复。无法打开 D:/搬走.hush：文件不存在（系统找不到指定的文件。 (os error 2)）";
  const { session, fake, state } = setup({ path: null, recovered: true, notice });
  try {
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

test("没有修改时关闭标签页不询问，直接让 Rust 丢弃工作副本", async () => {
  const { session, fake } = setup();
  try {
    assert.equal(await session.closeTab(), true);
    assert.deepEqual(fake.asked, []);
    assert.deepEqual(fileCommands(fake), ["close_tab"]);
    // A released tab stashes nothing any more.
    session.update(fromText("关闭之后"));
    await session.flush();
    assert.deepEqual(fileCommands(fake), ["close_tab"]);
  } finally {
    await teardown(session);
  }
});

test("关闭标签页前询问：取消保留，保存失败保留并说明，不保存则丢弃", async () => {
  const { session, fake, state } = setup({
    answers: ["cancel", "save", "discard"],
  });
  try {
    session.update(fromText("改过"));
    assert.equal(await session.closeTab(), false);
    assert.ok(!fake.calls.includes("close_tab"));

    fake.failSave = true;
    const failure = (e) => `${e}，标签页未关闭。`;
    assert.equal(await session.closeTab(failure), false);
    assert.match(state().error, /^保存失败：.*测试写入失败，标签页未关闭。$/);
    assert.equal(state().saveFailed, true);
    assert.equal(state().busy, false);
    assert.ok(!fake.calls.includes("close_tab"));

    assert.equal(await session.closeTab(), true);
    assert.deepEqual(fake.asked, ["测试.hush", "测试.hush", "测试.hush"]);
    assert.equal(fake.calls.at(-1), "close_tab");
    assert.equal(fake.calls.filter((cmd) => cmd === "save_document").length, 1);
  } finally {
    await teardown(session);
  }
});

test("恢复后关闭时选保存：保存成功后才丢弃，恢复提示清除", async () => {
  const { session, fake, state } = setup({ recovered: true, answers: ["save"] });
  try {
    assert.equal(await session.closeTab(), true);
    assert.equal(state().notice, "");
    assert.deepEqual(fileCommands(fake), ["save_document", "close_tab"]);
  } finally {
    await teardown(session);
  }
});

test("未命名文档选保存但取消另存为时，不关闭；询问用的是标签页的显示名", async () => {
  const { session, fake, state } = setup({
    path: null,
    answers: ["save"],
    name: "无标题 3",
  });
  try {
    session.update(fromText("草稿"));
    assert.equal(await session.closeTab(), false);
    assert.deepEqual(fake.asked, ["无标题 3"]);
    assert.equal(state().path, null);
    assert.equal(state().dirty, true);
    assert.equal(state().error, "");
    assert.ok(!fake.calls.includes("close_tab"));
  } finally {
    await teardown(session);
  }
});

test("关闭时清理失败也照常关闭，不显示错误；忙碌时不关闭", async () => {
  const { session, fake, state } = setup({ answers: ["discard"] });
  try {
    session.update(fromText("不要了"));
    fake.failClose = true;
    assert.equal(await session.closeTab(), true);
    assert.equal(fake.calls.at(-1), "close_tab");
    assert.equal(state().error, "");
  } finally {
    await teardown(session);
  }
  const busy = setup();
  try {
    // A save waiting for its dialog keeps the session busy.
    busy.fake.savePath = null;
    const saving = busy.session.saveDocumentAs();
    assert.equal(busy.state().busy, true);
    assert.equal(await busy.session.resolveUnsaved(), false);
    await saving;
    assert.equal(await busy.session.resolveUnsaved(), true);
  } finally {
    await teardown(busy.session);
  }
});

test("切换文档时 Rust 的提示显示在横幅上，保存后仍保留", async () => {
  const warning = "上一个文件的未引用图片未能清理：读写失败（disk I/O error）";
  const { session, fake, state } = setup({ path: null });
  try {
    session.adopt({
      document: fromText("打开的内容"),
      path: "D:/甲.hush",
      recovered: false,
      notice: warning,
    });
    assert.equal(state().path, "D:/甲.hush");
    assert.equal(state().error, "");
    assert.equal(state().notice, warning);
    assert.equal(state().dirty, false);
    assert.equal(state().saveFailed, false);
    session.update(fromText("新内容"));
    fake.savePath = "D:/新.hush";
    await session.saveDocument();
    assert.equal(state().notice, warning);
  } finally {
    await teardown(session);
  }
});

test("导出 PDF：默认文件名与标题用显示名，打印页用传入设置的字体，失败显示导出失败", async () => {
  const { session, fake, state } = setup({
    path: "D:/日记/十月.hush",
    name: "十月.hush",
  });
  try {
    fake.savePath = "D:/导出/十月.pdf";
    await session.exportDocument("pdf", DEFAULT_SETTINGS);
    assert.equal(fake.dialog.defaultPath, "十月.pdf");
    assert.equal(fake.pdf.tab, "t1");
    assert.equal(fake.pdf.path, "D:/导出/十月.pdf");
    assert.ok(fake.pdf.html.includes("<title>十月</title>"));
    assert.ok(fake.pdf.html.includes('<div class="line">旧日记</div>'));
    // 传入的设置：默认的微软雅黑 10 pt。
    assert.ok(fake.pdf.html.includes('font-family:"微软雅黑", "Microsoft YaHei UI"'));
    assert.ok(fake.pdf.html.includes("font-size:10pt"));
    assert.equal(state().error, "");
    assert.equal(state().notice, "");
    // 取消对话框不调用 Rust。
    fake.pdf = undefined;
    fake.savePath = null;
    await session.exportDocument("pdf", DEFAULT_SETTINGS);
    assert.equal(fake.pdf, undefined);
    fake.savePath = "D:/导出/十月.pdf";
    fake.failPdf = true;
    await session.exportDocument("pdf", DEFAULT_SETTINGS);
    assert.equal(state().error, "导出失败：无法写入 PDF 文件");
    assert.equal(state().busy, false);
  } finally {
    await teardown(session);
  }
});

test("未命名文档导出的默认文件名为“无标题”", async () => {
  const { session, fake } = setup({ path: null, name: "无标题" });
  try {
    fake.savePath = null;
    await session.exportDocument("txt", DEFAULT_SETTINGS);
    assert.equal(fake.dialog.defaultPath, "无标题.txt");
  } finally {
    await teardown(session);
  }
});

/** A promise the test resolves by hand. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("已命名文件保存中：不锁界面（locked 为 false）但不重入（busy 为 true）", async () => {
  const { session, fake, state } = setup();
  try {
    session.update(fromText("新日记"));
    const gate = deferred();
    fake.holdSave = gate.promise;
    const saving = session.saveDocument();
    await new Promise((r) => setImmediate(r));
    assert.equal(fake.calls.at(-1), "save_document");
    assert.equal(state().busy, true);
    assert.equal(state().locked, false);
    // A second save while one is running is dropped, not queued.
    await session.saveDocument();
    gate.resolve();
    await saving;
    assert.equal(state().busy, false);
    assert.equal(state().locked, false);
    assert.equal(state().dirty, false);
    assert.equal(fake.calls.filter((cmd) => cmd === "save_document").length, 1);
  } finally {
    await teardown(session);
  }
});

test("保存进行中继续编辑：保存完成后仍为未保存，新内容随后暂存到工作副本", async () => {
  const { session, fake, state } = setup();
  try {
    session.update(fromText("第一版"));
    const gate = deferred();
    fake.holdSave = gate.promise;
    const saving = session.saveDocument();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fileCommands(fake), ["stash_document", "save_document"]);
    session.update(fromText("第二版"));
    assert.equal(state().dirty, true);
    // Nothing is stashed while the file is being written (Rust empties the
    // working copy when the save lands).
    await session.flush();
    assert.deepEqual(fileCommands(fake), ["stash_document", "save_document"]);
    gate.resolve();
    await saving;
    assert.equal(state().busy, false);
    assert.equal(state().dirty, true);
    assert.equal(state().saveFailed, false);
    assert.equal(state().error, "");
    const written = fake.args.find(([cmd]) => cmd === "save_document")[1].document;
    assert.deepEqual(written, fromText("第一版"));
    await session.flush();
    assert.deepEqual(fileCommands(fake), [
      "stash_document",
      "save_document",
      "stash_document",
    ]);
    assert.deepEqual(fake.args.at(-1)[1].document, fromText("第二版"));
    // Typing the saved content back is clean again; the second save writes 第二版.
    session.update(fromText("第一版"));
    assert.equal(state().dirty, false);
    session.update(fromText("第二版"));
    await session.saveDocument();
    assert.equal(state().dirty, false);
    assert.deepEqual(fake.args.at(-1)[1].document, fromText("第二版"));
  } finally {
    await teardown(session);
  }
});

test("保存进行中继续编辑而保存失败：错误横幅不带重试，新内容仍暂存", async () => {
  const { session, fake, state } = setup();
  try {
    session.update(fromText("第一版"));
    const gate = deferred();
    fake.holdSave = gate.promise;
    const saving = session.saveDocument();
    await new Promise((r) => setImmediate(r));
    session.update(fromText("第二版"));
    fake.failSave = true;
    gate.resolve();
    await saving;
    assert.equal(state().dirty, true);
    assert.match(state().error, /^保存失败：/);
    // 重试保存 would write 第二版, not what failed: it is not offered.
    assert.equal(state().saveFailed, false);
    await session.flush();
    assert.deepEqual(fileCommands(fake), [
      "stash_document",
      "save_document",
      "stash_document",
    ]);
    assert.deepEqual(fake.args.at(-1)[1].document, fromText("第二版"));
    fake.failSave = false;
    fake.holdSave = null;
    await session.saveDocument();
    assert.equal(state().dirty, false);
  } finally {
    await teardown(session);
  }
});

test("无标题文档保存（走对话框）期间锁住界面：locked 与 busy 都为 true", async () => {
  const { session, fake, state } = setup({ path: null, name: "无标题" });
  /** Runs `start` with the dialog held open, checks the flags, then lets it cancel. */
  async function heldDialog(start) {
    const gate = deferred();
    fake.holdDialog = gate.promise;
    fake.savePath = null;
    const pending = start();
    await new Promise((r) => setImmediate(r));
    assert.equal(state().busy, true);
    assert.equal(state().locked, true);
    gate.resolve();
    await pending;
    assert.equal(state().busy, false);
    assert.equal(state().locked, false);
  }
  try {
    session.update(fromText("草稿"));
    await heldDialog(() => session.saveDocument());
    assert.equal(fake.calls.at(-1), "plugin:dialog|save");
    // Save As and export lock too.
    await heldDialog(() => session.saveDocumentAs());
    await heldDialog(() => session.exportDocument("txt", DEFAULT_SETTINGS));
  } finally {
    await teardown(session);
  }
});

test("关闭标签页询问期间锁住界面", async () => {
  const { session, fake, state } = setup({ answers: ["cancel"] });
  try {
    session.update(fromText("改过"));
    const gate = deferred();
    fake.holdAsk = gate.promise;
    const closing = session.closeTab();
    await new Promise((r) => setImmediate(r));
    assert.equal(state().busy, true);
    assert.equal(state().locked, true);
    gate.resolve();
    assert.equal(await closing, false);
    assert.equal(state().locked, false);
  } finally {
    await teardown(session);
  }
});
