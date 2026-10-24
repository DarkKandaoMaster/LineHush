import { test, expect, type Page } from "@playwright/test";
import {
  calls,
  caretOf,
  editorOf,
  frames,
  load,
  loadSample,
  selection,
  setDoc,
  type Item,
} from "./helpers";

// 左栏选行（src/editor/margin.ts）：在 .tiptap 的左内边距（16px）单击 / 拖动选中整行，
// 包含换行；设置“左栏选行”为“视觉行”时只选一折。

/** 左栏中线的 x 与第 i 个顶层块（p 或 .image-item）的中线 y。 */
async function gutterAt(page: Page, i: number) {
  const editor = (await editorOf(page).boundingBox())!;
  const box = (await editorOf(page).locator(":scope > p, :scope > .image-item").nth(i).boundingBox())!;
  return { x: editor.x + 8, y: box.y + box.height / 2 };
}
async function clickGutter(page: Page, i: number, shift = false) {
  const at = await gutterAt(page, i);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.click(at.x, at.y);
  if (shift) await page.keyboard.up("Shift");
}
/** 编辑器有焦点、浏览器的 DOM 选区与编辑器的一致、画出的选区路径。 */
const state = (page: Page) =>
  editorOf(page).evaluate(async (el: any) => {
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done)));
    const view = el.editor.view;
    const dom = getSelection()!;
    return {
      focused: document.activeElement === el,
      dom: [
        view.posAtDOM(dom.anchorNode, dom.anchorOffset),
        view.posAtDOM(dom.focusNode, dom.focusOffset),
      ],
      drawn: el.parentElement.querySelector(".selection-layer path")?.getAttribute("d") ?? "",
      images: el.querySelectorAll(".image-selected").length,
    };
  });

const LINES: Item[] = ["第一行", "第二行", "第三行", "第四行"];
// "第一行" 0-5（文字 1-4），"第二行" 5-10，"第三行" 10-15，"第四行" 15-20（文字 16-19）。

test("单击左栏选中一行，含换行（选区到下一段 +1），焦点留在编辑器，指针为反向箭头", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await clickGutter(page, 1);
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 11 });
  const s = await state(page);
  expect(s.focused).toBe(true);
  expect(s.dom).toEqual([6, 11]);
  expect(s.drawn).not.toBe("");
  // 换行画成行尾多半个字：选区比这一行的文字宽。
  const width = await editorOf(page).evaluate((el: any) => {
    const p = el.querySelectorAll(":scope > p")[1];
    const range = document.createRange();
    range.selectNodeContents(p);
    const text = range.getBoundingClientRect();
    const path = el.parentElement.querySelector(".selection-layer path").getBBox();
    return { text: text.width, path: path.width };
  });
  expect(width.path).toBeGreaterThan(width.text + 4);
  // 光标画在下一行行首。
  await frames(page);
  const caret = await caretOf(page);
  const third = (await editorOf(page).locator("p").nth(2).boundingBox())!;
  expect(Math.abs(caret.y - third.y)).toBeLessThan(2);
  // 指针：SVG 反向箭头，热点在尖端。
  const cursor = await page.locator(".margin-gutter").evaluate((el) => getComputedStyle(el).cursor);
  expect(cursor).toMatch(/^url\("data:image\/svg\+xml,.*"\) 13 0, default$/);
  expect(errors).toEqual([]);
});

test("单击最后一行：只到行尾（没有换行）；首行上方与末行下方的空白选首行 / 末行", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await clickGutter(page, 3);
  expect(await selection(page)).toEqual({ type: "text", anchor: 16, head: 19 });
  const editor = (await editorOf(page).boundingBox())!;
  // 顶部内边距里（首行上方）。
  await page.mouse.click(editor.x + 8, editor.y + 4);
  expect(await selection(page)).toEqual({ type: "text", anchor: 1, head: 6 });
  // 底部 40vh 空白（末行下方）。
  await page.mouse.click(editor.x + 8, editor.y + editor.height - 20);
  expect(await selection(page)).toEqual({ type: "text", anchor: 16, head: 19 });
  // 空文档：光标在唯一的空行里。
  await setDoc(page, [""]);
  await page.mouse.click(editor.x + 8, editor.y + 30);
  expect(await selection(page)).toEqual({ type: "text", anchor: 1, head: 1 });
  expect(errors).toEqual([]);
});

