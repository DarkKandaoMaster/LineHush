import { test, expect, type Page } from "@playwright/test";
import { calls, content, editorOf, load } from "./helpers";

// ---- Folders (2026-11-01): a dropped or pasted folder goes in as one attached file, `<name>.zip`. ----

/** A file inside a dropped folder (`huge`: claims 300 MB) or a folder (`fail`: cannot be read). */
type Entry =
  | { name: string; size?: number; huge?: boolean }
  | { name: string; children: Entry[]; fail?: boolean };
/** What is dropped, in order: plain files, or folders. */
type Dropped = { file: string; size: number } | { folder: Entry & { children: Entry[] } };

/**
 * Drops `items` onto the first line. Playwright cannot make a drop that holds a
 * real folder, so each folder is a stub file whose DataTransferItem hands out
 * a made-up directory entry (webkitGetAsEntry), read two entries at a time.
 */
const drop = (page: Page, items: Dropped[]) =>
  editorOf(page).evaluate((el, items: Dropped[]) => {
    const w = window as any;
    const fakes: Map<File, unknown> = (w.folderEntries ??= new Map());
    if (!w.folderPatched) {
      w.folderPatched = true;
      const real = DataTransferItem.prototype.webkitGetAsEntry;
      DataTransferItem.prototype.webkitGetAsEntry = function () {
        const file = this.getAsFile();
        for (const [stub, entry] of fakes) if (file && stub.name === file.name) return entry as any;
        return real.call(this);
      };
    }
    const entryOf = (node: Entry): unknown => {
      if (!("children" in node)) {
        return {
          name: node.name,
          isFile: true,
          isDirectory: false,
          file: (ok: (file: File) => void) => {
            const file = new File([new Uint8Array(node.size ?? 1)], node.name);
            if (node.huge) Object.defineProperty(file, "size", { value: 300 * 1024 * 1024 });
            setTimeout(() => ok(file));
          },
        };
      }
      const children = node.children.map(entryOf);
      return {
        name: node.name,
        isFile: false,
        isDirectory: true,
        createReader: () => {
          let at = 0;
          return {
            readEntries: (ok: (e: unknown[]) => void, error: (e: unknown) => void) =>
              setTimeout(() => {
                if (node.fail) return error(new DOMException("denied", "NotReadableError"));
                ok(children.slice(at, at + 2));
                at += 2;
              }),
          };
        },
      };
    };
    const data = new DataTransfer();
    for (const item of items) {
      if ("file" in item) data.items.add(new File([new Uint8Array(item.size)], item.file));
      else {
        const stub = new File([], item.folder.name);
        fakes.set(stub, entryOf(item.folder));
        data.items.add(stub);
      }
    }
    // The first line, or the editor once images have taken its place.
    const p = el.querySelector("p") ?? el;
    const box = p.getBoundingClientRect();
    p.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        clientX: box.left + 2,
        clientY: box.top + box.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, items);

/** A paste of `files` ([name, size, type]) and `text`; nothing at all by default. */
const paste = (page: Page, files: [string, number, string][] = [], text?: string) =>
  editorOf(page).evaluate(
    (el, { files, text }) => {
      const data = new DataTransfer();
      for (const [name, size, type] of files)
        data.items.add(new File([new Uint8Array(size)], name, { type }));
      if (text !== undefined) data.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { files, text },
  );
const setClipboardFolders = (page: Page, folders: { name: string; path: string }[]) =>
  page.evaluate((folders) => ((window as any).testNative.clipboardFolders = folders), folders);

const chipNames = (page: Page) => editorOf(page).locator(".file-chip .file-name");
/** The zip_* calls in order, as `cmd args`. */
const zipCalls = (page: Page) =>
  page.evaluate(() =>
    (window as any).testNative.calls
      .filter((c: any) => c.cmd.startsWith("zip_"))
      .map((c: any) =>
        c.cmd === "zip_add"
          ? `zip_add ${c.args.headers["x-linehush-zip"]} ${decodeURIComponent(c.args.headers["x-linehush-path"])} ${c.args.size}`
          : `${c.cmd} ${JSON.stringify(c.args)}`,
      ),
  );

test("拖进文件夹：逐目录 / 逐文件交给 Rust 打包，与普通文件按拖入顺序插入成“名字.zip”胶囊，一步撤销", async ({
  page,
}) => {
  const errors = await load(page);
  await drop(page, [
    { file: "前.txt", size: 10 },
    {
      folder: {
        name: "资料",
        children: [
          { name: "z.txt", size: 3 },
          { name: "子目录", children: [{ name: "b 和 c.txt", size: 5 }, { name: "空目录", children: [] }] },
          { name: "a.txt", size: 2 },
        ],
      },
    },
    { folder: { name: "空", children: [] } },
    { file: "后.txt", size: 20 },
  ]);
  await expect(chipNames(page)).toHaveText(["前.txt", "资料.zip", "空.zip", "后.txt"]);
  await expect(editorOf(page).locator(".file-chip .file-size")).toHaveText(["10 B", "10 B", "0 B", "20 B"]);
  expect(await zipCalls(page)).toEqual([
    'zip_begin {"tab":"t1","name":"资料"}',
    'zip_add_dir {"zipId":"zip1","path":"子目录"}',
    'zip_add_dir {"zipId":"zip1","path":"子目录/空目录"}',
    "zip_add zip1 z.txt 3",
    "zip_add zip1 子目录/b 和 c.txt 5",
    "zip_add zip1 a.txt 2",
    'zip_finish {"zipId":"zip1"}',
    'zip_begin {"tab":"t1","name":"空"}',
    'zip_finish {"zipId":"zip2"}',
  ]);
  // The path goes URI-encoded in its header.
  const [, second] = (await calls(page, "zip_add")) as any[];
  expect(second.headers["x-linehush-path"]).toBe(encodeURIComponent("子目录/b 和 c.txt"));
  expect((await calls(page, "import_file")).map((c: any) => c.size)).toEqual([10, 20]);
  // The zip is a plain attached file in the document.
  await expect
    .poll(async () => {
      const stashed = await calls(page, "stash_document");
      return stashed.at(-1)?.document.blocks.find((b: any) => b.type === "images")?.images[1];
    })
    .toEqual({ id: `${"d".repeat(63)}1`, name: "资料.zip", width: 0, height: 0, kind: "file", size: 10 });
  await expect(page.locator(".error-banner")).toHaveCount(0);
  // One undo step for the whole drop.
  await expect(editorOf(page)).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(chipNames(page)).toHaveCount(0);
  expect(await content(page)).toEqual([""]);
  expect(errors).toEqual([]);
});

test("拖进超过 256 MB 的文件夹：打包前按大小之和拒绝，不调 zip_begin", async ({ page }) => {
  const errors = await load(page);
  await drop(page, [
    { folder: { name: "大", children: [{ name: "录像.bin", huge: true }, { name: "a.txt", size: 1 }] } },
  ]);
  await expect(page.locator(".error-banner")).toContainText("无法插入文件夹“大”：文件夹过大（上限 256 MB）");
  expect(await zipCalls(page)).toEqual([]);
  await expect(chipNames(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("文件夹打包中途失败：zip_abort 丢掉半成品并报错，之前的项照常插入", async ({ page }) => {
  const errors = await load(page);
  await drop(page, [
    { file: "前.txt", size: 10 },
    { folder: { name: "资料", children: [{ name: "a.txt", size: 2 }, { name: "坏.txt", size: 2 }] } },
    { file: "后.txt", size: 20 },
  ]);
  await expect(page.locator(".error-banner")).toContainText("无法插入文件夹“资料”：写入压缩包失败：拒绝访问");
  await expect(chipNames(page)).toHaveText(["前.txt"]);
  expect((await zipCalls(page)).slice(-2)).toEqual(["zip_add zip1 坏.txt 2", 'zip_abort {"zipId":"zip1"}']);
  // Reading the folder fails: nothing is sent.
  await drop(page, [{ folder: { name: "私密", children: [], fail: true } }]);
  await expect(page.locator(".error-banner")).toContainText("无法插入文件夹“私密”：无法读取“私密”");
  expect((await calls(page, "zip_begin")).length).toBe(1);
  expect(errors).toEqual([]);
});

test("粘贴文件夹：剪贴板文件夹交给 import_folder，剔掉同名 0 字节假文件，排在文件之后一步撤销", async ({
  page,
}) => {
  const errors = await load(page);
  await setClipboardFolders(page, [{ name: "资料", path: "D:\\x\\资料" }]);
  await paste(page, [
    ["资料", 0, ""],
    ["a.txt", 10, "text/plain"],
  ]);
  await expect(chipNames(page)).toHaveText(["a.txt", "资料.zip"]);
  await expect(editorOf(page).locator(".file-chip .file-size")).toHaveText(["10 B", "4 KB"]);
  expect(await calls(page, "import_file")).toEqual([{ size: 10, headers: { "x-linehush-tab": "t1" } }]);
  expect(await calls(page, "import_folder")).toEqual([{ tab: "t1", path: "D:\\x\\资料" }]);
  expect(await zipCalls(page)).toEqual([]);
  await expect(editorOf(page)).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(chipNames(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("粘贴既无文字也无文件：问 Rust 剪贴板里的文件夹；纯文字粘贴不问；读不了的文件夹报错", async ({ page }) => {
  const errors = await load(page);
  // Nothing on the clipboard at all: nothing happens.
  await paste(page);
  await expect.poll(async () => (await calls(page, "clipboard_folders")).length).toBe(1);
  await expect(chipNames(page)).toHaveCount(0);
  // A folder alone, which the page does not see.
  await setClipboardFolders(page, [{ name: "照片", path: "D:\\照片" }]);
  await paste(page);
  await expect(chipNames(page)).toHaveText(["照片.zip"]);
  // Text goes in as text, without asking.
  await paste(page, [], "文字");
  expect((await calls(page, "clipboard_folders")).length).toBe(2);
  // Rust cannot read it.
  await setClipboardFolders(page, [{ name: "坏", path: "D:\\坏" }]);
  await paste(page);
  await expect(page.locator(".error-banner")).toContainText("无法插入文件夹“坏”：无法读取文件夹：拒绝访问");
  await expect(chipNames(page)).toHaveText(["照片.zip"]);
  expect(errors).toEqual([]);
});
