import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve("test-results/native-" + Date.now());
await mkdir(root, { recursive: true });
const exe = path.resolve("src-tauri/target/debug/linehush.exe");
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
  await page.getByRole("textbox", { name: "日记正文" }).waitFor();
  return page;
}
const call = (page, cmd, args = {}) =>
  page.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
try {
  let page = await start();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let editor = page.getByRole("textbox", { name: "日记正文" });
  await editor.click();
  await page.keyboard.insertText("桌面端中文日记");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二行");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByText("草稿已保留", { exact: true })).toBeVisible();
  const draft = JSON.parse(
    await readFile(path.join(root, "app/recovery.json"), "utf8"),
  );
  expect(draft.document.blocks.map((b) => b.text)).toEqual([
    "桌面端中文日记",
    "",
    "第二行",
    "",
    "",
  ]);
  const file = path.join(root, "测试.linehush");
  await call(page, "save_as", { path: file, document: draft.document });
  await page.reload();
  await editor.waitFor();
  await expect(page.getByText("测试.linehush", { exact: true })).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+End");
  // Import two real PNGs through the app's file input and raw IPC.
  const png = await page.screenshot();
  await page.locator("input[type=file]").setInputFiles([
    { name: "第一张.png", mimeType: "image/png", buffer: png },
    { name: "第二张.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(editor.locator(".image-group")).toHaveCount(1);
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  await editor.locator(".image-tile").first().click();
  await page.locator("input[type=file]").setInputFiles([{ name: "追加.png", mimeType: "image/png", buffer: png }]);
  await expect(editor.locator(".image-tile img")).toHaveCount(3);
  await page.keyboard.press("Control+z");
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  await editor.click(); await page.keyboard.press("Control+End");
  const blankLines = await editor.locator("p").count();
  await page.locator("input[type=file]").setInputFiles([{ name: "空行之后.png", mimeType: "image/png", buffer: png }]);
  await expect(editor.locator(".image-group")).toHaveCount(2);
  expect(await editor.locator("p").count()).toBeGreaterThanOrEqual(blankLines);
  await page.keyboard.press("Control+z");
  await expect(editor.locator(".image-group")).toHaveCount(1);
  await expect
    .poll(() =>
      editor
        .locator(".image-tile img")
        .evaluateAll((images) =>
          images.every((img) => img.complete && img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await editor.locator(".image-tile").first().dblclick();
  await expect(page.locator("dialog img")).toBeVisible();
  await page.getByRole("button", { name: "关闭原图" }).click();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("图片之后");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  const before = JSON.parse(await readFile(file, "utf8"));
  expect(before.blocks.at(-1)).toEqual({ type: "line", text: "" });
  expect(
    before.blocks.filter((b) => b.type === "images")[0].images,
  ).toHaveLength(2);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, "desktop.png") });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("关闭前输入");
  before.blocks.at(-1).text = "关闭前输入";
  await call(page, "plugin:window|close");
  if (processHandle.exitCode === null)
    await new Promise((r) => processHandle.once("exit", r));
  await browser.close();
  browser = undefined;
  page = await start();
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(before);
  // Reopening backs up the version the session started from.
  expect(JSON.parse(await readFile(file + ".bak", "utf8"))).toEqual(before);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      root,
      checks: [
        "中文换行",
        "草稿恢复",
        "保存重开",
        "多图原图",
        "撤销重做",
        "关闭保护",
        "重开备份",
      ],
    }),
  );
} finally {
  if (browser) await browser.close();
  if (processHandle?.exitCode === null) processHandle.kill();
}
