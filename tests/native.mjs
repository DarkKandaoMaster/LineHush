import { chromium, expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = path.resolve("test-results/native-" + Date.now());
const appData = path.join(root, "app");
const working = path.join(appData, "working.hush");
await mkdir(root, { recursive: true });
const profile = process.argv.includes("--release") ? "release" : "debug";
/**
 * `--only <名称>` 只跑一项可单独运行的用例（见下方 `cases`），不跑整套回归。
 * 整套只在发布前跑。
 */
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? undefined : process.argv[onlyAt + 1];
const exe = path.resolve(`src-tauri/target/${profile}/LineHush.exe`);
const errors = [];
const checks = [];
const passed = (name) => checks.push(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let processHandle, browser;
const cdp = "http://127.0.0.1:9223";
const appEnv = {
  ...process.env,
  LINEHUSH_TEST_DATA_DIR: appData,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223",
};
/** Launches the app (with `args`, run from `cwd`) and waits for its editor. */
async function start(args = [], cwd = undefined) {
  // A killed instance may still be releasing the debugging port.
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${cdp}/json/version`);
      await sleep(250);
    } catch {
      break;
    }
  }
  processHandle = spawn(exe, args, { windowsHide: true, cwd, env: appEnv });
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(cdp);
      break;
    } catch {
      await sleep(500);
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
async function exited() {
  if (processHandle.exitCode === null && processHandle.signalCode === null)
    await new Promise((r) => processHandle.once("exit", r));
  await browser?.close().catch(() => {});
  browser = undefined;
}
/**
 * Launches a second instance, the way a double-click does, and resolves with its
 * exit code: it should hand `args` to the running instance and quit at once.
 */
const launchSecond = (args, cwd) =>
  new Promise((resolve, reject) => {
    const second = spawn(exe, args, { windowsHide: true, cwd, env: appEnv });
    const timer = setTimeout(() => {
      second.kill();
      reject(Error("第二个进程没有退出"));
    }, 15000);
    second.once("error", reject);
    second.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
const windowTitle = (page) =>
  call(page, "plugin:window|title", { label: "main" });
/** Closes a window without unsaved changes; no question is asked. */
async function stop(page) {
  await requestClose(page);
  await exited();
}
/** Same as clicking the title bar ×: the frontend's close guard decides. */
const requestClose = (page) => call(page, "plugin:window|close");
/** Simulates a crash: the process gets no chance to clean up. */
async function kill() {
  await new Promise((resolve, reject) =>
    execFile("taskkill", ["/F", "/PID", String(processHandle.pid)], (e) =>
      e ? reject(e) : resolve(),
    ),
  );
  await exited();
}
const call = (page, cmd, args = {}) =>
  page.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
/**
 * Answers the native "保存日记" file dialog the way a user would: types the
 * file name into its box, presses 保存 and, with `replace`, confirms 是 in the
 * "already exists" question. Resolves with the name the dialog suggested.
 */
const SAVE_DIALOG = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SaveDialog {
  delegate bool Visit(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Visit visit, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  static string Class(IntPtr hwnd) { var b = new StringBuilder(256); GetClassName(hwnd, b, 256); return b.ToString(); }
  static string Title(IntPtr hwnd) { var b = new StringBuilder(256); GetWindowText(hwnd, b, 256); return b.ToString(); }
  static string Text(IntPtr edit) { var b = new StringBuilder(1024); SendMessage(edit, 0x000D, new IntPtr(1024), b); return b.ToString(); } // WM_GETTEXT
  /** A visible dialog box of the process: titled title, or (title null) any title but except. */
  static IntPtr Find(uint pid, string title, string except) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || Class(h) != "#32770" || !IsWindowVisible(h)) return true;
      string t = Title(h);
      if (title != null ? t == title : t != except) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  /** Returns the suggested name once the name is typed and 保存 pressed; null while not ready. */
  public static string Answer(uint pid, string title, string path) {
    IntPtr dialog = Find(pid, title, null), edit = IntPtr.Zero;
    if (dialog == IntPtr.Zero) return null;
    EnumChildWindows(dialog, (h, _) => {
      if (Class(h) == "Edit" && GetDlgCtrlID(h) == 1001) { edit = h; return false; }
      return true;
    }, IntPtr.Zero);
    IntPtr button = GetDlgItem(dialog, 1);
    if (edit == IntPtr.Zero || button == IntPtr.Zero) return null;
    // Wait until the dialog has filled in its default name, or it overwrites ours.
    string suggested = Text(edit);
    if (suggested.Length == 0) return null;
    System.Threading.Thread.Sleep(300);
    // The dialog only takes typed text, but typing a whole path races its
    // autocomplete; so set all but the last character and type that one.
    SendMessage(edit, 0x000C, IntPtr.Zero, new StringBuilder(path.Substring(0, path.Length - 1))); // WM_SETTEXT
    SendMessage(edit, 0x00B1, new IntPtr(path.Length), new IntPtr(path.Length)); // EM_SETSEL: caret at end
    SendMessage(edit, 0x0102, new IntPtr(path[path.Length - 1]), IntPtr.Zero); // WM_CHAR
    string typed = Text(edit);
    if (typed != path) {
      // Never let the dialog save under its default name somewhere else.
      PostMessage(GetDlgItem(dialog, 2), 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK 取消
      throw new Exception("file name not accepted: " + typed);
    }
    PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK 保存
    return suggested;
  }
  /** Presses 是 in the "replace the existing file?" task dialog. */
  public static bool Confirm(uint pid, string title) {
    IntPtr question = Find(pid, null, title);
    if (question == IntPtr.Zero) return false;
    PostMessage(question, 0x0466, new IntPtr(6), IntPtr.Zero); // TDM_CLICK_BUTTON IDYES
    return true;
  }
}
'@
$deadline = [DateTime]::Now.AddSeconds(20)
while (($suggested = [SaveDialog]::Answer([uint32]$env:LH_PID, $env:LH_TITLE, $env:LH_PATH)) -eq $null) {
  if ([DateTime]::Now -gt $deadline) { throw 'save dialog not found' }
  Start-Sleep -Milliseconds 200
}
if ($env:LH_REPLACE -eq '1') {
  while (-not [SaveDialog]::Confirm([uint32]$env:LH_PID, $env:LH_TITLE)) {
    if ([DateTime]::Now -gt $deadline) { throw 'replace question not found' }
    Start-Sleep -Milliseconds 200
  }
}
[Console]::Out.Write($suggested)
`;
const answerSaveDialog = (
  target,
  { replace = false, title = "保存日记" } = {},
) =>
  new Promise((resolve, reject) =>
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(SAVE_DIALOG, "utf16le").toString("base64"),
      ],
      {
        timeout: 30000,
        env: {
          ...process.env,
          LH_PID: String(processHandle.pid),
          LH_TITLE: title,
          LH_PATH: target,
          LH_REPLACE: replace ? "1" : "0",
        },
      },
      (e, stdout, stderr) =>
        e ? reject(Error(stderr || e.message)) : resolve(stdout),
    ),
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
/** The stashed body of the working copy, or null when nothing is stashed. */
const stash = (file = working) => {
  const rows = query(file, "SELECT body FROM doc WHERE id = 1");
  return rows.length ? JSON.parse(rows[0].body) : null;
};
const storedIds = (file) =>
  query(file, "SELECT id FROM images ORDER BY id").map((r) => r.id);
const stored = (file, id) =>
  Buffer.from(query(file, "SELECT data FROM images WHERE id = ?", id)[0].data);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pictures = (doc) =>
  doc.blocks.filter((b) => b.type === "images").flatMap((b) => b.images);
const lines = (doc) =>
  doc.blocks.filter((b) => b.type === "line").map((b) => b.text);
/** Bytes and modification time: proof that a file was not written at all. */
const fingerprint = async (file) => ({
  sha: sha256(await readFile(file)),
  mtime: (await stat(file)).mtimeMs,
});
/** Waits until the debounced stash (650 ms after the last edit) has landed. */
const stashed = (predicate) =>
  expect
    .poll(() => {
      const doc = stash();
      return doc !== null && predicate(doc);
    })
    .toBe(true);
/**
 * Image groups on screen. Each image is its own node, so a group is a run of
 * neighbouring `.image-item` children; hidden cursor widgets do not count.
 */
const imageGroups = (editor) =>
  editor.evaluate((el) => {
    let groups = 0;
    let previous = false;
    for (const child of el.children) {
      if (child.matches(".ProseMirror-gapcursor, .drop-line")) continue;
      const image = child.classList.contains("image-item");
      if (image && !previous) groups++;
      previous = image;
    }
    return groups;
  });
const expectGroups = (editor, count) =>
  expect.poll(() => imageGroups(editor)).toBe(count);
const imageNames = (editor) =>
  editor.locator(".image-tile img").evaluateAll((images) => images.map((img) => img.alt));
/**
 * 导出 PDF：新建文档输入中文（含空行）与两张图片，经导出菜单与系统保存对话框
 * 导出，再覆盖导出一次。只检查文件头尾与隐藏窗口已关闭；文字、图片与版式另用
 * Poppler（pdftotext / pdfimages / pdftoppm）检查。返回 PDF 路径。
 */
async function exportPdfCase() {
  const page = await start();
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await editor.click();
  await page.keyboard.insertText("导出 PDF 的中文第一行");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("空行之后的第二行，后面接两张图片");
  await page.keyboard.press("Enter");
  const sources = path.join(root, "PDF 源图");
  await mkdir(sources, { recursive: true });
  const files = [];
  for (const [name, options] of [
    ["横图.png", { clip: { x: 0, y: 0, width: 480, height: 240 } }],
    ["截图.jpg", { type: "jpeg", quality: 85 }],
  ]) {
    const file = path.join(sources, name);
    await writeFile(file, await page.screenshot(options));
    files.push(file);
  }
  await page.locator("input[type=file]").setInputFiles(files);
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  await editor.locator(".image-tile").last().click();
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("图片之后的最后一行");
  const target = path.join(root, "导出.pdf");
  const newButton = page.getByRole("button", { name: "新建", exact: true });
  const exportPdf = async (replace) => {
    await page.getByText("导出", { exact: true }).click();
    await page
      .getByRole("button", { name: "PDF 文档 (.pdf)", exact: true })
      .click();
    const suggested = await answerSaveDialog(target, {
      title: "导出日记",
      replace,
    });
    // 导出期间文件按钮不可用，结束后恢复。
    await expect.poll(() => existsSync(target), { timeout: 60000 }).toBe(true);
    await expect(newButton).toBeEnabled({ timeout: 60000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    const bytes = await readFile(target);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.subarray(-1024).toString("latin1")).toContain("%%EOF");
    // 隐藏的打印窗口已经关闭。
    expect(await call(page, "plugin:window|get_all_windows")).toEqual(["main"]);
    return suggested;
  };
  const suggested = await exportPdf(false);
  const first = await stat(target);
  await copyFile(target, path.join(root, "导出-第一次.pdf"));
  // 同一路径再导出一次：覆盖，标签 print 可以重复使用。
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二次导出追加的一行");
  await exportPdf(true);
  expect((await stat(target)).mtimeMs).toBeGreaterThan(first.mtimeMs);
  passed("导出 PDF");
  await requestClose(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "不保存", exact: true })
    .click();
  await exited();
  return { pdf: target, suggested };
}
const cases = { "导出 PDF": exportPdfCase };
if (only !== undefined) {
  try {
    const run = cases[only];
    if (!run)
      throw Error(
        `没有名为“${only}”的单项用例，可选：${Object.keys(cases).join("、")}`,
      );
    const result = await run();
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ passed: true, profile, root, checks, result }));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (processHandle?.exitCode === null) processHandle.kill();
  }
} else try {
  // --- Unnamed draft: stashed, recovered after a crash, saved via Save As ---
  let page = await start();
  let editor = page.getByRole("textbox", { name: "日记正文" });
  // Unsaved changes show only as "● " at the start of the window title.
  const dirty = (value) =>
    expect
      .poll(async () => (await windowTitle(page)).startsWith("● "))
      .toBe(value);
  await editor.click();
  await page.keyboard.insertText("桌面端中文日记");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二行");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const draftLines = ["桌面端中文日记", "", "第二行", "", ""];
  await dirty(true);
  // The unnamed draft lives only in the working copy, a .hush file in the data folder.
  await stashed((doc) => JSON.stringify(lines(doc)) === JSON.stringify(draftLines));
  expect(existsSync(path.join(appData, "draft.hush"))).toBe(false);
  await kill();
  page = await start();
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(page.getByText("已恢复未保存的修改。")).toBeVisible();
  await dirty(true);
  await expect(editor.locator("p")).toHaveText(draftLines);
  passed("草稿崩溃恢复");
  // Ctrl+S on an unnamed document goes through the Save As dialog.
  const file = path.join(root, "测试.hush");
  await editor.click();
  await page.keyboard.press("Control+s");
  const suggestedForDraft = await answerSaveDialog(file);
  await dirty(false);
  await expect.poll(() => windowTitle(page)).toBe("测试.hush");
  expect(lines(body(file))).toEqual(draftLines);
  expect(existsSync(file + ".tmp")).toBe(false);
  expect(stash()).toBeNull();
  expect(
    JSON.parse(await readFile(path.join(appData, "recovery.json"), "utf8"))
      .path,
  ).toMatch(/测试\.hush$/);
  passed("中文换行");
  passed("未命名保存走另存为");

  // --- Named file: edits and imports reach it only on Ctrl+S ---
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
    ["崩溃前.png", { clip: { x: 0, y: 0, width: 150, height: 100 } }],
  ]) {
    const bytes = await page.screenshot(options);
    const file = path.join(sources, name);
    await writeFile(file, bytes);
    source[name] = { file, bytes, id: sha256(bytes) };
  }
  const savedFile = await fingerprint(file);
  const savedBody = body(file);
  const savedIds = storedIds(file);
  const input = () => page.locator("input[type=file]");
  await input().setInputFiles([
    source["第一张.png"].file,
    source["第二张.png"].file,
  ]);
  await expectGroups(editor, 1);
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  // A click selects just that image; an import goes in right after it, inside the group.
  await editor.locator(".image-tile").first().click();
  await expect(editor.locator(".ProseMirror-selectednode")).toHaveCount(1);
  await expect(editor.locator(".image-item").first()).toHaveClass(
    /ProseMirror-selectednode/,
  );
  await input().setInputFiles(source["追加.jpg"].file);
  await expect(editor.locator(".image-tile img")).toHaveCount(3);
  expect(await imageNames(editor)).toEqual([
    "第一张.png",
    "追加.jpg",
    "第二张.png",
  ]);
  await expectGroups(editor, 1);
  await page.keyboard.press("Control+z");
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  // The first import replaced the empty line it went to: the document ends with
  // the group. Enter on its last image starts a line after it; an import on an
  // empty line below a text line replaces that line and makes a second group.
  expect(await editor.locator("p").count()).toBe(draftLines.length - 1);
  await editor.locator(".image-tile").last().click();
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("组后文字");
  await page.keyboard.press("Enter");
  const blankLines = await editor.locator("p").count();
  await input().setInputFiles(source["空行之后.png"].file);
  await expectGroups(editor, 2);
  expect(await editor.locator("p").count()).toBe(blankLines - 1);
  await page.keyboard.press("Control+z");
  await expectGroups(editor, 1);
  expect(await editor.locator("p").count()).toBe(blankLines);
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
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await dirty(true);
  await stashed(
    (doc) =>
      pictures(doc).length === 2 &&
      doc.blocks.at(-1).text === "" &&
      doc.blocks.some((b) => b.text === "图片之后"),
  );
  // The stash and the imported originals are in the working copy only.
  expect(await fingerprint(file)).toEqual(savedFile);
  expect(body(file)).toEqual(savedBody);
  expect(storedIds(file)).toEqual(savedIds);
  for (const name of ["第一张.png", "第二张.png", "追加.jpg", "空行之后.png"])
    expect(stored(working, source[name].id).equals(source[name].bytes)).toBe(
      true,
    );
  passed("只在保存时写文件");
  const edited = stash();
  await page.keyboard.press("Control+s");
  await dirty(false);
  const saved = body(file);
  expect(saved).toEqual(edited);
  expect(saved.blocks.at(-1)).toEqual({ type: "line", text: "" });
  expect(pictures(saved)).toEqual(
    ["第一张.png", "第二张.png"].map((name) =>
      expect.objectContaining({ id: source[name].id, name }),
    ),
  );
  // Originals are stored unchanged; undone imports stay until the file is closed.
  for (const name of ["第一张.png", "第二张.png", "追加.jpg", "空行之后.png"])
    expect(stored(file, source[name].id).equals(source[name].bytes)).toBe(true);
  // Saving empties the working copy, so a restart would not report a recovery.
  expect(stash()).toBeNull();
  expect(storedIds(working)).toEqual([]);
  await thumbnailsLoaded();
  passed("保存写入正文与新图片");
  passed("撤销重做");
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
  passed("多图原图");
  // Save As onto the open file itself: the dialog asks to replace, then it just saves.
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("另存为同一文件");
  await page.keyboard.press("Enter");
  await dirty(true);
  await page.keyboard.press("Control+Shift+S");
  const suggestedForFile = await answerSaveDialog(file, { replace: true });
  await dirty(false);
  await expect.poll(() => windowTitle(page)).toBe("测试.hush");
  expect(body(file).blocks.slice(-2)).toEqual([
    { type: "line", text: "另存为同一文件" },
    { type: "line", text: "" },
  ]);
  expect(existsSync(file + ".tmp")).toBe(false);
  expect(stash()).toBeNull();
  passed("另存为当前文件");
  await page.screenshot({ path: path.join(root, "desktop.png") });
  // A saved image deleted from the body stays in the file until it is closed.
  const doomed = source["将删除.png"];
  await editor.click();
  await page.keyboard.press("Control+End");
  // The import replaces the empty line the caret is on; keep one above it.
  await page.keyboard.press("Enter");
  await input().setInputFiles(doomed.file);
  await expectGroups(editor, 2);
  await thumbnailsLoaded();
  await page.keyboard.press("Control+s");
  await dirty(false);
  expect(pictures(body(file)).map((p) => p.id)).toContain(doomed.id);
  // Delete removes only the selected image, the last one, which was a group on its own.
  await editor.locator(".image-tile").last().click();
  await page.keyboard.press("Delete");
  await expect(editor.locator(".image-tile")).toHaveCount(2);
  await expectGroups(editor, 1);
  await page.keyboard.press("Control+s");
  await dirty(false);
  const before = body(file);
  expect(pictures(before).map((p) => p.id)).not.toContain(doomed.id);
  expect(storedIds(file)).toContain(doomed.id);
  expect(before.blocks.at(-1).type).toBe("line");

  // --- Close with unsaved changes: Esc / 取消 keep the window, 不保存 discards ---
  const savedBeforeClose = await fingerprint(file);
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("关闭前输入");
  await dirty(true);
  await expect.poll(() => windowTitle(page)).toBe("● 测试.hush");
  const prompt = () =>
    page.getByRole("dialog", { name: "是否保存对“测试.hush”的更改？" });
  await requestClose(page);
  await expect(prompt()).toBeVisible();
  // Ctrl+S behind the modal does nothing; the question stays open.
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Escape");
  await expect(prompt()).toBeHidden();
  // The dialog's close event, which ends the first close attempt, fires a task
  // after it is hidden; closing again before that only shows "操作仍在进行".
  await sleep(300);
  await requestClose(page);
  await expect(prompt()).toBeVisible();
  await prompt().getByRole("button", { name: "取消", exact: true }).click();
  await expect(prompt()).toBeHidden();
  expect(processHandle.exitCode).toBeNull();
  // Focus is back in the editor: typing continues where it stopped.
  await page.keyboard.insertText("，取消后继续");
  await expect(editor.locator("p").last()).toHaveText("关闭前输入，取消后继续");
  expect(await fingerprint(file)).toEqual(savedBeforeClose);
  await requestClose(page);
  await expect(prompt()).toBeVisible();
  await prompt()
    .getByRole("button", { name: "不保存", exact: true })
    .click({ noWaitAfter: true })
    .catch(() => {});
  await exited();
  expect(body(file)).toEqual(before);
  expect(stash()).toBeNull();
  passed("关闭弹窗");
  // Closing drops the images the saved body no longer references.
  expect(storedIds(file)).toEqual(
    [...new Set(pictures(before).map((p) => p.id))].sort(),
  );
  expect(storedIds(file)).not.toContain(doomed.id);
  expect(storedIds(file)).not.toContain(source["追加.jpg"].id);
  passed("关闭清理");
  // A single plain SQLite file; the data folder holds only the app's own files.
  expect(
    (await readdir(root)).filter((n) => n.startsWith("测试.hush")),
  ).toEqual(["测试.hush"]);
  expect((await readdir(appData)).sort()).toEqual([
    "recovery.json",
    "session.lock",
    "working.hush",
  ]);
  const header = (await readFile(file)).subarray(0, 16).toString("latin1");
  expect(header).toBe("SQLite format 3\0");
  expect((await readFile(working)).subarray(0, 16).toString("latin1")).toBe(
    "SQLite format 3\0",
  );
  for (const target of [file, working]) {
    expect(query(target, "PRAGMA application_id")[0].application_id).toBe(
      0x48555348,
    );
    expect(query(target, "PRAGMA user_version")[0].user_version).toBe(1);
    expect(query(target, "PRAGMA auto_vacuum")[0].auto_vacuum).toBe(2);
  }
  expect(query(file, "PRAGMA freelist_count")[0].freelist_count).toBe(0);
  passed("文件结构");

  // --- Restart after a normal close: a new unnamed document, not the last file ---
  const recovery = async () =>
    JSON.parse(await readFile(path.join(appData, "recovery.json"), "utf8"));
  page = await start();
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect.poll(() => windowTitle(page)).toBe("未命名");
  await dirty(false);
  await expect(page.getByText("已恢复未保存的修改。")).toHaveCount(0);
  await expect(editor).toHaveText("");
  await expect(editor.locator(".image-tile")).toHaveCount(0);
  expect(await recovery()).toEqual({ path: null });
  expect(stash()).toBeNull();
  passed("正常关闭后新建");

  // --- Reopen via double-click: not recovered; 保存 in the close prompt writes ---
  expect(await launchSecond([file])).toBe(0);
  await expect.poll(() => windowTitle(page)).toBe("测试.hush");
  await dirty(false);
  await expect(page.getByText("已恢复未保存的修改。")).toHaveCount(0);
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  await thumbnailsLoaded();
  await expect(editor.locator("p").last()).toHaveText("");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("保存后关闭");
  await requestClose(page);
  await expect(prompt()).toBeVisible();
  await prompt()
    .getByRole("button", { name: "保存", exact: true })
    .click({ noWaitAfter: true })
    .catch((e) => console.error("CLICK", e.message.slice(0, 200)));
  await exited();
  const afterSaveClose = body(file);
  expect(afterSaveClose.blocks.slice(0, -1)).toEqual(before.blocks.slice(0, -1));
  expect(afterSaveClose.blocks.at(-1)).toEqual({
    type: "line",
    text: "保存后关闭",
  });
  expect(stash()).toBeNull();
  passed("关闭时保存");

  // --- Crash with unsaved text and a new image: the file keeps its saved state ---
  page = await start([file]);
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect.poll(() => windowTitle(page)).toBe("测试.hush");
  await dirty(false);
  await expect(editor.locator(".image-tile img")).toHaveCount(2);
  await thumbnailsLoaded();
  const crashed = source["崩溃前.png"];
  await editor.click();
  // ProseMirror syncs the clicked caret back to the DOM shortly after mouseup;
  // an earlier Control+End would be undone and the text land mid-document.
  await sleep(200);
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("崩溃前输入");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  // The import replaces the empty line the caret is on; the last line stays.
  await page.keyboard.press("ArrowUp");
  await input().setInputFiles(crashed.file);
  await expectGroups(editor, 2);
  await thumbnailsLoaded();
  await stashed(
    (doc) =>
      pictures(doc).some((p) => p.id === crashed.id) &&
      doc.blocks.some((b) => b.text === "崩溃前输入"),
  );
  const crashStash = stash();
  // Typed at the end, after the line saved by the close prompt.
  expect(lines(crashStash).indexOf("崩溃前输入")).toBeGreaterThan(
    lines(crashStash).indexOf("保存后关闭"),
  );
  const beforeCrash = await fingerprint(file);
  await kill();
  expect(await fingerprint(file)).toEqual(beforeCrash);
  expect(body(file)).toEqual(afterSaveClose);
  expect(storedIds(file)).not.toContain(crashed.id);
  page = await start();
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(page.getByText("已恢复未保存的修改。")).toBeVisible();
  await dirty(true);
  await expect.poll(() => windowTitle(page)).toBe("● 测试.hush");
  await expect(editor.getByText("崩溃前输入")).toBeVisible();
  await expectGroups(editor, 2);
  await expect(editor.locator(".image-tile img")).toHaveCount(3);
  await thumbnailsLoaded();
  expect(await fingerprint(file)).toEqual(beforeCrash);
  passed("崩溃恢复");
  await editor.click();
  await page.keyboard.press("Control+s");
  await dirty(false);
  await expect(page.getByText("已恢复未保存的修改。")).toHaveCount(0);
  expect(body(file)).toEqual(crashStash);
  expect(stored(file, crashed.id).equals(crashed.bytes)).toBe(true);
  expect(stash()).toBeNull();
  await stop(page);
  // Once saved, the restart starts unnamed again; the file opens from a double-click.
  page = await start();
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect.poll(() => windowTitle(page)).toBe("未命名");
  await expect(page.getByText("已恢复未保存的修改。")).toHaveCount(0);
  await expect(editor.locator(".image-tile")).toHaveCount(0);
  expect(await recovery()).toEqual({ path: null });
  expect(await launchSecond([file])).toBe(0);
  await expect.poll(() => windowTitle(page)).toBe("测试.hush");
  await dirty(false);
  await expect(editor.locator(".image-tile img")).toHaveCount(3);
  await thumbnailsLoaded();
  expect(body(file)).toEqual(crashStash);
  passed("保存重开");

  // --- Crash, then the file is moved away: the unsaved changes come back unnamed ---
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("搬走前输入");
  await stashed((doc) => doc.blocks.some((b) => b.text === "搬走前输入"));
  const movedStash = stash();
  await kill();
  const moved = path.join(root, "搬走.hush");
  await rename(file, moved);
  const movedFile = await fingerprint(moved);
  page = await start();
  editor = page.getByRole("textbox", { name: "日记正文" });
  const lost = page.getByRole("status").filter({
    hasText: "未保存的修改已作为未命名文档恢复",
  });
  await expect(lost).toBeVisible();
  await expect(lost).toContainText("测试.hush");
  await dirty(true);
  await expect
    .poll(() => call(page, "plugin:window|title", { label: "main" }))
    .toBe("● 未命名");
  await expect(editor.getByText("搬走前输入")).toBeVisible();
  // The images were saved into the moved file only, so they show a placeholder.
  await expect(editor.getByText("无法显示此图片")).toHaveCount(3);
  expect(stash()).toEqual(movedStash);
  expect(await recovery()).toEqual({ path: null });
  expect(await fingerprint(moved)).toEqual(movedFile);
  passed("原文件丢失恢复");

  // --- Second launch with a file (double-click): the running window opens it ---
  // The running document has unsaved changes, so it asks first; 不保存 opens the file.
  expect(processHandle.exitCode).toBeNull();
  const firstPid = processHandle.pid;
  expect(await launchSecond([moved])).toBe(0);
  const draftPrompt = page.getByRole("dialog", {
    name: "是否保存对“未命名”的更改？",
  });
  await expect(draftPrompt).toBeVisible();
  await draftPrompt.getByRole("button", { name: "不保存", exact: true }).click();
  await expect.poll(() => windowTitle(page)).toBe("搬走.hush");
  await dirty(false);
  await expect(editor.getByText("搬走前输入")).toHaveCount(0);
  expect(processHandle.pid).toBe(firstPid);
  expect(processHandle.exitCode).toBeNull();
  // The same file again, relative and from another folder: nothing reopens.
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("再次双击前输入");
  await dirty(true);
  expect(await launchSecond(["搬走.hush"], root)).toBe(0);
  await sleep(1000);
  await expect(draftPrompt).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(editor.getByText("再次双击前输入")).toBeVisible();
  expect(await windowTitle(page)).toBe("● 搬走.hush");
  // No argument: the window only comes to the front.
  expect(await launchSecond([])).toBe(0);
  await sleep(500);
  await expect(editor.getByText("再次双击前输入")).toBeVisible();
  expect(processHandle.exitCode).toBeNull();
  passed("第二实例转发");
  await kill();

  // --- First launch with a file: opened at once when nothing is unsaved ---
  // The kill left unsaved text for 搬走.hush: a plain start recovers it into that file.
  page = await start();
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(page.getByText("已恢复未保存的修改。")).toBeVisible();
  await expect.poll(() => windowTitle(page)).toBe("● 搬走.hush");
  await editor.click();
  await page.keyboard.press("Control+s");
  await dirty(false);
  await stop(page);
  expect((await recovery()).path).toMatch(/搬走\.hush$/);
  const copy = path.join(root, "副本.hush");
  await copyFile(moved, copy);
  page = await start(["副本.hush"], root);
  editor = page.getByRole("textbox", { name: "日记正文" });
  await expect.poll(() => windowTitle(page)).toBe("副本.hush");
  await expect(page.getByText("已恢复未保存的修改。")).toHaveCount(0);
  expect((await recovery()).path).toMatch(/副本\.hush$/);
  // With unsaved changes left by a crash, those come back first and are asked about.
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("副本未保存");
  await stashed((doc) => doc.blocks.some((b) => b.text === "副本未保存"));
  await kill();
  page = await start([moved]);
  editor = page.getByRole("textbox", { name: "日记正文" });
  const copyPrompt = page.getByRole("dialog", {
    name: "是否保存对“副本.hush”的更改？",
  });
  await expect(copyPrompt).toBeVisible();
  await expect(page.getByText("已恢复未保存的修改。")).toBeVisible();
  await copyPrompt.getByRole("button", { name: "不保存", exact: true }).click();
  await expect.poll(() => windowTitle(page)).toBe("搬走.hush");
  expect(stash()).toBeNull();
  passed("启动参数打开文件");
  await kill();
  await exportPdfCase();
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      profile,
      root,
      checks,
      suggested: [suggestedForDraft, suggestedForFile],
    }),
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (processHandle?.exitCode === null) processHandle.kill();
}
