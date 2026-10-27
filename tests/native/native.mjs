// 真实 WebView2 桌面回归：启动构建好的 LineHush.exe（默认 debug，`--release` 用
// release），经 CDP（Playwright connectOverCDP）操作各窗口的页面，经 Win32 回答系统
// 文件对话框、检查自绘标题栏。每项用例互相独立：各用 `test-results/native-<时间>/<用例名>/`
// 下自己的测试数据目录（LINEHUSH_TEST_DATA_DIR）与测试文件。
//
//   node tests/native/native.mjs [--only 名称] [--release]   整套只在发布前跑；--only 只跑一项（名称见文末 `cases`）
//
// 注意：会弹出 / 移动 / 最大化 LineHush 窗口，并改写系统剪贴板（“图片复制粘贴”“右键菜单”）；
// “对话框挪进屏幕”会移动真实鼠标（按住标题栏拖动）并发送真实 Esc 键，运行时不要动鼠标键盘。
import { chromium, expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
await mkdir(root, { recursive: true });
const profile = process.argv.includes("--release") ? "release" : "debug";
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? undefined : process.argv[onlyAt + 1];
const exe = path.resolve(`src-tauri/target/${profile}/LineHush.exe`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdp = "http://127.0.0.1:9223";

// ---------------------------------------------------------------------------
// 当前用例的状态：测试文件目录、应用数据目录、进程与 CDP 连接、页面错误、已通过的检查。
let dir, appData;
let processHandle, browser, context;
let errors = [];
let checks = [];
const passed = (name) => checks.push(name);
/** 新用例：新的测试文件目录与应用数据目录。 */
async function fresh(name) {
  dir = path.join(root, name);
  appData = path.join(dir, "app");
  await mkdir(appData, { recursive: true });
}
const appEnv = () => ({
  ...process.env,
  LINEHUSH_TEST_DATA_DIR: appData,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223",
});

/** Launches the app (with `args`, run from `cwd`) and connects to its WebView2. */
async function launch(args = [], cwd = undefined) {
  // A killed instance may still be releasing the debugging port.
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${cdp}/json/version`);
      await sleep(250);
    } catch {
      break;
    }
  }
  processHandle = spawn(exe, args, { windowsHide: true, cwd, env: appEnv() });
  browser = undefined;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(cdp);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw Error("无法连接 WebView2");
  context = browser.contexts()[0];
}
/** Launches the app and returns the page of window `label` once its editor is there. */
async function start(args = [], cwd = undefined, label = "win-1") {
  await launch(args, cwd);
  return pageOf(label);
}
const watched = new WeakSet();
function watch(page) {
  if (watched.has(page)) return;
  watched.add(page);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) errors.push(msg.text());
  });
}
/** The window label of a page (`win-1`…); undefined for other pages (e.g. PDF printing). */
const labelOf = (page) =>
  page
    .evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)
    .catch(() => undefined);
/** label → page of the editor windows that exist now. */
async function pages() {
  const map = new Map();
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const label = await labelOf(page);
    if (label?.startsWith("win-")) {
      watch(page);
      map.set(label, page);
    }
  }
  return map;
}
const windowCount = async () => (await pages()).size;
/** Waits for window `label` and the editor of its current tab. */
async function pageOf(label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const page = (await pages()).get(label);
    if (page) {
      await editor(page).waitFor({ timeout: Math.max(1000, end - Date.now()) });
      return page;
    }
    await sleep(200);
  }
  throw Error(`窗口 ${label} 没有出现`);
}
/** The editor of the current tab (the other tabs' panes are hidden). */
const editor = (page) =>
  page
    .locator(".tab-pane:not([hidden])")
    .getByRole("textbox", { name: "日记正文" });
/** The current tab's pane: its banners, editor and hidden file input. */
const pane = (page) => page.locator(".tab-pane:not([hidden])");
const input = (page) => pane(page).locator("input[type=file]");
const tabNames = (page) =>
  page.locator(".tabbar [role=tab] .tab-name").allTextContents();
const activeName = (page) =>
  page.locator('.tabbar [role=tab][aria-selected="true"] .tab-name').textContent();
const call = (page, cmd, args = {}) =>
  page.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
const title = async (page) =>
  call(page, "plugin:window|title", { label: await labelOf(page) });
/**
 * Ctrl+N, then waits for the new tab (made current, its editor focused): keys
 * pressed before Rust has made the tab still go to the previous one.
 */
async function pressNewTab(page) {
  const count = (await tabNames(page)).length;
  await page.keyboard.press("Control+n");
  await expect.poll(async () => (await tabNames(page)).length).toBe(count + 1);
  await expect(editor(page)).toBeFocused();
}
/** Unsaved changes show as "● " at the start of the window title (and of the tab). */
const dirty = (page, value) =>
  expect
    .poll(async () => (await title(page)).startsWith("● "))
    .toBe(value);
/** The "save changes?" question about `name`. */
const prompt = (page, name) =>
  page.getByRole("dialog", { name: `是否保存对“${name}”的更改？` });
/** Answers the question about `name`; the window may close right after. */
async function answer(page, name, button) {
  const dialog = prompt(page, name);
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: button, exact: true })
    .click({ noWaitAfter: true })
    .catch(() => {});
}
/** Same as clicking the title bar ×: the frontend's close guard decides. */
async function requestClose(page) {
  const label = await labelOf(page);
  await call(page, "plugin:window|close", { label }).catch(() => {});
}
/** Waits until the process has exited (every window closed). */
async function exited(timeout = 20000) {
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    const timer = sleep(timeout).then(() => "超时");
    const result = await Promise.race([
      new Promise((r) => processHandle.once("exit", r)),
      timer,
    ]);
    if (result === "超时") throw Error("LineHush 没有退出");
  }
  await browser?.close().catch(() => {});
  browser = undefined;
}
/** Closes a window without unsaved changes, the last one: no question, the process exits. */
async function stop(page) {
  await requestClose(page);
  await exited();
}
/** Simulates a crash: the process gets no chance to clean up. */
async function kill() {
  await new Promise((resolve) =>
    execFile(
      "taskkill",
      ["/F", "/T", "/PID", String(processHandle.pid)],
      () => resolve(),
    ),
  );
  await exited();
}
/**
 * Launches a second instance, the way a double-click does, and resolves with its
 * exit code: it should hand `args` to the running instance and quit at once.
 */
const launchSecond = (args, cwd) =>
  new Promise((resolve, reject) => {
    const second = spawn(exe, args, { windowsHide: true, cwd, env: appEnv() });
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

// ---------------------------------------------------------------------------
// 数据目录：session.json、tabs/<id>.hush。
const sessionData = () =>
  JSON.parse(readFileSync(path.join(appData, "session.json"), "utf8"));
const windowEntry = (label = "win-1") =>
  sessionData().windows.find((w) => w.label === label);
const tabIds = (label = "win-1") =>
  windowEntry(label)?.tabs.map((t) => t.id) ?? [];
/** The current tab of a window as session.json records it. */
const activeId = (label = "win-1") => windowEntry(label)?.active;
/** The working copy of a tab. */
const workOf = (id) => path.join(appData, "tabs", `${id}.hush`);
const tabFiles = async () =>
  (await readdir(path.join(appData, "tabs"))).sort();
/** settings.json; empty until a setting was changed. */
const readSettings = () => {
  const file = path.join(appData, "settings.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};

// ---------------------------------------------------------------------------
// `.hush` 文件（SQLite）。
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
/** The stashed body of a working copy, or null when nothing is stashed. */
const stash = (file) => {
  if (!existsSync(file)) return null;
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
const linesDoc = (texts) => ({
  blocks: texts.map((text) => ({ type: "line", text })),
});
/**
 * Writes a `.hush` file the way LineHush does (same header and tables): `doc`
 * as its body (none: a working copy without a stash) and `images` as originals.
 */
function writeHush(file, doc, images = []) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA auto_vacuum = INCREMENTAL;
      PRAGMA application_id = ${0x48555348};
      PRAGMA user_version = 1;
      CREATE TABLE doc (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
      CREATE TABLE images (id TEXT PRIMARY KEY, data BLOB NOT NULL);`);
    if (doc)
      db.prepare("INSERT INTO doc (id, body) VALUES (1, ?)").run(
        JSON.stringify(doc),
      );
    const insert = db.prepare(
      "INSERT OR IGNORE INTO images (id, data) VALUES (?, ?)",
    );
    for (const bytes of images) insert.run(sha256(bytes), bytes);
  } finally {
    db.close();
  }
  return file;
}
/** Bytes and modification time: proof that a file was not written at all. */
const fingerprint = async (file) => ({
  sha: sha256(await readFile(file)),
  mtime: (await stat(file)).mtimeMs,
});
/** Waits until the debounced stash (650 ms after the last edit) of tab `id` satisfies `predicate`. */
const stashed = (id, predicate) =>
  expect
    .poll(() => {
      const doc = stash(workOf(id));
      return doc !== null && predicate(doc);
    })
    .toBe(true);
/**
 * Real images on disk, cut from screenshots of `page`: `[name, width, height]`
 * (PNG) or `[name, null, null, "jpeg"]` (whole page). Returns name →
 * `{ file, bytes, id, picture }`; `picture` is the body entry for a PNG.
 */
async function makeImages(page, specs, folder = path.join(dir, "源图")) {
  await mkdir(folder, { recursive: true });
  const out = {};
  for (const [name, width, height, type] of specs) {
    const bytes =
      type === "jpeg"
        ? await page.screenshot({ type: "jpeg", quality: 80 })
        : await page.screenshot({ clip: { x: 0, y: 0, width, height } });
    const file = path.join(folder, name);
    await writeFile(file, bytes);
    const id = sha256(bytes);
    out[name] = { file, bytes, id, picture: { id, name, width, height } };
  }
  return out;
}
/**
 * Image groups on screen. Each image is its own node, so a group is a run of
 * neighbouring `.image-item` children; hidden cursor widgets do not count.
 */
