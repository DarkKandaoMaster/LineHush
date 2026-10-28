import { test, expect, type Page } from "@playwright/test";
import { calls, editorOf, frames, load, near, pixel, selection, setDoc, shoot } from "./helpers";

// 查找 / 替换（src/editor/find.ts、src/hooks/useFind.ts、src/components/FindWidget.tsx）：
// Ctrl+F / Ctrl+H 打开右上角的查找条，其余匹配半透明橙色高亮（.find-match），当前匹配是真实选区、
// 另加不透明的灰橄榄色装饰（.find-match-current），颜色照 VS Code 浅色主题。

const widget = (page: Page) => page.getByRole("search", { name: "查找与替换" });
const findBox = (page: Page) => page.getByRole("textbox", { name: "查找", exact: true });
const replaceBox = (page: Page) => page.getByRole("textbox", { name: "替换", exact: true });
const count = (page: Page) => widget(page).locator(".find-count");
const marks = (page: Page) => editorOf(page).locator(".find-match");
const currentMark = (page: Page) => editorOf(page).locator(".find-match-current");
/** 自绘选区路径的填充色（computed）。 */
const selectionFill = (page: Page) =>
  editorOf(page).evaluate(
    (el: any) => getComputedStyle(el.parentElement.querySelector(".selection-layer path")).fill,
  );
const ACTIVE = "rgb(151, 198, 235)"; // #97c6eb
const INACTIVE = "rgb(213, 221, 230)"; // #d5dde6
const caretAt = (page: Page, from: number, to = from) =>
  editorOf(page).evaluate(
    (el: any, [from, to]) => el.editor.commands.setTextSelection({ from, to }),
    [from, to],
  );
/** 一个按键在页面里是否被 preventDefault（监听器挂在 window 上、排在应用之后）。 */
async function prevented(page: Page, key: string) {
  await page.evaluate(() => {
    const w = window as any;
    w.lastPrevented = null;
    if (w.watchingPrevented) return;
    w.watchingPrevented = true;
    window.addEventListener("keydown", (e) => (w.lastPrevented = e.defaultPrevented));
  });
  await page.keyboard.press(key);
  return page.evaluate(() => (window as any).lastPrevented);
}

// "今天天气好" 0-7（文字 1-6，“天气” 3-5），"明天天气也好" 7-15（“天气” 10-12），
// "天气" 15-19（文字 16-18）。
const LINES = ["今天天气好", "明天天气也好", "天气"];

test("Ctrl+F 打开查找条，输入即高亮并选中，Enter / Shift+Enter 首尾循环", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await caretAt(page, 1);
  // 拦掉 WebView2 自带的查找条。
  expect(await prevented(page, "Control+f")).toBe(true);
  await expect(widget(page)).toBeVisible();
  await expect(findBox(page)).toBeFocused();
  await expect(count(page)).toHaveText("");
  await page.keyboard.type("天气");
  await expect(count(page)).toHaveText("1 / 3");
  expect(await selection(page)).toEqual({ type: "text", anchor: 3, head: 5 });
  // 当前匹配是选区，另加 .find-match-current；其余两个 .find-match。
  await expect(marks(page)).toHaveCount(2);
  await expect(marks(page)).toHaveText(["天气", "天气"]);
  await expect(currentMark(page)).toHaveCount(1);
  const currentIn = () =>
    editorOf(page).evaluate((el: any) => {
      const span = el.querySelector(".find-match-current");
      if (!span) return null;
      const view = el.editor.view;
      return [view.posAtDOM(span, 0), view.posAtDOM(span, span.childNodes.length)];
    });
  expect(await currentIn()).toEqual([3, 5]);
  // 选区层画出了当前匹配（编辑器失焦也照常显示）。
  const drawn = await editorOf(page).evaluate(
    (el: any) => el.parentElement.querySelector(".selection-layer path")?.getAttribute("d") ?? "",
  );
  expect(drawn).not.toBe("");
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("2 / 3");
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  // 当前装饰随选区换到第二个匹配。
  expect(await currentIn()).toEqual([10, 12]);
  await expect(marks(page)).toHaveText(["天气", "天气"]);
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("3 / 3");
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("1 / 3");
  await page.keyboard.press("Shift+Enter");
  await expect(count(page)).toHaveText("3 / 3");
  expect(await selection(page)).toEqual({ type: "text", anchor: 16, head: 18 });
  // 跳转后焦点仍在输入框里。
  await expect(findBox(page)).toBeFocused();
  // 按钮同 Enter / Shift+Enter。
  await widget(page).getByRole("button", { name: "下一个匹配项" }).click();
  await expect(count(page)).toHaveText("1 / 3");
  await widget(page).getByRole("button", { name: "上一个匹配项" }).click();
  await expect(count(page)).toHaveText("3 / 3");
  await expect(widget(page).getByRole("button", { name: "下一个匹配项" })).toHaveAttribute(
    "title",
    "下一个匹配项 (Enter)",
  );
  // 选区不是匹配时显示“共 n 项”，没有当前装饰。
  await caretAt(page, 2);
  await expect(count(page)).toHaveText("共 3 项");
  await expect(marks(page)).toHaveCount(3);
  await expect(currentMark(page)).toHaveCount(0);
  // 选区比匹配大（盖过第一个匹配）：仍是 .find-match，没有当前装饰。
  await caretAt(page, 1, 6);
  await expect(marks(page)).toHaveCount(3);
  await expect(currentMark(page)).toHaveCount(0);
  // 选区恰好等于某个匹配（不经查找条）：它成为当前。
  await caretAt(page, 16, 18);
  await expect(count(page)).toHaveText("3 / 3");
  expect(await currentIn()).toEqual([16, 18]);
  await caretAt(page, 2);
  // 在编辑器里改动，匹配随之重算。
  await editorOf(page).evaluate((el: any) => el.editor.commands.insertContentAt(19, "天气"));
  await expect(count(page)).toHaveText("共 4 项");
  expect(errors).toEqual([]);
});