test("单击图片行旁的左栏：选中整行图片到下一行行首；文字行后接图片行时到图片之前", async ({ page }) => {
  const errors = await loadSample(page);
  // "上面" 0-4，a 4-5、b 5-6 一行，"下面" 6-10。
  await clickGutter(page, 1);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 4, head: 7 });
  let s = await state(page);
  expect(s.images).toBe(2);
  expect(s.focused).toBe(true);
  // 浏览器的 DOM 选区与编辑器的一致（读回不会被改成别的选区）。
  expect(s.dom).toEqual([4, 7]);
  await clickGutter(page, 0);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 1, head: 4 });
  s = await state(page);
  expect(s.images).toBe(0);
  expect(s.dom).toEqual([1, 4]);
  expect(s.drawn).not.toBe("");
  // 图片行是最后一行：到最后一张图片之后。
  await setDoc(page, ["上面", { id: "a" }, { id: "b" }]);
  await clickGutter(page, 1);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 4, head: 6 });
  s = await state(page);
  expect(s.dom).toEqual([4, 6]);
  expect(s.images).toBe(2);
  expect(await page.evaluate(() => (window as any).selections)).not.toContain("node");
  expect(errors).toEqual([]);
});

test("Shift+单击：左栏产生的选区保持锚行取并集；否则从当前 anchor 扩到点击行的行末 / 行首", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await clickGutter(page, 1);
  await clickGutter(page, 3, true);
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 19 });
  // 再 Shift+单击上方：锚行仍是第二行，anchor 换到它的行末。
  await clickGutter(page, 0, true);
  expect(await selection(page)).toEqual({ type: "text", anchor: 11, head: 1 });
  // 选区不是左栏产生的：光标在第二行中间（7），点下方扩到行末、点上方扩到行首。
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(7));
  await clickGutter(page, 2, true);
  expect(await selection(page)).toEqual({ type: "text", anchor: 7, head: 16 });
  await editorOf(page).evaluate((el: any) => el.editor.commands.setTextSelection(7));
  await clickGutter(page, 0, true);
  expect(await selection(page)).toEqual({ type: "text", anchor: 7, head: 1 });
  expect(errors).toEqual([]);
});

test("左栏拖动按行扩展：向下 head 在当前行下一行行首，向上 anchor 在锚行末；越出编辑区钳到首行 / 末行", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  let at = await gutterAt(page, 1);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 11 });
  const moveTo = async (x: number, y: number) => {
    for (let i = 1; i <= 6; i++)
      await page.mouse.move(at.x + ((x - at.x) * i) / 6, at.y + ((y - at.y) * i) / 6);
    at = { x, y };
  };
  // 向下到第三行（指针离开左栏进正文也照样按行）。
  const third = await gutterAt(page, 2);
  await moveTo(third.x + 200, third.y);
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 16 });
  // 越出窗口底部：末行。
  await moveTo(third.x, page.viewportSize()!.height + 50);
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 19 });
  // 向上到第一行：anchor 在锚行末（第三行行首），head 在第一行行首。
  const first = await gutterAt(page, 0);
  await moveTo(first.x, first.y);
  expect(await selection(page)).toEqual({ type: "text", anchor: 11, head: 1 });
  // 越出窗口顶部：首行。
  await moveTo(first.x, -40);
  expect(await selection(page)).toEqual({ type: "text", anchor: 11, head: 1 });
  // 回到锚行：只有锚行。
  const second = await gutterAt(page, 1);
  await moveTo(second.x, second.y);
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 11 });
  await page.mouse.up();
  const s = await state(page);
  expect(s.dom).toEqual([6, 11]);
  expect(s.focused).toBe(true);
  // 松开后在正文里移动不再改选区。
  await page.mouse.move(third.x + 100, third.y);
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 11 });
  expect(errors).toEqual([]);
});

test("左栏拖过图片行：图片行按整行加入选区", async ({ page }) => {
  const errors = await loadSample(page);
  let at = await gutterAt(page, 0);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const last = await gutterAt(page, 3);
  for (let i = 1; i <= 8; i++) await page.mouse.move(at.x, at.y + ((last.y - at.y) * i) / 8);
  expect(await selection(page)).toEqual({ type: "text", anchor: 1, head: 9 });
  // 向上回到图片行。
  const row = await gutterAt(page, 1);
  at = last;
  for (let i = 1; i <= 8; i++) await page.mouse.move(at.x, at.y + ((row.y - at.y) * i) / 8);
  expect(await selection(page)).toEqual({ type: "text", anchor: 1, head: 7 });
  await page.mouse.up();
  expect((await state(page)).images).toBe(2);
  expect(errors).toEqual([]);
});

const LONG =
  "今天天气很好，我们去公园散步，看见湖边有很多人在钓鱼。孩子们在草地上奔跑，老人坐在长椅上晒太阳聊天。" +
  "中午在附近的小馆子吃了一碗面，味道一般但是分量很足。下午回家整理了书架，把不再看的旧书装进箱子里准备捐出去。" +
  "晚上又下起了小雨，窗外的路灯把树影投在墙上，一晃一晃的，我泡了杯茶坐在窗边看了很久。";

