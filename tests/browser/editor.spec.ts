import { test, expect, type Page } from "@playwright/test";
import { calls, caretOf, clickHalf, editorOf, frames, layout, load, releaseSave, selection, setDoc, tile } from "./helpers";

test("真实编辑区保留连续末尾换行，撤销重做正常", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await page.keyboard.insertText("今天记录");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二段");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(editor.locator("p")).toHaveText([
    "今天记录",
    "",
    "第二段",
    "",
    "",
  ]);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await expect(editor.locator("p")).toHaveText([
    "今天记录",
    "",
    "第二段",
    "",
    "",
  ]);
  expect(errors).toEqual([]);
});
test("Ctrl+Enter / Ctrl+Shift+Enter 与 Enter 一样换行", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["今天记录"]);
  // The caret after "今天".
  await editor.evaluate((el: any) => el.editor.commands.setTextSelection(3));
  await page.keyboard.press("Control+Enter");
  await expect(editor.locator("p")).toHaveText(["今天", "记录"]);
  expect(await selection(page)).toEqual({ type: "text", anchor: 5, head: 5 });
  await page.keyboard.press("Control+Shift+Enter");
  await expect(editor.locator("p")).toHaveText(["今天", "", "记录"]);
  expect(await selection(page)).toEqual({ type: "text", anchor: 7, head: 7 });
  expect(errors).toEqual([]);
});
test("图片之间按 Ctrl+Enter 与 Enter 一样：后一张另起一行，光标在它前面", async ({ page }) => {
  const errors = await load(page);
  // "上面" 0-4, a 4-5, b 5-6 (one row), "下面" 6-10.
  await setDoc(page, ["上面", { id: "a" }, { id: "b" }, "下面"]);
  await clickHalf(tile(page, 0), "right");
  expect(await selection(page)).toMatchObject({ type: "blockRange", anchor: 5, head: 5 });
  await page.keyboard.press("Control+Enter");
  expect(await layout(page)).toEqual(["上面", "[a]", "[b]", "下面"]);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 5, head: 5, side: 1 });
  expect(errors).toEqual([]);
});
test("粘贴只接收纯文本且保留全部空行，不解析 Markdown", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "# 标题\n\n**普通文字**\n\n");
    data.setData("text/html", "<h1>标题</h1><b>普通文字</b>");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(editor.locator("p")).toHaveText([
    "# 标题",
    "",
    "**普通文字**",
    "",
    "",
  ]);
  await expect(editor.locator("h1,strong,b")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("editor.png") });
  expect(errors).toEqual([]);
});

/**
 * A press at (x, y) moved by `move` pixels before the release: whether the
 * editor's and the DOM's selections ended up collapsed, and the dragstart
 * events it fired.
 */
async function pressAfter(page: Page, x: number, y: number, move: number) {
  await page.evaluate(() => {
    const w = window as any;
    if (w.dragstarts === undefined)
      document.addEventListener("dragstart", () => w.dragstarts++, true);
    w.dragstarts = 0;
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (move) await page.mouse.move(x + move, y + 1, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  return editorOf(page).evaluate((el: any) => ({
    empty: el.editor.state.selection.empty,
    dom: document.getSelection()!.isCollapsed,
    dragstarts: (window as any).dragstarts,
  }));
}
/** A drag selection from (x0, y0) to (x1, y1); something ends up selected. */
async function dragSelect(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
  expect((await selection(page)).anchor).not.toBe((await selection(page)).head);
}

// Chromium holds a range for a drag of it when the position under the press
// is inside it, and below the last line that is a position in the last line.
// The release then collapses it only if the pointer did not move at all
// (image-view's pressOffSelection).
test("选区到文末后点正文下方空白（按下后指针微动或不动）都取消选中，光标在末行", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["第一行文字内容", "第二行文字内容", "第三行文字内容", "第四行文字内容"]);
  const lines = editor.locator(":scope > p");
  const second = (await lines.nth(1).boundingBox())!;
  const last = (await lines.nth(3).boundingBox())!;
  const below = last.y + last.height + 100;
  // Right of the last line's text (moving there stays past its end) and under
  // its middle (moving there would select characters).
  const presses = [
    ...[0, 1, 4, 8].map((move) => ({ x: last.x + 500, move })),
    ...[0, 1].map((move) => ({ x: last.x + 30, move })),
  ];
  for (const { x, move } of presses) {
    // Down to the end of the document, past the last line's text.
    await dragSelect(page, second.x + 30, second.y + second.height / 2, last.x + 400, last.y + last.height / 2);
    expect(await pressAfter(page, x, below, move), `move ${move}, x ${x}`).toEqual({
      empty: true,
      dom: true,
      dragstarts: 0,
    });
    // In the last line (its text runs from 28 to 35).
    expect((await selection(page)).head).toBeGreaterThanOrEqual(28);
  }
  // Right of a line whose end is selected (the selection ends in the line below).
  const third = (await lines.nth(2).boundingBox())!;
  await dragSelect(page, second.x + 30, second.y + second.height / 2, third.x + 30, third.y + third.height / 2);
  expect(await pressAfter(page, second.x + 400, second.y + second.height / 2, 1)).toEqual({
    empty: true,
    dom: true,
    dragstarts: 0,
  });
  expect(await selection(page)).toMatchObject({ anchor: 17, head: 17 });
  expect(errors).toEqual([]);
});

test("点空白取消选中不影响：Shift+单击扩展、从空白处拖选、拖动选中的文字", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["第一行文字内容", "第二行文字内容", "第三行文字内容", "第四行"]);
  const lines = editor.locator(":scope > p");
  const second = (await lines.nth(1).boundingBox())!;
  const last = (await lines.nth(3).boundingBox())!;
  const middle = second.y + second.height / 2;
  await dragSelect(page, second.x + 20, middle, second.x + 60, middle);
  const { anchor } = await selection(page);
  await page.keyboard.down("Shift");
  await page.mouse.click(last.x + 300, last.y + last.height + 100);
  await page.keyboard.up("Shift");
  expect(await selection(page)).toMatchObject({ anchor, head: 31 });
  // A press below the text with a selection there drags a new one from the end.
  await dragSelect(page, last.x + 300, last.y + last.height + 100, second.x + 30, middle);
  expect((await selection(page)).anchor).toBe(31);
  // A press on the selected text still drags it.
  const moved = await pressAfter(page, second.x + 60, middle, 8);
  expect(moved.dragstarts).toBe(1);
  expect(errors).toEqual([]);
});