test("查询从光标处往后找第一个，没有就回到第一个；无结果时红字、按钮禁用、选区不动", async ({
  page,
}) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await caretAt(page, 8);
  await page.keyboard.press("Control+f");
  await page.keyboard.type("天气");
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  await expect(count(page)).toHaveText("2 / 3");
  await findBox(page).fill("");
  await caretAt(page, 18);
  await findBox(page).fill("天气");
  await expect(count(page)).toHaveText("1 / 3");
  await caretAt(page, 2);
  await findBox(page).fill("下雨");
  await expect(count(page)).toHaveText("无结果");
  await expect(count(page)).toHaveClass(/none/);
  expect(
    await count(page).evaluate((el) => getComputedStyle(el).color),
  ).toBe("rgb(196, 43, 28)");
  await expect(widget(page).getByRole("button", { name: "下一个匹配项" })).toBeDisabled();
  await expect(widget(page).getByRole("button", { name: "上一个匹配项" })).toBeDisabled();
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 2 });
  await expect(marks(page)).toHaveCount(0);
  // Enter 无结果时什么也不做。
  await page.keyboard.press("Enter");
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 2 });
  expect(errors).toEqual([]);
});

test("Alt+C 区分大小写、Alt+W 全字匹配，开关有选中态", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, ["Cat cat concat", "CAT"]);
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  await page.keyboard.type("cat");
  await expect(count(page)).toHaveText("1 / 4");
  const caseButton = widget(page).getByRole("button", { name: "Aa" });
  const wordButton = widget(page).getByTitle("全字匹配 (Alt+W)");
  await expect(caseButton).toHaveAttribute("title", "区分大小写 (Alt+C)");
  await expect(caseButton).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Alt+c");
  await expect(caseButton).toHaveAttribute("aria-pressed", "true");
  await expect(caseButton).toHaveClass(/on/);
  // "cat"（5-8）与 "concat" 里的（12-15）。
  await expect(count(page)).toHaveText("1 / 2");
  expect(await selection(page)).toEqual({ type: "text", anchor: 5, head: 8 });
  await page.keyboard.press("Alt+w");
  await expect(wordButton).toHaveAttribute("aria-pressed", "true");
  await expect(count(page)).toHaveText("1 / 1");
  await page.keyboard.press("Alt+c");
  // 不区分大小写的全字：Cat、cat、CAT。
  await expect(count(page)).toHaveText("2 / 3");
  // 点按钮同快捷键，焦点留在输入框。
  await wordButton.click();
  await expect(wordButton).toHaveAttribute("aria-pressed", "false");
  await expect(findBox(page)).toBeFocused();
  await expect(count(page)).toHaveText("2 / 4");
  expect(errors).toEqual([]);
});

