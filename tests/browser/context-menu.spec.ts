import { test, expect, type Page } from "@playwright/test";
import { calls, content, editorOf, load, loadSample, selection, setDoc, tile } from "./helpers";

// 编辑区的右键菜单（src/hooks/useContextMenu.ts、src/components/ContextMenu.tsx）。这里没有 Rust
// （替身环境），页面自己响应 contextmenu 事件；“粘贴”只能经 Rust 交给 WebView2，这里不可用。

const LINES: { type: "line"; text: string }[] = [
  { type: "line", text: "今天天气好" },
  { type: "line", text: "明天" },
];
const menu = (page: Page) => page.getByRole("menu", { name: "编辑" });
const item = (page: Page, name: string) => menu(page).getByRole("menuitem", { name });
const caretAt = (page: Page, from: number, to = from) =>
  editorOf(page).evaluate(
    (el: any, [from, to]) => el.editor.commands.setTextSelection({ from, to }),
    [from, to],
  );
/** 右键 `x, y`（视口坐标）；返回 contextmenu 事件是否被 preventDefault（即不弹自带菜单）。 */
async function rightClick(page: Page, x: number, y: number) {
  await page.evaluate(() => {
    const w = window as any;
    w.menuPrevented = null;
    if (w.watchingMenu) return;
    w.watchingMenu = true;
    window.addEventListener("contextmenu", (e) => (w.menuPrevented = e.defaultPrevented));
  });
  await page.mouse.click(x, y, { button: "right" });
  return page.evaluate(() => (window as any).menuPrevented);
}
/** 右键文字位置 `pos` 后面那个字的中间（落在含它的选区里时选区不变）。 */
async function rightClickPos(page: Page, pos: number) {
  const at = await editorOf(page).evaluate((el: any, pos) => {
    const a = el.editor.view.coordsAtPos(pos, 1);
    const b = el.editor.view.coordsAtPos(pos + 1, -1);
    return { x: (a.left + b.left) / 2, y: (a.top + a.bottom) / 2 };
  }, pos);
  return rightClick(page, at.x, at.y);
}
/** 右键编辑器第一行文字的中间。 */
async function rightClickText(page: Page) {
  const box = (await editorOf(page).locator("p").first().boundingBox())!;
  return rightClick(page, box.x + 20, box.y + box.height / 2);
}
const states = (page: Page) =>
  menu(page)
    .getByRole("menuitem")
    .evaluateAll((items) =>
      items.map((el) => `${(el as HTMLButtonElement).disabled ? "-" : "+"}${el.textContent}`),
    );

