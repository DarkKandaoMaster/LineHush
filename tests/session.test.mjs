import test from "node:test";
import assert from "node:assert/strict";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { createSession } from "../src/core/session.ts";
import { fromText } from "../src/core/document.ts";

test("会话初始化只恢复一次，订阅快照稳定，更新后保存最新正文", async () => {
  globalThis.window = {};
  globalThis.isTauri = true;
  let restores = 0;
  const saved = [];
  mockIPC(async (cmd, args) => {
    if (cmd === "restore") {
      restores++;
      return {
        document: fromText("旧日记\n\n"),
        path: "D:/测试.hush",
        recovered: true,
      };
    }
    if (cmd === "save_document") saved.push(args.document);
  });
  const session = createSession();
  try {
    const initial = session.getSnapshot();
    assert.equal(session.getSnapshot(), initial);
    await Promise.all([session.initialize(), session.initialize()]);
    assert.equal(restores, 1);
    assert.equal(session.getSnapshot().ready, true);
    assert.equal(session.getSnapshot().generation, 1);
    let notifications = 0;
    session.subscribe(() => notifications++);
    const doc = fromText("新日记\n\n");
    session.update(doc);
    assert.equal(session.getSnapshot().dirty, true);
    await session.flush();
    assert.deepEqual(saved, [doc]);
    assert.equal(session.getSnapshot().dirty, false);
    assert.equal(session.getSnapshot().status, "已保存");
    assert.notEqual(session.getSnapshot(), initial);
    assert.ok(notifications > 0);
  } finally {
    clearMocks();
    delete globalThis.window;
    delete globalThis.isTauri;
  }
});