test("Ctrl+F 用同一段落内的文字选区预填并全选；已开着时再按重新聚焦全选", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await caretAt(page, 10, 12);
  await page.keyboard.press("Control+f");
  await expect(findBox(page)).toHaveValue("天气");
  await expect(count(page)).toHaveText("2 / 3");
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  const selected = () =>
    findBox(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
  expect(await selected()).toEqual([0, 2]);
  await page.keyboard.press("End");
  expect(await selected()).toEqual([2, 2]);
  await page.keyboard.press("Control+f");
  expect(await selected()).toEqual([0, 2]);
  // 跨段落的选区不预填，保留上次的查询。
  await page.keyboard.press("Escape");
  await caretAt(page, 2, 9);
  await page.keyboard.press("Control+f");
  await expect(findBox(page)).toHaveValue("天气");
  await expect(count(page)).toHaveText("共 3 项");
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 9 });
  // 焦点在编辑器里、选中新文字时再按 Ctrl+F，重新预填。
  await caretAt(page, 1, 3);
  await editorOf(page).focus();
  await page.keyboard.press("Control+f");
  await expect(findBox(page)).toHaveValue("今天");
  await expect(findBox(page)).toBeFocused();
  expect(errors).toEqual([]);
});

test("Esc 关闭：高亮清空、选区保持、焦点回编辑器；再开保留查询与替换行状态", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  await page.keyboard.type("天气");
  await page.keyboard.press("Enter");
  await expect(marks(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(widget(page)).toHaveCount(0);
  await expect(marks(page)).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  // 浏览器的 DOM 选区与编辑器一致（焦点回来时没被重置到开头）。
  const dom = await editorOf(page).evaluate((el: any) => {
    const sel = getSelection()!;
    return [
      el.editor.view.posAtDOM(sel.anchorNode, sel.anchorOffset),
      el.editor.view.posAtDOM(sel.focusNode, sel.focusOffset),
    ];
  });
  expect(dom).toEqual([10, 12]);
  // 打字替换选区：说明焦点与选区都在编辑器里。
  await page.keyboard.insertText("晴");
  await expect(editorOf(page).locator("p").nth(1)).toHaveText("明天晴也好");
  // 再打开：查询还在，高亮回来（选区不是匹配）；×关闭。
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  await expect(findBox(page)).toHaveValue("天气");
  await expect(count(page)).toHaveText("共 2 项");
  await expect(marks(page)).toHaveCount(2);
  await widget(page).getByRole("button", { name: "关闭" }).click();
  await expect(widget(page)).toHaveCount(0);
  await expect(marks(page)).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  // 替换行展开的状态保留到下一次 Ctrl+F。
  await page.keyboard.press("Control+h");
  await expect(replaceBox(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+f");
  await expect(replaceBox(page)).toBeVisible();
  await widget(page).getByRole("button", { name: "切换替换" }).click();
  await expect(replaceBox(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+f");
  await expect(replaceBox(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("F3 / Shift+F3：查找条关着也按上次的查询跳转；没有查询时等同 Ctrl+F", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await caretAt(page, 1);
  expect(await prevented(page, "F3")).toBe(true);
  await expect(widget(page)).toBeVisible();
  await expect(findBox(page)).toBeFocused();
  await page.keyboard.type("天气");
  await page.keyboard.press("Escape");
  await expect(editorOf(page)).toBeFocused();
  expect(await selection(page)).toEqual({ type: "text", anchor: 3, head: 5 });
  expect(await prevented(page, "F3")).toBe(true);
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  await expect(widget(page)).toHaveCount(0);
  await expect(marks(page)).toHaveCount(0);
  await page.keyboard.press("F3");
  await page.keyboard.press("F3");
  expect(await selection(page)).toEqual({ type: "text", anchor: 3, head: 5 });
  await page.keyboard.press("Shift+F3");
  expect(await selection(page)).toEqual({ type: "text", anchor: 16, head: 18 });
  await expect(editorOf(page)).toBeFocused();
  expect(errors).toEqual([]);
});

test("Ctrl+H 展开替换：替换一个并跳到下一个，全部替换一个事务、Ctrl+Z 一次全部撤销", async ({
  page,
}) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await caretAt(page, 1);
  expect(await prevented(page, "Control+h")).toBe(true);
  await expect(replaceBox(page)).toBeVisible();
  // 查找框为空：焦点在查找框。
  await expect(findBox(page)).toBeFocused();
  await page.keyboard.type("天气");
  await expect(count(page)).toHaveText("1 / 3");
  // 再按 Ctrl+H：查找框有字，焦点到替换框。
  await page.keyboard.press("Control+h");
  await expect(replaceBox(page)).toBeFocused();
  await page.keyboard.type("心情");
  await expect(
    widget(page).getByRole("button", { name: "全部替换", exact: true }),
  ).toHaveAttribute("title", "全部替换 (Ctrl+Alt+Enter)");
  // Enter = 替换一个：换掉当前匹配，选中下一个。
  await page.keyboard.press("Enter");
  await expect(editorOf(page).locator("p")).toHaveText(["今天心情好", "明天天气也好", "天气"]);
  await expect(count(page)).toHaveText("1 / 2");
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  await expect(replaceBox(page)).toBeFocused();
  // 选区不是匹配时“替换”只跳到下一个。
  await caretAt(page, 2);
  await widget(page).getByRole("button", { name: "替换", exact: true }).click();
  await expect(editorOf(page).locator("p")).toHaveText(["今天心情好", "明天天气也好", "天气"]);
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  // 全部替换（Ctrl+Alt+Enter）：一个事务。
  await page.keyboard.press("Control+Alt+Enter");
  await expect(editorOf(page).locator("p")).toHaveText(["今天心情好", "明天心情也好", "心情"]);
  await expect(count(page)).toHaveText("无结果");
  expect((await selection(page)).anchor).toBe((await selection(page)).head);
  // 走正常编辑路径：会话变脏（窗口标题带 ●）、暂存了替换后的正文。
  await expect
    .poll(async () => (await calls(page, "plugin:window|set_title")).at(-1)?.value)
    .toBe("● 无标题");
  await expect
    .poll(async () =>
      (await calls(page, "stash_document")).at(-1)?.document.blocks.map((b: any) => b.text),
    )
    .toEqual(["今天心情好", "明天心情也好", "心情"]);
  await page.keyboard.press("Escape");
  await expect(editorOf(page)).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(editorOf(page).locator("p")).toHaveText(["今天心情好", "明天天气也好", "天气"]);
  await page.keyboard.press("Control+z");
  await expect(editorOf(page).locator("p")).toHaveText(LINES);
  expect(errors).toEqual([]);
});

test("替换为空串即删除；编辑器以外的输入（查找框里的 Ctrl+Z）不动正文", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, ["a-a-a"]);
  await caretAt(page, 1);
  await page.keyboard.press("Control+h");
  await page.keyboard.type("-");
  await widget(page).getByRole("button", { name: "全部替换", exact: true }).click();
  await expect(editorOf(page).locator("p")).toHaveText(["aaa"]);
  await findBox(page).focus();
  await page.keyboard.press("Control+z");
  await expect(editorOf(page).locator("p")).toHaveText(["aaa"]);
  expect(errors).toEqual([]);
});

test("查找条在编辑区右上角、距顶 4px，盖在正文与左栏之上，被盖住的匹配滚到它下面", async ({ page }) => {
  const errors = await load(page);
  // 很多行，最后一行的末尾是要找的字，长到伸到查找条下面。
  const lines = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行`);
  lines.push(`${"占".repeat(60)}目标`);
  lines.push(...Array.from({ length: 80 }, (_, i) => `后 ${i + 1} 行`));
  await setDoc(page, lines);
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  const host = (await page.locator(".tab-pane:not([hidden]) .editor-host").boundingBox())!;
  const scrollbar = await page
    .locator(".tab-pane:not([hidden]) .editor-host")
    .evaluate((el: HTMLElement) => el.offsetWidth - el.clientWidth);
  const box = (await widget(page).boundingBox())!;
  expect(Math.abs(box.y - host.y - 4)).toBeLessThan(1);
  expect(Math.abs(host.x + host.width - scrollbar - 14 - (box.x + box.width))).toBeLessThan(1);
  // 一行 32px 加上下边框（缩放 100% 时 34px，同 VS Code；边框按设备像素取整）。
  const border = await widget(page).evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
  expect(border).toBeGreaterThan(0);
  expect(Math.abs(box.height - 32 - 2 * border)).toBeLessThan(0.1);
  // 盖在最上面：查找条中点处的元素是查找条自己。
  const top = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".find-widget"),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(top).toBe(true);
  await page.keyboard.press("Escape");
  // 窗口很矮（安全区 = 视口一半，不到展开替换后的查找条高）：揭示后匹配会落在查找条下面，
  // 再往回滚，让它落到查找条下方。
  await page.setViewportSize({ width: 1000, height: 200 });
  await caretAt(page, 1);
  await page.keyboard.press("Control+h");
  await page.keyboard.type("目标");
  await expect(count(page)).toHaveText("1 / 1");
  await frames(page);
  const match = await editorOf(page).evaluate((el: any) => {
    const view = el.editor.view;
    const { from, to } = view.state.selection;
    const a = view.coordsAtPos(from, 1);
    const b = view.coordsAtPos(to, -1);
    return { top: a.top, bottom: b.bottom, left: a.left, right: b.right };
  });
  const now = (await widget(page).boundingBox())!;
  const viewport = (await page.locator(".tab-pane:not([hidden]) .editor-host").boundingBox())!;
  // 匹配在查找条横向范围里，且落在查找条下方、仍在可见范围内。
  expect(match.right > now.x && match.left < now.x + now.width).toBe(true);
  expect(match.top).toBeGreaterThanOrEqual(now.y + now.height);
  expect(match.bottom).toBeLessThanOrEqual(viewport.y + viewport.height);
  expect(errors).toEqual([]);
});

test("高亮颜色（VS Code 浅色）、当前匹配盖住选区、失焦时为非活动选区色；截图", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, ["苹果 苹果", "第二行文字"]);
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  await page.keyboard.type("苹果");
  await expect(marks(page)).toHaveCount(1);
  await expect(currentMark(page)).toHaveCount(1);
  await frames(page);
  const mark = (await marks(page).boundingBox())!;
  const cur = (await currentMark(page).boundingBox())!;
  const clip = { x: 0, y: mark.y - 4, width: mark.x + mark.width + 4, height: mark.height + 8 };
  // 方角；其余匹配 #EA5C0055（半透明），当前匹配 #A8AC94（不透明）。
  const look = (loc: ReturnType<typeof marks>) =>
    loc.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.borderTopLeftRadius, style.backgroundColor];
    });
  expect(await look(marks(page))).toEqual(["0px", "rgba(234, 92, 0, 0.333)"]);
  expect(await look(currentMark(page))).toEqual(["0px", "rgb(168, 172, 148)"]);
  const dpr = await page.evaluate(() => devicePixelRatio);
  type Shot = Awaited<ReturnType<typeof shoot>>;
  const at = (shot: Shot, box: { y: number }, x: number, y: number) =>
    pixel(shot, Math.round(x * dpr), Math.round((y - box.y) * dpr));
  // 焦点在查找框：选区为非活动色；当前匹配左上角 2px 内侧（避开字形）为 #a8ac94，盖住选区；
  // 其余匹配在 #f9f9f9 上合成约 #f4c5a6，方角（紧贴左上角的像素也是高亮色）。
  await expect(findBox(page)).toBeFocused();
  expect(await selectionFill(page)).toBe(INACTIVE);
  let shot = await shoot(page, clip);
  expect(near(at(shot, clip, cur.x + 2, cur.y + 2), "#a8ac94", 3)).toBe(true);
  expect(near(at(shot, clip, mark.x + 2, mark.y + 2), "#f4c5a6", 3)).toBe(true);
  expect(near(at(shot, clip, mark.x + 0.5, mark.y + 0.5), "#f4c5a6", 6)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("find-visual-findbox-focused.png") });
  // 编辑器有焦点：当前匹配仍是 #a8ac94（选区色被盖住）。
  await editorOf(page).evaluate((el: any) => el.editor.view.focus());
  await expect(editorOf(page)).toBeFocused();
  expect(await selectionFill(page)).toBe(ACTIVE);
  await frames(page);
  shot = await shoot(page, clip);
  expect(near(at(shot, clip, cur.x + 2, cur.y + 2), "#a8ac94", 3)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("find-visual-editor-focused.png") });
  // 选区盖过两个匹配（1-6）：都是 .find-match，选区色透过高亮。
  // 编辑器有焦点：1/3 × #ea5c00 + 2/3 × #97c6eb ≈ #b3a39d；中间的空格（不是匹配）是选区色本身。
  await caretAt(page, 1, 6);
  await expect(marks(page)).toHaveCount(2);
  await expect(currentMark(page)).toHaveCount(0);
  await frames(page);
  const space = await editorOf(page).evaluate((el: any) => {
    const a = el.editor.view.coordsAtPos(3, 1);
    const b = el.editor.view.coordsAtPos(4, -1);
    return { x: (a.left + b.right) / 2, y: a.top + 2 };
  });
  shot = await shoot(page, clip);
  expect(near(at(shot, clip, cur.x + 2, cur.y + 2), "#b3a39d", 4)).toBe(true);
  expect(near(at(shot, clip, space.x, space.y), "#97c6eb", 3)).toBe(true);
  // 焦点回查找框：1/3 × #ea5c00 + 2/3 × #d5dde6 ≈ #dcb299；空格处为 #d5dde6。
  await findBox(page).focus();
  expect(await selectionFill(page)).toBe(INACTIVE);
  await frames(page);
  shot = await shoot(page, clip);
  expect(near(at(shot, clip, cur.x + 2, cur.y + 2), "#dcb299", 4)).toBe(true);
  expect(near(at(shot, clip, space.x, space.y), "#d5dde6", 3)).toBe(true);
  await caretAt(page, 1);
  await page.keyboard.press("Control+h");
  await page.screenshot({ path: test.info().outputPath("find-replace.png") });
  // 关掉查找条、选第二行的一段后让编辑器失焦（焦点到别处）：非活动色；回来恢复。
  await page.keyboard.press("Escape");
  await expect(widget(page)).toHaveCount(0);
  await caretAt(page, 8, 12);
  expect(await selectionFill(page)).toBe(ACTIVE);
  await editorOf(page).evaluate((el: HTMLElement) => el.blur());
  expect(await selectionFill(page)).toBe(INACTIVE);
  await frames(page);
  const line2 = await editorOf(page).evaluate((el: any) => {
    const r = el.editor.view.coordsAtPos(9, 1);
    return { x: r.left + 2, y: r.top + 2, top: r.top };
  });
  const band = { x: 0, y: line2.top - 4, width: line2.x + 40, height: 40 };
  shot = await shoot(page, band);
  expect(near(at(shot, band, line2.x, line2.y), "#d5dde6", 3)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("find-visual-blurred-no-widget.png") });
  await editorOf(page).evaluate((el: any) => el.editor.view.focus());
  expect(await selectionFill(page)).toBe(ACTIVE);
  expect(errors).toEqual([]);
});

test("选中图片的蒙层随编辑器焦点换成非活动色；组字时仍由浏览器画原生选区", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, ["上面", { id: "a" }, "下面"]);
  await editorOf(page).evaluate((el: any) => {
    el.editor.view.focus();
    el.editor.commands.setTextSelection({ from: 1, to: 8 });
  });
  await expect(editorOf(page).locator(".image-selected")).toHaveCount(1);
  const overlay = () =>
    editorOf(page)
      .locator(".image-tile")
      .first()
      .evaluate((el) => {
        const after = getComputedStyle(el, "::after");
        return [after.backgroundColor, after.opacity];
      });
  expect(await overlay()).toEqual([ACTIVE, "0.5"]);
  expect(await selectionFill(page)).toBe(ACTIVE);
  // 打开查找条：焦点到查找框，文字选区与图片蒙层都是非活动色。
  await page.keyboard.press("Control+f");
  await expect(findBox(page)).toBeFocused();
  expect(await overlay()).toEqual([INACTIVE, "0.5"]);
  expect(await selectionFill(page)).toBe(INACTIVE);
  // Esc 关闭、焦点回编辑器：恢复活动色。
  await page.keyboard.press("Escape");
  await expect(editorOf(page)).toBeFocused();
  expect(await overlay()).toEqual([ACTIVE, "0.5"]);
  expect(await selectionFill(page)).toBe(ACTIVE);
  // 组字期间仍隐藏自绘选区、用浏览器的原生选区色（.composing 的规则不受非活动色影响）。
  const composing = await editorOf(page).evaluate((el: any) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    const host = el.parentElement;
    const out = {
      composing: host.classList.contains("composing"),
      layer: getComputedStyle(host.querySelector(".selection-layer")).display,
      native: getComputedStyle(el.querySelector("p"), "::selection").backgroundColor,
    };
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
    return out;
  });
  expect(composing).toEqual({ composing: true, layer: "none", native: ACTIVE });
  expect(errors).toEqual([]);
});

test("高亮开着时：单击正文落点、自绘光标、左栏选行照常（inline 装饰不影响）", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  await page.keyboard.type("天气");
  await caretAt(page, 1);
  await expect(marks(page)).toHaveCount(3);
  // 单击第二行“天气”（10-12）之后的“也”中间偏右：光标在 13，自绘光标画在那里。
  const at = await editorOf(page).evaluate((el: any) => {
    const view = el.editor.view;
    const a = view.coordsAtPos(12, 1);
    const b = view.coordsAtPos(13, -1);
    return { x: (a.left + 3 * b.left) / 4, y: (a.top + a.bottom) / 2, caret: b.left };
  });
  await page.mouse.click(at.x, at.y);
  await expect(editorOf(page)).toBeFocused();
  expect(await selection(page)).toEqual({ type: "text", anchor: 13, head: 13 });
  await frames(page);
  const caret = await editorOf(page).evaluate((el: any) =>
    el.parentElement.querySelector(".editor-caret").getBoundingClientRect().toJSON(),
  );
  expect(Math.abs(caret.x - at.caret)).toBeLessThan(2);
  // 查找条还开着，高亮仍在。
  await expect(marks(page)).toHaveCount(3);
  // 左栏单击第二行：选中整行到下一段 +1。
  const editor = (await editorOf(page).boundingBox())!;
  await page.mouse.click(editor.x + 8, at.y);
  expect(await selection(page)).toEqual({ type: "text", anchor: 8, head: 16 });
  // Shift+→ 扩展选区（键盘路径）也照常。
  await caretAt(page, 10);
  await editorOf(page).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  await expect(count(page)).toHaveText("2 / 3");
  expect(errors).toEqual([]);
});

/** 编辑区滚动容器。 */
/** 查找条底边到编辑区顶边：正文顶部空白的高度（缩放 100% 时 4 + 34 = 38px）。 */
const zoneOf = async (page: Page) => {
  const box = (await widget(page).boundingBox())!;
  const area = (await page.locator(".tab-pane:not([hidden]) .editor-area").boundingBox())!;
  return box.y + box.height - area.y;
};
const scrollHost = (page: Page) => page.locator(".tab-pane:not([hidden]) .editor-host");
const scrollTopOf = (page: Page) => scrollHost(page).evaluate((el) => el.scrollTop);
const paragraphTop = (page: Page, i: number) =>
  editorOf(page)
    .locator("p")
    .nth(i)
    .evaluate((el) => el.getBoundingClientRect().top);
const paddingTop = (page: Page) =>
  editorOf(page).evaluate((el) => getComputedStyle(el).paddingTop);

test("打开时正文顶部多一块与查找条等高的空白，视口不跳；滚到顶时首行在查找条下方；展开替换、关闭时同步", async ({
  page,
}) => {
  const errors = await load(page);
  await setDoc(page, Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`));
  await caretAt(page, 1);
  expect(await paddingTop(page)).toBe("16px");
  await scrollHost(page).evaluate((el) => (el.scrollTop = 600));
  await frames(page);
  const before = await paragraphTop(page, 40);
  await page.keyboard.press("Control+f");
  await expect(widget(page)).toBeVisible();
  await frames(page);
  // 空白 = 查找条的 top（4px）+ 高（100% 时 34px）；scrollTop 同样加上，视口里的内容不动。
  const zone = await zoneOf(page);
  expect(Math.abs(zone - 4 - (await widget(page).boundingBox())!.height)).toBeLessThan(0.1);
  expect(Math.abs(parseFloat(await paddingTop(page)) - 16 - zone)).toBeLessThan(0.1);
  expect(Math.abs((await scrollTopOf(page)) - 600 - zone)).toBeLessThan(1);
  expect(Math.abs((await paragraphTop(page, 40)) - before)).toBeLessThan(1);
  // 展开替换：查找条多一行（4 + 24px），空白跟着变高，scrollTop 按差值调整，内容仍不动。
  await page.keyboard.press("Control+h");
  await expect(replaceBox(page)).toBeVisible();
  await frames(page);
  const zone2 = await zoneOf(page);
  expect(Math.abs(zone2 - zone - 28)).toBeLessThan(0.1);
  expect(Math.abs(parseFloat(await paddingTop(page)) - 16 - zone2)).toBeLessThan(0.1);
  expect(Math.abs((await scrollTopOf(page)) - 600 - zone2)).toBeLessThan(1);
  expect(Math.abs((await paragraphTop(page, 40)) - before)).toBeLessThan(1);
  // 滚到顶：首行在查找条下方（之间仍是原来的 16px）。
  await scrollHost(page).evaluate((el) => (el.scrollTop = 0));
  await frames(page);
  const box = (await widget(page).boundingBox())!;
  expect(Math.abs((await paragraphTop(page, 0)) - (box.y + box.height + 16))).toBeLessThan(1);
  // 收起替换，再回到原处关闭：空白去掉，scrollTop 减回去，内容不动。
  await widget(page).getByRole("button", { name: "切换替换" }).click();
  await scrollHost(page).evaluate((el, top) => (el.scrollTop = top), 600 + zone);
  await frames(page);
  expect(Math.abs((await paragraphTop(page, 40)) - before)).toBeLessThan(1);
  await page.keyboard.press("Escape");
  await expect(widget(page)).toHaveCount(0);
  await frames(page);
  expect(await paddingTop(page)).toBe("16px");
  expect(Math.abs((await scrollTopOf(page)) - 600)).toBeLessThan(1);
  expect(Math.abs((await paragraphTop(page, 40)) - before)).toBeLessThan(1);
  // 文档短得滚不动：空白照样加上，内容下移，首行不被盖住。
  await setDoc(page, LINES);
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  await frames(page);
  const short = (await widget(page).boundingBox())!;
  expect(await paragraphTop(page, 0)).toBeGreaterThanOrEqual(short.y + short.height);
  expect(errors).toEqual([]);
});

test("打开时选区在顶部、会被查找条盖住：scrollTop 不变，正文下移露出选区；否则视口不动", async ({
  page,
}) => {
  const errors = await load(page);
  // 首行很长，末尾的“目标”（61-63）在查找条左边界右侧。
  await setDoc(page, [
    `${"占".repeat(60)}目标`,
    ...Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 行`),
  ]);
  await caretAt(page, 61, 63);
  await frames(page);
  const top0 = await paragraphTop(page, 0);
  await page.keyboard.press("Control+f");
  await expect(findBox(page)).toHaveValue("目标");
  await frames(page);
  const box = (await widget(page).boundingBox())!;
  const match = await editorOf(page).evaluate((el: any) => {
    const r = el.editor.view.coordsAtPos(61, 1);
    return { top: r.top, left: r.left };
  });
  expect(match.left).toBeGreaterThan(box.x);
  expect(await scrollTopOf(page)).toBe(0);
  const zone = await zoneOf(page);
  expect(Math.abs((await paragraphTop(page, 0)) - top0 - zone)).toBeLessThan(1);
  expect(match.top).toBeGreaterThanOrEqual(box.y + box.height);
  // 自绘选区跟着文字下移（空白是内边距，编辑器大小不变，靠 redrawCarets 重画）。
  const drawn = await editorOf(page).evaluate(
    (el: any) => el.parentElement.querySelector(".selection-layer path").getBoundingClientRect().top,
  );
  expect(Math.abs(drawn - match.top)).toBeLessThan(3);
  await page.keyboard.press("Escape");
  await frames(page);
  expect(Math.abs((await paragraphTop(page, 0)) - top0)).toBeLessThan(1);
  // 光标在首行左端（不在查找条下面）：scrollTop 加上空白的高度，视口内容不动（首行可滚上去看）。
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  await frames(page);
  expect(Math.abs((await scrollTopOf(page)) - zone)).toBeLessThan(1);
  expect(Math.abs((await paragraphTop(page, 0)) - top0)).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test("焦点在编辑器里按 Esc 也关闭查找条；对话框开着时 Esc 只关对话框", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, LINES);
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  await page.keyboard.type("天气");
  await page.keyboard.press("Enter");
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  await editorOf(page).focus();
  await expect(editorOf(page)).toBeFocused();
  expect(await prevented(page, "Escape")).toBe(true);
  await expect(widget(page)).toHaveCount(0);
  await expect(marks(page)).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  // 空白去掉、文字上移，焦点没变：自绘选区同步重画，仍与文字对齐（redrawCarets）。
  const aligned = await editorOf(page).evaluate((el: any) => {
    const path = el.parentElement.querySelector(".selection-layer path").getBoundingClientRect();
    return Math.abs(path.top - el.editor.view.coordsAtPos(10, 1).top);
  });
  expect(aligned).toBeLessThan(3);
  // 查找条关着时 Esc 什么也不做。
  await page.keyboard.press("Escape");
  await expect(widget(page)).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  expect(await selection(page)).toEqual({ type: "text", anchor: 10, head: 12 });
  // 设置对话框开着：Esc 关掉对话框，查找条还在；再按 Esc 才关查找条。
  await page.keyboard.press("Control+f");
  await expect(widget(page)).toBeVisible();
  const dialog = page.locator("dialog.settings-dialog");
  await page.locator(".settings-button").click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(widget(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(widget(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("计数区最小 48px，出现过更宽的计数后只增不减", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, [...LINES, "天气".repeat(120)]);
  await caretAt(page, 1);
  await page.keyboard.press("Control+f");
  const width = async () => (await count(page).boundingBox())!.width;
  expect(Math.abs((await width()) - 48)).toBeLessThan(0.5);
  await page.keyboard.type("今天");
  await expect(count(page)).toHaveText("1 / 1");
  expect(Math.abs((await width()) - 48)).toBeLessThan(0.5);
  await findBox(page).fill("天气");
  await caretAt(page, 2);
  await expect(count(page)).toHaveText("共 123 项");
  const wide = await width();
  expect(wide).toBeGreaterThan(48);
  // 内容变短，宽度保持（输入时不来回抖动）。
  await findBox(page).fill("今天");
  await expect(count(page)).toHaveText("1 / 1");
  expect(Math.abs((await width()) - wide)).toBeLessThan(0.5);
  await findBox(page).fill("");
  await expect(count(page)).toHaveText("");
  expect(Math.abs((await width()) - wide)).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});