test("编辑区右键：自绘菜单代替自带菜单，各项与快捷键、无选区时剪切 / 复制 / 删除置灰，粘贴不可用", async ({
  page,
}) => {
  // 文档从 Rust 载入（没有撤消历史）。
  const errors = await load(page, { blocks: LINES });
  await caretAt(page, 2);
  expect(await rightClickText(page)).toBe(true);
  await expect(menu(page)).toBeVisible();
  expect(await states(page)).toEqual([
    "-撤消Ctrl+Z",
    "-重做Ctrl+Y",
    "-剪切Ctrl+X",
    "-复制Ctrl+C",
    "-粘贴Ctrl+V",
    "-删除Del",
    "+全选Ctrl+A",
    "+查找Ctrl+F",
    "+替换Ctrl+H",
  ]);
  await expect(menu(page).getByRole("separator")).toHaveCount(3);
  // 焦点留在编辑器里。
  await expect(editorOf(page)).toBeFocused();
  // 样式：每项 32px 高，白底菜单。
  const look = await menu(page).evaluate((el) => ({
    background: getComputedStyle(el).backgroundColor,
    item: el.querySelector("button")!.getBoundingClientRect().height,
  }));
  expect(look).toEqual({ background: "rgb(255, 255, 255)", item: 32 });
  // 菜单左上角在指针处。
  const box = (await menu(page).boundingBox())!;
  const p = (await editorOf(page).locator("p").first().boundingBox())!;
  expect(Math.abs(box.x - (p.x + 20))).toBeLessThan(1);
  expect(Math.abs(box.y - (p.y + p.height / 2))).toBeLessThan(1);
  // Esc 关闭，选区不变。
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 2 });

  // 有选区、右键在选区里：选区不变，剪切 / 复制 / 删除可用。
  await caretAt(page, 1, 3);
  await rightClickPos(page, 2);
  expect(await selection(page)).toEqual({ type: "text", anchor: 1, head: 3 });
  await expect(item(page, "剪切")).toBeEnabled();
  await expect(item(page, "复制")).toBeEnabled();
  await expect(item(page, "删除")).toBeEnabled();
  // 点外面关闭。
  await page.mouse.click(600, 400);
  await expect(menu(page)).toHaveCount(0);
  // 右键在选区外：光标移到那里（浏览器的做法，像记事本），剪切等置灰。
  await caretAt(page, 1, 3);
  await rightClickPos(page, 4);
  expect(await selection(page)).toMatchObject({ type: "text", anchor: 4, head: 4 });
  await expect(item(page, "复制")).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("撤消 / 重做按历史置灰与执行；全选后删除", async ({ page }) => {
  const errors = await load(page);
  await page.keyboard.type("abc");
  await rightClickText(page);
  await expect(item(page, "撤消")).toBeEnabled();
  await expect(item(page, "重做")).toBeDisabled();
  await item(page, "撤消").click();
  await expect(menu(page)).toHaveCount(0);
  expect(await content(page)).toEqual([""]);
  await expect(editorOf(page)).toBeFocused();
  await rightClickText(page);
  await expect(item(page, "撤消")).toBeDisabled();
  await expect(item(page, "重做")).toBeEnabled();
  await item(page, "重做").click();
  expect(await content(page)).toEqual(["abc"]);

  await page.keyboard.press("Enter");
  await page.keyboard.type("def");
  // 之后的删除另成一步撤消（与按 Delete 一样，间隔不到半秒的编辑会并成一步）。
  await page.waitForTimeout(600);
  await rightClickText(page);
  await item(page, "全选").click();
  expect((await selection(page)).type).toBe("all");
  await rightClickText(page);
  await item(page, "删除").click();
  expect(await content(page)).toEqual([""]);
  // 一步撤消回来。
  await page.keyboard.press("Control+z");
  expect(await content(page)).toEqual(["abc", "def"]);
  expect(errors).toEqual([]);
});

test("删除：文字选区照常删除；选中的图片按图片的删除规则", async ({ page }) => {
  const errors = await loadSample(page);
  // “上面”的“面”。
  await caretAt(page, 2, 3);
  await rightClickPos(page, 2);
  await item(page, "删除").click();
  expect(await content(page)).toEqual(["上", "[a]", "[b]", "下面"]);
  // 选中图片 a（右键缩略图也弹菜单）。
  await tile(page, 0).click({ position: { x: 5, y: 50 } });
  await page.keyboard.press("Shift+ArrowRight");
  expect((await selection(page)).type).toBe("blockRange");
  // 右键选中的图片：选区不变。
  const t = (await tile(page, 0).boundingBox())!;
  await rightClick(page, t.x + t.width / 2, t.y + t.height / 2);
  await expect(menu(page)).toBeVisible();
  expect((await selection(page)).type).toBe("blockRange");
  await item(page, "删除").click();
  expect(await content(page)).toEqual(["上", "[b]", "下面"]);
  expect(errors).toEqual([]);
});

test("复制 / 剪切：经编辑器的 copy / cut 事件（纯文字、纯图片交给 Rust）", async ({ page }) => {
  const errors = await loadSample(page);
  await page.evaluate(() => {
    const w = window as any;
    w.copies = [];
    for (const type of ["copy", "cut"])
      document.addEventListener(type, (event: any) =>
        w.copies.push({
          type,
          prevented: event.defaultPrevented,
          text: event.clipboardData?.getData("text/plain") ?? "",
        }),
      );
  });
  await caretAt(page, 1, 3);
  await rightClickPos(page, 1);
  await item(page, "复制").click();
  await expect(menu(page)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).copies))
    .toEqual([{ type: "copy", prevented: true, text: "上面" }]);
  await rightClickPos(page, 1);
  await item(page, "剪切").click();
  await expect.poll(() => content(page)).toEqual(["", "[a]", "[b]", "下面"]);
  expect(await page.evaluate(() => (window as any).copies.at(-1).type)).toBe("cut");
  // 两张图片（块间范围）：交给 Rust 的 copy_images。
  await tile(page, 0).click({ position: { x: 5, y: 50 } });
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  const t = (await tile(page, 0).boundingBox())!;
  await rightClick(page, t.x + t.width / 2, t.y + t.height / 2);
  await item(page, "复制").click();
  await expect.poll(() => calls(page, "copy_images")).toHaveLength(1);
  expect((await calls(page, "copy_images"))[0].pictures.map((p: any) => p.id)).toEqual(["a", "b"]);
  expect(errors).toEqual([]);
});

