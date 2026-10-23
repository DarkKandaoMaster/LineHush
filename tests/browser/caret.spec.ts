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
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5, side: -1 });
  expect(await carets(page)).toEqual(["gap-after", ""]);
  await clickHalf(tile(page, 0), "left");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 4, head: 4, side: 1 });
  expect(await carets(page)).toEqual(["gap-before", ""]);
  await clickHalf(tile(page, 1), "right");
  expect(await carets(page)).toEqual(["", "gap-after"]);
  // Empty space right of the row of images: the caret after its last image.
  await clickHalf(tile(page, 0), "left");
  const row = (await tile(page, 1).boundingBox())!;
  await page.mouse.click(row.x + row.width + 300, row.y + row.height / 2);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 6, side: -1 });
  await expect(editorOf(page).locator(".ProseMirror-selectednode")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).selections)).not.toContain("node");
  // The caret line is drawn (by caret.ts) at the image's full height while
  // the editor has focus, in the middle of the 8px gap after the image.
  const drawn = await editorOf(page)
    .locator(".image-item")
    .nth(1)
    .evaluate((item) => {
      const caret = item.closest(".tiptap")!.parentElement!.querySelector(".editor-caret")!;
      const c = caret.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      return {
        display: getComputedStyle(caret).display,
        height: c.height,
        image: r.height,
        middle: (c.left + c.right) / 2 - r.right,
      };
    });
  expect(drawn.display).toBe("block");
  expect(Math.abs(drawn.height - drawn.image)).toBeLessThan(1.5);
  expect(Math.abs(drawn.middle - 4)).toBeLessThan(1);
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
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 6, side: -1 });
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
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 6, side: -1 });
  expect(await page.evaluate(() => (window as any).selections)).not.toContain("node");
  await page.keyboard.type("末尾");
  expect(await content(page)).toEqual(["上面", "[a]", "[b]", "末尾"]);
  expect(errors).toEqual([]);
});

test("鼠标拖选文字与图片：拖到图片上按左右半区、拖过文档末尾的图片都能选中图片", async ({
  page,
}) => {
  const errors = await load(page);
  // "文本1" 0-5, then the image as the document's last node (no empty line after it).
  const reset = (nodes: string[]) =>
    editorOf(page).evaluate((el: any, nodes: string[]) => {
      el.editor.commands.setContent({
        type: "doc",
        content: nodes.map((n) =>
          n === "[a]"
            ? { type: "image", attrs: { id: "a", name: "a.png", width: 200, height: 100 } }
            : { type: "paragraph", content: [{ type: "text", text: n }] },
        ),
      });
      (window as any).drags = 0;
      el.addEventListener("dragstart", () => (window as any).drags++);
    }, nodes);
  type Point = { x: number; y: number };
  async function drag(from: Point, to: Point) {
    // A press inside the previous range would drag that range as content, so
    // a click far below first leaves a caret (not where the drag starts, which
    // would make the press a double click).
    const box = (await editorOf(page).boundingBox())!;
    await page.mouse.click(box.x + 300, box.y + box.height - 20);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++)
      await page.mouse.move(
        from.x + ((to.x - from.x) * i) / 10,
        from.y + ((to.y - from.y) * i) / 10,
      );
    await page.mouse.up();
  }
  const line = async (at: "start" | "end") => {
    const box = (await editorOf(page).locator("p").first().boundingBox())!;
    return { x: box.x + (at === "start" ? 2 : 40), y: box.y + box.height / 2 };
  };
  const onImage = async (side: "left" | "right") => {
    const box = (await tile(page, 0).boundingBox())!;
    return {
      x: box.x + (side === "left" ? 10 : box.width - 10),
      y: box.y + box.height / 2,
    };
  };
  const belowImage = async () => {
    const box = (await tile(page, 0).boundingBox())!;
    return { x: box.x + 50, y: box.y + box.height + 80 };
  };
  const selected = () => editorOf(page).locator(".image-selected");

  await reset(["文本1", "[a]"]);
  // The caret after the image, as in the report.
  const below = await belowImage();
  await page.mouse.click(below.x, below.y);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 6, side: -1 });
  // Past the end of the document, below the image.
  await drag(await line("start"), await belowImage());
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 1, head: 6 });
  await expect(selected()).toHaveCount(1);
  // Onto the image: its right half takes it, its left half stops before it.
  await drag(await line("start"), await onImage("right"));
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 1, head: 6 });
  await expect(selected()).toHaveCount(1);
  await drag(await line("start"), await onImage("left"));
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 1, head: 5 });
  await expect(selected()).toHaveCount(0);
  // Backwards, from below the image to the text.
  await drag(await belowImage(), await line("start"));
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 1 });
  await expect(selected()).toHaveCount(1);
  // Mirrored: the image starts the document. Up onto its left half takes it.
  await reset(["[a]", "文本1"]);
  await drag(await line("end"), await onImage("left"));
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 0 });
  await expect(selected()).toHaveCount(1);
  await drag(await line("end"), await onImage("right"));
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 1 });
  await expect(selected()).toHaveCount(0);
  // The range is the editor's; the browser never turned the drag into dragging content.
  expect(await page.evaluate(() => (window as any).drags)).toBe(0);
  // The DOM selection catches up on mouseup: copying / deleting acts on the range.
  await drag(await line("end"), await onImage("left"));
  await page.keyboard.press("Delete");
  expect(await content(page)).toEqual([""]);
  expect(errors).toEqual([]);
});

