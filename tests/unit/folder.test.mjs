import test from "node:test";
import assert from "node:assert/strict";
import {
  FOLDER_LIMIT,
  FOLDER_TOO_LARGE,
  checkFolderSize,
  childPath,
  folderSize,
  isFolderItem,
  readBytes,
  readFolder,
  withoutFolderStubs,
  zipName,
} from "../../src/core/folder.ts";

/** A file entry as webkitGetAsEntry hands it out; `fail` makes `file()` fail. */
const fileEntry = (name, size = 1, fail = false) => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (ok, error) =>
    setTimeout(() =>
      fail ? error(new Error("NotReadableError")) : ok(new File([new Uint8Array(size)], name)),
    ),
});
/**
 * A folder entry whose reader hands out `batch` entries per call (Chromium: up
 * to 100) and then an empty array; counts the calls in `reads`.
 */
const dirEntry = (name, children, { batch = 2, fail = false } = {}) => {
  const entry = {
    name,
    isFile: false,
    isDirectory: true,
    reads: 0,
    createReader() {
      let at = 0;
      return {
        readEntries(ok, error) {
          entry.reads++;
          setTimeout(() => {
            if (fail) return error(new Error("SecurityError"));
            ok(children.slice(at, at + batch));
            at += batch;
          });
        },
      };
    },
  };
  return entry;
};

test("childPath：根下不带前缀，子文件夹用正斜杠拼接", () => {
  assert.equal(childPath("", "a.txt"), "a.txt");
  assert.equal(childPath("子目录", "b.txt"), "子目录/b.txt");
  assert.equal(childPath("子目录/空目录", "c"), "子目录/空目录/c");
  assert.equal(zipName("资料"), "资料.zip");
});

test("readFolder：readEntries 循环读到空数组为止，深度优先、按原顺序，空文件夹也记下", async () => {
  const many = Array.from({ length: 5 }, (_, i) => fileEntry(`${i}.txt`));
  const sub = dirEntry("子目录", [fileEntry("b.txt", 3), dirEntry("空目录", []), ...many]);
  const root = dirEntry("资料", [fileEntry("z.txt", 2), sub, fileEntry("a.txt", 4)]);
  const folder = await readFolder(root);
  assert.equal(folder.name, "资料");
  assert.deepEqual(folder.dirs, ["子目录", "子目录/空目录"]);
  assert.deepEqual(
    folder.files.map((f) => f.path),
    ["z.txt", "子目录/b.txt", "子目录/0.txt", "子目录/1.txt", "子目录/2.txt", "子目录/3.txt", "子目录/4.txt", "a.txt"],
  );
  assert.ok(folder.files.every((f) => f.file instanceof File));
  // 7 entries two at a time: 4 parts and the empty one.
  assert.equal(sub.reads, 5);
  assert.equal(folderSize(folder), 2 + 3 + 5 + 4);
});

test("readFolder：空文件夹没有文件也没有子文件夹", async () => {
  assert.deepEqual(await readFolder(dirEntry("空", [])), { name: "空", files: [], dirs: [] });
});

test("readFolder：读不了的文件夹 / 文件报“无法读取”加相对路径", async () => {
  await assert.rejects(
    readFolder(dirEntry("资料", [dirEntry("私密", [], { fail: true })])),
    { message: "无法读取“私密”" },
  );
  await assert.rejects(readFolder(dirEntry("资料", [], { fail: true })), {
    message: "无法读取“资料”",
  });
  await assert.rejects(
    readFolder(dirEntry("资料", [dirEntry("子", [fileEntry("锁.txt", 1, true)])])),
    { message: "无法读取“子/锁.txt”" },
  );
});

test("大小预检：文件大小之和超过 256 MB 才拒绝", () => {
  const big = (size) => ({ path: "x", file: { size } });
  assert.doesNotThrow(() => checkFolderSize({ name: "a", files: [big(FOLDER_LIMIT)], dirs: [] }));
  assert.doesNotThrow(() => checkFolderSize({ name: "a", files: [], dirs: ["空"] }));
  assert.throws(
    () => checkFolderSize({ name: "a", files: [big(FOLDER_LIMIT - 10), big(11)], dirs: [] }),
    { message: FOLDER_TOO_LARGE },
  );
  assert.equal(FOLDER_TOO_LARGE, "文件夹过大（上限 256 MB）");
});

test("withoutFolderStubs：只剔掉与剪贴板文件夹同名、0 字节、无类型的假文件", () => {
  const stub = new File([], "资料");
  const real = new File([new Uint8Array(3)], "资料");
  const typed = new File([], "资料", { type: "text/plain" });
  const other = new File([], "空.txt");
  const files = [other, stub, real, typed];
  assert.deepEqual(withoutFolderStubs(files, [{ name: "资料", path: "D:\\资料" }]), [other, real, typed]);
  assert.deepEqual(withoutFolderStubs(files, []), files);
});

test("isFolderItem / readBytes", async () => {
  assert.equal(isFolderItem(new File([], "a")), false);
  assert.equal(isFolderItem({ folder: "a", path: "D:\\a" }), true);
  assert.equal((await readBytes({ path: "a", file: new File([new Uint8Array(4)], "a") })).byteLength, 4);
  const broken = { arrayBuffer: () => Promise.reject(new Error("NotReadableError")) };
  await assert.rejects(readBytes({ path: "子/a.txt", file: broken }), { message: "无法读取“子/a.txt”" });
});