test("选区含末尾图片时点下方空白取消选中，光标在图片后", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["上面", "第一行文字", { id: "a" }, { id: "b" }]);
  const line = (await editor.locator(":scope > p").nth(1).boundingBox())!;
  const image = (await editor.locator(".image-item").nth(1).boundingBox())!;
  await dragSelect(page, line.x + 20, line.y + line.height / 2, image.x + image.width + 40, image.y + image.height + 30);
  expect(await pressAfter(page, image.x + image.width + 100, image.y + image.height + 100, 1)).toEqual({
    empty: true,
    dom: true,
    dragstarts: 0,
  });
  expect(await selection(page)).toMatchObject({ type: "blockRange", head: 13, side: -1 });
  expect(errors).toEqual([]);
});

/** The text position under (x, y), as ProseMirror reads it. */
const posAt = (page: Page, x: number, y: number) =>
  editorOf(page).evaluate(
    (el: any, [x, y]) => el.editor.view.posAtCoords({ left: x, top: y })!.pos as number,
    [x, y],
  );

// Chromium holds a range pressed on for a drag of it and collapses it on the
// release only if the pointer did not move at all; a click often moves it a
// pixel or two, short of a dragstart (image-view's clickOnSelection).
test("单击已选中的文字（按下后指针微动）取消选中，光标在按下处；拖出几个像素仍拖动选区", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["第一行文字内容", "第二行文字内容", "第三行文字内容"]);
  const second = (await editor.locator(":scope > p").nth(1).boundingBox())!;
  const middle = second.y + second.height / 2;
  for (const move of [0, 1, 2]) {
    await dragSelect(page, second.x + 10, middle, second.x + 90, middle);
    const at = await posAt(page, second.x + 45, middle);
    expect(await pressAfter(page, second.x + 45, middle, move), `move ${move}`).toEqual({
      empty: true,
      dom: true,
      dragstarts: 0,
    });
    expect(await selection(page)).toMatchObject({ anchor: at, head: at });
    // The drawn selection is gone.
    await frames(page);
    expect(
      await editor.evaluate((el) => !!el.parentElement!.querySelector(".selection-layer path")!.getAttribute("d")),
    ).toBe(false);
    // Away from the press, so the next drag is not a double click.
    await page.waitForTimeout(600);
  }
  await dragSelect(page, second.x + 10, middle, second.x + 90, middle);
  const before = await selection(page);
  const moved = await pressAfter(page, second.x + 45, middle, 8);
  expect(moved.dragstarts).toBe(1);
  expect(await selection(page)).toEqual(before);
  expect(errors).toEqual([]);
});

// A range's client rects hold the border box of every element wholly inside
// it: a line selected from end to end counted across the editor's width.
test("选区跨过整行与空行时点这些行右侧空白（按下后指针微动）取消选中", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["第一行文字内容", "第二行文字内容", "", "第四行文字内容"]);
  const lines = editor.locator(":scope > p");
  const first = (await lines.nth(0).boundingBox())!;
  const second = (await lines.nth(1).boundingBox())!;
  const blank = (await lines.nth(2).boundingBox())!;
  const last = (await lines.nth(3).boundingBox())!;
  const mid = (box: { y: number; height: number }) => box.y + box.height / 2;
  const presses = [
    { box: second, move: 1, head: 17 },
    { box: blank, move: 1, head: 19 },
    // Moved further it drags a new selection, not the old one.
    { box: second, move: 8, head: undefined },
  ];
  for (const { box, move, head } of presses) {
    await dragSelect(page, first.x + 30, mid(first), last.x + 30, mid(last));
    const result = await pressAfter(page, box.x + 400, mid(box), move);
    expect(result.dragstarts, `move ${move}`).toBe(0);
    if (head !== undefined) {
      expect(result).toMatchObject({ empty: true, dom: true });
      expect(await selection(page)).toMatchObject({ anchor: head, head });
    } else expect((await selection(page)).anchor).toBe(17);
    await page.waitForTimeout(600);
  }
  expect(errors).toEqual([]);
});

/** A double click at (x, y) whose second press is `clickCount` 2: the selection after it. */
async function doublePress(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await page.waitForTimeout(50);
  return selection(page);
}