test("拖选经过图片：松开鼠标之前文字高亮（DOM 选区）就与编辑器选区一致，松开后不变", async ({
  page,
}) => {
  const errors = await load(page);
  await page.evaluate(() => {
    (window as any).drags = 0;
    document.addEventListener("dragstart", () => (window as any).drags++);
  });
  // Tiles show a real picture, as in the app: over an <img> the browser's own
  // end of a drag selection jumps back to the press.
  const reset = async (nodes: string[]) => {
    await editorOf(page).evaluate((el: any, nodes: string[]) => {
      el.editor.commands.setContent({
        type: "doc",
        content: nodes.map((n) =>
          n === "[a]"
            ? { type: "image", attrs: { id: "a", name: "a.png", width: 200, height: 100 } }
            : { type: "paragraph", content: [{ type: "text", text: n }] },
        ),
      });
    }, nodes);
    // The tile shows its placeholder (no desktop), or the picture put in
    // before when the same image was kept.
    await expect(
      editorOf(page).locator(".image-error, .image-tile img.test-picture"),
    ).toHaveCount(1);
    await editorOf(page).evaluate((el: any) => {
      if (el.querySelector(".test-picture")) return;
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 100;
      canvas.getContext("2d")!.fillRect(0, 0, 200, 100);
      const tile = el.querySelector(".image-tile");
      tile.classList.remove("image-error");
      tile.textContent = "";
      const img = document.createElement("img");
      img.className = "test-picture";
      img.draggable = false;
      img.src = canvas.toDataURL();
      tile.append(img);
    });
  };
  /** The editor's selection and the DOM's, after the next frame is drawn. */
  const both = () =>
    editorOf(page).evaluate(async (el: any) => {
      await new Promise((done) => requestAnimationFrame(() => setTimeout(done)));
      const view = el.editor.view;
      const dom = getSelection()!;
      const { anchor, head } = view.state.selection;
      return {
        state: [anchor, head],
        dom: [
          view.posAtDOM(dom.anchorNode, dom.anchorOffset),
          view.posAtDOM(dom.focusNode, dom.focusOffset),
        ],
        // The whole text "文本1" is highlighted.
        text: dom.containsNode(el.querySelector("p").firstChild, false),
        // The editor draws the selection itself (caret.ts) from its state.
        drawn: !!el.parentElement.querySelector(".selection-layer path").getAttribute("d"),
      };
    });
  type Point = { x: number; y: number };
  const point = async (at: string): Promise<Point> => {
    const line = (await editorOf(page).locator("p").first().boundingBox())!;
    const image = (await tile(page, 0).boundingBox())!;
    const y = image.y + image.height / 2;
    if (at === "start") return { x: line.x + 2, y: line.y + line.height / 2 };
    if (at === "end") return { x: line.x + 40, y: line.y + line.height / 2 };
    if (at === "left") return { x: image.x + 10, y };
    if (at === "right") return { x: image.x + image.width - 10, y };
    return { x: image.x + 50, y: image.y + image.height + 80 }; // below
  };
  /** Presses at the first point and moves through the others; returns before releasing. */
  async function press(...stops: string[]) {
    const box = (await editorOf(page).boundingBox())!;
    await page.mouse.click(box.x + 300, box.y + box.height - 20);
    let from = await point(stops[0]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (const stop of stops.slice(1)) {
      const to = await point(stop);
      for (let i = 1; i <= 8; i++)
        await page.mouse.move(
          from.x + ((to.x - from.x) * i) / 8,
          from.y + ((to.y - from.y) * i) / 8,
        );
      from = to;
    }
    // Small moves over the same spot keep the selection where it is.
    await page.mouse.move(from.x - 3, from.y + 2);
    await page.mouse.move(from.x - 1, from.y - 2);
  }
  async function expectDrag(nodes: string[], stops: string[], range: number[], text = true) {
    await reset(nodes);
    await press(...stops);
    const during = await both();
    expect(during, stops.join(" → ")).toEqual({ state: range, dom: range, text, drawn: true });
    await page.mouse.up();
    expect(await both(), stops.join(" → ") + "（松开后）").toEqual(during);
  }
  // "文本1" 0-5, the image 5-6 as the document's last node.
  await expectDrag(["文本1", "[a]"], ["start", "right"], [1, 6]);
  await expectDrag(["文本1", "[a]"], ["start", "left"], [1, 5]);
  // Over the image's left half, then below it: past the end of the document.
  await expectDrag(["文本1", "[a]"], ["start", "left", "below"], [1, 6]);
  // Over the image and back into the text: the browser's own selection again.
  await expectDrag(["文本1", "[a]"], ["start", "right", "end"], [1, 4]);
  await expect(editorOf(page).locator(".image-selected")).toHaveCount(0);
  // Mirrored: the image 0-1 starts the document, "文本1" 1-6.
  await expectDrag(["[a]", "文本1"], ["end", "left"], [5, 0]);
  await expectDrag(["[a]", "文本1"], ["end", "right"], [5, 1]);
  expect(await page.evaluate(() => (window as any).drags)).toBe(0);
  expect(errors).toEqual([]);
});

test("拖选越出窗口左 / 右边框：图片行旁按单击的几何规则定端点，与夹到编辑区边缘相同；再向上到文字照常", async ({
  page,
}) => {
  const errors = await load(page);
  // "文本" 0-4, images a 4-5 and b 5-6 in one row, b the document's last node.
  await editorOf(page).evaluate((el: any) => {
    const image = (id: string) => ({
      type: "image",
      attrs: { id, name: `${id}.png`, width: 200, height: 100 },
    });
    el.editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "文本" }] }, image("a"), image("b")],
    });
  });
  const editor = (await editorOf(page).boundingBox())!;
  const a = (await tile(page, 0).boundingBox())!;
  const b = (await tile(page, 1).boundingBox())!;
  const line = (await editorOf(page).locator("p").first().boundingBox())!;
  const row = a.y + a.height / 2;
  const text = line.y + line.height / 2;
  const width = page.viewportSize()!.width;
  /** The editor's selection and the DOM's, after the next frame is drawn. */
  const both = () =>
    editorOf(page).evaluate(async (el: any) => {
      await new Promise((done) => requestAnimationFrame(() => setTimeout(done)));
      const view = el.editor.view;
      const dom = getSelection()!;
      const { anchor, head } = view.state.selection;
      return {
        state: [anchor, head],
        dom: [
          view.posAtDOM(dom.anchorNode, dom.anchorOffset),
          view.posAtDOM(dom.focusNode, dom.focusOffset),
        ],
        images: el.querySelectorAll(".image-selected").length,
      };
    });
  let at = { x: 0, y: 0 };
  async function moveTo(x: number, y: number) {
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(at.x + ((x - at.x) * i) / 8, at.y + ((y - at.y) * i) / 8);
    at = { x, y };
  }
  async function step(x: number, y: number, range: number[], images: number, label: string) {
    await moveTo(x, y);
    expect(await both(), label).toEqual({ state: range, dom: range, images });
  }
  // Pressed beside the row after b (the caret after image 2, put there by a
  // click far below first), dragged left.
  await page.mouse.click(editor.x + 300, editor.y + editor.height - 20);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 6, head: 6, side: -1 });
  at = { x: b.x + b.width + 40, y: row };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  // 1. Past the empty space left of image 1, still in the window: both images.
  await step(editor.x + 8, row, [6, 4], 2, "图片 1 左侧空白");
  // 2. Out of the window's left edge: still both (the browser alone took the
  //    position after image 1, leaving only image 2).
  await step(-50, row, [6, 4], 2, "越出左边框");
  await step(-50, a.y + a.height - 5, [6, 4], 2, "越出左边框，图片行下部");
  // 3. Up to the text line: the text too.
  await step(-50, text, [6, 1], 2, "越出左边框后向上到文字");
  await page.mouse.up();
  expect(await both(), "松开后").toEqual({ state: [6, 1], dom: [6, 1], images: 2 });

  // Mirrored: pressed left of image 1 (the browser's own anchor would be after
  // it), dragged right out of the window, then up to the text line.
  await page.mouse.click(editor.x + 300, editor.y + editor.height - 20);
  at = { x: editor.x + 8, y: row };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await step(b.x + b.width + 60, row, [4, 6], 2, "图片 2 右侧空白");
  await step(width + 50, row, [4, 6], 2, "越出右边框");
  await step(width + 50, text, [4, 3], 0, "越出右边框后向上到文字");
  await page.mouse.up();
  expect(await both(), "松开后").toEqual({ state: [4, 3], dom: [4, 3], images: 0 });
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

// ---- Rows of images (2026-10-22): an image with `newline` starts a new row. ----

type Item = string | { id: string; newline?: boolean; width?: number; height?: number };
/** Strings are text lines; images as { id, newline }. */
async function setDoc(page: Page, items: Item[]) {
  await editorOf(page).evaluate((el: any, items: Item[]) => {
    el.editor.commands.setContent({
      type: "doc",
      content: items.map((item) =>
        typeof item === "string"
          ? { type: "paragraph", content: item ? [{ type: "text", text: item }] : [] }
          : {
              type: "image",
              attrs: {
                id: item.id,
                name: `${item.id}.png`,
                width: item.width ?? 200,
                height: item.height ?? 100,
                newline: !!item.newline,
              },
            },
      ),
    });
  }, items);
}
/** Lines as text, each row of images as "[a b]". */
const layout = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const out: string[] = [];
    let image = false;
    el.editor.state.doc.forEach((node: any) => {
      if (node.type.name !== "image") {
        out.push(node.textContent);
        image = false;
        return;
      }
      if (image && !node.attrs.newline)
        out[out.length - 1] = `${out[out.length - 1].slice(0, -1)} ${node.attrs.id}]`;
      else out.push(`[${node.attrs.id}]`);
      image = true;
    });
    return out;
  });
const itemBox = async (page: Page, i: number) =>
  (await editorOf(page).locator(".image-item").nth(i).boundingBox())!;

test("图片行：换行处左右键两步，Backspace / Delete 合并两行，Enter 拆行与插空行", async ({
  page,
}) => {
  const errors = await load(page);
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
    classes.push(await carets(page));
  }
  expect(stops).toEqual([
    "blockRange 4 -1",
    "blockRange 5 -1",
    "blockRange 5 1",
    "blockRange 6 -1",
    "text 7",
  ]);
  // At the line break: after a (the end of the upper row), then before b (the start of the lower one).
  expect(classes[1]).toEqual(["gap-after", ""]);
  expect(classes[2]).toEqual(["", "gap-before"]);
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
  expect(await carets(page)).toEqual(["", "gap-before"]);
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
  const errors = await load(page);
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
  await page.screenshot({ path: "test-results/image-rows-2026-10-22.png" });
  expect(errors).toEqual([]);
});

