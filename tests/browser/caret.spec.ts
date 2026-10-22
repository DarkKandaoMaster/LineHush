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
    expect(during, stops.join(" → ")).toEqual({ state: range, dom: range, text });
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

test("选中换行：行末画半个字宽的选区色块，空行隐藏 trailingBreak，行高不变，收起后消失", async ({
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
  const lines = () =>
    editor.evaluate((el: any) =>
      Array.from(el.querySelectorAll(":scope > p")).map((p: any) => {
        const after = getComputedStyle(p, "::after");
        const br = p.querySelector("br.ProseMirror-trailingBreak");
        return {
          selected: p.classList.contains("newline-selected"),
          height: p.getBoundingClientRect().height,
          em: parseFloat(getComputedStyle(p).fontSize),
          after: after.content === "none" || after.content === "normal" ? null : parseFloat(after.width),
          afterHeight: parseFloat(after.height),
          br: br ? getComputedStyle(br).display : null,
        };
      }),
    );
  const before = await lines();
  expect(before.map((l) => l.selected)).toEqual([false, false, false]);
  expect(before[1].br).not.toBe("none");

  // "我|" + Shift+→: the selection is just the line break of the first line.
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 4 });
  let now = await lines();
  expect(now.map((l) => l.selected)).toEqual([true, false, false]);
  expect(now[0].after).toBeCloseTo(now[0].em / 2, 1);
  expect(now[0].afterHeight).toBeCloseTo(before[0].height, 0);
  expect(now.map((l) => l.height)).toEqual(before.map((l) => l.height));

  // Across the empty line too: its trailing <br> is hidden, the block holds it open.
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 6 });
  now = await lines();
  expect(now.map((l) => l.selected)).toEqual([true, true, false]);
  expect(now[1].br).toBe("none");
  expect(now[1].after).toBeCloseTo(now[1].em / 2, 1);
  expect(now.map((l) => l.height)).toEqual(before.map((l) => l.height));

  // Select all: the last line has no line break after it.
  await page.keyboard.press("Control+a");
  now = await lines();
  expect(now.map((l) => l.selected)).toEqual([true, true, false]);
  expect(now[2].after).toBeNull();

  // Collapsing the selection removes the blocks.
  await page.keyboard.press("ArrowRight");
  now = await lines();
  expect(now.map((l) => l.selected)).toEqual([false, false, false]);
  expect(now.every((l) => l.after === null)).toBe(true);
  expect(now[1].br).not.toBe("none");
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
