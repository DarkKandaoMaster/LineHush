import { test, expect } from "@playwright/test";
import {
  caretBeside,
  clickHalf,
  content,
  editorOf,
  itemBox,
  layout,
  loadSample,
  selection,
  setDoc,
  tile,
} from "./helpers";

// ---- Rows of images (2026-10-22): an image with `newline` starts a new row. ----

test("图片行：换行处左右键两步，Backspace / Delete 合并两行，Enter 拆行与插空行", async ({
  page,
}) => {
  const errors = await loadSample(page);
  // "上面" 0-4, a 4-5, b 5-6 (a new row), "下面" 6-10.
  await setDoc(page, ["上面", { id: "a" }, { id: "b", newline: true }, "下面"]);
  await expect(editorOf(page).locator(".image-row-break")).toHaveCount(1);
  // b is on the row below a, at the left edge.
  let a = await itemBox(page, 0);
  let b = await itemBox(page, 1);
  expect(b.y).toBeGreaterThan(a.y + a.height);
  expect(Math.abs(b.x - a.x)).toBeLessThan(1);
  await editorOf(page).locator("p").first().click();
  await page.keyboard.press("End");
  const stops: string[] = [];
  const classes: string[][] = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("ArrowRight");
    const sel = await selection(page);
    stops.push(`${sel.type} ${sel.head}${sel.side === undefined ? "" : ` ${sel.side}`}`);
    classes.push(await caretBeside(page));
  }
  expect(stops).toEqual([
    "blockRange 4 -1",
    "blockRange 5 -1",
    "blockRange 5 1",
    "blockRange 6 -1",
    "text 7",
  ]);
  // At the line break: after a (the end of the upper row), then before b (the start of the lower one).
  expect(classes[1]).toEqual(["after", ""]);
  expect(classes[2]).toEqual(["", "before"]);
  // Back to the start of the lower row; Backspace removes the line break.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5, side: 1 });
  await page.keyboard.press("Backspace");
  expect(await layout(page)).toEqual(["上面", "[a b]", "下面"]);
  await expect(editorOf(page).locator(".image-row-break")).toHaveCount(0);
  a = await itemBox(page, 0);
  b = await itemBox(page, 1);
  expect(Math.abs(b.y - a.y)).toBeLessThan(1);
  expect(b.x).toBeGreaterThan(a.x + a.width);
  // Enter between them: b starts a new row, the caret at its start.
  await page.keyboard.press("Enter");
  expect(await layout(page)).toEqual(["上面", "[a]", "[b]", "下面"]);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5, side: 1 });
  expect(await caretBeside(page)).toEqual(["", "before"]);
  // At the end of the upper row, Delete removes the line break too.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Delete");
  expect(await layout(page)).toEqual(["上面", "[a b]", "下面"]);
  // Enter at the start of a lower row: an empty line above it, the caret stays before b.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  expect(await layout(page)).toEqual(["上面", "[a]", "", "[b]", "下面"]);
  expect(await selection(page)).toMatchObject({ type: "blockRange", head: 7 });
  // Enter at the end of an upper row: an empty line below it with the caret in it.
  await setDoc(page, ["上面", { id: "a" }, { id: "b", newline: true }, "下面"]);
  await clickHalf(tile(page, 0), "right");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5, side: -1 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("中");
  expect(await layout(page)).toEqual(["上面", "[a]", "中", "[b]", "下面"]);
  // A click on the left half of the lower row's first image: the start of that row.
  await setDoc(page, ["上面", { id: "a" }, { id: "b", newline: true }, "下面"]);
  await clickHalf(tile(page, 1), "left");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5, side: 1 });
  // A click on the spacer between the rows: the line break, on the nearer image's side.
  const spacer = (await editorOf(page).locator(".image-row-break").boundingBox())!;
  a = await itemBox(page, 0);
  await page.mouse.click(a.x + a.width - 5, spacer.y + spacer.height / 2 - 1);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5, side: -1 });
  await page.mouse.click(a.x + 5, spacer.y + spacer.height - 1);
  expect(await selection(page)).toMatchObject({ type: "blockRange", head: 5 });
  expect(errors).toEqual([]);
});