/** 长段落（第 1 个块，文字从 5 开始）的每个折行位置及其上下两处。 */
const wraps = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const view = el.editor.view;
    const out: { pos: number; up: any; down: any }[] = [];
    for (let pos = 6; pos < 5 + view.state.doc.child(1).content.size; pos++) {
      const up = view.coordsAtPos(pos, -1);
      const down = view.coordsAtPos(pos, 1);
      if (Math.abs(up.top - down.top) > 2) out.push({ pos, up, down });
    }
    return out;
  });

test("视觉行：长段落折行时只选指针所在的一折，非最后一折光标画在这一折末尾，最后一折含换行", async ({ page }) => {
  const errors = await load(page, { settings: { marginSelection: "visualLine" } });
  await setDoc(page, ["上面", LONG, "下面"]);
  const w = await wraps(page);
  expect(w.length).toBeGreaterThanOrEqual(2);
  const editor = (await editorOf(page).boundingBox())!;
  const x = editor.x + 8;
  // 第一折：从段首到第一个折行处，光标在上一行（这一折）末尾。
  await page.mouse.click(x, (w[0].up.top + w[0].up.bottom) / 2);
  expect(await selection(page)).toEqual({ type: "text", anchor: 5, head: w[0].pos });
  await frames(page);
  let caret = await caretOf(page);
  expect(Math.abs(caret.y - w[0].up.top)).toBeLessThan(1.5);
  expect(Math.abs(caret.x - w[0].up.left)).toBeLessThan(1.5);
  // 第二折。
  await page.mouse.click(x, (w[1].up.top + w[1].up.bottom) / 2);
  expect(await selection(page)).toEqual({ type: "text", anchor: w[0].pos, head: w[1].pos });
  // 最后一折：到下一段行首（含换行）。
  const end = w[w.length - 1];
  await page.mouse.click(x, (end.down.top + end.down.bottom) / 2);
  const tail = await selection(page);
  expect(tail.anchor).toBe(end.pos);
  expect(tail.head).toBe(5 + LONG.length + 2);
  // 向上拖：在第三折按下，拖到第二折，anchor 在锚折末（第三折之后），head 在第二折首，
  // 光标画在第二折开头（不是第一折末尾）。
  const third = (w[1].down.top + w[1].down.bottom) / 2;
  await page.mouse.move(x, third);
  await page.mouse.down();
  await page.mouse.move(x, third - 4);
  await page.mouse.move(x, (w[0].down.top + w[0].down.bottom) / 2);
  const thirdEnd = w.length > 2 ? w[2].pos : 5 + LONG.length + 2;
  expect(await selection(page)).toEqual({ type: "text", anchor: thirdEnd, head: w[0].pos });
  await page.mouse.up();
  await frames(page);
  caret = await caretOf(page);
  expect(Math.abs(caret.y - w[0].down.top)).toBeLessThan(1.5);
  expect(Math.abs(caret.x - w[0].down.left)).toBeLessThan(1.5);
  // 整行模式（默认）下同一处选整段。
  await page.locator(".settings-button").click();
  const dialog = page.locator("dialog.settings-dialog");
  const group = dialog.getByRole("radiogroup", { name: "左栏选行" });
  await expect(group.getByRole("radio", { name: "视觉行" })).toBeChecked();
  await group.getByRole("radio", { name: "整行" }).check();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.mouse.click(x, (w[0].down.top + w[0].down.bottom) / 2);
  expect(await selection(page)).toEqual({ type: "text", anchor: 5, head: 5 + LONG.length + 2 });
  await expect
    .poll(async () => (await calls(page, "write_settings")).at(-1)?.settings.marginSelection)
    .toBe("line");
  expect(errors).toEqual([]);
});

test("视觉行：一行图片折成几排时只选指针所在的那一排", async ({ page }) => {
  const errors = await load(page, { settings: { marginSelection: "visualLine" } });
  const images: Item[] = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => ({ id, newline: i === 0 }));
  await setDoc(page, ["上面", ...images, "下面"]);
  // 各图的顶边，分出几排；"上面" 0-4，图片 4..11，"下面" 11-15。
  const tops = await editorOf(page).evaluate((el: any) =>
    Array.from(el.querySelectorAll(".image-item") as NodeListOf<HTMLElement>).map((item) =>
      Math.round(item.getBoundingClientRect().top),
    ),
  );
  const firstOfSecond = tops.findIndex((top) => top !== tops[0]);
  expect(firstOfSecond).toBeGreaterThan(0);
  const items = editorOf(page).locator(".image-item");
  const editor = (await editorOf(page).boundingBox())!;
  const firstRow = (await items.nth(0).boundingBox())!;
  await page.mouse.click(editor.x + 8, firstRow.y + firstRow.height / 2);
  expect(await selection(page)).toEqual({ type: "blockRange", anchor: 4, head: 4 + firstOfSecond });
  expect((await state(page)).images).toBe(firstOfSecond);
  // 最后一排：到下一行行首（含换行）。
  const lastRow = (await items.nth(6).boundingBox())!;
  await page.mouse.click(editor.x + 8, lastRow.y + lastRow.height / 2);
  const tail = await selection(page);
  expect(tail.head).toBe(12);
  expect(tail.anchor).toBe(4 + tops.findIndex((top) => top === Math.round(lastRow.y)));
  expect(errors).toEqual([]);
});