// With a range selected, Chromium's double click keeps it (no word selected,
// no caret put): a press the system counts as the second of a double click
// (a quick one within a couple of pixels of the press before) left the
// selection in place wherever it was.
test("有选区时按下被系统记为双击第二下：与从光标开始的双击结果相同（选词或落光标）", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["第一行文字内容", "第二行文字内容", "", "第四行文字内容", "第五行文字内容"]);
  const lines = editor.locator(":scope > p");
  const second = (await lines.nth(1).boundingBox())!;
  const fourth = (await lines.nth(3).boundingBox())!;
  const last = (await lines.nth(4).boundingBox())!;
  const mid = (box: { y: number; height: number }) => box.y + box.height / 2;
  const points = [
    { x: fourth.x + 40, y: mid(fourth) }, // unselected text
    { x: fourth.x + 400, y: mid(fourth) }, // right of a line
    { x: last.x + 300, y: last.y + last.height + 100 }, // below the last line
    { x: second.x + 45, y: mid(second) }, // selected text
  ];
  for (const { x, y } of points) {
    // From a caret: the first click puts it, the second selects.
    await page.mouse.click(x, y);
    const expected = await doublePress(page, x, y);
    await page.waitForTimeout(600);
    await dragSelect(page, second.x + 10, mid(second), second.x + 90, mid(second));
    await page.waitForTimeout(600);
    expect(await doublePress(page, x, y), `${x}, ${y}`).toEqual(expected);
    await page.waitForTimeout(600);
  }
  // A triple click still selects the line, and so does one after a word was
  // selected by a double click.
  await page.mouse.click(fourth.x + 40, mid(fourth));
  await doublePress(page, fourth.x + 40, mid(fourth));
  await page.mouse.down({ clickCount: 3 });
  await page.mouse.up({ clickCount: 3 });
  expect(await selection(page)).toMatchObject({ anchor: 21, head: 28 });
  expect(errors).toEqual([]);
});

/** The DOM selection's anchor and focus, as ProseMirror positions. */
const domEnds = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const view = el.editor.view;
    const dom = getSelection()!;
    return [view.posAtDOM(dom.anchorNode, dom.anchorOffset), view.posAtDOM(dom.focusNode, dom.focusOffset)];
  });

/** The editor's selection while the button is still held (`selection` reads it the same). */
const held = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const { anchor, head } = el.editor.state.selection;
    return { anchor, head };
  });