test("图片后的空行上插入图片：新图自成一行在图 1 下方，不补空行", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, [{ id: "a" }, ""]);
  await editorOf(page).locator("p").first().click();
  // What a paste or import does (DiaryEditor's reserveInsertion), with the
  // editor's own module: the plain browser cannot read pictures from Rust.
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
  // Copied rows go through the clipboard HTML and come back in the same rows.
  const copied = await editorOf(page).evaluate(async () => {
    const { imagesHtml, clipboardImages } = await import("/src/editor/image-view.ts");
    const id = (c: string) => c.repeat(64);
    const pics = ["a", "b", "c"].map((c) => ({ id: id(c), name: `${c}.png`, width: 2, height: 1 }));
    return clipboardImages(imagesHtml(pics, [false, true, false]));
  });
  expect(copied!.rows).toEqual([false, true, false]);
  expect(copied!.pictures.map((p: any) => p.name)).toEqual(["a.png", "b.png", "c.png"]);
  expect(errors).toEqual([]);
});

test("选中换行：选区在行末多出半个字宽，空行同样，行高不变，收起后消失", async ({
  page,
}) => {
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
    el.editor.commands.setContent({ type: "doc", content: [line("我"), line(""), line("你")] });
    el.editor.commands.focus();
    el.editor.commands.setTextSelection(2); // after "我"
  });
  /**
   * Per line: whether the drawn selection (caret.ts) covers the points a
   * quarter and three quarters of a character after the line's text, at its
   * middle and near its top and bottom.
   */
  const lines = () =>
    editor.evaluate((el: any) => {
      const layer = el.parentElement.querySelector(".selection-layer");
      const origin = layer.getBoundingClientRect();
      const path = layer.querySelector("path");
      const filled = (x: number, y: number) => {
        const point = layer.createSVGPoint();
        point.x = x - origin.left;
        point.y = y - origin.top;
        return !!path.getAttribute("d") && path.isPointInFill(point);
      };
      return Array.from(el.querySelectorAll(":scope > p")).map((p: any) => {
        const box = p.getBoundingClientRect();
        const em = parseFloat(getComputedStyle(p).fontSize);
        const range = document.createRange();
        range.selectNodeContents(p);
        const end = p.textContent ? range.getBoundingClientRect().right : box.left;
        const middle = (box.top + box.bottom) / 2;
        return {
          selected: p.classList.contains("newline-selected"),
          height: box.height,
          half: filled(end + em / 4, middle),
          beyond: filled(end + (em * 3) / 4, middle),
          full: filled(end + em / 4, box.top + 1) && filled(end + em / 4, box.bottom - 1),
        };
      });
    });
  const before = await lines();
  expect(before.map((l) => l.selected)).toEqual([false, false, false]);
  expect(before.some((l) => l.half)).toBe(false);

  // "我|" + Shift+→: the selection is just the line break of the first line,
  // half a character wide, the line's full height.
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 4 });
  let now = await lines();
  expect(now.map((l) => l.selected)).toEqual([true, false, false]);
  expect(now.map((l) => l.half)).toEqual([true, false, false]);
  expect(now[0].beyond).toBe(false);
  expect(now[0].full).toBe(true);
  expect(now.map((l) => l.height)).toEqual(before.map((l) => l.height));

  // Across the empty line too: half a character at its start.
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 6 });
  now = await lines();
  expect(now.map((l) => l.selected)).toEqual([true, true, false]);
  expect(now.map((l) => l.half)).toEqual([true, true, false]);
  expect(now[1].beyond).toBe(false);
  expect(now[1].full).toBe(true);
  expect(now.map((l) => l.height)).toEqual(before.map((l) => l.height));

  // Select all: the last line has no line break after it.
  await page.keyboard.press("Control+a");
  now = await lines();
  expect(now.map((l) => l.selected)).toEqual([true, true, false]);
  expect(now.map((l) => l.half)).toEqual([true, true, false]);

  // Collapsing the selection removes the shape.
  await page.keyboard.press("ArrowRight");
  now = await lines();
  expect(now.map((l) => l.selected)).toEqual([false, false, false]);
  expect(now.some((l) => l.half)).toBe(false);
  expect(now.map((l) => l.height)).toEqual(before.map((l) => l.height));
  expect(errors).toEqual([]);
});

// ---- Images with text lines on the clipboard (2026-10-22). ----

const BLOCKS_MIME = "application/x-linehush-blocks";
// Pasting checks for SHA-256 ids.
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
  const errors = await load(page);
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
  const errors = await load(page);
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
  const errors = await load(page);
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

// ---- Scrolling to the caret: the safe zone, fast repeated keys, PageUp / PageDown (2026-10-22). ----

const LONG = (k: number) => `长段落${k}：` + "今天天气很好，我们去公园散步，看到很多花。".repeat(5);
type Spec = ["t", string] | ["i", number, number, boolean?];
// 40 blocks: short, wrapping and empty text lines, images of three sizes
// (shown 200×100, 267×200, 60×200), runs of two to five, some rows after a
// line break (true).
const LONG_DOC: Spec[] = [
  ["t", "开头第一行"], ["t", LONG(1)], ["i", 200, 100], ["i", 320, 240], ["i", 120, 400],
  ["t", "图后文字"], ["t", ""], ["i", 320, 240], ["i", 200, 100, true], ["t", LONG(2)],
  ["t", ""], ["t", ""], ["i", 120, 400], ["t", "短行"], ["i", 200, 100],
  ["i", 200, 100], ["i", 320, 240, true], ["i", 120, 400], ["t", LONG(3)], ["i", 320, 240],
  ["t", ""], ["i", 200, 100], ["i", 120, 400, true], ["i", 320, 240, true], ["t", "短行二"],
  ["t", LONG(4)], ["i", 120, 400], ["i", 120, 400], ["i", 320, 240], ["i", 200, 100],
  ["i", 320, 240], ["t", ""], ["t", LONG(5)], ["i", 200, 100], ["t", "短行三"],
  ["i", 320, 240], ["i", 120, 400, true], ["t", "倒数第二行"], ["i", 200, 100], ["i", 320, 240],
];

/** One step: coordinates relative to the editor host's visible top. */
type Snap = {
  sel: any;
  stop: boolean;
  scrollTop: number;
  maxScroll: number;
  clientHeight: number;
  lineHeight: number;
  padding: number;
  /** The caret as drawn: the DOM selection in text, the image a caret between blocks is drawn on. */
  box: { top: number; bottom: number; how: string } | null;
};

/**
 * Loads LONG_DOC and installs `window.snap()` and a log (`window.log`) of
 * every scroll position and selection the editor goes through.
 */
