import { test, expect, type Locator, type Page } from "@playwright/test";

// Plain browser (no desktop): thumbnails cannot load, so tiles show their
// placeholder at the picture's size, which is all the caret needs.
const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "日记正文" });

async function load(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const editor = editorOf(page);
  await expect(editor).toBeVisible();
  await editor.evaluate((el: any) => {
    const line = (text: string) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    });
    const image = (id: string) => ({
      type: "image",
      attrs: { id, name: `${id}.png`, width: 200, height: 100 },
    });
    el.editor.commands.setContent({
      type: "doc",
      content: [line("上面"), image("a"), image("b"), line("下面")],
    });
    // Every selection the editor goes through, to catch a passing NodeSelection.
    (window as any).selections = [];
    el.editor.on("selectionUpdate", ({ editor }: any) =>
      (window as any).selections.push(editor.state.selection.toJSON().type),
    );
  });
  return errors;
}
/** Top-level lines and images, images as [id]. */
const content = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const out: string[] = [];
    el.editor.state.doc.forEach((node: any) =>
      out.push(node.type.name === "image" ? `[${node.attrs.id}]` : node.textContent),
    );
    return out;
  });
const selection = (page: Page) =>
  editorOf(page).evaluate((el: any) => el.editor.state.selection.toJSON());
const tile = (page: Page, i: number) =>
  editorOf(page).locator(".image-tile").nth(i);
async function clickHalf(target: Locator, side: "left" | "right") {
  const box = (await target.boundingBox())!;
  await target.click({
    position: { x: side === "left" ? 10 : box.width - 10, y: box.height / 2 },
  });
}
/** The caret classes on each image, e.g. ["gap-after", ""]. */
const carets = (page: Page) =>
  editorOf(page)
    .locator(".image-item")
    .evaluateAll((items) =>
      items.map((item) =>
        Array.from(item.classList)
          .filter((c) => c.startsWith("gap-"))
          .join(" "),
      ),
    );