// Below the last text line (the editor's bottom padding) a click is at the
// document's end whatever its x, as in Notepad / VS Code (image-view's
// belowLastLine); the browser would put it in the last line under the pointer.
// A drag pressed there keeps the end as its anchor; dragged left of the press
// while below the line its head is at the pointer's x in the line
// (image-view's lastLineAt), so the line is selected from under the pointer to
// the end, as in Notepad (2026-11-08); a drag pressed in the text has its head
// at the end below the line.
test("末行下方空白：单击落到文末，与 x 无关；Shift+单击扩到文末；从那里往左拖，head 按 x 落在末行", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["第一行文字内容", "第二行文字内容", "第三行文字内容", "第四行文字内容"]);
  // "第四行文字内容" 27-36, its text 28-35: the document's end is 35.
  const lines = editor.locator(":scope > p");
  const second = (await lines.nth(1).boundingBox())!;
  const last = (await lines.nth(3).boundingBox())!;
  const mid = (box: { y: number; height: number }) => box.y + box.height / 2;
  const below = last.y + last.height + 60;
  // A click under the middle of the last line, and just below its bottom.
  for (const { x, y } of [
    { x: last.x + 30, y: below },
    { x: last.x + 1, y: last.y + last.height + 2 },
  ]) {
    await page.mouse.click(second.x + 30, mid(second));
    await page.waitForTimeout(600);
    await page.mouse.click(x, y);
    expect(await selection(page), `${x}, ${y}`).toMatchObject({ type: "text", anchor: 35, head: 35 });
    // Drawn at the end of the last line; the DOM caret is there too.
    await frames(page);
    const caret = await caretOf(page);
    const end = await editor.evaluate((el: any) => {
      const c = el.editor.view.coordsAtPos(35);
      const dom = getSelection()!;
      return { x: c.left, top: c.top, dom: el.editor.view.posAtDOM(dom.focusNode, dom.focusOffset) };
    });
    expect(Math.abs(caret.x + caret.width / 2 - end.x)).toBeLessThan(2);
    expect(Math.abs(caret.y - end.top)).toBeLessThan(3);
    expect(end.dom).toBe(35);
    await page.waitForTimeout(600);
  }

  // Shift+click below: from the anchor to the end.
  await page.mouse.click(second.x + 30, mid(second));
  const { anchor } = await selection(page);
  expect(anchor).toBeLessThan(18);
  await page.waitForTimeout(600);
  await page.keyboard.down("Shift");
  await page.mouse.click(last.x + 30, below);
  await page.keyboard.up("Shift");
  expect(await selection(page)).toMatchObject({ anchor, head: 35 });
  await page.waitForTimeout(600);

  // Pressed below and dragged left under the last line: from the end to the
  // pointer's x in the line; up into the line the browser's head (from the
  // end); back below, left of the press by x again, right of it the end.
  const at = await posAt(page, last.x + 45, mid(last));
  const at20 = await posAt(page, last.x + 20, mid(last));
  expect(at).toBeGreaterThan(28);
  expect(at).toBeLessThan(35);
  expect(at20).toBeGreaterThan(28);
  expect(at20).toBeLessThan(at);
  await page.mouse.move(last.x + 75, below);
  await page.mouse.down();
  await page.mouse.move(last.x + 45, below, { steps: 4 });
  await page.waitForTimeout(50);
  expect(await held(page), "往左").toEqual({ anchor: 35, head: at });
  await page.mouse.move(last.x + 45, mid(last), { steps: 4 });
  await page.waitForTimeout(50);
  expect(await held(page), "进入末行").toEqual({ anchor: 35, head: at });
  await page.mouse.move(last.x + 20, below, { steps: 4 });
  await page.waitForTimeout(50);
  expect(await held(page), "回到下方左侧").toEqual({ anchor: 35, head: at20 });
  await page.mouse.move(last.x + 150, below, { steps: 6 });
  await page.waitForTimeout(50);
  expect(await held(page), "下方按下点右侧").toEqual({ anchor: 35, head: 35 });
  await page.mouse.move(last.x + 20, below, { steps: 6 });
  await page.waitForTimeout(50);
  expect(await held(page), "再回左侧").toEqual({ anchor: 35, head: at20 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 35, head: at20 });
  // The browser's DOM selection agrees, and it is drawn.
  await frames(page);
  expect(await domEnds(page)).toEqual([35, at20]);
  const part = await editor.evaluate((el: any, from) => el.editor.state.doc.textBetween(from, 35), at20);
  expect(part.length).toBe(35 - at20);
  expect("第四行文字内容".endsWith(part)).toBe(true);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(part);
  expect(
    await editor.evaluate((el) => !!el.parentElement!.querySelector(".selection-layer path")!.getAttribute("d")),
  ).toBe(true);
  await page.waitForTimeout(600);

  // Dragged left out of the line (into the left margin): its start, so the
  // whole line.
  await page.mouse.move(last.x + 75, below);
  await page.mouse.down();
  await page.mouse.move(last.x - 10, below, { steps: 8 });
  await page.waitForTimeout(50);
  expect(await held(page), "越出行左侧").toEqual({ anchor: 35, head: 28 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 35, head: 28 });
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("第四行文字内容");
  await page.waitForTimeout(600);

  // Up into the lines above: from the end.
  await page.mouse.move(last.x + 30, below);
  await page.mouse.down();
  await page.mouse.move(second.x + 30, mid(second), { steps: 8 });
  await page.mouse.up();
  expect(await selection(page)).toMatchObject({
    anchor: 35,
    head: await posAt(page, second.x + 30, mid(second)),
  });
  await page.waitForTimeout(600);

  // Dragged from a line above (outside the selection) down below the last
  // line: the head is the end, whatever the pointer's x.
  const first = (await lines.nth(0).boundingBox())!;
  await page.mouse.move(first.x + 30, mid(first));
  await page.mouse.down();
  await page.mouse.move(last.x + 30, below, { steps: 8 });
  await page.waitForTimeout(50);
  expect((await held(page)).head).toBe(35);
  await page.mouse.up();
  expect(await selection(page)).toMatchObject({ anchor: await posAt(page, first.x + 30, mid(first)), head: 35 });
  expect(errors).toEqual([]);
});

// A drag pressed in the text with the pointer then below the last line has its
// head at the document's end whatever the pointer's x (2026-11-08: the head by
// x of 2026-11-03 was dropped).
test("末行下方空白：从正文拖到末行下方，head 固定在文末，与 x 无关", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);

  // (a) One line, pressed in it, dragged down-left below it: to its end.
  await setDoc(page, ["第一行文字内容"]);
  // "第一行文字内容" 0-9, its text 1-8: the end is 8.
  const only = (await editor.locator(":scope > p").first().boundingBox())!;
  const midOnly = only.y + only.height / 2;
  const from = await posAt(page, only.x + 60, midOnly);
  expect(from).toBeGreaterThan(1);
  expect(from).toBeLessThan(8);
  await page.mouse.move(only.x + 60, midOnly);
  await page.mouse.down();
  await page.mouse.move(only.x + 10, only.y + only.height + 80, { steps: 10 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor: from, head: 8 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: from, head: 8 });
  await frames(page);
  expect(await domEnds(page)).toEqual([from, 8]);
  await page.waitForTimeout(600);

  // (b) From a line in the middle down below the last line, then along under it.
  await setDoc(page, ["第一行文字内容", "第二行文字内容", "第三行文字内容"]);
  // "第三行文字内容" 18-27, its text 19-26: the end is 26.
  const lines = editor.locator(":scope > p");
  const second = (await lines.nth(1).boundingBox())!;
  const last = (await lines.nth(2).boundingBox())!;
  const mid = (box: { y: number; height: number }) => box.y + box.height / 2;
  const below = last.y + last.height + 60;
  const anchor = await posAt(page, second.x + 50, mid(second));
  await page.mouse.move(second.x + 50, mid(second));
  await page.mouse.down();
  await page.mouse.move(last.x + 20, below, { steps: 8 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor, head: 26 });
  await page.mouse.move(last.x + 70, below, { steps: 6 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor, head: 26 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor, head: 26 });
  await frames(page);
  expect(await domEnds(page)).toEqual([anchor, 26]);
  await page.waitForTimeout(600);

  // With Shift, pressed in the text: the anchor stays, the head the end below.
  await page.mouse.click(second.x + 50, mid(second));
  await page.waitForTimeout(600);
  await page.keyboard.down("Shift");
  await page.mouse.move(last.x + 70, mid(last));
  await page.mouse.down();
  await page.mouse.move(last.x + 20, below, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ anchor, head: 26 });
  await page.waitForTimeout(600);

  // A click below the last line is still at the end.
  await page.mouse.click(last.x + 20, below);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 26, head: 26 });
  expect(errors).toEqual([]);
});

