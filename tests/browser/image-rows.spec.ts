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