test("单击图片左右半区：光标停在图片前 / 后，画成与图片等高的竖线，没有节点选中", async ({
  page,
}) => {
  const errors = await load(page);
  await clickHalf(tile(page, 0), "right");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5 });
  expect(await carets(page)).toEqual(["gap-after", ""]);
  await clickHalf(tile(page, 0), "left");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 4, head: 4 });
  expect(await carets(page)).toEqual(["gap-before", ""]);
  await clickHalf(tile(page, 1), "right");
  expect(await carets(page)).toEqual(["", "gap-after"]);
  // Empty space right of the row of images: the caret after its last image.
  await clickHalf(tile(page, 0), "left");
  const row = (await tile(page, 1).boundingBox())!;
  await page.mouse.click(row.x + row.width + 300, row.y + row.height / 2);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 6 });
  await expect(editorOf(page).locator(".ProseMirror-selectednode")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).selections)).not.toContain("node");
  // The caret line is drawn at the image's full height while the editor has focus.
  const drawn = await editorOf(page)
    .locator(".image-item")
    .nth(1)
    .evaluate((item) => {
      const after = getComputedStyle(item, "::after");
      return {
        display: after.display,
        height: parseFloat(after.height),
        image: item.getBoundingClientRect().height,
      };
    });
  expect(drawn.display).toBe("block");
  expect(Math.abs(drawn.height - drawn.image)).toBeLessThan(1.5);
  // The browser's own caret is hidden meanwhile.
  await expect(editorOf(page)).toHaveClass(/ProseMirror-hideselection/);
  // A double click keeps the caret where the first click put it.
  await tile(page, 0).dblclick({ position: { x: 190, y: 50 } });
  expect((await selection(page)).type).toBe("blockRange");
  await expect(editorOf(page).locator(".ProseMirror-selectednode")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("块间光标处打字：文字落到新起的一行；Enter 插入空行", async ({ page }) => {
  const errors = await load(page);
  // Keypresses (ProseMirror's keypress path).
  await clickHalf(tile(page, 0), "right");
  await page.keyboard.type("中间");
  expect(await content(page)).toEqual(["上面", "[a]", "中间", "[b]", "下面"]);
  await page.keyboard.type("行");
  expect(await content(page)).toEqual(["上面", "[a]", "中间行", "[b]", "下面"]);
  // Text without a keypress (beforeinput insertText), before an image below a line.
  await clickHalf(tile(page, 1), "left");
  await page.keyboard.insertText("插入");
  expect(await content(page)).toEqual([
    "上面",
    "[a]",
    "中间行",
    "插入",
    "[b]",
    "下面",
  ]);
  // A composition, as Chrome's input method events (not a real input method).
  await clickHalf(tile(page, 1), "right");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "ni",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await cdp.send("Input.imeSetComposition", {
    text: "nihao",
    selectionStart: 5,
    selectionEnd: 5,
  });
  await cdp.send("Input.insertText", { text: "你好" });
  await expect
    .poll(() => content(page))
    .toEqual(["上面", "[a]", "中间行", "插入", "[b]", "你好", "下面"]);
  // Enter at the caret between blocks: an empty line, the caret in it.
  await clickHalf(tile(page, 0), "left");
  await page.keyboard.press("Enter");
  await page.keyboard.type("空");
  expect((await content(page)).slice(0, 3)).toEqual(["上面", "空", "[a]"]);
  expect(errors).toEqual([]);
});

test("左右键逐停靠点移动，Backspace / Delete 规则，Shift+左右选中图片显示蒙层", async ({
  page,
}) => {
  const errors = await load(page);
  await editorOf(page).locator("p").first().click();
  await page.keyboard.press("End");
  const stops: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("ArrowRight");
    const sel = await selection(page);
    stops.push(`${sel.type} ${sel.head}`);
  }
  expect(stops).toEqual(["blockRange 4", "blockRange 5", "blockRange 6", "text 7"]);
  // Backspace at the start of a line with text below an image: nothing.
  await page.keyboard.press("Backspace");
  expect(await content(page)).toEqual(["上面", "[a]", "[b]", "下面"]);
  expect((await selection(page)).head).toBe(7);
  // An empty line there goes, and the caret stays after the image.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  expect(await content(page)).toEqual(["上面", "[a]", "[b]", "", "下面"]);
  await page.keyboard.press("Backspace");
  expect(await content(page)).toEqual(["上面", "[a]", "[b]", "下面"]);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 6 });
  expect(await carets(page)).toEqual(["", "gap-after"]);
  await page.screenshot({ path: "test-results/playwright/caret-after-image.png" });
  // Delete at the end of a line with text above an image: nothing.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await selection(page)).toMatchObject({ type: "text", head: 3 });
  await page.keyboard.press("Delete");
  expect(await content(page)).toEqual(["上面", "[a]", "[b]", "下面"]);
  // Shift+Right from the caret selects the image: a translucent layer, no frame.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(editorOf(page).locator(".image-selected")).toHaveCount(1);
  await page.screenshot({ path: "test-results/playwright/image-selected.png" });
  const look = await tile(page, 0).evaluate((el) => {
    const layer = getComputedStyle(el, "::after");
    return {
      background: layer.backgroundColor,
      outline: getComputedStyle(el.parentElement!).outlineStyle,
    };
  });
  expect(look).toEqual({ background: "rgba(183, 217, 248, 0.5)", outline: "none" });
  // Delete removes the selected image; Backspace at a caret after an image removes it.
  await page.keyboard.press("Delete");
  expect(await content(page)).toEqual(["上面", "[b]", "下面"]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Backspace");
  expect(await content(page)).toEqual(["上面", "下面"]);
  await page.screenshot({ path: "test-results/playwright/caret.png" });
  expect(errors).toEqual([]);
});

test("文档以图片结尾：点图片下方空白，光标停在最后一张图后，打字起新行", async ({
  page,
}) => {
  const errors = await load(page);
  await editorOf(page).evaluate((el: any) => {
    const { state, view } = el.editor;
    view.dispatch(state.tr.delete(6, state.doc.content.size));
    // The deletion itself may map the old caret onto the last image.
    (window as any).selections = [];
  });
  expect(await content(page)).toEqual(["上面", "[a]", "[b]"]);
  const last = (await tile(page, 1).boundingBox())!;
  await page.mouse.click(last.x + 50, last.y + last.height + 80);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 6 });
  expect(await page.evaluate(() => (window as any).selections)).not.toContain("node");
  await page.keyboard.type("末尾");
  expect(await content(page)).toEqual(["上面", "[a]", "[b]", "末尾"]);
  expect(errors).toEqual([]);
});

test("拖动图片仍按左右半区落位", async ({ page }) => {
  const errors = await load(page);
  const target = (await tile(page, 1).boundingBox())!;
  await tile(page, 0).dragTo(tile(page, 1), {
    targetPosition: { x: target.width - 10, y: target.height / 2 },
  });
  await expect.poll(() => content(page)).toEqual(["上面", "[b]", "[a]", "下面"]);
  expect(errors).toEqual([]);
});