test("图片行间距：折行 < 换行 < 空行；截图", async ({ page }) => {
  const errors = await loadSample(page);
  // Five images of 200px in a row wrap after the fourth (editor about 970px wide),
  // then a line break, then an empty line.
  await setDoc(page, [
    "同一行折行 / 换行 / 空行",
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" },
    { id: "e" },
    { id: "f", newline: true },
    "",
    { id: "g" },
    "下面",
  ]);
  const boxes = await editorOf(page)
    .locator(".image-item")
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
  const [, , , d, e, f, g] = boxes;
  // e wrapped onto a second visual row; f starts a new row; g comes after an empty line.
  expect(e.top).toBeGreaterThan(d.bottom);
  const wrap = e.top - d.bottom;
  const newline = f.top - e.bottom;
  const blank = g.top - f.bottom;
  console.log(`间隙：折行 ${wrap}px，换行 ${newline}px，空行 ${blank}px`);
  expect(wrap).toBeCloseTo(8, 0);
  expect(newline).toBeCloseTo(16, 0);
  expect(blank).toBeGreaterThan(newline + 4);
  expect(wrap).toBeLessThan(newline);
  await page.screenshot({ path: test.info().outputPath("image-rows-2026-10-22.png") });
  expect(errors).toEqual([]);
});

test("图片后的空行上插入图片：新图自成一行在图 1 下方，不补空行", async ({ page }) => {
  const errors = await loadSample(page);
  await setDoc(page, [{ id: "a" }, ""]);
  await editorOf(page).locator("p").first().click();
  // What a paste or import does (DiaryEditor's reserveInsertion), with the
  // editor's own module.
  await editorOf(page).evaluate(async (el: any) => {
    const { insertImages } = await import("/src/editor/image-view.ts");
    const { state, view } = el.editor;
    const tr = state.tr;
    insertImages(tr, [
      state.schema.nodes.image.create({ id: "b", name: "b.png", width: 200, height: 100 }),
    ]);
    view.dispatch(tr);
  });
  expect(await content(page)).toEqual(["[a]", "[b]"]);
  expect(await layout(page)).toEqual(["[a]", "[b]"]);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 2, head: 2, side: -1 });
  const a = await itemBox(page, 0);
  const b = await itemBox(page, 1);
  expect(b.y - (a.y + a.height)).toBeCloseTo(16, 0);
  expect(Math.abs(b.x - a.x)).toBeLessThan(1);
  expect(errors).toEqual([]);
});


// ---- 2026-10-28: an image is one big character for the keyboard too ----

/** "type head" for the selection, "type anchor→head" for a range. */
const where = async (page: import("@playwright/test").Page) => {
  const sel = await selection(page);
  return sel.anchor === sel.head ? `${sel.type} ${sel.head}` : `${sel.type} ${sel.anchor}→${sel.head}`;
};
/** Records every selection the editor goes through (a NodeSelection passing by too). */
const recordSelections = (page: import("@playwright/test").Page) =>
  editorOf(page).evaluate((el: any) => {
    (window as any).selections = [];
    el.editor.on("selectionUpdate", ({ editor }: any) =>
      (window as any).selections.push(editor.state.selection.toJSON().type),
    );
  });

