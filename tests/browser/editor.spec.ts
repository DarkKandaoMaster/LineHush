import { test, expect, type Page } from "@playwright/test";
import { editorOf, frames, load, selection, setDoc } from "./helpers";

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