// A drag pressed below the last line and kept there: dragged left of the
// press, from the pointer's x in the last line to the end (image-view's
// lastLineAt; left of the line its start, so the whole line; right of its text
// its end, so nothing); at / right of the press nothing (the end); a press
// moved no more than ProseMirror's click slop is still a click (to the end).
test("末行下方空白：从右侧按下往左拖，head 按 x 落在末行，越出行左侧整行；往右拖不选、拖回右边收回，DOM 选区一致", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["第一行文字内容", "第二行文字内容", "第三行文字内容", "第四行文字内容"]);
  // "第四行文字内容" 27-36, its text 28-35.
  const lines = editor.locator(":scope > p");
  const second = (await lines.nth(1).boundingBox())!;
  const last = (await lines.nth(3).boundingBox())!;
  const below = last.y + last.height + 60;
  await page.mouse.click(second.x + 30, second.y + second.height / 2);
  await page.waitForTimeout(600);

  const selectedText = () =>
    editor.evaluate((el: any) => {
      const { state } = el.editor;
      return state.doc.textBetween(state.selection.from, state.selection.to);
    });
  // "第四行文字内容": the left edge of its 4th character (after 31), and a point
  // just right of it, under that character's left part.
  const x31 = await editor.evaluate((el: any) => el.editor.view.coordsAtPos(31).left as number);

  // Right of the text, along under it to the left, under the 4th character:
  // from there to the end.
  await page.mouse.move(last.x + 400, below);
  await page.mouse.down();
  await page.mouse.move(x31 + 3, below + 5, { steps: 10 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor: 35, head: 31 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 35, head: 31 });
  await frames(page);
  expect(await domEnds(page)).toEqual([35, 31]);
  expect(await selectedText()).toBe("文字内容");
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("文字内容");
  expect(
    await editor.evaluate((el) => !!el.parentElement!.querySelector(".selection-layer path")!.getAttribute("d")),
  ).toBe(true);
  await page.waitForTimeout(600);

  // On out of the line to the left: the whole line.
  await page.mouse.move(last.x + 400, below);
  await page.mouse.down();
  await page.mouse.move(x31 + 3, below, { steps: 8 });
  await page.mouse.move(last.x - 30, below, { steps: 8 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor: 35, head: 28 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selectedText()).toBe("第四行文字内容");
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("第四行文字内容");
  await page.waitForTimeout(600);

  // Left but still right of the text: the line's end, nothing selected.
  await page.mouse.move(last.x + 400, below);
  await page.mouse.down();
  await page.mouse.move(last.x + 300, below + 5, { steps: 10 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor: 35, head: 35 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 35, head: 35 });
  await page.waitForTimeout(600);

  // Left to right under the text: nothing, the caret at the end.
  await page.mouse.move(last.x + 15, below);
  await page.mouse.down();
  await page.mouse.move(last.x + 70, below, { steps: 10 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor: 35, head: 35 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 35, head: 35 });
  await page.waitForTimeout(600);

  // Left, then back right past the press: the selection goes again.
  await page.mouse.move(last.x + 200, below);
  await page.mouse.down();
  await page.mouse.move(x31 + 3, below, { steps: 6 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor: 35, head: 31 });
  await page.mouse.move(last.x + 300, below, { steps: 6 });
  await page.waitForTimeout(50);
  expect(await held(page)).toEqual({ anchor: 35, head: 35 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 35, head: 35 });
  await page.waitForTimeout(600);

  // Moved left within the click slop: a click, at the end.
  await page.mouse.move(last.x + 30, below);
  await page.mouse.down();
  await page.mouse.move(last.x + 27, below + 1, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 35, head: 35 });
  await page.waitForTimeout(600);

  // With Shift: the anchor stays; dragged left the head is at the pointer's x
  // in the last line, dragged right the end.
  await page.mouse.click(second.x + 30, second.y + second.height / 2);
  const { anchor } = await selection(page);
  await page.waitForTimeout(600);
  await page.keyboard.down("Shift");
  await page.mouse.move(last.x + 400, below);
  await page.mouse.down();
  await page.mouse.move(x31 + 3, below, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ anchor, head: 31 });
  await page.waitForTimeout(600);
  await page.mouse.click(second.x + 30, second.y + second.height / 2);
  await page.waitForTimeout(600);
  await page.keyboard.down("Shift");
  await page.mouse.move(last.x + 40, below);
  await page.mouse.down();
  await page.mouse.move(last.x + 400, below, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(50);
  expect(await selection(page)).toMatchObject({ anchor, head: 35 });
  expect(errors).toEqual([]);
});

