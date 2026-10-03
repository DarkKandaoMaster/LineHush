import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = path.resolve("test-results/native-" + Date.now());
await mkdir(root, { recursive: true });
const profile = process.argv.includes("--release") ? "release" : "debug";
const exe = path.resolve(`src-tauri/target/${profile}/linehush.exe`);
const errors = [];
let processHandle, browser;
async function start() {
  processHandle = spawn(exe, [], {
    windowsHide: true,
    env: {
      ...process.env,
      LINEHUSH_TEST_DATA_DIR: path.join(root, "app"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223",
    },
  });
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) throw Error("无法连接 WebView2");
  const context = browser.contexts()[0];
  let page = context.pages()[0];
  if (!page) page = await context.waitForEvent("page");
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) errors.push(msg.text());
  });
  await page.getByRole("textbox", { name: "日记正文" }).waitFor();
  return page;
}
async function stop(page) {
  await call(page, "plugin:window|close");
  if (processHandle.exitCode === null)
    await new Promise((r) => processHandle.once("exit", r));
  await browser.close();
  browser = undefined;
}
const call = (page, cmd, args = {}) =>
  page.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
// Short read-only connections, so the app's own writes are never held up.
function query(file, sql, ...params) {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
const body = (file) =>
  JSON.parse(query(file, "SELECT body FROM doc WHERE id = 1")[0].body);
const storedIds = (file) =>
  query(file, "SELECT id FROM images ORDER BY id").map((r) => r.id);
const stored = (file, id) =>
  Buffer.from(query(file, "SELECT data FROM images WHERE id = ?", id)[0].data);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pictures = (doc) =>
  doc.blocks.filter((b) => b.type === "images").flatMap((b) => b.images);
try {
  let page = await start();
  let editor = page.getByRole("textbox", { name: "日记正文" });
  await editor.click();
  await page.keyboard.insertText("桌面端中文日记");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二行");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByText("草稿已保留", { exact: true })).toBeVisible();
  // The unnamed draft is itself a .hush file in the data folder.
  const draftFile = path.join(root, "app/draft.hush");
  const draft = body(draftFile);
  expect(draft.blocks.map((b) => b.text)).toEqual([
    "桌面端中文日记",
    "",
    "第二行",
    "",
    "",
  ]);
  expect(
    JSON.parse(await readFile(path.join(root, "app/recovery.json"), "utf8")),
  ).toEqual({ path: null });
  const file = path.join(root, "测试.hush");
  await call(page, "save_as", { path: file, document: draft });
  expect(existsSync(file + ".tmp")).toBe(false);
  expect(existsSync(draftFile)).toBe(false);
  await page.reload();
  await editor.waitFor();
  await expect(page.getByText("测试.hush", { exact: true })).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+End");
  // Distinct real images on disk, so each one can be compared byte for byte.
  const sources = path.join(root, "源图");
  await mkdir(sources);
  const source = {};
  for (const [name, options] of [
    ["第一张.png", { clip: { x: 0, y: 0, width: 240, height: 160 } }],
    ["第二张.png", { clip: { x: 0, y: 0, width: 200, height: 140 } }],
    ["追加.jpg", { type: "jpeg", quality: 80 }],
    ["空行之后.png", { clip: { x: 0, y: 0, width: 180, height: 120 } }],
    ["将删除.png", { clip: { x: 0, y: 0, width: 160, height: 110 } }],
  ]) {
    const bytes = await page.screenshot(options);
    const file = path.join(sources, name);
    await writeFile(file, bytes);
    source[name] = { file, bytes, id: sha256(bytes) };
  }
  const input = page.locator("input[type=file]");
  await input.setInputFiles([
    source["第一张.png"].file,
    source["第二张.png"].file,
  ]);
  await expect(editor.locator(".image-group")).toHaveCount(1);
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  await editor.locator(".image-tile").first().click();
  await input.setInputFiles(source["追加.jpg"].file);
  await expect(editor.locator(".image-tile img")).toHaveCount(3);
  await page.keyboard.press("Control+z");
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  await editor.click();
  await page.keyboard.press("Control+End");
  const blankLines = await editor.locator("p").count();
  await input.setInputFiles(source["空行之后.png"].file);
  await expect(editor.locator(".image-group")).toHaveCount(2);
  expect(await editor.locator("p").count()).toBeGreaterThanOrEqual(blankLines);
  await page.keyboard.press("Control+z");
  await expect(editor.locator(".image-group")).toHaveCount(1);
  const thumbnailsLoaded = () =>
    expect
      .poll(() =>
        editor
          .locator(".image-tile img")
          .evaluateAll((images) =>
            images.every((img) => img.complete && img.naturalWidth > 0),
          ),
      )
      .toBe(true);
  await thumbnailsLoaded();
  await editor.locator(".image-tile").first().dblclick();
  await expect(page.locator("dialog img")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存原图" })).toBeVisible();
  await page.getByRole("button", { name: "关闭原图" }).click();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("图片之后");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  const saved = body(file);
  expect(saved.blocks.at(-1)).toEqual({ type: "line", text: "" });
  expect(pictures(saved)).toEqual(
    ["第一张.png", "第二张.png"].map((name) =>
      expect.objectContaining({ id: source[name].id, name }),
    ),
  );
  // Originals are stored unchanged; undone imports stay until the file is closed.
  for (const name of Object.keys(source).filter((n) => n !== "将删除.png"))
    expect(stored(file, source[name].id).equals(source[name].bytes)).toBe(true);
  const exported = path.join(root, "导出");
  await mkdir(exported);
  const first = source["第一张.png"];
  await call(page, "export_image", {
    id: first.id,
    path: path.join(exported, "原图.png"),
  });
  expect(
    (await readFile(path.join(exported, "原图.png"))).equals(first.bytes),
  ).toBe(true);
  const attachment = `${first.id.slice(0, 12)}-第一张.png`;
  await call(page, "export_document", {
    path: path.join(exported, "测试.html"),
    content: "<p>导出</p>",
    images: [{ id: first.id, file: attachment }],
  });
  expect(
    (await readFile(path.join(exported, "附件", attachment))).equals(
      first.bytes,
    ),
  ).toBe(true);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, "desktop.png") });
  // An image deleted from the body stays in the file until it is closed.
  const doomed = source["将删除.png"];
  await page.keyboard.press("Control+End");
  await input.setInputFiles(doomed.file);
  await expect(editor.locator(".image-group")).toHaveCount(2);
  await thumbnailsLoaded();
  await editor.locator(".image-group").last().locator(".image-tile").click();
  await page.keyboard.press("Delete");
  await expect(editor.locator(".image-group")).toHaveCount(1);
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  const before = body(file);
  expect(pictures(before).map((p) => p.id)).not.toContain(doomed.id);
  expect(storedIds(file)).toContain(doomed.id);
  expect(before.blocks.at(-1).type).toBe("line");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("关闭前输入");
  before.blocks.at(-1).text += "关闭前输入";
  await stop(page);
  // Closing leaves a single plain SQLite file with only the referenced images.
  expect(
    (await readdir(root)).filter((n) => n.startsWith("测试.hush")),
  ).toEqual(["测试.hush"]);
  const header = (await readFile(file)).subarray(0, 16).toString("latin1");
  expect(header).toBe("SQLite format 3\0");
  expect(query(file, "PRAGMA application_id")[0].application_id).toBe(
    0x48555348,
  );
  expect(query(file, "PRAGMA user_version")[0].user_version).toBe(1);
  expect(query(file, "PRAGMA auto_vacuum")[0].auto_vacuum).toBe(2);
  expect(query(file, "PRAGMA freelist_count")[0].freelist_count).toBe(0);
  expect(body(file)).toEqual(before);
  expect(storedIds(file)).toEqual(
    [...new Set(pictures(before).map((p) => p.id))].sort(),
  );
  expect(storedIds(file)).not.toContain(doomed.id);
  page = await start();
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  await thumbnailsLoaded();
  expect(body(file)).toEqual(before);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      profile,
      root,
      checks: [
        "中文换行",
        "草稿恢复",
        "保存重开",
        "多图原图",
        "撤销重做",
        "关闭保护",
        "关闭清理",
        "文件结构",
      ],
    }),
  );
} finally {
  if (browser) await browser.close();
  if (processHandle?.exitCode === null) processHandle.kill();
}