const imageGroups = (ed) =>
  ed.evaluate((el) => {
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
const expectGroups = (ed, count) =>
  expect.poll(() => imageGroups(ed)).toBe(count);
/** The caret right after the first / last image: a collapsed block range there, on the image's side. */
const expectCaretAfterImage = (ed, which) =>
  expect
    .poll(() =>
      ed.evaluate((el, which) => {
        const { doc, selection } = el.editor.state;
        const ends = [];
        doc.forEach((node, offset) => {
          if (node.type.name === "image") ends.push(offset + node.nodeSize);
        });
        const end = which === "first" ? ends[0] : ends.at(-1);
        const json = selection.toJSON();
        return json.type === "blockRange" && selection.empty && selection.head === end && json.side === -1;
      }, which),
    )
    .toBe(true);
const imageNames = (ed) =>
  ed.locator(".image-tile img").evaluateAll((images) => images.map((img) => img.alt));
/** A click on an image's left / right half puts the caret before / after it (no image gets selected). */
async function clickImageSide(tile, side) {
  const box = await tile.boundingBox();
  await tile.click({
    position: { x: side === "before" ? 8 : box.width - 8, y: box.height / 2 },
  });
}
const thumbnailsLoaded = (ed) =>
  expect
    .poll(() =>
      ed
        .locator(".image-tile img")
        .evaluateAll((images) =>
          images.every((img) => img.complete && img.naturalWidth > 0),
        ),
    )
    .toBe(true);

// ---------------------------------------------------------------------------
// 系统文件对话框（“保存日记”“导出日记”“打开日记”）。
/**
 * Answers a native file dialog the way a user would: types the path into its
 * file name box and presses 保存 / 打开; with `replace`, confirms 是 in the
 * "already exists" question. Resolves with the name a save dialog suggested.
 */
const FILE_DIALOG = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FileDialog {
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
  /** The file name box: the Edit (id 1001) of the file name combo box. */
  static IntPtr NameBox(IntPtr dialog, bool open) {
    IntPtr box = IntPtr.Zero, edit = IntPtr.Zero;
    if (open) EnumChildWindows(dialog, (h, _) => {
      if (GetDlgCtrlID(h) == 1148) { box = h; return false; } // cmb13：打开对话框的文件名框
      return true;
    }, IntPtr.Zero);
    EnumChildWindows(box != IntPtr.Zero ? box : dialog, (h, _) => {
      if (Class(h) == "Edit" && (GetDlgCtrlID(h) == 1001 || box != IntPtr.Zero)) { edit = h; return false; }
      return true;
    }, IntPtr.Zero);
    return edit;
  }
  /** Returns the suggested name once the path is typed and 保存 / 打开 pressed; null while not ready. */
  public static string Answer(uint pid, string title, string path, bool open) {
    IntPtr dialog = Find(pid, title, null);
    if (dialog == IntPtr.Zero) return null;
    IntPtr edit = NameBox(dialog, open);
    IntPtr button = GetDlgItem(dialog, 1);
    if (edit == IntPtr.Zero || button == IntPtr.Zero) return null;
    // Wait until a save dialog has filled in its default name, or it overwrites ours.
    string suggested = Text(edit);
    if (!open && suggested.Length == 0) return null;
    System.Threading.Thread.Sleep(open ? 500 : 300);
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
    PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK 保存 / 打开
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
$open = $env:LH_OPEN -eq '1'
while (($suggested = [FileDialog]::Answer([uint32]$env:LH_PID, $env:LH_TITLE, $env:LH_PATH, $open)) -eq $null) {
  if ([DateTime]::Now -gt $deadline) { throw 'file dialog not found' }
  Start-Sleep -Milliseconds 200
}
if ($env:LH_REPLACE -eq '1') {
  while (-not [FileDialog]::Confirm([uint32]$env:LH_PID, $env:LH_TITLE)) {
    if ([DateTime]::Now -gt $deadline) { throw 'replace question not found' }
    Start-Sleep -Milliseconds 200
  }
}
[Console]::Out.Write($suggested)
`;
/** Runs a PowerShell script (passed encoded, so no quoting issues) with extra environment variables. */
const powershell = (script, env, timeout = 30000) =>
  new Promise((resolve, reject) =>
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { timeout, env: { ...process.env, ...env } },
      (e, stdout, stderr) =>
        e ? reject(Error(stderr || e.message)) : resolve(stdout),
    ),
  );
const answerSaveDialog = (
  target,
  { replace = false, title = "保存日记" } = {},
) =>
  powershell(FILE_DIALOG, {
    LH_PID: String(processHandle.pid),
    LH_TITLE: title,
    LH_PATH: target,
    LH_REPLACE: replace ? "1" : "0",
    LH_OPEN: "0",
  });
const answerOpenDialog = (target) =>
  powershell(FILE_DIALOG, {
    LH_PID: String(processHandle.pid),
    LH_TITLE: "打开日记",
    LH_PATH: target,
    LH_REPLACE: "0",
    LH_OPEN: "1",
  });

// ---------------------------------------------------------------------------
// 自绘标题栏的 Win32 检查：最大化按钮上的覆盖窗口（caption.rs）、窗口状态。
// 坐标为物理像素（脚本进程设为 Per-Monitor V2 DPI 感知）。
const WIN32 = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr p, IntPtr after, string cls, string name);
  [DllImport("user32")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32")] public static extern bool GetMonitorInfoW(IntPtr m, ref MONITORINFO i);
  [DllImport("user32")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  // x64 布局：type 之后按 8 字节对齐。
  [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  /** 真实鼠标按键（MOUSEEVENTF_*），在光标当前位置。 */
  public static uint Mouse(uint flags) { var i = new INPUT[1]; i[0].type = 0; i[0].mi.dwFlags = flags; return SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  /** 真实键盘按键（发给前台窗口）。 */
  public static uint Key(ushort vk, uint flags) { var i = new INPUT[1]; i[0].type = 1; i[0].ki.wVk = vk; i[0].ki.dwFlags = flags; return SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  /** The editor window of the process: the top-level window that holds the overlay. */
  public static IntPtr FindMain(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && FindWindowExW(h, IntPtr.Zero, "LineHushCaptionMaximize", null) != IntPtr.Zero) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static IntPtr Pack(int x, int y) { return (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF)); }
}
'@
[void][W]::SetProcessDpiAwarenessContext([IntPtr](-4))
$main = [W]::FindMain([uint32]$env:LH_PID)
if ($main -eq [IntPtr]::Zero) { Write-Output '{"error":"no window"}'; exit }
$overlay = [W]::FindWindowExW($main, [IntPtr]::Zero, "LineHushCaptionMaximize", $null)
function OverlayCenter {
  $r = New-Object W+RECT; [void][W]::GetWindowRect($overlay, [ref]$r)
  return @([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2))
}
switch ($env:LH_OP) {
  "info" {
    $cr = New-Object W+RECT; [void][W]::GetClientRect($main, [ref]$cr)
    $o = New-Object W+POINT; [void][W]::ClientToScreen($main, [ref]$o)
    $mi = New-Object W+MONITORINFO; $mi.cbSize = 40
    [void][W]::GetMonitorInfoW([W]::MonitorFromWindow($main, 2), [ref]$mi)
    $ov = $null
    if ($overlay -ne [IntPtr]::Zero) {
      $r = New-Object W+RECT; [void][W]::GetWindowRect($overlay, [ref]$r)
      $p = New-Object W+POINT; $p.X = $r.L; $p.Y = $r.T; [void][W]::ScreenToClient($main, [ref]$p)
      $ov = @{ x = $p.X; y = $p.Y; w = $r.R - $r.L; h = $r.B - $r.T; visible = [W]::IsWindowVisible($overlay) }
    }
    $wr = New-Object W+RECT; [void][W]::GetWindowRect($main, [ref]$wr)
    @{ client = @($o.X, $o.Y, $cr.R, $cr.B); window = @($wr.L, $wr.T, $wr.R, $wr.B);
       work = @($mi.rcWork.L, $mi.rcWork.T, $mi.rcWork.R, $mi.rcWork.B);
       zoomed = [W]::IsZoomed($main); iconic = [W]::IsIconic($main); dpi = [W]::GetDpiForWindow($main); overlay = $ov } | ConvertTo-Json -Compress -Depth 4
  }
  "hittest" {
    # 客户区坐标 (LH_X, LH_Y) 处，覆盖窗口与主窗口各自的 WM_NCHITTEST 结果。
    $p = New-Object W+POINT; $p.X = [int]$env:LH_X; $p.Y = [int]$env:LH_Y; [void][W]::ClientToScreen($main, [ref]$p)
    $hit = [W]::SendMessageW($overlay, 0x84, [IntPtr]::Zero, [W]::Pack($p.X, $p.Y)).ToInt64()
    $parentHit = [W]::SendMessageW($main, 0x84, [IntPtr]::Zero, [W]::Pack($p.X, $p.Y)).ToInt64()
    @{ overlayHit = $hit; parentHit = $parentHit } | ConvertTo-Json -Compress
  }
  "maxclick" {
    # 系统在命中 HTMAXBUTTON 后发来的非客户区按下 / 抬起。
    $c = OverlayCenter; $l = [W]::Pack($c[0], $c[1])
    [void][W]::PostMessageW($overlay, 0xA1, [IntPtr]9, $l); [void][W]::PostMessageW($overlay, 0xA2, [IntPtr]9, $l)
    Write-Output '{"ok":true}'
  }
  "restore" { [void][W]::ShowWindow($main, 9); Write-Output '{"ok":true}' }
  "move" {
    # 窗口外框左上角移到屏幕坐标 (LH_X, LH_Y)：SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE。
    [void][W]::SetWindowPos($main, [IntPtr]::Zero, [int]$env:LH_X, [int]$env:LH_Y, 0, 0, 0x15)
    Write-Output '{"ok":true}'
  }
  "drag" {
    # 真实鼠标：在屏幕坐标 (LH_X, LH_Y) 按下左键，横向移动 LH_DX 后松开。
    $x = [int]$env:LH_X; $y = [int]$env:LH_Y; $dx = [int]$env:LH_DX
    [void][W]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 150
    $down = [W]::Mouse(0x2)
    Start-Sleep -Milliseconds 500
    for ($i = 1; $i -le 15; $i++) { [void][W]::SetCursorPos($x + [int]($dx * $i / 15), $y); Start-Sleep -Milliseconds 40 }
    Start-Sleep -Milliseconds 300
    $up = [W]::Mouse(0x4)
    Start-Sleep -Milliseconds 300
    @{ down = $down; up = $up } | ConvertTo-Json -Compress
  }
  "escape" {
    # 真实键盘 Esc，发给前台窗口。
    $fg = [W]::GetForegroundWindow() -eq $main
    $a = [W]::Key(0x1B, 0); Start-Sleep -Milliseconds 50; $b = [W]::Key(0x1B, 2)
    @{ sent = $a + $b; foreground = $fg } | ConvertTo-Json -Compress
  }
}
`;
const win32 = async (op, x = 0, y = 0, dx = 0) =>
  JSON.parse(
    (
      await powershell(WIN32, {
        LH_PID: String(processHandle.pid),
        LH_OP: op,
        LH_X: String(x),
        LH_Y: String(y),
        LH_DX: String(dx),
      })
    ).trim(),
  );

// ---------------------------------------------------------------------------
// 用例。每项以 fresh() 开始，结束时进程已退出或被结束（runCase 兜底）。

/** 启动：一个窗口 win-1、一个“无标题”标签页，没有系统标题栏，自绘标题按钮。 */
async function startupCase() {
  const page = await start();
  expect(await windowCount()).toBe(1);
  expect(await call(page, "plugin:window|get_all_windows")).toEqual(["win-1"]);
  expect(await tabNames(page)).toEqual(["无标题"]);
  await expect.poll(() => title(page)).toBe("无标题");
  expect(
    await call(page, "plugin:window|is_decorated", { label: "win-1" }),
  ).toBe(false);
  for (const name of ["最小化", "最大化", "关闭"])
    await expect(
      page.locator(".caption-buttons").getByRole("button", { name, exact: true }),
    ).toBeVisible();
  // The data folder: session.json names the window and its tab's working copy.
  const session = sessionData();
  expect(session.windows).toHaveLength(1);
  const [window] = session.windows;
  expect(window.label).toBe("win-1");
  expect(window.tabs).toHaveLength(1);
  expect(window.tabs[0].path).toBeNull();
  expect(window.active).toBe(window.tabs[0].id);
  expect(window.tabs[0].id).toMatch(/^[0-9a-f]{16}$/);
  expect(await tabFiles()).toEqual([`${window.tabs[0].id}.hush`]);
  for (const legacy of ["working.hush", "recovery.json"])
    expect(existsSync(path.join(appData, legacy))).toBe(false);
  passed("启动：win-1、一个无标题标签页、无系统标题栏");
  await stop(page);
  expect(sessionData().windows).toEqual([]);
  expect(await tabFiles()).toEqual([]);
  passed("正常关闭：会话与工作副本清空");
}

/** Ctrl+N 编号，Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1 / Ctrl+9 切换，各标签页的撤销历史保留。 */
async function tabKeysCase() {
  const page = await start();
  const ed = () => editor(page);
  await ed().click();
  await page.keyboard.insertText("第一页");
  await pressNewTab(page);
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题", "无标题 2"]);
  // The new tab's editor has the focus: typing goes there.
  await page.keyboard.insertText("第二页");
  await expect(ed()).toHaveText("第二页");
  await pressNewTab(page);
  await page.keyboard.insertText("第三页");
  await expect
    .poll(() => tabNames(page))
    .toEqual(["● 无标题", "● 无标题 2", "● 无标题 3"]);
  await expect.poll(() => tabIds().length).toBe(3);
  const ids = tabIds();
  const go = async (key, name, text, index) => {
    await page.keyboard.press(key);
    await expect.poll(() => activeName(page)).toBe(name);
    await expect(ed()).toHaveText(text);
    await expect.poll(() => title(page)).toBe(name);
    // Rust records the current tab (restored after a crash).
    await expect.poll(() => activeId()).toBe(ids[index]);
  };
  await go("Control+1", "● 无标题", "第一页", 0);
  await go("Control+9", "● 无标题 3", "第三页", 2);
  await go("Control+Tab", "● 无标题", "第一页", 0);
  await go("Control+Shift+Tab", "● 无标题 3", "第三页", 2);
  await go("Control+Shift+Tab", "● 无标题 2", "第二页", 1);
  passed("Ctrl+N 编号与 Ctrl+Tab / Ctrl+1 / Ctrl+9 切换");
  // Each tab keeps its own undo history across switches.
  await page.keyboard.press("Control+z");
  await expect(ed()).toHaveText("");
  await expect.poll(() => activeName(page)).toBe("无标题 2");
  await page.keyboard.press("Control+y");
  await expect(ed()).toHaveText("第二页");
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Control+z");
  await expect(ed()).toHaveText("");
  await expect.poll(() => activeName(page)).toBe("无标题");
  await page.keyboard.press("Control+3");
  await expect(ed()).toHaveText("第三页");
  passed("切换后撤销历史保留");
  // An unchanged tab closes without a question; its number is free again.
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Control+w");
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题 2", "● 无标题 3"]);
  await expect.poll(() => activeName(page)).toBe("● 无标题 2");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => existsSync(workOf(ids[0]))).toBe(false);
  await pressNewTab(page);
  await expect
    .poll(() => tabNames(page))
    .toEqual(["● 无标题 2", "● 无标题 3", "无标题"]);
  passed("无标题编号复用");
  await kill();
}

/** Ctrl+W：有修改先询问，“取消”保留、“不保存”关闭并删工作副本；关最后一个标签页即关窗口。 */
async function closeTabCase() {
  const page = await start();
  const ed = () => editor(page);
  await ed().click();
  await page.keyboard.insertText("甲");
  await pressNewTab(page);
  await page.keyboard.insertText("乙");
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题", "● 无标题 2"]);
  await expect.poll(() => tabIds().length).toBe(2);
  const [first, second] = tabIds();
  await stashed(second, (doc) => lines(doc)[0] === "乙");
  await page.keyboard.press("Control+w");
  await expect(prompt(page, "无标题 2")).toBeVisible();
  await answer(page, "无标题 2", "取消");
  await expect(prompt(page, "无标题 2")).toBeHidden();
  expect(await tabNames(page)).toEqual(["● 无标题", "● 无标题 2"]);
  expect(existsSync(workOf(second))).toBe(true);
  // Focus is back in the editor: typing continues where it stopped.
  await page.keyboard.insertText("，继续");
  await expect(ed()).toHaveText("乙，继续");
  passed("Ctrl+W 询问后取消");
  // The dialog's close event, which ends the first attempt, fires a task after it is hidden.
  await sleep(300);
  await page.keyboard.press("Control+w");
  await answer(page, "无标题 2", "不保存");
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题"]);
  await expect(ed()).toHaveText("甲");
  await expect.poll(() => existsSync(workOf(second))).toBe(false);
  await expect.poll(() => tabIds()).toEqual([first]);
  passed("Ctrl+W 不保存：关闭并删除工作副本");
  // An unchanged tab closes at once, by its × or by a middle click.
  await pressNewTab(page);
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题", "无标题 2"]);
  await page
    .locator(".tabbar [role=tab]")
    .nth(1)
    .getByRole("button", { name: "关闭 无标题 2" })
    .click();
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题"]);
  await pressNewTab(page);
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题", "无标题 2"]);
  await page.locator(".tabbar [role=tab]").nth(1).click({ button: "middle" });
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => tabFiles()).toEqual([`${first}.hush`]);
  passed("× 与中键关闭标签页");
  // Closing the last tab closes the window, asking first.
  await editor(page).click();
  await page.keyboard.press("Control+w");
  await answer(page, "无标题", "不保存");
  await exited();
  expect(sessionData().windows).toEqual([]);
  expect(await tabFiles()).toEqual([]);
  passed("关最后一个标签页即关窗口");
}

/** 关窗口按标签页顺序逐个询问；中途“取消”窗口保留，已保存的标签页保持已保存。 */
async function closeWindowCase() {
  const file = writeHush(path.join(dir, "甲.hush"), linesDoc(["甲原文"]));
  const page = await start([file]);
  await expect.poll(() => tabNames(page)).toEqual(["甲.hush"]);
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("改甲");
  await pressNewTab(page);
  await page.keyboard.insertText("草稿");
  await pressNewTab(page);
  await pressNewTab(page);
  await page.keyboard.insertText("丁");
  await expect
    .poll(() => tabNames(page))
    .toEqual(["● 甲.hush", "● 无标题", "无标题 2", "● 无标题 3"]);
  await requestClose(page);
  // Each tab asked about is shown first.
  await expect(prompt(page, "甲.hush")).toBeVisible();
  expect(await activeName(page)).toBe("● 甲.hush");
  await answer(page, "甲.hush", "保存");
  await expect(prompt(page, "无标题")).toBeVisible();
  expect(await activeName(page)).toBe("● 无标题");
  expect(lines(body(file))).toEqual(["甲原文改甲"]);
  await answer(page, "无标题", "取消");
  await expect(prompt(page, "无标题")).toBeHidden();
  await sleep(500);
  expect(processHandle.exitCode).toBeNull();
  expect(await windowCount()).toBe(1);
  expect(await tabNames(page)).toEqual([
    "甲.hush",
    "● 无标题",
    "无标题 2",
    "● 无标题 3",
  ]);
  passed("关窗中途取消：窗口保留，已保存的标签页保持已保存");
  await requestClose(page);
  // 甲.hush has nothing left to save; 无标题 2 never changed.
  await answer(page, "无标题", "不保存");
  await answer(page, "无标题 3", "不保存");
  await exited();
  expect(lines(body(file))).toEqual(["甲原文改甲"]);
  expect(sessionData().windows).toEqual([]);
  expect(await tabFiles()).toEqual([]);
  passed("关窗逐个询问");
}

/** taskkill /F 后，所有窗口里有未保存修改的标签页恢复到一个窗口，带 ●。 */
async function crashTabsCase() {
  const file = writeHush(path.join(dir, "乙.hush"), linesDoc(["乙原文"]));
  const page = await start([file]);
  await expect.poll(() => tabNames(page)).toEqual(["乙.hush"]);
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("改乙");
  await pressNewTab(page);
  await page.keyboard.insertText("二");
  // An untouched tab is no unsaved change: it does not come back.
  await pressNewTab(page);
  await expect.poll(() => tabIds().length).toBe(3);
  await page.keyboard.press("Control+Shift+N");
  const second = await pageOf("win-2");
  await editor(second).click();
  await second.keyboard.insertText("三");
  await expect.poll(() => tabIds("win-2").length).toBe(1);
  const [changed, draft, untouched] = tabIds();
  const [other] = tabIds("win-2");
  await stashed(changed, (doc) => lines(doc)[0] === "乙原文改乙");
  await stashed(draft, (doc) => lines(doc)[0] === "二");
  await stashed(other, (doc) => lines(doc)[0] === "三");
  const saved = await fingerprint(file);
  await kill();
  expect(await fingerprint(file)).toEqual(saved);
  const again = await start();
  await expect
    .poll(() => tabNames(again))
    .toEqual(["● 乙.hush", "● 无标题", "● 无标题 2"]);
  expect(await windowCount()).toBe(1);
  expect(await activeName(again)).toBe("● 乙.hush");
  await expect(editor(again)).toHaveText("乙原文改乙");
  await expect(pane(again).getByText("已恢复未保存的修改。")).toBeVisible();
  await dirty(again, true);
  await again.keyboard.press("Control+2");
  await expect(editor(again)).toHaveText("二");
  await again.keyboard.press("Control+3");
  await expect(editor(again)).toHaveText("三");
  const session = sessionData();
  expect(session.windows.map((w) => w.label)).toEqual(["win-1"]);
  expect(tabIds()).toEqual([changed, draft, other]);
  expect(await tabFiles()).toEqual(
    [changed, draft, other].map((id) => `${id}.hush`).sort(),
  );
  expect(existsSync(workOf(untouched))).toBe(false);
  expect(await fingerprint(file)).toEqual(saved);
  passed("崩溃后多个标签页恢复到一个窗口");
  await requestClose(again);
  await answer(again, "乙.hush", "不保存");
  await answer(again, "无标题", "不保存");
  await answer(again, "无标题 2", "不保存");
  await exited();
  expect(await fingerprint(file)).toEqual(saved);
  expect(await tabFiles()).toEqual([]);
}

/** 再次启动 LineHush：无参开新窗口；已打开的文件置顶那个窗口；新文件按“打开文件”设置。 */
async function secondInstanceCase() {
  const [a, b, c] = ["A", "B", "C"].map((name) =>
    writeHush(path.join(dir, `${name}.hush`), linesDoc([`文件 ${name}`])),
  );
  const first = await start([a]);
  await expect.poll(() => tabNames(first)).toEqual(["A.hush"]);
  const firstPid = processHandle.pid;
  // No argument: a new window with a new unnamed tab.
  expect(await launchSecond([])).toBe(0);
  const second = await pageOf("win-2");
  expect(await tabNames(second)).toEqual(["无标题"]);
  expect(await windowCount()).toBe(2);
  await expect.poll(() => sessionData().focused).toBe("win-2");
  passed("第二实例无参：新窗口");
  // A file already open: its window comes to the front, nothing new opens.
  expect(await launchSecond([a])).toBe(0);
  await expect.poll(() => sessionData().focused).toBe("win-1");
  await expect
    .poll(() => call(first, "plugin:window|is_focused", { label: "win-1" }))
    .toBe(true);
  // The same file, relative and from another folder.
  expect(await launchSecond(["A.hush"], dir)).toBe(0);
  await sleep(1000);
  expect(await windowCount()).toBe(2);
  expect(await tabNames(first)).toEqual(["A.hush"]);
  expect(await tabNames(second)).toEqual(["无标题"]);
  expect(processHandle.pid).toBe(firstPid);
  passed("第二实例带已打开的文件：置顶那个窗口，不新开");
  // 打开文件 = 在新标签页中打开 (default): a new tab in the window used last, no question.
  expect(await launchSecond([b])).toBe(0);
  await expect.poll(() => tabNames(first)).toEqual(["A.hush", "B.hush"]);
  await expect.poll(() => activeName(first)).toBe("B.hush");
  await expect(editor(first)).toHaveText("文件 B");
  expect(await windowCount()).toBe(2);
  await expect(first.getByRole("dialog")).toHaveCount(0);
  passed("第二实例带新文件（openFile=tab）：焦点窗口新标签页");
  // 打开文件 = 在新窗口中打开.
  await first.locator(".settings-button").click();
  await first.locator(".settings-dialog[open]").waitFor();
  await first.getByLabel("在新窗口中打开").check();
  await first.locator(".settings-dialog button.primary").click();
  await expect.poll(() => readSettings().openFile).toBe("window");
  expect(await launchSecond([c])).toBe(0);
  const third = await pageOf("win-3");
  await expect.poll(() => tabNames(third)).toEqual(["C.hush"]);
  expect(await tabNames(first)).toEqual(["A.hush", "B.hush"]);
  expect(await windowCount()).toBe(3);
  passed("第二实例带新文件（openFile=window）：新窗口");
  await kill();
}

/** Ctrl+O：当前标签页为空的无标题且未修改 → 就地打开；否则新标签页；已打开 → 切到那个标签页。 */
async function ctrlOCase() {
  const [a, b, c] = ["A", "B", "C"].map((name) =>
    writeHush(path.join(dir, `${name}.hush`), linesDoc([`文件 ${name}`])),
  );
  const page = await start();
  await expect.poll(() => tabIds().length).toBe(1);
  const [first] = tabIds();
  const open = async (target) => {
    await page.keyboard.press("Control+o");
    await answerOpenDialog(target);
  };
  await editor(page).click();
  await open(a);
  await expect.poll(() => tabNames(page)).toEqual(["A.hush"]);
  await expect(editor(page)).toHaveText("文件 A");
  expect(tabIds()).toEqual([first]);
  passed("Ctrl+O 在空的无标题标签页里就地打开");
  await open(b);
  await expect.poll(() => tabNames(page)).toEqual(["A.hush", "B.hush"]);
  await expect.poll(() => activeName(page)).toBe("B.hush");
  passed("Ctrl+O 在新标签页打开");
  await page.keyboard.press("Control+1");
  await open(b);
  await expect.poll(() => activeName(page)).toBe("B.hush");
  await sleep(500);
  expect(await tabNames(page)).toEqual(["A.hush", "B.hush"]);
  passed("Ctrl+O 已打开的文件：切到那个标签页");
  // A changed unnamed tab is kept: the file opens in a new tab right of it.
  await page.keyboard.press("Control+1");
  await pressNewTab(page);
  await page.keyboard.insertText("改过");
  await open(c);
  await expect
    .poll(() => tabNames(page))
    .toEqual(["A.hush", "B.hush", "● 无标题", "C.hush"]);
  await expect.poll(() => activeName(page)).toBe("C.hush");
  passed("Ctrl+O 当前标签页有修改：新标签页");
  // Open in another window: the window that has it comes to the front and shows it.
  await page.keyboard.press("Control+Shift+N");
  const second = await pageOf("win-2");
  await editor(second).click();
  await second.keyboard.press("Control+o");
  await answerOpenDialog(a);
  await expect.poll(() => activeName(page)).toBe("A.hush");
  await expect.poll(() => sessionData().focused).toBe("win-1");
  await sleep(500);
  expect(await tabNames(second)).toEqual(["无标题"]);
  passed("Ctrl+O 在另一个窗口已打开的文件：切过去");
  await kill();
}

/** 设置在一个窗口修改，其他窗口立即应用（字号）。 */
async function settingsSyncCase() {
  const first = await start();
  await editor(first).click();
  await first.keyboard.press("Control+Shift+N");
  const second = await pageOf("win-2");
  const size = (page) =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--editor-font-size")
        .trim(),
    );
  expect(await size(first)).toBe("10pt");
  expect(await size(second)).toBe("10pt");
  const choose = async (page, value) => {
    await page.locator(".settings-button").click();
    await page.locator(".settings-dialog[open]").waitFor();
    await page
      .locator(".settings-size button", { hasText: new RegExp(`^${value}$`) })
      .click();
  };
  await choose(first, 14);
  await expect.poll(() => size(second)).toBe("14pt");
  const px = await editor(second).evaluate((el) => getComputedStyle(el).fontSize);
  expect(Math.abs(parseFloat(px) - (14 * 4) / 3)).toBeLessThan(0.05);
  await first.locator(".settings-dialog button.primary").click();
  await expect.poll(() => readSettings().fontSizePt).toBe(14);
  await choose(second, 12);
  await expect.poll(() => size(first)).toBe("12pt");
  await second.locator(".settings-dialog button.primary").click();
  await expect.poll(() => readSettings().fontSizePt).toBe(12);
  passed("设置在两个窗口间同步");
  await kill();
}

/**
 * 启动时 = 打开上一会话中的内容：关非最后一个窗口照常询问；关最后一个窗口不询问，
 * 重启恢复窗口、标签页、当前标签页与 ●；改了又撤销回原样的标签页重启后没有 ●。
 */
async function lastSessionCase() {
  await writeFile(
    path.join(appData, "settings.json"),
    JSON.stringify({
      fontFamily: "微软雅黑",
      fontSizePt: 10,
      openFile: "tab",
      startup: "lastSession",
    }),
  );
  const jia = writeHush(path.join(dir, "甲.hush"), linesDoc(["甲原文"]));
  const yi = writeHush(path.join(dir, "乙.hush"), linesDoc(["乙原文"]));
  let page = await start([jia]);
  await expect.poll(() => tabNames(page)).toEqual(["甲.hush"]);
  await pressNewTab(page);
  await editor(page).click();
  await page.keyboard.insertText("草稿");
  expect(await launchSecond([yi])).toBe(0);
  await expect
    .poll(() => tabNames(page))
    .toEqual(["甲.hush", "● 无标题", "乙.hush"]);
  // Changed, stashed, then undone back to the saved text.
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("改了");
  await expect.poll(() => activeName(page)).toBe("● 乙.hush");
  await expect.poll(() => tabIds().length).toBe(3);
  const [, draft, undone] = tabIds();
  await stashed(undone, (doc) => lines(doc)[0] === "乙原文改了");
  await page.keyboard.press("Control+z");
  await expect.poll(() => activeName(page)).toBe("乙.hush");
  await stashed(undone, (doc) => lines(doc)[0] === "乙原文");
  // Not the last window: asked about as usual, and gone from the session.
  await page.keyboard.press("Control+Shift+N");
  let second = await pageOf("win-2");
  await editor(second).click();
  await second.keyboard.insertText("二号窗口");
  await dirty(second, true);
  await requestClose(second);
  await answer(second, "无标题", "不保存");
  await expect.poll(() => windowEntry("win-2")).toBeUndefined();
  await expect.poll(() => windowCount()).toBe(1);
  expect(processHandle.exitCode).toBeNull();
  passed("上一会话：关非最后一个窗口照常询问");
  // The last window: no question; everything stays for the next launch.
  await editor(page).click();
  await page.keyboard.press("Control+2");
  await expect.poll(() => activeId()).toBe(draft);
  await requestClose(page);
  await exited();
  const kept = sessionData();
  expect(kept.windows.map((w) => w.label)).toEqual(["win-1"]);
  expect(tabIds()).toHaveLength(3);
  expect(windowEntry().tabs.map((t) => t.path && path.basename(t.path))).toEqual([
    "甲.hush",
    null,
    "乙.hush",
  ]);
  expect(activeId()).toBe(draft);
  expect(lines(stash(workOf(draft)))).toEqual(["草稿"]);
  // Same as saved: its stash was dropped, so it is not "unsaved" next time.
  expect(stash(workOf(undone))).toBeNull();
  passed("上一会话：关最后一个窗口不询问");
  page = await start();
  await expect
    .poll(() => tabNames(page))
    .toEqual(["甲.hush", "● 无标题", "乙.hush"]);
  expect(await windowCount()).toBe(1);
  expect(await activeName(page)).toBe("● 无标题");
  await expect(editor(page)).toHaveText("草稿");
  await page.keyboard.press("Control+3");
  await expect(editor(page)).toHaveText("乙原文");
  await expect.poll(() => title(page)).toBe("乙.hush");
  await page.keyboard.press("Control+1");
  await expect(editor(page)).toHaveText("甲原文");
  passed("上一会话：重启恢复标签页、当前标签页与 ●");
  passed("改了又撤销回原样的标签页重启后没有 ●");
  // A crash keeps every window; the next launch brings them all back.
  await page.keyboard.press("Control+Shift+N");
  second = await pageOf("win-2");
  await editor(second).click();
  await second.keyboard.insertText("第二个窗口");
  await expect.poll(() => tabIds("win-2").length).toBe(1);
  await stashed(tabIds("win-2")[0], (doc) => lines(doc)[0] === "第二个窗口");
  await kill();
  page = await start();
  second = await pageOf("win-2");
  expect(await windowCount()).toBe(2);
  await expect.poll(() => tabNames(second)).toEqual(["● 无标题"]);
  await expect(editor(second)).toHaveText("第二个窗口");
  await expect
    .poll(() => tabNames(page))
    .toEqual(["甲.hush", "● 无标题", "乙.hush"]);
  passed("上一会话：崩溃后恢复全部窗口");
  await requestClose(second);
  await answer(second, "无标题", "不保存");
  await expect.poll(() => windowCount()).toBe(1);
  await stop(page);
  expect(sessionData().windows.map((w) => w.label)).toEqual(["win-1"]);
}

/** 自绘标题栏：最大化按钮（经覆盖窗口的 HTMAXBUTTON）、双击空白、最小化 / 还原、关闭按钮。 */
async function titleBarCase() {
  const page = await start();
  const rect = () =>
    page.evaluate(() => {
      const box = document.querySelector(".caption-max").getBoundingClientRect();
      const s = devicePixelRatio;
      const x = Math.round(box.left * s);
      const y = Math.round(box.top * s);
      return {
        x,
        y,
        w: Math.round(box.right * s) - x,
        h: Math.round(box.bottom * s) - y,
        dpr: s,
        iw: innerWidth,
        ih: innerHeight,
      };
    });
  const covers = (overlay, dom) =>
    !!overlay?.visible &&
    overlay.x === dom.x &&
    overlay.y === dom.y &&
    overlay.w === dom.w &&
    overlay.h === dom.h;
  const maxButton = page.locator(".caption-max");
  // The overlay window sits exactly on the maximize button.
  await expect
    .poll(async () => covers((await win32("info")).overlay, await rect()), {
      timeout: 10000,
    })
    .toBe(true);
  let info = await win32("info");
  const cx = info.overlay.x + (info.overlay.w >> 1);
  const cy = info.overlay.y + (info.overlay.h >> 1);
  expect((await win32("hittest", cx, cy)).overlayHit).toBe(9); // HTMAXBUTTON
  passed("最大化按钮命中测试为 HTMAXBUTTON（贴靠布局）");
  await win32("maxclick");
  await expect.poll(async () => (await win32("info")).zoomed).toBe(true);
  await expect(maxButton).toHaveAttribute("title", "向下还原");
  await sleep(500);
  info = await win32("info");
  const dom = await rect();
  const work = info.work;
  expect(info.client.slice(0, 2)).toEqual(work.slice(0, 2));
  expect(info.client[2]).toBe(work[2] - work[0]);
  expect(info.client[3]).toBe(work[3] - work[1]);
  expect(Math.abs(dom.iw * dom.dpr - info.client[2])).toBeLessThan(dom.dpr);
  expect(Math.abs(dom.ih * dom.dpr - info.client[3])).toBeLessThan(dom.dpr);
  await expect
    .poll(async () => covers((await win32("info")).overlay, await rect()))
    .toBe(true);
  passed("最大化：客户区等于工作区");
  await win32("maxclick");
  await expect.poll(async () => (await win32("info")).zoomed).toBe(false);
  await expect(maxButton).toHaveAttribute("title", "最大化");
  passed("最大化按钮切换最大化 / 还原");
  await sleep(500);
  // Double-clicking the empty part of the title bar.
  const blank = async () => {
    const box = await page.locator(".titlebar-drag").boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  await page.mouse.dblclick(...(await blank()));
  await expect.poll(async () => (await win32("info")).zoomed).toBe(true);
  await sleep(500);
  await page.mouse.dblclick(...(await blank()));
  await expect.poll(async () => (await win32("info")).zoomed).toBe(false);
  passed("双击标题栏空白最大化 / 还原");
  await sleep(500);
  await page.locator(".caption-min").click();
  await expect.poll(async () => (await win32("info")).iconic).toBe(true);
  await expect(page.locator(".titlebar.inactive")).toHaveCount(1);
  await win32("restore");
  await expect.poll(async () => (await win32("info")).iconic).toBe(false);
  passed("最小化 / 还原");
  // The close button goes through the close guard.
  await editor(page).click();
  await page.keyboard.insertText("未保存的文字");
  await page.locator(".caption-close").click();
  await answer(page, "无标题", "取消");
  await expect(prompt(page, "无标题")).toBeHidden();
  await sleep(500);
  expect(processHandle.exitCode).toBeNull();
  await page.locator(".caption-close").click();
  await answer(page, "无标题", "不保存");
  await exited();
  passed("关闭按钮走询问流程");
}

/**
 * 窗口大半在屏幕外（只露出顶上 200 物理像素）时关窗：保存询问打开后窗口被挪上来，
 * 询问框（外加 8 像素）整个露在工作区里；取消后不挪回。询问开着时标题栏仍可用真实
 * 鼠标拖动，拖完真实键盘 Esc 等于取消。
 */
async function revealCase() {
  const page = await start();
  const start0 = await win32("info");
  const work = start0.work;
  const [left0, , right0, bottom0] = start0.window;
  const height = bottom0 - start0.window[1];
  const width = right0 - left0;
  await win32("move", left0, work[3] - 200);
  await expect.poll(async () => (await win32("info")).window[1]).toBe(work[3] - 200);
  await editor(page).click();
  await page.keyboard.insertText("未保存的文字");
  await dirty(page, true);
  await page.keyboard.press("Control+w");
  const dialog = prompt(page, "无标题");
  await expect(dialog).toBeVisible();
  /** 询问框在屏幕上的位置（物理像素）与当时的窗口信息。 */
  const onScreen = async () => {
    const info = await win32("info");
    const box = await page.evaluate(() => {
      const b = document.querySelector("dialog.unsaved-dialog").getBoundingClientRect();
      return [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v * devicePixelRatio));
    });
    return {
      info,
      rect: [
        info.client[0] + box[0],
        info.client[1] + box[1],
        info.client[0] + box[2],
        info.client[1] + box[3],
      ],
    };
  };
  await expect
    .poll(async () => {
      const { rect, info } = await onScreen();
      return rect[1] >= info.work[1] + 8 && rect[3] <= info.work[3] - 8;
    })
    .toBe(true);
  const shown = await onScreen();
  const moved = shown.info.window;
  // 只挪最小距离：询问框下边恰好在工作区下边往上 8 像素处（取整误差 1）；左右与大小不变。
  expect(Math.abs(shown.rect[3] - (work[3] - 8))).toBeLessThanOrEqual(1);
  expect(moved[1]).toBeLessThan(work[3] - 200);
  expect(moved[0]).toBe(left0);
  expect([moved[2] - moved[0], moved[3] - moved[1]]).toEqual([width, height]);
  passed("保存询问打开时窗口挪进屏幕（最小距离）");
  await answer(page, "无标题", "取消");
  await expect(dialog).toBeHidden();
  await sleep(500);
  expect((await win32("info")).window).toEqual(moved);
  expect(processHandle.exitCode).toBeNull();
  passed("取消后窗口不挪回");

  // 询问开着时，真实鼠标按住标题栏空白处横向拖 150 像素。
  await page.keyboard.press("Control+w");
  await expect(dialog).toBeVisible();
  await sleep(300);
  const before = await win32("info");
  expect(before.window).toEqual(moved);
  const blank = await page.locator(".titlebar-drag").boundingBox();
  const dpr = await page.evaluate(() => devicePixelRatio);
  const sx = Math.round(before.client[0] + (blank.x + blank.width / 2) * dpr);
  const sy = Math.round(before.client[1] + (blank.y + blank.height / 2) * dpr);
  const dx = before.window[0] - 150 >= work[0] ? -150 : 150;
  const drag = await win32("drag", sx, sy, dx);
  expect([drag.down, drag.up]).toEqual([1, 1]);
  // 系统的移动循环要等光标移过拖动阈值（SM_CXDRAG）才开始跟随，会少几个像素。
  await expect
    .poll(async () => Math.abs((await win32("info")).window[0] - before.window[0] - dx))
    .toBeLessThanOrEqual(15);
  expect(Math.abs((await win32("info")).window[1] - before.window[1])).toBeLessThanOrEqual(5);
  await expect(dialog).toBeVisible();
  passed("询问开着时可用真实鼠标拖动标题栏");
  // 拖完（焦点可能已不在询问框里）真实键盘 Esc：等于取消。
  const esc = await win32("escape");
  expect(esc.foreground).toBe(true);
  await expect(dialog).toBeHidden();
  expect(processHandle.exitCode).toBeNull();
  passed("拖动后真实键盘 Esc 取消询问");
  await page.keyboard.press("Control+w");
  await answer(page, "无标题", "不保存");
  await exited();
}

/** 无标题草稿：暂存、崩溃后恢复，Ctrl+S 走另存为；中文与连续空行原样保存。 */
async function draftCase() {
  let page = await start();
  await editor(page).click();
  await page.keyboard.insertText("桌面端中文日记");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二行");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const draftLines = ["桌面端中文日记", "", "第二行", "", ""];
  await dirty(page, true);
  await expect.poll(() => tabIds().length).toBe(1);
  const [id] = tabIds();
  // The unnamed draft lives only in the tab's working copy.
  await stashed(id, (doc) => JSON.stringify(lines(doc)) === JSON.stringify(draftLines));
  await kill();
  page = await start();
  await expect(pane(page).getByText("已恢复未保存的修改。")).toBeVisible();
  await dirty(page, true);
  await expect(editor(page).locator("p")).toHaveText(draftLines);
  expect(await tabNames(page)).toEqual(["● 无标题"]);
  expect(tabIds()).toEqual([id]);
  passed("草稿崩溃恢复");
  // Ctrl+S on an unnamed document goes through the Save As dialog.
  const file = path.join(dir, "测试.hush");
  await editor(page).click();
  await page.keyboard.press("Control+s");
  const suggested = await answerSaveDialog(file);
  await dirty(page, false);
  await expect.poll(() => title(page)).toBe("测试.hush");
  expect(await tabNames(page)).toEqual(["测试.hush"]);
  expect(lines(body(file))).toEqual(draftLines);
  expect(existsSync(file + ".tmp")).toBe(false);
  expect(stash(workOf(id))).toBeNull();
  expect(windowEntry().tabs[0].path).toMatch(/测试\.hush$/);
  passed("中文换行");
  passed("未命名保存走另存为");
  await stop(page);
  return { suggested };
}

/**
 * 有文件的标签页：编辑与导入只在 Ctrl+S 时写入文件；撤销重做；原图逐字节；另存为
 * 当前文件；关闭询问（Esc / 取消 / 不保存）；关闭时清理未引用图片；文件结构。
 */
async function imagesCase() {
  const draftLines = ["桌面端中文日记", "", "第二行", "", ""];
  const file = writeHush(path.join(dir, "测试.hush"), linesDoc(draftLines));
  const page = await start([file]);
  const ed = editor(page);
  await expect.poll(() => title(page)).toBe("测试.hush");
  await expect.poll(() => tabIds().length).toBe(1);
  const [id] = tabIds();
  const working = workOf(id);
  await ed.click();
  await page.keyboard.press("Control+End");
  // Distinct real images on disk, so each one can be compared byte for byte.
  const source = await makeImages(page, [
    ["第一张.png", 240, 160],
    ["第二张.png", 200, 140],
    ["追加.jpg", null, null, "jpeg"],
    ["空行之后.png", 180, 120],
    ["将删除.png", 160, 110],
  ]);
  const savedFile = await fingerprint(file);
  const savedBody = body(file);
  const savedIds = storedIds(file);
  await input(page).setInputFiles([
    source["第一张.png"].file,
    source["第二张.png"].file,
  ]);
  await expectGroups(ed, 1);
  await expect(ed.locator(".image-tile img")).toHaveCount(2);
  // Nothing ends up selected: the caret is after the last new image.
  await expect(ed.locator(".ProseMirror-selectednode, .image-selected")).toHaveCount(0);
  await expectCaretAfterImage(ed, "last");
  // A click on an image's right half puts the caret after it (no image is
  // selected); an import goes in right there, inside the group.
  await clickImageSide(ed.locator(".image-tile").first(), "after");
  await expect(ed.locator(".ProseMirror-selectednode, .image-selected")).toHaveCount(0);
  await expectCaretAfterImage(ed, "first");
  await input(page).setInputFiles(source["追加.jpg"].file);
  await expect(ed.locator(".image-tile img")).toHaveCount(3);
  expect(await imageNames(ed)).toEqual(["第一张.png", "追加.jpg", "第二张.png"]);
  await expectGroups(ed, 1);
  await page.keyboard.press("Control+z");
  await expect(ed.locator(".image-tile img")).toHaveCount(2);
  // The first import replaced the empty line it went to (a text line above it,
  // so no line was added): the document ends with the group. Enter at the caret
  // after its last image starts a line; an import on an empty line below a text
  // line replaces that line and makes a second group.
  expect(await ed.locator("p").count()).toBe(draftLines.length - 1);
  await clickImageSide(ed.locator(".image-tile").last(), "after");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("组后文字");
  await page.keyboard.press("Enter");
  const blankLines = await ed.locator("p").count();
  await input(page).setInputFiles(source["空行之后.png"].file);
  await expectGroups(ed, 2);
  expect(await ed.locator("p").count()).toBe(blankLines - 1);
  await page.keyboard.press("Control+z");
  await expectGroups(ed, 1);
  expect(await ed.locator("p").count()).toBe(blankLines);
  await thumbnailsLoaded(ed);
  await ed.locator(".image-tile").first().dblclick();
  await expect(page.locator("dialog img")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存原图" })).toBeVisible();
  await page.getByRole("button", { name: "关闭原图" }).click();
  await ed.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("图片之后");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await dirty(page, true);
  await stashed(
    id,
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
  const edited = stash(working);
  await page.keyboard.press("Control+s");
  await dirty(page, false);
  const saved = body(file);
  expect(saved).toEqual(edited);
  expect(saved.blocks.at(-1)).toEqual({ type: "line", text: "" });
  expect(pictures(saved)).toEqual(
    ["第一张.png", "第二张.png"].map((name) =>
      expect.objectContaining({ id: source[name].id, name }),
    ),
  );
  // Originals are stored unchanged; undone imports stay until the tab is closed.
  for (const name of ["第一张.png", "第二张.png", "追加.jpg", "空行之后.png"])
    expect(stored(file, source[name].id).equals(source[name].bytes)).toBe(true);
  // Saving empties the working copy, so a restart would not report a recovery.
  expect(stash(working)).toBeNull();
  expect(storedIds(working)).toEqual([]);
  await thumbnailsLoaded(ed);
  passed("保存写入正文与新图片");
  passed("撤销重做");
  const exported = path.join(dir, "导出");
  await mkdir(exported);
  const first = source["第一张.png"];
  await call(page, "export_image", {
    tab: id,
    id: first.id,
    path: path.join(exported, "原图.png"),
  });
  expect(
    (await readFile(path.join(exported, "原图.png"))).equals(first.bytes),
  ).toBe(true);
  const attachment = `${first.id.slice(0, 12)}-第一张.png`;
  await call(page, "export_document", {
    tab: id,
    path: path.join(exported, "测试.html"),
    content: "<p>导出</p>",
    images: [{ id: first.id, file: attachment }],
  });
  expect(
    (await readFile(path.join(exported, "附件", attachment))).equals(first.bytes),
  ).toBe(true);
  passed("多图原图");
  // Save As onto the open file itself: the dialog asks to replace, then it just saves.
  await ed.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("另存为同一文件");
  await page.keyboard.press("Enter");
  await dirty(page, true);
  await page.keyboard.press("Control+Shift+S");
  const suggested = await answerSaveDialog(file, { replace: true });
  await dirty(page, false);
  await expect.poll(() => title(page)).toBe("测试.hush");
  expect(body(file).blocks.slice(-2)).toEqual([
    { type: "line", text: "另存为同一文件" },
    { type: "line", text: "" },
  ]);
  expect(existsSync(file + ".tmp")).toBe(false);
  expect(stash(working)).toBeNull();
  passed("另存为当前文件");
  await page.screenshot({ path: path.join(dir, "desktop.png") });
  // A saved image deleted from the body stays in the file until the tab is closed.
  const doomed = source["将删除.png"];
  await ed.click();
  await page.keyboard.press("Control+End");
  // The import replaces the empty line the caret is on; keep one above it.
  await page.keyboard.press("Enter");
  await input(page).setInputFiles(doomed.file);
  await expectGroups(ed, 2);
  await thumbnailsLoaded(ed);
  await page.keyboard.press("Control+s");
  await dirty(page, false);
  expect(pictures(body(file)).map((p) => p.id)).toContain(doomed.id);
  // Delete at the caret before the last image (a group on its own) removes only that image.
  await clickImageSide(ed.locator(".image-tile").last(), "before");
  await page.keyboard.press("Delete");
  await expect(ed.locator(".image-tile")).toHaveCount(2);
  await expectGroups(ed, 1);
  await page.keyboard.press("Control+s");
  await dirty(page, false);
  const before = body(file);
  expect(pictures(before).map((p) => p.id)).not.toContain(doomed.id);
  expect(storedIds(file)).toContain(doomed.id);
  expect(before.blocks.at(-1).type).toBe("line");
  // The working copy has the same header as a .hush file.
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

  // --- Close with unsaved changes: Esc / 取消 keep the window, 不保存 discards ---
  const savedBeforeClose = await fingerprint(file);
  await ed.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("关闭前输入");
  await dirty(page, true);
  await expect.poll(() => title(page)).toBe("● 测试.hush");
  await requestClose(page);
  await expect(prompt(page, "测试.hush")).toBeVisible();
  // Ctrl+S behind the modal does nothing; the question stays open.
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Escape");
  await expect(prompt(page, "测试.hush")).toBeHidden();
  // The dialog's close event, which ends the first close attempt, fires a task
  // after it is hidden; closing again before that only shows "操作仍在进行".
  await sleep(300);
  await requestClose(page);
  await answer(page, "测试.hush", "取消");
  await expect(prompt(page, "测试.hush")).toBeHidden();
  expect(processHandle.exitCode).toBeNull();
  // Focus is back in the editor: typing continues where it stopped.
  await page.keyboard.insertText("，取消后继续");
  await expect(ed.locator("p").last()).toHaveText("关闭前输入，取消后继续");
  expect(await fingerprint(file)).toEqual(savedBeforeClose);
  await sleep(300);
  await requestClose(page);
  await answer(page, "测试.hush", "不保存");
  await exited();
  expect(body(file)).toEqual(before);
  expect(existsSync(working)).toBe(false);
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
    (await readdir(dir)).filter((n) => n.startsWith("测试.hush")),
  ).toEqual(["测试.hush"]);
  expect((await readdir(appData)).sort()).toEqual([
    "session.json",
    "session.lock",
    "tabs",
  ]);
  expect(await tabFiles()).toEqual([]);
  expect((await readFile(file)).subarray(0, 16).toString("latin1")).toBe(
    "SQLite format 3\0",
  );
  expect(query(file, "PRAGMA freelist_count")[0].freelist_count).toBe(0);
  passed("文件结构");
  return { suggested };
}

/**
 * 关闭询问中选“保存”；程序崩溃时文件保持已保存的样子，重启恢复到那个文件；保存后
 * 重启是新的无标题文档，双击文件（第二实例）在空标签页里打开。
 */
async function saveAndCrashCase() {
  let page = await start();
  const source = await makeImages(page, [
    ["第一张.png", 240, 160],
    ["第二张.png", 200, 140],
    ["崩溃前.png", 150, 100],
  ]);
  const file = writeHush(
    path.join(dir, "测试.hush"),
    {
      blocks: [
        { type: "line", text: "第一行" },
        {
          type: "images",
          images: ["第一张.png", "第二张.png"].map((n) => source[n].picture),
        },
        { type: "line", text: "" },
      ],
    },
    ["第一张.png", "第二张.png"].map((n) => source[n].bytes),
  );
  // Double-clicked while running: opens in the empty unnamed tab.
  expect(await launchSecond([file])).toBe(0);
  let ed = editor(page);
  await expect.poll(() => title(page)).toBe("测试.hush");
  expect(await tabNames(page)).toEqual(["测试.hush"]);
  await dirty(page, false);
  await expect(ed.locator(".image-tile img")).toHaveCount(2);
  await thumbnailsLoaded(ed);
  await ed.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("保存后关闭");
  await requestClose(page);
  await answer(page, "测试.hush", "保存");
  await exited();
  const afterSaveClose = body(file);
  expect(afterSaveClose.blocks.at(-1)).toEqual({
    type: "line",
    text: "保存后关闭",
  });
  expect(await tabFiles()).toEqual([]);
  passed("关闭时保存");

  // --- Crash with unsaved text and a new image: the file keeps its saved state ---
  page = await start([file]);
  ed = editor(page);
  await expect.poll(() => title(page)).toBe("测试.hush");
  await dirty(page, false);
  await expect(ed.locator(".image-tile img")).toHaveCount(2);
  await thumbnailsLoaded(ed);
  const crashed = source["崩溃前.png"];
  await ed.click();
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
  await input(page).setInputFiles(crashed.file);
  await expectGroups(ed, 2);
  await thumbnailsLoaded(ed);
  const [id] = tabIds();
  await stashed(
    id,
    (doc) =>
      pictures(doc).some((p) => p.id === crashed.id) &&
      doc.blocks.some((b) => b.text === "崩溃前输入"),
  );
  const crashStash = stash(workOf(id));
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
  ed = editor(page);
  await expect(pane(page).getByText("已恢复未保存的修改。")).toBeVisible();
  await dirty(page, true);
  await expect.poll(() => title(page)).toBe("● 测试.hush");
  await expect(ed.getByText("崩溃前输入")).toBeVisible();
  await expectGroups(ed, 2);
  await expect(ed.locator(".image-tile img")).toHaveCount(3);
  await thumbnailsLoaded(ed);
  expect(await fingerprint(file)).toEqual(beforeCrash);
  passed("崩溃恢复");
  await ed.click();
  await page.keyboard.press("Control+s");
  await dirty(page, false);
  await expect(pane(page).getByText("已恢复未保存的修改。")).toHaveCount(0);
  expect(body(file)).toEqual(crashStash);
  expect(stored(file, crashed.id).equals(crashed.bytes)).toBe(true);
  expect(stash(workOf(id))).toBeNull();
  await stop(page);
  // Once saved, the restart starts unnamed again; the file opens from a double-click.
  page = await start();
  ed = editor(page);
  await expect.poll(() => title(page)).toBe("无标题");
  await expect(pane(page).getByText("已恢复未保存的修改。")).toHaveCount(0);
  await expect(ed).toHaveText("");
  await expect(ed.locator(".image-tile")).toHaveCount(0);
  expect(windowEntry().tabs.map((t) => t.path)).toEqual([null]);
  expect(await launchSecond([file])).toBe(0);
  await expect.poll(() => title(page)).toBe("测试.hush");
  expect(await tabNames(page)).toEqual(["测试.hush"]);
  await dirty(page, false);
  await expect(ed.locator(".image-tile img")).toHaveCount(3);
  await thumbnailsLoaded(ed);
  expect(body(file)).toEqual(crashStash);
  passed("正常关闭后新建");
  passed("保存重开");
  await stop(page);
}

/** 崩溃后原文件被搬走：未保存的修改作为无标题文档恢复，带说明。 */
async function lostFileCase() {
  let page = await start();
  const source = await makeImages(page, [["图.png", 200, 140]]);
  const file = writeHush(
    path.join(dir, "测试.hush"),
    {
      blocks: [
        { type: "line", text: "已保存" },
        { type: "images", images: [source["图.png"].picture] },
        { type: "line", text: "" },
      ],
    },
    [source["图.png"].bytes],
  );
  await kill();
  page = await start([file]);
  await expect.poll(() => title(page)).toBe("测试.hush");
  await thumbnailsLoaded(editor(page));
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("搬走前输入");
  const [id] = tabIds();
  await stashed(id, (doc) => doc.blocks.some((b) => b.text === "搬走前输入"));
  const movedStash = stash(workOf(id));
  await kill();
  const moved = path.join(dir, "搬走.hush");
  await rename(file, moved);
  const movedFile = await fingerprint(moved);
  page = await start();
  const lost = pane(page)
    .getByRole("status")
    .filter({ hasText: "未保存的修改已作为未命名文档恢复" });
  await expect(lost).toBeVisible();
  await expect(lost).toContainText("测试.hush");
  await dirty(page, true);
  await expect.poll(() => title(page)).toBe("● 无标题");
  await expect(editor(page).getByText("搬走前输入")).toBeVisible();
  // The image was saved into the moved file only, so it shows a placeholder.
  await expect(editor(page).getByText("无法显示此图片")).toHaveCount(1);
  expect(stash(workOf(id))).toEqual(movedStash);
  expect(windowEntry().tabs.map((t) => t.path)).toEqual([null]);
  expect(await fingerprint(moved)).toEqual(movedFile);
  passed("原文件丢失恢复");
  await requestClose(page);
  await answer(page, "无标题", "不保存");
  await exited();
  expect(await fingerprint(moved)).toEqual(movedFile);
}

/** 带文件启动（相对路径）；有崩溃残留时残留先恢复（不询问），文件在它右侧的新标签页打开。 */
async function launchArgumentCase() {
  writeHush(path.join(dir, "副本.hush"), linesDoc(["副本内容"]));
  const other = writeHush(path.join(dir, "另一个.hush"), linesDoc(["另一个内容"]));
  let page = await start(["副本.hush"], dir);
  await expect.poll(() => title(page)).toBe("副本.hush");
  expect(await tabNames(page)).toEqual(["副本.hush"]);
  await expect(pane(page).getByText("已恢复未保存的修改。")).toHaveCount(0);
  expect(windowEntry().tabs[0].path).toMatch(/副本\.hush$/);
  passed("启动参数（相对路径）打开文件");
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("副本未保存");
  const [id] = tabIds();
  await stashed(id, (doc) => doc.blocks.some((b) => b.text === "副本未保存"));
  await kill();
  page = await start([other]);
  await expect
    .poll(() => tabNames(page))
    .toEqual(["● 副本.hush", "另一个.hush"]);
  await expect.poll(() => activeName(page)).toBe("另一个.hush");
  await expect.poll(() => title(page)).toBe("另一个.hush");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Control+1");
  await expect(pane(page).getByText("已恢复未保存的修改。")).toBeVisible();
  await expect(editor(page).getByText("副本未保存")).toBeVisible();
  passed("启动参数打开文件：崩溃残留先恢复，文件开在新标签页");
  await requestClose(page);
  await answer(page, "副本.hush", "不保存");
  await exited();
  expect(await tabFiles()).toEqual([]);
}

/** 选中图片 Ctrl+C，在另一个标签页 Ctrl+V：同一张原图（同 id）进入那个标签页的工作副本。 */
async function copyPasteCase() {
  const page = await start();
  const source = await makeImages(page, [["复制.png", 220, 150]]);
  const picture = source["复制.png"];
  await editor(page).click();
  await input(page).setInputFiles(picture.file);
  await expect(editor(page).locator(".image-tile img")).toHaveCount(1);
  await thumbnailsLoaded(editor(page));
  // A click only places the caret; Shift+Left from after the image selects it.
  await clickImageSide(editor(page).locator(".image-tile"), "after");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(editor(page).locator(".image-selected")).toHaveCount(1);
  await page.keyboard.press("Control+c");
  // Rust writes the clipboard in the background.
  await sleep(1500);
  await pressNewTab(page);
  await expect.poll(() => tabNames(page)).toEqual(["● 无标题", "无标题 2"]);
  await editor(page).click();
  await page.keyboard.press("Control+v");
  await expect(editor(page).locator(".image-tile img")).toHaveCount(1);
  await thumbnailsLoaded(editor(page));
  expect(await imageNames(editor(page))).toEqual(["复制.png"]);
  await expect.poll(() => tabIds().length).toBe(2);
  const pasted = tabIds()[1];
  await stashed(pasted, (doc) =>
    pictures(doc).some((p) => p.id === picture.id),
  );
  expect(stored(workOf(pasted), picture.id).equals(picture.bytes)).toBe(true);
  passed("图片复制粘贴（跨标签页，原图不变）");
  await kill();
}

/**
 * 导出：经导出菜单与系统保存对话框导出 TXT、HTML、PDF（PDF 再覆盖导出一次）。
 * PDF 只检查文件头尾与隐藏窗口已关闭；文字、图片与版式另用 Poppler 检查。
 */
async function exportCase() {
  const page = await start();
  const ed = editor(page);
  await ed.click();
  await page.keyboard.insertText("导出 PDF 的中文第一行");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("空行之后的第二行，后面接两张图片");
  await page.keyboard.press("Enter");
  const source = await makeImages(
    page,
    [
      ["横图.png", 480, 240],
      ["截图.jpg", null, null, "jpeg"],
    ],
    path.join(dir, "PDF 源图"),
  );
  await input(page).setInputFiles([source["横图.png"].file, source["截图.jpg"].file]);
  await expect(ed.locator(".image-tile img")).toHaveCount(2);
  await clickImageSide(ed.locator(".image-tile").last(), "after");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("图片之后的最后一行");
  const newButton = page.getByRole("button", { name: "新建", exact: true });
  const exportAs = async (item, target, replace = false) => {
    const before = existsSync(target) ? (await stat(target)).mtimeMs : 0;
    await page.getByText("导出", { exact: true }).click();
    await page.getByRole("button", { name: item, exact: true }).click();
    const suggested = await answerSaveDialog(target, {
      title: "导出日记",
      replace,
    });
    // 导出期间文件按钮不可用，结束后恢复。
    await expect
      .poll(async () => existsSync(target) && (await stat(target)).mtimeMs > before, {
        timeout: 60000,
      })
      .toBe(true);
    await expect(newButton).toBeEnabled({ timeout: 60000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    return suggested;
  };
  const txt = path.join(dir, "导出.txt");
  await exportAs("纯文本 (.txt)", txt);
  await expect
    .poll(() => readFile(txt, "utf8"))
    .toBe(
      [
        "导出 PDF 的中文第一行",
        "",
        "空行之后的第二行，后面接两张图片",
        "[图片：横图.png] [图片：截图.jpg]",
        "图片之后的最后一行",
      ].join("\n"),
    );
  passed("导出 TXT");
  const html = path.join(dir, "导出.html");
  await exportAs("图文网页 (.html)", html);
  for (const name of ["横图.png", "截图.jpg"]) {
    const attachment = path.join(
      dir,
      "附件",
      `${source[name].id.slice(0, 12)}-${name}`,
    );
    await expect.poll(() => existsSync(attachment)).toBe(true);
    expect((await readFile(attachment)).equals(source[name].bytes)).toBe(true);
  }
  expect(await readFile(html, "utf8")).toContain("空行之后的第二行");
  passed("导出 HTML");
  const target = path.join(dir, "导出.pdf");
  const exportPdf = async (replace) => {
    const suggested = await exportAs("PDF 文档 (.pdf)", target, replace);
    const bytes = await readFile(target);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.subarray(-1024).toString("latin1")).toContain("%%EOF");
    // 隐藏的打印窗口已经关闭。
    expect(await call(page, "plugin:window|get_all_windows")).toEqual(["win-1"]);
    return suggested;
  };
  const suggested = await exportPdf(false);
  const first = await stat(target);
  await copyFile(target, path.join(dir, "导出-第一次.pdf"));
  // 同一路径再导出一次：覆盖，标签 print 可以重复使用。
  await ed.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二次导出追加的一行");
  await exportPdf(true);
  expect((await stat(target)).mtimeMs).toBeGreaterThan(first.mtimeMs);
  passed("导出 PDF");
  await requestClose(page);
  await answer(page, "无标题", "不保存");
  await exited();
  return { pdf: target, suggested };
}

/**
 * 编辑区的右键菜单（hooks/useContextMenu.ts、src-tauri/src/context_menu.rs）：CDP 的右键同样引起
 * WebView2 的 ContextMenuRequested，菜单是页面画的；复制走 copy 事件，粘贴交回 WebView2
 * 执行（菜单请求挂起期间页面照常响应）。左栏、图片上右键也能粘贴；工具栏上不弹菜单。
 */
async function contextMenuCase() {
  const page = await start();
  const ed = editor(page);
  const menu = page.getByRole("menu", { name: "编辑" });
  const item = (name) => menu.getByRole("menuitem", { name });
  const lines = () =>
    ed.evaluate((el) => {
      const out = [];
      el.editor.state.doc.forEach((n) => out.push(n.type.name === "image" ? "[图]" : n.textContent));
      return out;
    });
  const select = (from, to = from) =>
    ed.evaluate((el, [from, to]) => el.editor.commands.setTextSelection({ from, to }), [from, to]);
  /** 右键文字位置 `pos` 后面那个字。 */
  async function rightAt(pos) {
    const at = await ed.evaluate((el, pos) => {
      const a = el.editor.view.coordsAtPos(pos, 1);
      return { x: a.left + 3, y: (a.top + a.bottom) / 2 };
    }, pos);
    await page.mouse.click(at.x, at.y, { button: "right" });
  }
  await ed.click();
  await page.keyboard.type("今天天气好");
  await select(3, 5);
  await rightAt(3);
  await expect(menu).toBeVisible();
  await expect(item("复制")).toBeEnabled();
  await item("复制").click();
  await expect(menu).toHaveCount(0);
  // 行尾右侧空白里右键：光标到行尾（按在选区外时浏览器把光标移到按下处）。
  await select(6);
  const row = await ed.locator("p").first().boundingBox();
  await page.mouse.click(row.x + 400, row.y + row.height / 2, { button: "right" });
  await expect(item("粘贴")).toBeEnabled();
  await item("粘贴").click();
  await expect.poll(lines).toEqual(["今天天气好天气"]);
  passed("右键菜单复制、粘贴（粘贴交回 WebView2）");
  // 图片：选中后经菜单复制（Rust 写剪贴板），左栏右键粘贴到行首。
  const source = await makeImages(page, [["菜单.png", 120, 80]]);
  await select(8);
  await input(page).setInputFiles(source["菜单.png"].file);
  await expect(ed.locator(".image-tile img")).toHaveCount(1);
  await thumbnailsLoaded(ed);
  await clickImageSide(ed.locator(".image-tile"), "after");
  await page.keyboard.press("Shift+ArrowLeft");
  const tile = (await ed.locator(".image-tile").boundingBox());
  await page.mouse.click(tile.x + tile.width / 2, tile.y + tile.height / 2, { button: "right" });
  await item("复制").click();
  await sleep(1500);
  await select(1);
  const box = await ed.boundingBox();
  const line = await ed.locator("p").first().boundingBox();
  await page.mouse.click(box.x + 6, line.y + line.height / 2, { button: "right" });
  await expect(item("粘贴")).toBeEnabled();
  await item("粘贴").click();
  await expect.poll(lines).toEqual(["[图]", "今天天气好天气", "[图]"]);
  passed("右键菜单复制图片、在左栏右键粘贴");
  // 工具栏上右键：没有菜单。
  const bar = await page.locator(".toolbar").boundingBox();
  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2, { button: "right" });
  await sleep(500);
  await expect(menu).toHaveCount(0);
  passed("工具栏上右键不弹菜单");
  await kill();
}

// ---------------------------------------------------------------------------
const cases = {
  启动与窗口: startupCase,
  标签页快捷键: tabKeysCase,
  关闭标签页: closeTabCase,
  关窗逐个询问: closeWindowCase,
  崩溃恢复多标签: crashTabsCase,
  第二实例: secondInstanceCase,
  "Ctrl+O": ctrlOCase,
  设置同步: settingsSyncCase,
  上一会话: lastSessionCase,
  自绘标题栏: titleBarCase,
  对话框挪进屏幕: revealCase,
  草稿与另存为: draftCase,
  图片与保存: imagesCase,
  关闭保存与崩溃恢复: saveAndCrashCase,
  原文件丢失恢复: lostFileCase,
  启动参数打开文件: launchArgumentCase,
  图片复制粘贴: copyPasteCase,
  导出: exportCase,
  右键菜单: contextMenuCase,
};
/** Runs one case in its own folders; whatever happens, no LineHush is left running. */
async function runCase(name) {
  const began = Date.now();
  errors = [];
  checks = [];
  await fresh(name.replace(/[^\p{L}\p{N}]+/gu, "-"));
  try {
    const result = await cases[name]();
    expect(errors).toEqual([]);
    return { name, ok: true, ms: Date.now() - began, checks, result };
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - began,
      checks,
      error: String(e?.message ?? e).slice(0, 3000),
      pageErrors: errors,
    };
  } finally {
    await browser?.close().catch(() => {});
    browser = undefined;
    if (
      processHandle &&
      processHandle.exitCode === null &&
      processHandle.signalCode === null
    )
      await kill().catch(() => {});
  }
}
if (only !== undefined && !cases[only])
  throw Error(`没有名为“${only}”的用例，可选：${Object.keys(cases).join("、")}`);
const began = Date.now();
const results = [];
for (const name of only === undefined ? Object.keys(cases) : [only]) {
  const result = await runCase(name);
  results.push(result);
  console.log(
    `${result.ok ? "通过" : "失败"}：${name}（${(result.ms / 1000).toFixed(1)} s）` +
      (result.ok ? "" : `\n  ${result.error}`),
  );
}
const ok = results.every((r) => r.ok);
console.log(
  JSON.stringify({
    passed: ok,
    profile,
    root,
    seconds: Math.round((Date.now() - began) / 1000),
    results,
  }),
);
if (!ok) process.exitCode = 1;
