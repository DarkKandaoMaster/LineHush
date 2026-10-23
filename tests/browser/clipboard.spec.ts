import { test, expect, type Page } from "@playwright/test";
import {
  calls,
  clickHalf,
  editorOf,
  layout,
  loadSample,
  selection,
  setDoc,
  tile,
} from "./helpers";

// Copy, cut, paste and drag of images, alone and with text lines (2026-10-22).

test("复制 / 剪切纯图片：Ctrl+C / Ctrl+X 取消 copy 事件、浏览器不写剪贴板，交给 Rust（copy_images）", async ({
  page,
}) => {
  const errors = await loadSample(page);
  // What the copy / cut events left on the clipboard, seen after the editor's handler.
  await page.evaluate(() => {
    const w = window as any;
    w.copies = [];
    for (const type of ["copy", "cut"])
      document.addEventListener(type, (event: any) =>
        w.copies.push({
          type,
          prevented: event.defaultPrevented,
          types: Array.from(event.clipboardData?.types ?? []),
        }),
      );
  });
  // Both images (one row): from the caret before a, Shift+→ twice.
  await clickHalf(tile(page, 0), "left");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 4, head: 6 });
  await page.keyboard.press("Control+c");
  await expect.poll(() => calls(page, "copy_images")).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).copies)).toEqual([
    { type: "copy", prevented: true, types: [] },
  ]);
  const pictures = (await calls(page, "copy_images"))[0];
  expect(pictures.tab).toBe("t1");
  expect(pictures.pictures.map((p: any) => p.id)).toEqual(["a", "b"]);
  expect(pictures.rows).toEqual([false, false]);
  // A cut copies the same way and removes the images as Backspace would.
  await page.keyboard.press("Control+x");
  await expect.poll(() => calls(page, "copy_images")).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).copies.at(-1))).toEqual({
    type: "cut",
    prevented: true,
    types: [],
  });
  expect(await layout(page)).toEqual(["上面", "下面"]);
  expect(errors).toEqual([]);
});

const BLOCKS_MIME = "application/x-linehush-blocks";
// Ids as SHA-256 hashes look.
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
type Copied = { prevented: boolean; types: string[]; text: string; blocks: string };
/** A copy / cut event as the browser sends it; returns what the editor wrote. */
const clipboardEvent = (page: Page, type: "copy" | "cut") =>
  editorOf(page).evaluate((el: any, type: string): Copied => {
    const data = new DataTransfer();
    const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      types: Array.from(data.types),
      text: data.getData("text/plain"),
      blocks: data.getData("application/x-linehush-blocks"),
    };
  }, type);
/** A paste event carrying `copied`. */
const pasteEvent = (page: Page, copied: Copied) =>
  editorOf(page).evaluate((el: any, copied: Copied) => {
    const data = new DataTransfer();
    data.setData("text/plain", copied.text);
    data.setData("application/x-linehush-blocks", copied.blocks);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, copied);
const short = (rows: string[]) =>
  rows.map((row) => row.replaceAll(A, "A").replaceAll(B, "B").replaceAll(C, "C"));

test("混合复制粘贴：全选复制写纯文字与 blocks（无 HTML），同文档粘贴得到文字和图片，一步撤销", async ({
  page,
}) => {
  const errors = await loadSample(page);
  await setDoc(page, ["第一行", "第二行", { id: A }, { id: B, newline: true }, "第三行"]);
  await editorOf(page).click();
  await page.keyboard.press("Control+a");
  const copied = await clipboardEvent(page, "copy");
  expect(copied.prevented).toBe(true);
  expect(copied.types.sort()).toEqual([BLOCKS_MIME, "text/plain"].sort());
  // Other programs get the text, images as placeholders (one per row).
  expect(copied.text).toBe("第一行\n第二行\n[图片]\n[图片]\n第三行");
  expect(JSON.parse(copied.blocks).blocks.map((b: any) => b.type)).toEqual([
    "line", "line", "images", "images", "line",
  ]);
  await page.keyboard.press("Control+End");
  await pasteEvent(page, copied);
  // The first pasted line joins the line at the caret, as a plain text paste does.
  expect(short(await layout(page))).toEqual([
    "第一行", "第二行", "[A]", "[B]", "第三行第一行", "第二行", "[A]", "[B]", "第三行",
  ]);
  await expect(editorOf(page).locator(".image-item")).toHaveCount(4);
  // The caret at the end of what was pasted.
  const end = await editorOf(page).evaluate((el: any) => el.editor.state.doc.content.size - 1);
  expect(await selection(page)).toEqual({ type: "text", anchor: end, head: end });
  await page.keyboard.press("Control+z");
  expect(short(await layout(page))).toEqual(["第一行", "第二行", "[A]", "[B]", "第三行"]);
  expect(errors).toEqual([]);
});

test("混合剪切：删除保持图片行结构，粘贴回来文字与图片都在", async ({ page }) => {
  const errors = await loadSample(page);
  await setDoc(page, [{ id: A }, "t", { id: B }, { id: C }]);
  // From after A (right half) over "t" and B: a range between blocks.
  await clickHalf(tile(page, 0), "right");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 1, head: 5 });
  const cut = await clipboardEvent(page, "cut");
  expect(cut.prevented).toBe(true);
  expect(cut.text).toBe("t\n[图片]");
  // The text line went: C starts a row of its own below A.
  expect(short(await layout(page))).toEqual(["[A]", "[C]"]);
  await pasteEvent(page, cut);
  expect(short(await layout(page))).toEqual(["[A]", "t", "[B]", "[C]"]);
  await expect(editorOf(page).locator(".image-item")).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("拖动混合选区：等价于剪切后粘贴到落点，一步撤销；拖回选区内不动", async ({ page }) => {
  const errors = await loadSample(page);
  await setDoc(page, ["甲", { id: A }, "乙", "丙"]);
  const lines = editorOf(page).locator("p");
  // "甲" and the image after it.
  await lines.nth(0).click({ position: { x: 1, y: 8 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 1, head: 4 });
  const from = (await lines.nth(0).boundingBox())!;
  // Onto itself (the left half of its image): nothing changes.
  await lines.nth(0).dragTo(tile(page, 0), {
    sourcePosition: { x: 4, y: from.height / 2 },
    targetPosition: { x: 10, y: 50 },
  });
  expect(short(await layout(page))).toEqual(["甲", "[A]", "乙", "丙"]);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 1, head: 4 });
  // Playwright starts the next drag only after a click: select again.
  await lines.nth(2).click();
  await lines.nth(0).click({ position: { x: 1, y: 8 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  // To the end of "丙".
  const to = (await lines.nth(2).boundingBox())!;
  await lines.nth(0).dragTo(lines.nth(2), {
    sourcePosition: { x: 4, y: from.height / 2 },
    targetPosition: { x: to.width - 4, y: to.height / 2 },
  });
  await expect.poll(async () => short(await layout(page))).toEqual(["", "乙", "丙甲", "[A]"]);
  await page.keyboard.press("Control+z");
  expect(short(await layout(page))).toEqual(["甲", "[A]", "乙", "丙"]);
  expect(errors).toEqual([]);
});