// With empty lines ending the document, a drag left below them has its head
// at the pointer's x in the line holding the last character before the end
// (image-view's lastLineAt): the text line above an empty last line (left of
// it its start, so the whole line and its line break), of several empty lines
// the one before the last (only its line break); a document of one empty line
// selects nothing; right of the press nothing (2026-11-08).
test("末行下方空白：末尾是空行时往左拖，head 按 x 落在文末前最后一个字符所在的行，往右拖不选；只有一个空行时不选", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  const lines = editor.locator(":scope > p");
  /** The left edge of the character after `pos` (a position in a text line). */
  const xOf = (pos: number) =>
    editor.evaluate((el: any, pos) => el.editor.view.coordsAtPos(pos).left as number, pos);
  /** Pressed below the last line at `from`, dragged to `to` under it: the selection held, released, and its text. */
  async function dragBelow(from: number, to: number) {
    const count = await lines.count();
    const last = (await lines.nth(count - 1).boundingBox())!;
    const below = last.y + last.height + 60;
    await page.mouse.move(from, below);
    await page.mouse.down();
    await page.mouse.move(to, below + 5, { steps: 10 });
    await page.waitForTimeout(50);
    const during = await held(page);
    await page.mouse.up();
    await page.waitForTimeout(50);
    const after = await editor.evaluate((el: any) => {
      const { state } = el.editor;
      const { anchor, head, from, to } = state.selection;
      return { anchor, head, text: state.doc.textBetween(from, to, "\n") };
    });
    await page.waitForTimeout(600);
    return { during, after };
  }

  // "文字" 0-4, "" 4-6, the end 5.
  await setDoc(page, ["文字", ""]);
  const left = (await lines.nth(0).boundingBox())!.x;
  const right = left + 400;
  await page.mouse.click(right, (await lines.nth(1).boundingBox())!.y + 80);
  expect(await selection(page), "单击").toMatchObject({ type: "text", anchor: 5, head: 5 });
  await page.waitForTimeout(600);
  // Left of the line: "文字" and its line break.
  expect(await dragBelow(right, left - 10), "文字 + 空行：越出行左侧").toEqual({
    during: { anchor: 5, head: 1 },
    after: { anchor: 5, head: 1, text: "文字\n" },
  });
  await frames(page);
  expect(await domEnds(page)).toEqual([5, 1]);
  // Under "字": from it.
  expect(await dragBelow(right, (await xOf(2)) + 3), "文字 + 空行：字下方").toEqual({
    during: { anchor: 5, head: 2 },
    after: { anchor: 5, head: 2, text: "字\n" },
  });
  // Right of the text: only the line break.
  expect(await dragBelow(right, left + 200), "文字 + 空行：文字右侧").toEqual({
    during: { anchor: 5, head: 3 },
    after: { anchor: 5, head: 3, text: "\n" },
  });
  expect(await dragBelow(left + 20, left + 200), "文字 + 空行：往右").toEqual({
    during: { anchor: 5, head: 5 },
    after: { anchor: 5, head: 5, text: "" },
  });

  // Twelve characters and an empty line ("文字文字文字文字文字文字" 0-14, "" 14-16,
  // the end 15): under the 7th character (7-8), from it to the end.
  await setDoc(page, ["文字文字文字文字文字文字", ""]);
  expect(await dragBelow(right, (await xOf(7)) + 3), "12 个字 + 空行：第 7 个字下方").toEqual({
    during: { anchor: 15, head: 7 },
    after: { anchor: 15, head: 7, text: "文字文字文字\n" },
  });

  // A last line with text ("abc" 0-5, the end 4): under "b", "bc".
  await setDoc(page, ["abc"]);
  expect(await dragBelow(right, (await xOf(2)) + 1), "abc：b 下方").toEqual({
    during: { anchor: 4, head: 2 },
    after: { anchor: 4, head: 2, text: "bc" },
  });

  // Three lines and an empty one ("第三行" 10-15, "" 15-17, the end 16): left
  // of the line, the third.
  await setDoc(page, ["第一行", "第二行", "第三行", ""]);
  expect(await dragBelow(right, left - 10), "三行 + 空行").toEqual({
    during: { anchor: 16, head: 11 },
    after: { anchor: 16, head: 11, text: "第三行\n" },
  });
  // With Shift: the anchor (in the first line) stays, the head by x in the third line.
  const first = (await lines.nth(0).boundingBox())!;
  await page.mouse.click(first.x + 20, first.y + first.height / 2);
  const { anchor } = await selection(page);
  expect(anchor).toBeGreaterThan(0);
  expect(anchor).toBeLessThan(5);
  await page.waitForTimeout(600);
  const x12 = (await xOf(12)) + 3;
  await page.keyboard.down("Shift");
  const shifted = await dragBelow(right, x12);
  await page.keyboard.up("Shift");
  expect(shifted.after, "Shift+往左").toMatchObject({ anchor, head: 12 });

  // Three empty lines ending the document ("文字" 0-4, "" 4-6, 6-8, 8-10, the
  // end 9): only the line break of the one before the last, wherever the x.
  await setDoc(page, ["文字", "", "", ""]);
  for (const to of [left - 10, left + 20])
    expect(await dragBelow(right, to), `文字 + 三个空行：${to}`).toEqual({
      during: { anchor: 9, head: 7 },
      after: { anchor: 9, head: 7, text: "\n" },
    });

  // A row of images and an empty line ("上面" 0-4, a 4-5, b 5-6, "" 6-8, the
  // end 7): by x in the images' visual line.
  await setDoc(page, ["上面", { id: "a" }, { id: "b" }, ""]);
  const items = editor.locator(".image-item");
  const a = (await items.nth(0).boundingBox())!;
  const b = (await items.nth(1).boundingBox())!;
  // Left of the row: before a, both images.
  expect(await dragBelow(right, a.x - 10), "图片行 + 空行：行左侧").toMatchObject({
    during: { anchor: 7, head: 4 },
    after: { anchor: 7, head: 4 },
  });
  await expect(editor.locator(".image-selected")).toHaveCount(2);
  // Under b's left half: before b, b only.
  expect(await dragBelow(right, b.x + b.width * 0.25), "图片行 + 空行：b 左半区").toMatchObject({
    during: { anchor: 7, head: 5 },
    after: { anchor: 7, head: 5 },
  });
  await expect(editor.locator(".image-selected")).toHaveCount(1);
  // Under b's right half: after b, only the line break.
  expect(await dragBelow(right, b.x + b.width * 0.75), "图片行 + 空行：b 右半区").toMatchObject({
    during: { anchor: 7, head: 6 },
    after: { anchor: 7, head: 6 },
  });
  await expect(editor.locator(".image-selected")).toHaveCount(0);

  // A single empty line ("" 0-2, the end 1): nothing to select.
  await setDoc(page, [""]);
  expect(await dragBelow(right, left - 10), "只有一个空行").toEqual({
    during: { anchor: 1, head: 1 },
    after: { anchor: 1, head: 1, text: "" },
  });
  expect(errors).toEqual([]);
});

