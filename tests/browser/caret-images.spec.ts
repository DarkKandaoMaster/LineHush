import { test, expect, type Page } from "@playwright/test";
import {
  caretBeside,
  clickHalf,
  content,
  editorOf,
  loadSample,
  selection,
  tile,
} from "./helpers";

// The caret between blocks (beside an image) and drag selections over and
// beside images. Thumbnails do not load (the test double has none), so tiles
// show their placeholder at the picture's size, which is all the caret needs.

test("单击图片左右半区：光标停在图片前 / 后，画成与图片等高的竖线，没有节点选中", async ({
  page,
}) => {
  const errors = await loadSample(page);
  await clickHalf(tile(page, 0), "right");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5, side: -1 });
  expect(await caretBeside(page)).toEqual(["after", ""]);
  await clickHalf(tile(page, 0), "left");
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 4, head: 4, side: 1 });
  expect(await caretBeside(page)).toEqual(["before", ""]);
  await clickHalf(tile(page, 1), "right");
  expect(await caretBeside(page)).toEqual(["", "after"]);
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
  const errors = await loadSample(page);
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
  const errors = await loadSample(page);
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
  expect(await caretBeside(page)).toEqual(["", "after"]);
  await page.screenshot({ path: test.info().outputPath("caret-after-image.png") });
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
  await page.screenshot({ path: test.info().outputPath("image-selected.png") });
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
  await page.screenshot({ path: test.info().outputPath("caret.png") });
  expect(errors).toEqual([]);
});

test("文档以图片结尾：点图片下方空白，光标停在最后一张图后，打字起新行", async ({
  page,
}) => {
  const errors = await loadSample(page);
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
  const errors = await loadSample(page);
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
  const errors = await loadSample(page);
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
    // The tile shows its placeholder (the test double has no thumbnails), or
    // the picture put in before when the same image was kept.
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
  const errors = await loadSample(page);
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

  // Mirrored: pressed left of image 1. That is the left margin (the editor's
  // left padding), where a press selects the whole row of images instead
  // (2026-10-24, src/editor/margin.ts); dragged right out of the window the row
  // stays selected, and up to the text line the selection grows by whole lines
  // (anchor at the row's end, head at the text line's start).
  await page.mouse.click(editor.x + 300, editor.y + editor.height - 20);
  at = { x: editor.x + 8, y: row };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await step(b.x + b.width + 60, row, [4, 6], 2, "图片 2 右侧空白");
  await step(width + 50, row, [4, 6], 2, "越出右边框");
  await step(width + 50, text, [6, 1], 2, "越出右边框后向上到文字");
  await page.mouse.up();
  expect(await both(), "松开后").toEqual({ state: [6, 1], dom: [6, 1], images: 2 });

  // Pressed beside the row after b, dragged right out of the window (the caret
  // stays after image 2), then up to the text line: the browser's end at the
  // text's end, both images in the range.
  await page.mouse.click(editor.x + 300, editor.y + editor.height - 20);
  at = { x: b.x + b.width + 40, y: row };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await step(width + 50, row, [6, 6], 0, "图片 2 右侧按下后越出右边框");
  await step(width + 50, text, [6, 3], 2, "越出右边框后向上到文字（从图片 2 右侧）");
  await page.mouse.up();
  expect(await both(), "松开后").toEqual({ state: [6, 3], dom: [6, 3], images: 2 });
  expect(errors).toEqual([]);
});

test("拖动图片仍按左右半区落位", async ({ page }) => {
  const errors = await loadSample(page);
  const target = (await tile(page, 1).boundingBox())!;
  await tile(page, 0).dragTo(tile(page, 1), {
    targetPosition: { x: target.width - 10, y: target.height / 2 },
  });
  await expect.poll(() => content(page)).toEqual(["上面", "[b]", "[a]", "下面"]);
  expect(errors).toEqual([]);
});