test("查找 / 替换打开查找条；选中的文字预填查询", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, ["今天天气好"]);
  await caretAt(page, 3, 5);
  await rightClickPos(page, 3);
  await item(page, "查找").click();
  const findBox = page.getByRole("textbox", { name: "查找", exact: true });
  await expect(findBox).toBeFocused();
  await expect(findBox).toHaveValue("天气");
  await expect(page.getByRole("textbox", { name: "替换", exact: true })).toHaveCount(0);
  // 查找框里右键：不弹自绘菜单，也不拦自带的（输入框要用它剪切、复制、粘贴）。
  const f = (await findBox.boundingBox())!;
  expect(await rightClick(page, f.x + 10, f.y + f.height / 2)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
  await editorOf(page).focus();
  await rightClickText(page);
  await item(page, "替换").click();
  await expect(page.getByRole("textbox", { name: "替换", exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test("编辑区以外不弹任何菜单；对话框开着时也不弹", async ({ page }) => {
  const errors = await load(page);
  for (const locator of [
    page.locator(".toolbar"),
    page.locator(".statusbar"),
    page.locator(".titlebar, header").first(),
  ]) {
    const b = (await locator.boundingBox())!;
    expect(await rightClick(page, b.x + b.width / 2, b.y + b.height / 2)).toBe(true);
    await expect(menu(page)).toHaveCount(0);
  }
  // 左栏与下方空白也是编辑区。
  const e = (await editorOf(page).boundingBox())!;
  await rightClick(page, e.x + 6, e.y + 10);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await rightClick(page, e.x + 200, e.y + e.height - 20);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  // 设置对话框开着。
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  expect(await rightClick(page, e.x + 200, e.y + 10)).toBe(true);
  await expect(menu(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("靠右 / 靠下时向左 / 向上翻，夹在视口内；滚动时关闭", async ({ page }) => {
  const errors = await load(page);
  await setDoc(page, Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行`));
  const viewport = page.viewportSize()!;
  const e = (await editorOf(page).boundingBox())!;
  const x = viewport.width - 40;
  const y = Math.min(e.y + e.height, viewport.height) - 40;
  await rightClick(page, x, y);
  const box = (await menu(page).boundingBox())!;
  expect(Math.abs(box.x + box.width - x)).toBeLessThan(1);
  expect(Math.abs(box.y + box.height - y)).toBeLessThan(1);
  await page.mouse.wheel(0, 200);
  await expect(menu(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Shift+F10 / 菜单键在光标处打开，第一个可用项高亮，↑ ↓ 移动、Enter 执行", async ({ page }) => {
  const errors = await load(page, { blocks: LINES });
  await caretAt(page, 3);
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  const caret = await editorOf(page).evaluate((el: any) =>
    el.parentElement.querySelector(".editor-caret").getBoundingClientRect().toJSON(),
  );
  const box = (await menu(page).boundingBox())!;
  expect(Math.abs(box.x - caret.x)).toBeLessThan(2);
  expect(Math.abs(box.y - caret.bottom)).toBeLessThan(2);
  await expect(menu(page).locator("button.active")).toHaveText("全选Ctrl+A");
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).locator("button.active")).toHaveText("查找Ctrl+F");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  // 循环到最后一个可用项。
  await expect(menu(page).locator("button.active")).toHaveText("替换Ctrl+H");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(menu(page)).toHaveCount(0);
  expect((await selection(page)).type).toBe("all");
  // 菜单开着时 Esc 只关菜单，不关查找条。
  await page.keyboard.press("Control+f");
  await editorOf(page).focus();
  await page.keyboard.press("ContextMenu");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole("search", { name: "查找与替换" })).toBeVisible();
  // 其余按键关掉菜单后照常生效。
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.type("x");
  await expect(menu(page)).toHaveCount(0);
  expect(await content(page)).toEqual(["x"]);
  expect(errors).toEqual([]);
});