test("末行下方空白：左栏仍选末行，行右侧空白仍在行尾，末尾是图片时仍在图片后", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await setDoc(page, ["第一行文字内容", "第二行文字内容"]);
  // "第一行文字内容" 0-9, "第二行文字内容" 9-18 (text 10-17).
  const lines = editor.locator(":scope > p");
  const first = (await lines.nth(0).boundingBox())!;
  const last = (await lines.nth(1).boundingBox())!;
  const box = (await editor.boundingBox())!;
  const below = last.y + last.height + 60;
  // The left margin below the last line: margin.ts selects the last line.
  await page.mouse.click(box.x + 8, below);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 10, head: 17 });
  await page.waitForTimeout(600);
  // Right of a line above: the end of that line, as the browser puts it.
  await page.mouse.click(first.x + 400, first.y + first.height / 2);
  expect(await selection(page)).toMatchObject({ anchor: 8, head: 8 });
  await page.waitForTimeout(600);
  // A final image: after it, as before.
  await setDoc(page, ["第一行文字内容", { id: "a" }]);
  const image = (await editor.locator(".image-item").boundingBox())!;
  await page.mouse.click(image.x + 30, image.y + image.height + 60);
  expect(await selection(page)).toMatchObject({ type: "blockRange", head: 10, side: -1 });
  expect(errors).toEqual([]);
});
test("无标题笔记打字后删空回到未修改（无 ●）；多留一个空行仍为已修改", async ({ page }) => {
  const errors = await load(page);
  const tabName = page.locator(".tab.active .tab-name");
  const tab = page.locator(".tab.active");
  await page.keyboard.insertText("今天");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("记录");
  await expect(tabName).toHaveText("无标题");
  await expect(tab).toHaveClass(/\bdirty\b/);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect(tabName).toHaveText("无标题");
  await expect(tab).not.toHaveClass(/\bdirty\b/);
  await page.keyboard.insertText("一");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await expect(tabName).toHaveText("无标题");
  await expect(tab).toHaveClass(/\bdirty\b/);
  await page.keyboard.press("Backspace");
  await expect(tabName).toHaveText("无标题");
  await expect(tab).not.toHaveClass(/\bdirty\b/);
  // Two empty lines are other content than the new document's one.
  await page.keyboard.press("Enter");
  await expect(tabName).toHaveText("无标题");
  await expect(tab).toHaveClass(/\bdirty\b/);
  await page.keyboard.press("Backspace");
  await expect(tabName).toHaveText("无标题");
  await expect(tab).not.toHaveClass(/\bdirty\b/);
  expect(errors).toEqual([]);
});
test("恢复的无标题笔记（崩溃残留）删空后回到未修改（无 ●）", async ({ page }) => {
  const errors = await load(page, {
    blocks: [{ type: "line", text: "恢复的内容" }],
    recovered: true,
  });
  const tabName = page.locator(".tab.active .tab-name");
  const tab = page.locator(".tab.active");
  await expect(editorOf(page).locator("p")).toHaveText(["恢复的内容"]);
  await expect(tabName).toHaveText("无标题");
  await expect(tab).toHaveClass(/\bdirty\b/);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await expect(tabName).toHaveText("无标题");
  await expect(tab).not.toHaveClass(/\bdirty\b/);
  expect(errors).toEqual([]);
});
test("已命名文件 Ctrl+S 期间编辑器仍有焦点、不禁用、不变淡，按钮不变灰；保存中打的字保存后仍为已修改并暂存", async ({ page }) => {
  const errors = await load(page, {
    tabs: [{ id: "t1", path: "D:\\笔记\\甲.hush" }],
    holdSave: true,
  });
  const editor = editorOf(page);
  const host = page.locator(".editor-host");
  const tabName = page.locator(".tab.active .tab-name");
  const tab = page.locator(".tab.active");
  const saveButton = page.getByRole("button", { name: "保存", exact: true });
  await page.keyboard.insertText("第一版");
  await expect(tabName).toHaveText("甲.hush");
  await expect(tab).toHaveClass(/\bdirty\b/);
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await calls(page, "save_document")).length).toBe(1);
  // The save is pending (holdSave): nothing on the page changed.
  await expect(editor).toHaveClass(/ProseMirror-focused/);
  await expect(editor).toBeFocused();
  await expect(host).not.toHaveClass(/disabled/);
  await expect(host).toHaveCSS("opacity", "1");
  await expect(saveButton).toBeEnabled();
  await expect(page.getByRole("button", { name: "另存为" })).toBeEnabled();
  await expect(tabName).toHaveText("甲.hush");
  await expect(tab).toHaveClass(/\bdirty\b/);
  // Typing meanwhile goes in as usual.
  await page.keyboard.insertText("，第二版");
  await expect(editor.locator("p")).toHaveText(["第一版，第二版"]);
  await releaseSave(page);
  // The file holds 第一版; the page is dirty again with 第二版, stashed shortly after.
  expect((await calls(page, "save_document"))[0].document.blocks).toEqual([
    { type: "line", text: "第一版" },
  ]);
  await expect(tabName).toHaveText("甲.hush");
  await expect(tab).toHaveClass(/\bdirty\b/);
  await expect(editor).toBeFocused();
  await expect(host).not.toHaveClass(/disabled/);
  await expect
    .poll(async () => (await calls(page, "stash_document")).at(-1)?.document.blocks)
    .toEqual([{ type: "line", text: "第一版，第二版" }]);
  // Saving again with no edits in between clears the mark.
  await page.keyboard.press("Control+s");
  await releaseSave(page);
  await expect(tabName).toHaveText("甲.hush");
  await expect(tab).not.toHaveClass(/\bdirty\b/);
  expect(errors).toEqual([]);
});
test("状态栏照记事本：“行 x，列 y │ 总数 │ 已选”，换行算 1 个字符，每个块算一个附件，选中栏只在选区非空时出现", async ({ page }) => {
  const errors = await load(page);
  const editor = editorOf(page);
  const items = page.locator(".statusbar .status-item");
  const position = page.locator(".statusbar .status-position");
  const count = page.locator(".statusbar .status-count");
  const selected = page.locator(".statusbar .status-selected");
  // "今天天气好" 0-7，a 7、b 8 一行，视频 v 9 另起一行，"明天" 10-14。
  // 7 个字 + 3 个换行（文字行 | 图片行 | 视频行 | 文字行）= 10；图片与视频各算一个附件。
  await setDoc(page, ["今天天气好", { id: "a" }, { id: "b" }, { id: "v", newline: true, kind: "video", duration: 3 }, "明天"]);
  await editor.evaluate((el: any) => el.editor.commands.setTextSelection(3));
  await expect(position).toHaveText("行 1，列 3");
  await expect(count).toHaveText("10 个字符，3 个附件");
  await expect(selected).toHaveCount(0);
  await expect(items).toHaveText(["行 1，列 3", "10 个字符，3 个附件", "100%"]);
  // 位置栏刚好放下“行 100，列 100”：常见行列号变化时总数栏不动。
  expect(Math.round((await position.boundingBox())!.width)).toBe(106);
  const countX = (await count.boundingBox())!.x;
  // 天气好 + 换行 + a b + 换行 + v + 换行 + 明天；总数栏位置不变，选中栏接在后面。
  await editor.evaluate((el: any) => el.editor.commands.setTextSelection({ from: 3, to: 14 }));
  await expect(items).toHaveText(["行 1，列 3", "10 个字符，3 个附件", "已选 8 个字符，3 个附件", "100%"]);
  expect((await count.boundingBox())!.x).toBe(countX);
  // 只选文字：0 个附件也照写。
  await editor.evaluate((el: any) => el.editor.commands.setTextSelection({ from: 3, to: 5 }));
  await expect(selected).toHaveText("已选 2 个字符，0 个附件");
  // 只选中视频：0 个字符。
  await clickHalf(tile(page, 2), "left");
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toMatchObject({ type: "blockRange", anchor: 9, head: 10 });
  await expect(selected).toHaveText("已选 0 个字符，1 个附件");
  await expect(count).toHaveText("10 个字符，3 个附件");
  // 没有附件的文档：两栏都不写附件部分；全选后打字，选中栏随选区清空而消失。
  await setDoc(page, ["ab", "", "c😀"]);
  await editor.evaluate((el: any) => el.editor.commands.focus("end"));
  await expect(items).toHaveText(["行 3，列 4", "6 个字符", "100%"]);
  await page.keyboard.press("Control+a");
  await expect(items).toHaveText(["行 1，列 1", "6 个字符", "已选 6 个字符", "100%"]);
  await page.keyboard.insertText("新");
  await expect(items).toHaveText(["行 1，列 2", "1 个字符", "100%"]);
  expect(errors).toEqual([]);
});