test("Ctrl+←/→ 把图片当一个词：停在图片前后，不选中图片；Ctrl+Backspace / Delete 与不带 Ctrl 一样不删文字行旁的图片", async ({
  page,
}) => {
  const errors = await loadSample(page);
  // "上面 文字" 0-7 (text 1-6), a 7-8, b 8-9, "下面 文字" 9-16.
  await setDoc(page, ["上面 文字", { id: "a" }, { id: "b" }, "下面 文字"]);
  await recordSelections(page);
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(1));
  const stops: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Control+ArrowRight");
    stops.push(await where(page));
  }
  // The browser's word moves inside the line (to the start of the next word,
  // then the line's end), then each image is one step.
  expect(stops).toEqual(["text 4", "text 6", "blockRange 7", "blockRange 8", "blockRange 9", "text 10"]);
  const back: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Control+ArrowLeft");
    back.push(await where(page));
  }
  expect(back).toEqual(["blockRange 9", "blockRange 8", "blockRange 7", "text 6"]);
  // Ctrl+Shift+→ takes the images one by one, and the text after them by words.
  await page.keyboard.press("Control+Shift+ArrowRight");
  expect(await where(page)).toBe("blockRange 6→8");
  await page.keyboard.press("Control+Shift+ArrowRight");
  await page.keyboard.press("Control+Shift+ArrowRight");
  expect(await where(page)).toBe("text 6→10");
  await page.keyboard.press("Control+Shift+ArrowRight");
  const sel = await selection(page);
  expect(sel.anchor).toBe(6);
  expect(sel.head).toBeGreaterThan(10);
  expect(sel.head).toBeLessThanOrEqual(15);
  // From the caret before a (a range between blocks): the images, then words of
  // the text line, the anchor staying before a.
  await clickHalf(tile(page, 0), "left");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Control+Shift+ArrowRight");
  expect(await where(page)).toBe("blockRange 7→13");
  await page.keyboard.press("Control+Shift+ArrowLeft");
  expect(await where(page)).toBe("blockRange 7→10");
  // Typing after Ctrl+→ next to an image: a new line, the image stays.
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(6));
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.type("x");
  expect(await content(page)).toEqual(["上面 文字", "x", "[a]", "[b]", "下面 文字"]);
  expect(await page.evaluate(() => (window as any).selections)).not.toContain("node");
  // Ctrl+Backspace at the start of a line with text below an image, Ctrl+Delete
  // at the end of one above it: nothing (as without Ctrl).
  await setDoc(page, ["上面", { id: "a" }, "下面"]);
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(6));
  await page.keyboard.press("Control+Backspace");
  await page.keyboard.press("Shift+Backspace");
  expect(await content(page)).toEqual(["上面", "[a]", "下面"]);
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(3));
  await page.keyboard.press("Control+Delete");
  expect(await content(page)).toEqual(["上面", "[a]", "下面"]);
  // Inside a line Ctrl+Backspace deletes a word as before.
  await page.keyboard.press("Control+Backspace");
  expect((await content(page))[0]).not.toBe("上面");
  // Beside the image (the caret between blocks), Ctrl+Backspace deletes it, as Backspace does.
  await setDoc(page, ["上面", { id: "a" }, "下面"]);
  await clickHalf(tile(page, 0), "right");
  await page.keyboard.press("Control+Backspace");
  expect(await content(page)).toEqual(["上面", "下面"]);
  expect(errors).toEqual([]);
});

test("图片行上 Home / End（含 Shift）到这一视觉行的首尾，不跳进旁边的文字行；折行处 Home 画在下一折行首", async ({
  page,
}) => {
  const errors = await loadSample(page);
  // "上面" 0-4, a-e 4-9 in one row (e wraps onto a second visual line), f 9-10
  // starting a row, "下面" 10-14.
  await setDoc(page, [
    "上面",
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" },
    { id: "e" },
    { id: "f", newline: true },
    "下面",
  ]);
  const boxes = await editorOf(page)
    .locator(".image-item")
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
  expect(boxes[4]).toBeGreaterThan(boxes[3] + 50); // e wrapped
  const key = async (name: string) => {
    await page.keyboard.press(name);
    const sel = await selection(page);
    return sel.anchor === sel.head ? `${sel.head} ${sel.side}` : `${sel.anchor}→${sel.head}`;
  };
  // Between a and b: Home before a, End after d (the end of the visual line).
  await clickHalf(tile(page, 1), "left");
  expect(await key("Home")).toBe("4 1");
  expect(await caretBeside(page)).toEqual(["before", "", "", "", "", ""]);
  expect(await key("End")).toBe("8 -1");
  expect(await caretBeside(page)).toEqual(["", "", "", "after", "", ""]);
  // Shift: the anchor stays.
  await clickHalf(tile(page, 1), "right");
  expect(await key("Shift+Home")).toBe("6→4");
  expect(await key("Shift+End")).toBe("6→8");
  expect(await key("Shift+End")).toBe("6→8");
  expect(await key("Shift+Home")).toBe("6→4");
  // On the wrapped visual line: e alone. Home there is drawn at its start (before e).
  await clickHalf(tile(page, 4), "right");
  expect(await key("Home")).toBe("8 1");
  expect(await caretBeside(page)).toEqual(["", "", "", "", "before", ""]);
  expect(await key("End")).toBe("9 -1");
  expect(await caretBeside(page)).toEqual(["", "", "", "", "after", ""]);
  expect(await key("Shift+Home")).toBe("9→8");
  // The row after the line break: f.
  await clickHalf(tile(page, 5), "left");
  expect(await key("End")).toBe("10 -1");
  expect(await key("Home")).toBe("9 1");
  expect(await caretBeside(page)).toEqual(["", "", "", "", "", "before"]);
  // In a text line Home / End are the browser's.
  await editorOf(page).locator(":scope > p").last().click();
  expect(await key("Home")).toBe("11 undefined");
  expect(errors).toEqual([]);
});

