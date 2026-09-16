import test from "node:test";
import assert from "node:assert/strict";
import { SaveQueue } from "../src/save-queue.ts";
test("保存期间的新修改随后保存，永不并发写入", async () => {
  let release;
  const seen = [];
  const queue = new SaveQueue(async (doc) => {
    seen.push(doc);
    if (doc === "a") await new Promise((resolve) => (release = resolve));
  });
  queue.update("a");
  const first = queue.flush();
  queue.update("b");
  const second = queue.flush();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(queue.dirty, false);
});
test("保存失败保留最新内容，可重试", async () => {
  let fails = true;
  const saved = [];
  const queue = new SaveQueue(async (doc) => {
    if (fails) throw Error("disk full");
    saved.push(doc);
  });
  queue.update("a");
  await assert.rejects(queue.flush());
  assert.equal(queue.dirty, true);
  queue.update("b");
  fails = false;
  await queue.flush();
  assert.deepEqual(saved, ["b"]);
});