test("从正文开始拖选经过左栏不被挡住（按下期间左栏不接收指针）", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  const editor = (await editorOf(page).boundingBox())!;
  const p = (await editorOf(page).locator("p").nth(2).boundingBox())!;
  await page.mouse.move(p.x + 30, p.y + p.height / 2);
  await page.mouse.down();
  const passive = await page.locator(".margin-gutter").evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(passive).toBe("none");
  const first = (await editorOf(page).locator("p").nth(0).boundingBox())!;
  for (let i = 1; i <= 8; i++)
    await page.mouse.move(p.x + 30 + ((editor.x + 4 - p.x - 30) * i) / 8, p.y + ((first.y - p.y) * i) / 8 + 2);
  await page.mouse.up();
  const sel = await selection(page);
  expect(sel.type).toBe("text");
  expect(sel.head).toBe(1);
  expect(await page.locator(".margin-gutter").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
  expect(errors).toEqual([]);
});

test("左栏拖动中窗口失焦：拖动结束，之后移动 / 滚动不再改选区，左栏恢复接收指针", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  const second = await gutterAt(page, 1);
  await page.mouse.move(second.x, second.y);
  await page.mouse.down();
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 11 });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const fourth = await gutterAt(page, 3);
  for (let i = 1; i <= 6; i++) await page.mouse.move(second.x, second.y + ((fourth.y - second.y) * i) / 6);
  await editorOf(page).evaluate((el: any) => el.closest(".editor-host").dispatchEvent(new Event("scroll")));
  expect(await selection(page)).toEqual({ type: "text", anchor: 6, head: 11 });
  await page.mouse.up();
  expect(await page.locator(".margin-gutter").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
  expect(errors).toEqual([]);
});

test("外部文件拖放落在左栏里：拖放期间左栏不接收指针，drop 进编辑器导入图片；结束后恢复", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  const at = await gutterAt(page, 1);
  const result = await page.evaluate(({ x, y }) => {
    const gutter = document.querySelector(".margin-gutter")!;
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }));
    const init = { clientX: x, clientY: y, dataTransfer: data, bubbles: true, cancelable: true };
    const before = document.elementFromPoint(x, y) === gutter;
    document.elementFromPoint(x, y)!.dispatchEvent(new DragEvent("dragenter", init));
    const passive = getComputedStyle(gutter).pointerEvents;
    const target = document.elementFromPoint(x, y)!;
    target.dispatchEvent(new DragEvent("dragover", init));
    target.dispatchEvent(new DragEvent("drop", init));
    return {
      before,
      passive,
      inEditor: !!target.closest(".tiptap"),
      after: getComputedStyle(gutter).pointerEvents,
    };
  }, at);
  expect(result).toEqual({ before: true, passive: "none", inEditor: true, after: "auto" });
  await expect.poll(async () => (await calls(page, "import_image")).length).toBe(1);
  // 拖出窗口（dragleave，没有 relatedTarget、坐标在窗口外）也恢复。
  const left = await page.evaluate(({ x, y }) => {
    const gutter = document.querySelector(".margin-gutter")!;
    const init = { clientX: x, clientY: y, bubbles: true, cancelable: true };
    gutter.dispatchEvent(new DragEvent("dragenter", init));
    const passive = getComputedStyle(gutter).pointerEvents;
    document.querySelector(".tiptap")!.dispatchEvent(
      new DragEvent("dragleave", { ...init, clientX: -5, clientY: y }),
    );
    return [passive, getComputedStyle(gutter).pointerEvents];
  }, at);
  expect(left).toEqual(["none", "auto"]);
  // 拖放结束后没有 mouseup：之后第一次不按键的移动也恢复。
  await page.evaluate(({ x, y }) =>
    document.querySelector(".margin-gutter")!.dispatchEvent(
      new DragEvent("dragenter", { clientX: x, clientY: y, bubbles: true }),
    ), at);
  await page.mouse.move(at.x + 100, at.y);
  await page.mouse.move(at.x, at.y);
  expect(await page.locator(".margin-gutter").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
  expect(errors).toEqual([]);
});