async function loadLong(page: Page) {
  const errors = await load(page);
  await editorOf(page).evaluate((el: any, layout: Spec[]) => {
    let n = 0;
    const content = layout.map((s) => {
      if (s[0] === "t") return { type: "paragraph", content: s[1] ? [{ type: "text", text: s[1] }] : [] };
      n++;
      return { type: "image", attrs: { id: n.toString(16).padStart(64, "0"), name: `p${n}.png`, width: s[1], height: s[2], newline: !!s[3] } };
    });
    el.editor.commands.setContent({ type: "doc", content });
    const view = el.editor.view;
    const host: HTMLElement = el.closest(".editor-host");
    const w = window as any;
    // The line height (line-height: normal): the height of the first text line.
    const lh = (el.querySelector("p") as HTMLElement).getBoundingClientRect().height;
    const stopAt = (sel: any) => {
      const $h = sel.$head;
      const type = sel.toJSON().type;
      if ($h.parent.inlineContent) return type === "text";
      const img = (node: any) => node?.type.name === "image";
      return type === "blockRange" && (img($h.nodeBefore) || img($h.nodeAfter));
    };
    w.snap = () => {
      const sel = view.state.selection;
      const hr = host.getBoundingClientRect();
      const rel = (r: DOMRect, how: string) => ({ top: r.top - hr.top, bottom: r.bottom - hr.top, how });
      let box = null;
      const item = el.querySelector(".image-item.gap-before, .image-item.gap-after");
      if (sel.toJSON().type === "blockRange" && sel.empty && item) box = rel(item.getBoundingClientRect(), "image");
      else {
        const ds = getSelection()!;
        if (ds.rangeCount) {
          const rects = Array.from(ds.getRangeAt(0).getClientRects());
          if (rects.length) box = rel(rects[rects.length - 1], "range");
          else {
            // An empty line: no caret rectangle; its line box.
            const f: any = ds.focusNode;
            const line = f?.nodeType === 1 ? f.closest("p") : f?.parentElement?.closest("p");
            if (line) box = rel(line.getBoundingClientRect(), "empty line");
          }
        }
      }
      return {
        sel: sel.toJSON(),
        stop: stopAt(sel),
        scrollTop: host.scrollTop,
        maxScroll: host.scrollHeight - host.clientHeight,
        clientHeight: host.clientHeight,
        lineHeight: lh,
        padding: Math.min(5 * lh, host.clientHeight / 2),
        box,
      };
    };
    w.log = [];
    host.addEventListener("scroll", () => w.log.push({ scroll: host.scrollTop }));
    el.editor.on("transaction", ({ transaction }: any) => {
      const sel = transaction.selection;
      w.log.push({ sel: sel.toJSON(), stop: stopAt(sel) });
    });
  }, LONG_DOC);
  return errors;
}
const snap = (page: Page): Promise<Snap> => page.evaluate(() => (window as any).snap());
const frames = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Puts the caret at the document's start (or end) with the host scrolled there. */
async function caretToEdge(page: Page, end: boolean) {
  await editorOf(page).evaluate((el: any, end: boolean) => {
    el.editor.commands.focus(end ? "end" : "start");
    const host = el.closest(".editor-host");
    host.scrollTop = end ? host.scrollHeight : 0;
  }, end);
  await frames(page);
  await page.evaluate(() => ((window as any).log = []));
}
/**
 * Where `s` breaks the safe zone, unless the scroll range does not allow it:
 * near the document's start the caret cannot have the zone above it (scrollTop
 * is already 0); near its end it always can (the 40vh bottom padding), so that
 * exemption only covers a scroll range ending early.
 */
function safeZoneMiss(s: Snap) {
  const out: string[] = [];
  if (!s.box) return ["no caret box"];
  const tol = 1;
  if (s.box.top < s.padding - tol && s.scrollTop > tol) out.push(`top ${s.box.top.toFixed(2)} < ${s.padding.toFixed(2)}`);
  if (s.box.bottom > s.clientHeight - s.padding + tol && s.scrollTop < s.maxScroll - tol)
    out.push(`bottom ${s.box.bottom.toFixed(2)} > ${(s.clientHeight - s.padding).toFixed(2)}`);
  return out;
}
const exempt = (s: Snap) =>
  !!s.box &&
  ((s.box.top < s.padding - 1 && s.scrollTop <= 1) ||
    (s.box.bottom > s.clientHeight - s.padding + 1 && s.scrollTop >= s.maxScroll - 1));

/** Walks with the key, two frames after each press, checking every step. */
async function walk(page: Page, key: "ArrowRight" | "ArrowLeft") {
  const dir = key === "ArrowRight" ? 1 : -1;
  const problems: string[] = [];
  const exempted: string[] = [];
  let prev = await snap(page);
  let same = 0;
  let steps = 0;
  for (let i = 1; i <= 2000 && same < 3; i++) {
    await page.keyboard.press(key);
    await frames(page);
    const s = await snap(page);
    steps = i;
    const where = `step ${i} ${JSON.stringify(s.sel)}`;
    if (!s.stop) problems.push(`${where}: not a caret stop`);
    if (dir * (s.scrollTop - prev.scrollTop) < -0.5) problems.push(`${where}: scrollTop ${prev.scrollTop} -> ${s.scrollTop}`);
    for (const miss of safeZoneMiss(s)) problems.push(`${where}: ${miss}`);
    if (exempt(s)) exempted.push(`${i}:${s.sel.head}`);
    same = JSON.stringify(prev.sel) === JSON.stringify(s.sel) ? same + 1 : 0;
    prev = s;
  }
  return { problems, steps, exempted, last: prev };
}

/**
 * Key presses as fast as the page takes them (auto-repeat): keydowns sent
 * through CDP `count` at a time, nothing awaited in between.
 */
async function burst(page: Page, key: "ArrowRight" | "ArrowLeft", total: number, count: number) {
  const client = await page.context().newCDPSession(page);
  const code = key === "ArrowRight" ? 39 : 37;
  const event = (type: string) =>
    client.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code } as any);
  for (let i = 0; i < total; i += count)
    await Promise.all(Array.from({ length: count }, () => event("rawKeyDown")));
  await event("keyUp");
  await frames(page);
  await page.waitForTimeout(50);
  await frames(page);
}
const pageLog = (page: Page) => page.evaluate(() => (window as any).log as any[]);
/** Scroll positions going against `dir`, and selections that are not caret stops. */
function logProblems(log: any[], dir: 1 | -1, start: number) {
  const problems: string[] = [];
  let last = start;
  for (const entry of log) {
    if ("scroll" in entry) {
      if (dir * (entry.scroll - last) < -0.5) problems.push(`scrollTop ${last} -> ${entry.scroll}`);
      last = entry.scroll;
    } else if (!entry.stop) problems.push(`not a caret stop: ${JSON.stringify(entry.sel)}`);
  }
  return problems;
}