test("Shift+↑/↓ 与 ↑/↓ 停在同样的地方（先停在图片旁），anchor 不漂移", async ({ page }) => {
  const errors = await loadSample(page);
  // "上面" 0-4, a 4-5, b 5-6, "下面" 6-10.
  await recordSelections(page);
  const key = async (name: string) => {
    await page.keyboard.press(name);
    return where(page);
  };
  // Before a: past both images to the start of "下面", the anchor before a.
  await clickHalf(tile(page, 0), "left");
  expect(await key("Shift+ArrowDown")).toBe("blockRange 4→7");
  await expect(editorOf(page).locator(".image-selected")).toHaveCount(2);
  expect(await key("Shift+ArrowUp")).toBe("blockRange 4→6");
  expect(await key("Shift+ArrowUp")).toBe("blockRange 4→3");
  // The head in the text line, the anchor between blocks: Shift+Home keeps the anchor.
  expect(await key("Shift+Home")).toBe("blockRange 4→1");
  // After b: up past both images to the end of "上面".
  await clickHalf(tile(page, 1), "right");
  expect(await key("Shift+ArrowUp")).toBe("blockRange 6→3");
  await expect(editorOf(page).locator(".image-selected")).toHaveCount(2);
  // The browser's own extension (Ctrl+Shift+End): the anchor stays after b,
  // though its DOM position reads back as the start of "下面".
  expect(await key("Control+Shift+End")).toBe("blockRange 6→9");
  expect(await key("Control+Shift+Home")).toBe("blockRange 6→1");
  // From the middle of "上面": first beside the images, as ↓ stops there.
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(2));
  expect(await key("Shift+ArrowDown")).toBe("blockRange 2→4");
  await expect(editorOf(page).locator(".image-selected")).toHaveCount(0);
  expect(await key("Shift+ArrowDown")).toBe("text 2→7");
  await expect(editorOf(page).locator(".image-selected")).toHaveCount(2);
  expect(await key("Shift+ArrowUp")).toBe("blockRange 2→6");
  expect(await key("Shift+ArrowUp")).toBe("text 2→3");
  // Plain ↓ from there still stops beside the images first.
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(2));
  expect(await key("ArrowDown")).toBe("blockRange 4");
  expect(await key("ArrowDown")).toBe("text 7");
  expect(await page.evaluate(() => (window as any).selections)).not.toContain("node");
  // Text lines alone: the browser's own extension.
  await setDoc(page, ["第一行", "第二行", "第三行"]);
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(2));
  expect(await key("Shift+ArrowDown")).toBe("text 2→7");
  expect(await key("Shift+ArrowDown")).toBe("text 2→12");
  expect(errors).toEqual([]);
});

test("向上选到图片行（左栏 Shift+单击、Shift+Home）时，光标画在这一行行首，不画在上一行行末", async ({ page }) => {
  const errors = await loadSample(page);
  // "上面" 0-4, a 4-5, b 5-6 (a new row), "下面" 6-10.
  await setDoc(page, ["上面", { id: "a" }, { id: "b", newline: true }, "下面"]);
  const box = (await editorOf(page).boundingBox())!;
  const b = (await tile(page, 1).boundingBox())!;
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(9));
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + 8, b.y + b.height / 2);
  await page.keyboard.up("Shift");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 9, head: 5 });
  expect(await caretBeside(page)).toEqual(["", "before"]);
  // From after b, Shift+Home: the start of b's row too.
  await clickHalf(tile(page, 1), "right");
  await page.keyboard.press("Shift+Home");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 5 });
  expect(await caretBeside(page)).toEqual(["", "before"]);
  expect(errors).toEqual([]);
});