test.describe("滚动：安全区与连按", () => {
  test.setTimeout(300_000);

  test("→ 从开头走到末尾：scrollTop 单调不减，每一步光标在安全区内、停在停靠点；连按（不等帧）同样", async ({ page }) => {
    const errors = await loadLong(page);
    await caretToEdge(page, false);
    const result = await walk(page, "ArrowRight");
    expect(result.problems).toEqual([]);
    const size = await editorOf(page).evaluate((el: any) => el.editor.state.doc.content.size);
    expect(result.last.sel).toEqual({ type: "blockRange", anchor: size, head: size, side: -1 });
    test.info().annotations.push({
      type: "→ 逐步",
      description: `${result.steps} 步；滚动范围不允许、安全区豁免的步（步:head）${result.exempted.join(" ")}`,
    });
    // Back to the start, then the same walk with keys back to back.
    await caretToEdge(page, false);
    await burst(page, "ArrowRight", 720, 3);
    expect(logProblems(await pageLog(page), 1, 0)).toEqual([]);
    const s = await snap(page);
    expect(s.sel).toEqual({ type: "blockRange", anchor: size, head: size, side: -1 });
    expect(safeZoneMiss(s)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("← 从末尾走回开头：scrollTop 单调不增，对称；连按同样", async ({ page }) => {
    const errors = await loadLong(page);
    await caretToEdge(page, true);
    const start = await snap(page);
    const result = await walk(page, "ArrowLeft");
    expect(result.problems).toEqual([]);
    expect(result.last.sel).toEqual({ type: "text", anchor: 1, head: 1 });
    expect(result.last.scrollTop).toBe(0);
    test.info().annotations.push({
      type: "← 逐步",
      description: `${result.steps} 步；豁免的步（步:head）${result.exempted.join(" ")}`,
    });
    await caretToEdge(page, true);
    await burst(page, "ArrowLeft", 720, 3);
    expect(logProblems(await pageLog(page), -1, start.scrollTop)).toEqual([]);
    const s = await snap(page);
    expect(s.sel).toEqual({ type: "text", anchor: 1, head: 1 });
    expect(s.scrollTop).toBe(0);
    expect(errors).toEqual([]);
  });

  test("两次按键连发（第二次在 selectionchange 之前到达）：行末 / 行首进入图片不跳到顶、不越过图片", async ({ page }) => {
    const errors = await loadLong(page);
    const client = await page.context().newCDPSession(page);
    const key = (type: string, k: string) =>
      client.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "ArrowRight" ? 39 : 37, nativeVirtualKeyCode: k === "ArrowRight" ? 39 : 37 } as any);
    // → one character before the end of a line an image follows; ← one
    // character after the start of a line an image precedes. Two keys: to the
    // line's end / start, then to the caret between blocks next to the image.
    const spots: { pos: number; dir: 1 | -1; expected: number }[] = await editorOf(page).evaluate((el: any) => {
      const out: { pos: number; dir: 1 | -1; expected: number }[] = [];
      const doc = el.editor.state.doc;
      doc.forEach((node: any, offset: number, index: number) => {
        if (node.type.name !== "paragraph" || node.content.size < 2) return;
        if (doc.maybeChild(index + 1)?.type.name === "image")
          out.push({ pos: offset + node.nodeSize - 2, dir: 1, expected: offset + node.nodeSize });
        if (doc.maybeChild(index - 1)?.type.name === "image")
          out.push({ pos: offset + 2, dir: -1, expected: offset });
      });
      return out;
    });
    expect(spots.length).toBeGreaterThan(8);
    const problems: string[] = [];
    for (const spot of spots) {
      await editorOf(page).evaluate((el: any, pos: number) => {
        const host = el.closest(".editor-host");
        el.editor.commands.focus();
        el.editor.commands.setTextSelection(pos);
        const c = el.editor.view.coordsAtPos(pos);
        host.scrollTop += c.top - host.getBoundingClientRect().top - host.clientHeight / 2;
      }, spot.pos);
      await frames(page);
      const before = await snap(page);
      await page.evaluate(() => ((window as any).log = []));
      const k = spot.dir > 0 ? "ArrowRight" : "ArrowLeft";
      await Promise.all([key("rawKeyDown", k), key("rawKeyDown", k)]);
      await key("keyUp", k);
      await frames(page);
      await page.waitForTimeout(50);
      await frames(page);
      const after = await snap(page);
      const log = await pageLog(page);
      const where = `${k} from ${spot.pos}`;
      for (const p of logProblems(log, spot.dir, before.scrollTop)) problems.push(`${where}: ${p}`);
      const scrolls = log.filter((e) => "scroll" in e).map((e) => e.scroll);
      if (scrolls.some((v) => Math.abs(v - before.scrollTop) > 120)) problems.push(`${where}: jumped ${JSON.stringify(scrolls)}`);
      if (JSON.stringify(after.sel) !== JSON.stringify({ type: "blockRange", anchor: spot.expected, head: spot.expected, side: -1 }))
        problems.push(`${where}: ended at ${JSON.stringify(after.sel)}, expected the caret between blocks at ${spot.expected}`);
      for (const miss of safeZoneMiss(after)) problems.push(`${where}: ${miss}`);
    }
    expect(problems).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("鼠标点击可见区底部附近的一行：不滚动；随后按 → 一次：滚到满足安全区", async ({ page }) => {
    const errors = await loadLong(page);
    await caretToEdge(page, false);
    // LONG(2), a line that wraps: its top 40px above the visible bottom.
    const point = await editorOf(page).evaluate((el: any) => {
      const host = el.closest(".editor-host");
      const line = Array.from(el.querySelectorAll("p") as NodeListOf<HTMLElement>).find((p) => p.textContent!.startsWith("长段落2"))!;
      const hr = host.getBoundingClientRect();
      host.scrollTop += line.getBoundingClientRect().top - (hr.top + host.clientHeight - 40);
      const r = line.getBoundingClientRect();
      return { x: r.left + 120, y: r.top + 8 };
    });
    await frames(page);
    const before = await snap(page);
    await page.mouse.click(point.x, point.y);
    await frames(page);
    const clicked = await snap(page);
    expect(clicked.sel.type).toBe("text");
    expect(clicked.scrollTop).toBe(before.scrollTop);
    // Inside the bottom safe zone, but visible.
    expect(clicked.box!.bottom).toBeGreaterThan(clicked.clientHeight - clicked.padding);
    expect(clicked.box!.bottom).toBeLessThanOrEqual(clicked.clientHeight);
    await page.keyboard.press("ArrowRight");
    await frames(page);
    const moved = await snap(page);
    expect(moved.scrollTop).toBeGreaterThan(before.scrollTop);
    expect(safeZoneMiss(moved)).toEqual([]);
    // The least scrolling: the caret at the bottom edge of the safe zone.
    expect(Math.abs(moved.box!.bottom - (moved.clientHeight - moved.padding))).toBeLessThan(1.5);
    expect(errors).toEqual([]);
  });

  test("PageDown / PageUp 按页移动光标、满足安全区；Shift+PageDown / PageUp 保持 anchor", async ({ page }) => {
    const errors = await loadLong(page);
    await caretToEdge(page, false);
    const size = await editorOf(page).evaluate((el: any) => el.editor.state.doc.content.size);
    const contentY = (s: Snap) => s.scrollTop + (s.box!.top + s.box!.bottom) / 2;
    const problems: string[] = [];
    let prev = await snap(page);
    const lh = prev.lineHeight;
    const pageSize = (Math.floor(prev.clientHeight / lh) - 2) * lh;
    const atEnd = (s: Snap) =>
      JSON.stringify(s.sel) === JSON.stringify({ type: "blockRange", anchor: size, head: size, side: -1 });
    let presses = 0;
    while (presses < 30 && !atEnd(prev)) {
      presses++;
      await page.keyboard.press("PageDown");
      await frames(page);
      const s = await snap(page);
      const where = `PageDown ${presses} ${JSON.stringify(s.sel)}`;
      if (!s.stop) problems.push(`${where}: not a caret stop`);
      if (s.scrollTop < prev.scrollTop - 0.5) problems.push(`${where}: scrolled up`);
      for (const miss of safeZoneMiss(s)) problems.push(`${where}: ${miss}`);
      const moved = contentY(s) - contentY(prev);
      // A page, give or take the block it lands on (images are up to 200px tall).
      if (!atEnd(s) && Math.abs(moved - pageSize) > 220)
        problems.push(`${where}: moved ${moved.toFixed(1)}, a page is ${pageSize.toFixed(1)}`);
      prev = s;
    }
    expect(problems).toEqual([]);
    expect(atEnd(prev)).toBe(true);
    expect(presses).toBeGreaterThan(2);
    for (let i = 1; i <= 30 && prev.sel.head !== 1; i++) {
      await page.keyboard.press("PageUp");
      await frames(page);
      const s = await snap(page);
      const where = `PageUp ${i} ${JSON.stringify(s.sel)}`;
      if (!s.stop) problems.push(`${where}: not a caret stop`);
      if (s.scrollTop > prev.scrollTop + 0.5) problems.push(`${where}: scrolled down`);
      for (const miss of safeZoneMiss(s)) problems.push(`${where}: ${miss}`);
      prev = s;
    }
    expect(problems).toEqual([]);
    expect(prev.sel).toEqual({ type: "text", anchor: 1, head: 1 });
    expect(prev.scrollTop).toBe(0);
    // Shift: the anchor stays at the start, the head goes a page at a time and
    // is the end kept in the safe zone.
    const headBox = () =>
      editorOf(page).evaluate((el: any) => {
        const view = el.editor.view;
        const hr = el.closest(".editor-host").getBoundingClientRect();
        const sel = view.state.selection;
        const $h = sel.$head;
        let r;
        if ($h.parent.inlineContent) r = view.coordsAtPos(sel.head, 1);
        else {
          // Between blocks: the block inside the range at the head, an image
          // whole, a text line at its near end.
          const forward = sel.head > sel.anchor;
          const node = forward ? $h.nodeBefore : $h.nodeAfter;
          // (An empty line: its box; with its line break selected coordsAtPos
          // has no line to measure.)
          r =
            node.type.name === "image" || !node.content.size
              ? view.nodeDOM(forward ? sel.head - node.nodeSize : sel.head).getBoundingClientRect()
              : view.coordsAtPos(forward ? sel.head - 1 : sel.head + 1, 1);
        }
        return { top: r.top - hr.top, bottom: r.bottom - hr.top, how: "head" };
      });
    let head = 1;
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+PageDown");
      await frames(page);
      const s = await snap(page);
      expect(s.sel.anchor).toBe(1);
      expect(s.sel.head).toBeGreaterThan(head);
      head = s.sel.head;
      expect(s.scrollTop).toBeGreaterThan(0);
      expect(safeZoneMiss({ ...s, box: await headBox() })).toEqual([]);
    }
    await page.keyboard.press("Shift+PageUp");
    await frames(page);
    const back = await snap(page);
    expect(back.sel.anchor).toBe(1);
    expect(back.sel.head).toBeLessThan(head);
    expect(safeZoneMiss({ ...back, box: await headBox() })).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// ---- The editor's own caret and selection (2026-10-23, src/editor/caret.ts). ----

type Shot = { width: number; height: number; data: number[] };
/** A screenshot of `clip` (CSS px) as RGBA screen pixels; finite animations end first (the caret on). */
async function shoot(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  path?: string,
): Promise<Shot> {
  const png = await page.screenshot({ clip, animations: "disabled", path });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    return { width: img.width, height: img.height, data: Array.from(data) };
  }, png.toString("base64"));
}
const pixel = (shot: Shot, x: number, y: number) => {
  const i = (y * shot.width + x) * 4;
  return shot.data.slice(i, i + 3);
};
const near = (rgb: number[], hex: string, tolerance = 2) =>
  [1, 3, 5].every(
    (k, i) => Math.abs(rgb[i] - parseInt(hex.slice(k, k + 2), 16)) <= tolerance,
  );
/** Each column of the shot: "caret" (#151515 all the way down), "background" (#f9f9f9), or "other". */
const columns = (shot: Shot) =>
  Array.from({ length: shot.width }, (_, x) => {
    const column = Array.from({ length: shot.height }, (_, y) => pixel(shot, x, y));
    if (column.every((rgb) => near(rgb, "#151515"))) return "caret";
    if (column.every((rgb) => near(rgb, "#f9f9f9"))) return "background";
    return `other(${column[Math.floor(column.length / 2)]})`;
  });
const caretOf = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const caret = el.parentElement.querySelector(".editor-caret");
    return {
      ...caret.getBoundingClientRect().toJSON(),
      display: getComputedStyle(caret).display,
      color: getComputedStyle(caret).backgroundColor,
    } as { x: number; y: number; width: number; height: number; display: string; color: string };
  });

test.describe("150% 缩放", () => {
  test.use({ deviceScaleFactor: 1.5 });

  test("自绘光标恰好 1 个屏幕像素宽、#151515，左右没有灰色半透明列；块间光标同宽", async ({
    page,
  }) => {
    const errors = await load(page);
    expect(await page.evaluate(() => devicePixelRatio)).toBe(1.5);
    await setDoc(page, ["文字", "", { id: "a" }, { id: "b" }, "下面"]);
    // The caret in the empty line (nothing else drawn around it).
    await editorOf(page).evaluate((el: any) => {
      el.editor.commands.focus();
      el.editor.commands.setTextSelection(5);
    });
    let caret = await caretOf(page);
    expect(caret.display).toBe("block");
    expect(caret.color).toBe("rgb(21, 21, 21)");
    // 2/3 px in layout units (1/64 px): 42/64; painted as one screen pixel (below).
    expect(caret.width).toBeCloseTo(1 / 1.5, 1);
    // The browser's own caret is transparent.
    expect(await editorOf(page).evaluate((el) => getComputedStyle(el).caretColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );
    const clip = (c: typeof caret) => ({
      // Narrow enough to stay inside the 8px gap between images.
      x: Math.floor(c.x) - 2,
      y: Math.ceil(c.y) + 2,
      width: 5,
      height: Math.floor(c.height) - 4,
    });
    let cols = columns(await shoot(page, clip(caret), "test-results/caret-150-text-2026-10-23.png"));
    expect(cols.filter((c) => c === "caret").length, cols.join(" ")).toBe(1);
    expect(cols.filter((c) => c.startsWith("other")), cols.join(" ")).toEqual([]);

    // Between the two images: as tall as the image, the same single column.
    await clickHalf(tile(page, 0), "right");
    caret = await caretOf(page);
    const image = (await tile(page, 0).boundingBox())!;
    expect(caret.display).toBe("block");
    expect(Math.abs(caret.height - image.height)).toBeLessThan(1);
    // 2/3 px in layout units (1/64 px): 42/64; painted as one screen pixel (below).
    expect(caret.width).toBeCloseTo(1 / 1.5, 1);
    cols = columns(await shoot(page, clip(caret), "test-results/caret-150-gap-2026-10-23.png"));
    expect(cols.filter((c) => c === "caret").length, cols.join(" ")).toBe(1);
    expect(cols.filter((c) => c.startsWith("other")), cols.join(" ")).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("光标粗细设为“粗”：自绘光标恰好 3 个屏幕像素宽、左右无灰列，块间光标同宽；在设置里改回“细”即时变 1 列；预写“中”为 2 列", async ({
    page,
  }) => {
    // The browser preview reads its settings from localStorage (useSettings).
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("linehush-settings", JSON.stringify({ caretWidth: "thick" }));
    });
    const errors = await load(page);
    await setDoc(page, ["文字", "", { id: "a" }, { id: "b" }, "下面"]);
    await editorOf(page).evaluate((el: any) => {
      el.editor.commands.focus();
      el.editor.commands.setTextSelection(5);
    });
    let caret = await caretOf(page);
    expect(caret.display).toBe("block");
    expect(caret.color).toBe("rgb(21, 21, 21)");
    expect(caret.width).toBeCloseTo(3 / 1.5, 1);
    const clip = (c: typeof caret) => ({
      x: Math.floor(c.x) - 2,
      y: Math.ceil(c.y) + 2,
      width: 6,
      height: Math.floor(c.height) - 4,
    });
    /** Exactly `n` caret columns side by side, the rest background. */
    const expectColumns = (cols: string[], n: number) => {
      const first = cols.indexOf("caret");
      expect(cols.filter((c) => c === "caret").length, cols.join(" ")).toBe(n);
      expect(cols.slice(first, first + n).every((c) => c === "caret"), cols.join(" ")).toBe(true);
      expect(cols.filter((c) => c.startsWith("other")), cols.join(" ")).toEqual([]);
    };
    expectColumns(
      columns(await shoot(page, clip(caret), "test-results/caret-150-thick-text-2026-10-23.png")),
      3,
    );

    // Between the two images: as tall as the image, still three columns, in the gap's middle.
    await clickHalf(tile(page, 0), "right");
    caret = await caretOf(page);
    const image = (await tile(page, 0).boundingBox())!;
    expect(caret.display).toBe("block");
    expect(Math.abs(caret.height - image.height)).toBeLessThan(1);
    expect(caret.width).toBeCloseTo(3 / 1.5, 1);
    expect(Math.abs(caret.x + caret.width / 2 - (image.x + image.width + 4))).toBeLessThan(1);
    expectColumns(
      columns(await shoot(page, clip(caret), "test-results/caret-150-thick-gap-2026-10-23.png")),
      3,
    );

    // Back to “细” in the settings dialog: applies at once, and is written.
    await page.locator(".settings-button").click();
    const dialog = page.locator("dialog.settings-dialog");
    await expect(dialog).toBeVisible();
    const group = dialog.getByRole("radiogroup", { name: "光标粗细" });
    await expect(group.getByRole("radio", { name: "粗" })).toBeChecked();
    await group.getByRole("radio", { name: "细" }).check();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await editorOf(page).evaluate((el: any) => {
      el.editor.commands.focus();
      el.editor.commands.setTextSelection(5);
    });
    caret = await caretOf(page);
    expect(caret.width).toBeCloseTo(1 / 1.5, 1);
    expectColumns(columns(await shoot(page, clip(caret))), 1);
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem("linehush-settings") ?? "{}").caretWidth),
      )
      .toBe("thin");

    // “中” written beforehand: exactly two columns, in the empty line and between images.
    await page.evaluate(() =>
      localStorage.setItem("linehush-settings", JSON.stringify({ caretWidth: "medium" })),
    );
    // The init script seeds "thick" only on the first load of this tab.
    await page.reload();
    await expect(editorOf(page)).toBeVisible();
    await setDoc(page, ["文字", "", { id: "a" }, { id: "b" }, "下面"]);
    await editorOf(page).evaluate((el: any) => {
      el.editor.commands.focus();
      el.editor.commands.setTextSelection(5);
    });
    caret = await caretOf(page);
    expect(caret.display).toBe("block");
    expect(caret.width).toBeCloseTo(2 / 1.5, 1);
    expectColumns(
      columns(await shoot(page, clip(caret), "test-results/caret-150-medium-text-2026-10-23.png")),
      2,
    );
    await clickHalf(tile(page, 0), "right");
    caret = await caretOf(page);
    const imageB = (await tile(page, 0).boundingBox())!;
    expect(Math.abs(caret.height - imageB.height)).toBeLessThan(1);
    expect(caret.width).toBeCloseTo(2 / 1.5, 1);
    expect(Math.abs(caret.x + caret.width / 2 - (imageB.x + imageB.width + 4))).toBeLessThan(1);
    expectColumns(
      columns(await shoot(page, clip(caret), "test-results/caret-150-medium-gap-2026-10-23.png")),
      2,
    );
    await page.locator(".settings-button").click();
    await expect(
      page
        .locator("dialog.settings-dialog")
        .getByRole("radiogroup", { name: "光标粗细" })
        .getByRole("radio", { name: "中" }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("选区边角设为“方角”：同一形状直角，外角最外像素为 #b7d9f8、无反向圆角；在设置里改为“圆角”即时变回背景色", async ({
    page,
  }) => {
    // The browser preview reads its settings from localStorage (useSettings).
    await page.addInitScript(() =>
      localStorage.setItem("linehush-settings", JSON.stringify({ selectionCorners: "square" })),
    );
    const errors = await load(page);
    await setDoc(page, [
      "短短的一行文字",
      "这一行比上一行和下一行都要长很多很多很多",
      "中等长度的一行文字",
      "后面",
    ]);
    // From after the second character of line 1 to after the fifth of line 3;
    // the editor blurred so no caret is drawn (the selection still is).
    const select = () =>
      editorOf(page).evaluate((el: any) => {
        el.editor.commands.setTextSelection({ from: 3, to: 37 });
        el.blur();
      });
    await select();
    expect(await selection(page)).toEqual({ type: "text", anchor: 3, head: 37 });
    // The shape alone: the text made transparent.
    await page.addStyleTag({ content: ".tiptap { color: transparent !important; }" });
    const first = await editorOf(page).evaluate((el: any) => {
      const p = el.querySelector(":scope > p")!;
      const range = document.createRange();
      range.setStart(p.firstChild!, 2);
      range.setEnd(p.firstChild!, p.firstChild!.textContent!.length);
      return range.getBoundingClientRect().toJSON() as DOMRect;
    });
    // From the page's corner, so screen pixel (i, j) is CSS (i, j) / 1.5.
    const region = { x: 0, y: 0, width: 520, height: 200 };
    const corners = async (path?: string) => {
      const shot = await shoot(page, region, path);
      // Line 1's part starts at screen pixel (left, top) (rows are rounded to screen pixels).
      const left = Math.round(first.left * 1.5);
      const top = Math.round(first.top * 1.5);
      const bottom = Math.round(first.bottom * 1.5);
      return {
        // The outermost pixel of the top-left corner of line 1's part.
        outer: pixel(shot, left, top),
        // Just left of line 1's part and just above line 2: the inner corner.
        inner: pixel(shot, left - 1, bottom - 1),
        // The middle of line 1's part.
        middle: pixel(shot, Math.round(((first.left + first.right) / 2) * 1.5), Math.round(((first.top + first.bottom) / 2) * 1.5)),
        // The pixel above the outer one: outside the shape.
        above: pixel(shot, left, top - 1),
      };
    };
    let px = await corners("test-results/square-selection-shape-2026-10-23.png");
    expect(near(px.outer, "#b7d9f8", 1), `outer corner ${px.outer}`).toBe(true);
    expect(near(px.above, "#f9f9f9", 1), `above the corner ${px.above}`).toBe(true);
    // No reverse rounding: the inner corner stays background.
    expect(near(px.inner, "#f9f9f9", 1), `inner corner ${px.inner}`).toBe(true);
    expect(near(px.middle, "#b7d9f8", 1), `middle ${px.middle}`).toBe(true);
    expect(
      await editorOf(page).evaluate(
        (el: any) => el.parentElement.querySelector(".selection-layer path").getAttribute("d"),
      ),
    ).not.toMatch(/A/);

    // “圆角” in the settings dialog: applies at once, and is written.
    await page.locator(".settings-button").click();
    const dialog = page.locator("dialog.settings-dialog");
    await expect(dialog).toBeVisible();
    const group = dialog.getByRole("radiogroup", { name: "选区边角" });
    await expect(group.getByRole("radio", { name: "方角" })).toBeChecked();
    await group.getByRole("radio", { name: "圆角" }).check();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // The dialog gives the focus back to the editor; blur again so no caret is drawn.
    await select();
    expect(
      await editorOf(page).evaluate(
        (el: any) => el.parentElement.querySelector(".selection-layer path").getAttribute("d"),
      ),
    ).toMatch(/A/);
    px = await corners("test-results/square-to-rounded-selection-shape-2026-10-23.png");
    expect(near(px.outer, "#f9f9f9", 1), `outer corner ${px.outer}`).toBe(true);
    expect(px.inner[0], `inner corner ${px.inner}`).toBeLessThan(215);
    expect(near(px.middle, "#b7d9f8", 1), `middle ${px.middle}`).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem("linehush-settings") ?? "{}").selectionCorners,
        ),
      )
      .toBe("rounded");
    expect(errors).toEqual([]);
  });
});

test("圆角选区：三行参差的文字连成一块，外角圆、内角反向圆，中部为 #b7d9f8；截图", async ({
  page,
}) => {
  const errors = await load(page);
  await setDoc(page, [
    "短短的一行文字",
    "这一行比上一行和下一行都要长很多很多很多",
    "中等长度的一行文字",
    "后面",
  ]);
  // From after the second character of line 1 to after the fifth of line 3;
  // the editor blurred so no caret is drawn (the selection still is).
  await editorOf(page).evaluate((el: any) => {
    el.editor.commands.setTextSelection({ from: 3, to: 37 });
    el.blur();
  });
  expect(await selection(page)).toEqual({ type: "text", anchor: 3, head: 37 });
  const box = (await editorOf(page).boundingBox())!;
  const region = { x: box.x, y: box.y, width: 520, height: 110 };
  await shoot(page, region, "test-results/rounded-selection-2026-10-23.png");
  // The shape alone: the text made transparent.
  await page.addStyleTag({ content: ".tiptap { color: transparent !important; }" });
  const geometry = await editorOf(page).evaluate((el: any) => {
    const ps = el.querySelectorAll(":scope > p");
    const part = (p: Element, start: number, end?: number) => {
      const range = document.createRange();
      range.setStart(p.firstChild!, start);
      range.setEnd(p.firstChild!, end ?? p.firstChild!.textContent!.length);
      return range.getBoundingClientRect().toJSON() as DOMRect;
    };
    return { first: part(ps[0], 2), second: part(ps[1], 0), third: part(ps[2], 0, 5) };
  });
  const shot = await shoot(page, region, "test-results/rounded-selection-shape-2026-10-23.png");
  const at = (x: number, y: number) =>
    pixel(shot, Math.floor(x - region.x), Math.floor(y - region.y));
  const { first, second, third } = geometry;
  // Outer corner (top left of line 1's part): its corner pixel stays background.
  const outer = at(Math.round(first.left), Math.round(first.top));
  expect(outer[0], `outer corner ${outer}`).toBeGreaterThan(240);
  // Inside that corner, the selection colour.
  expect(near(at(first.left + 4, first.top + 4), "#b7d9f8", 1)).toBe(true);
  // The middle of line 2.
  const middle = at((second.left + second.right) / 2, (second.top + second.bottom) / 2);
  expect(near(middle, "#b7d9f8", 1), `middle ${middle}`).toBe(true);
  // Inner corner where line 2 starts further left than line 1: the pixel just
  // left of line 1's part and just above line 2 is filled by the reverse
  // rounding (it would be background with square corners).
  const inner = at(Math.round(first.left) - 1, Math.round(first.bottom) - 1);
  expect(inner[0], `inner corner ${inner}`).toBeLessThan(215);
  // Below line 3's part (line 4, not selected): background.
  expect(at(third.right - 1, third.bottom + 3)[0]).toBeGreaterThan(240);
  expect(errors).toEqual([]);
});

test("输入法组字期间：自绘光标与选区隐藏，浏览器画光标；结束后恢复", async ({ page }) => {
  const errors = await load(page);
  await editorOf(page).evaluate((el: any) => {
    el.editor.commands.focus();
    el.editor.commands.setTextSelection(3);
  });
  expect((await caretOf(page)).display).toBe("block");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  const during = await editorOf(page).evaluate((el) => ({
    composing: el.parentElement!.classList.contains("composing"),
    caret: getComputedStyle(el.parentElement!.querySelector(".editor-caret")!).display,
    layer: getComputedStyle(el.parentElement!.querySelector(".selection-layer")!).display,
    native: getComputedStyle(el).caretColor,
  }));
  expect(during).toEqual({ composing: true, caret: "none", layer: "none", native: "rgb(21, 21, 21)" });
  await cdp.send("Input.insertText", { text: "你" });
  await expect.poll(() => content(page)).toEqual(["上面你", "[a]", "[b]", "下面"]);
  await expect
    .poll(() => editorOf(page).evaluate((el) => el.parentElement!.classList.contains("composing")))
    .toBe(false);
  // Drawn again, after the composed text.
  const caret = await caretOf(page);
  expect(caret.display).toBe("block");
  const end = await editorOf(page).evaluate((el: any) => el.editor.view.coordsAtPos(4, 1).left);
  expect(Math.abs(caret.x - end)).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test("全选长文档：画选区不卡（量一次全选的耗时）", async ({ page }) => {
  const errors = await load(page);
  await setDoc(
    page,
    Array.from({ length: 3000 }, (_, i) =>
      i % 7 === 3 ? "" : `第 ${i} 行：这是一行用来量画选区耗时的文字，长短不一${"。".repeat(i % 13)}`,
    ),
  );
  await editorOf(page).evaluate((el: any) => el.editor.commands.focus("start"));
  const ms = await editorOf(page).evaluate((el: any) => {
    const t = performance.now();
    el.editor.commands.selectAll();
    return performance.now() - t;
  });
  console.log(`3000 行全选：${ms.toFixed(1)} ms`);
  expect(
    await editorOf(page).evaluate(
      (el) => !!el.parentElement!.querySelector(".selection-layer path")!.getAttribute("d"),
    ),
  ).toBe(true);
  expect(ms).toBeLessThan(500);
  // Only lines near the viewport are measured; scrolled far away, the lines
  // shown are measured then and drawn selected.
  for (const at of [0.5, 1]) {
    await editorOf(page).evaluate((el: any, at: number) => {
      const host = el.closest(".editor-host");
      host.scrollTop = (host.scrollHeight - host.clientHeight) * at;
    }, at);
    await frames(page);
    const covered = await editorOf(page).evaluate((el: any) => {
      const host = el.closest(".editor-host").getBoundingClientRect();
      const layer = el.parentElement.querySelector(".selection-layer");
      const origin = layer.getBoundingClientRect();
      const path = layer.querySelector("path");
      const lines = Array.from(el.querySelectorAll(":scope > p")).filter((p: any) => {
        const r = p.getBoundingClientRect();
        return p.textContent && r.top > host.top && r.bottom < host.bottom;
      }) as HTMLElement[];
      return lines.map((p) => {
        const r = p.getBoundingClientRect();
        const point = layer.createSVGPoint();
        point.x = r.left + 4 - origin.left;
        point.y = (r.top + r.bottom) / 2 - origin.top;
        return path.isPointInFill(point);
      });
    });
    expect(covered.length).toBeGreaterThan(10);
    expect(covered.every(Boolean), `scrolled to ${at}`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("自动换行处光标所在行与浏览器一致：End / 点上一行末尾空白在上一行末，→ / ← / 点下一行行首在下一行首", async ({
  page,
}) => {
  const errors = await load(page);
  const text =
    "今天天气很好，我们去公园散步，看见湖边有很多人在钓鱼。孩子们在草地上奔跑，老人坐在长椅上晒太阳聊天。" +
    "中午在附近的小馆子吃了一碗面，味道一般但是分量很足。下午回家整理了书架，把不再看的旧书装进箱子里准备捐出去。";
  await setDoc(page, ["上面", text, "下面"]);
  // The first wrap of the long line (it starts at 4, its text at 5).
  const wrap = await editorOf(page).evaluate((el: any) => {
    const view = el.editor.view;
    for (let pos = 6; pos < 5 + view.state.doc.child(1).content.size; pos++) {
      const up = view.coordsAtPos(pos, -1);
      const down = view.coordsAtPos(pos, 1);
      if (Math.abs(up.top - down.top) > 2) return { pos, up, down };
    }
    return null;
  });
  expect(wrap).not.toBeNull();
  const { pos, up, down } = wrap!;
  const set = (at: number) =>
    editorOf(page).evaluate((el: any, at: number) => {
      el.editor.commands.focus();
      el.editor.commands.setTextSelection(at);
    }, at);
  /** Which line the drawn caret is on at the wrap: "up" (end of the upper line) or "down". */
  const line = async () => {
    expect((await selection(page)).head).toBe(pos);
    await frames(page);
    const c = await caretOf(page);
    expect(c.display).toBe("block");
    const near = (r: { top: number; left: number }) => Math.abs(c.y - r.top) < 1.5 && Math.abs(c.x - r.left) < 1.5;
    return near(up) ? "up" : near(down) ? "down" : `elsewhere ${JSON.stringify(c)}`;
  };
  await set(5);
  await page.keyboard.press("End");
  expect(await line()).toBe("up");
  await set(pos - 1);
  await page.keyboard.press("ArrowRight");
  expect(await line()).toBe("down");
  await page.keyboard.press("End");
  expect((await selection(page)).head).toBeGreaterThan(pos); // the end of the lower line
  await set(pos + 1);
  await page.keyboard.press("ArrowLeft");
  expect(await line()).toBe("down");
  // A click right of the upper line's end, then one on the lower line's first
  // character (the same position: no new selection in ProseMirror).
  const right = (await editorOf(page).boundingBox())!;
  await page.mouse.click(right.x + right.width - 4, (up.top + up.bottom) / 2);
  expect(await line()).toBe("up");
  await page.mouse.click(down.left + 1, (down.top + down.bottom) / 2);
  expect(await line()).toBe("down");
  // Shift+End: the head (a range) at the end of the upper line.
  await set(5);
  await page.keyboard.press("Shift+End");
  expect(await line()).toBe("up");
  expect(errors).toEqual([]);
});
