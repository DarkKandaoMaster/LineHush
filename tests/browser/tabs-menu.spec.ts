import { test, expect, type Page } from "@playwright/test";
import { calls, editorOf, load } from "./helpers";

// 标签页的右键菜单（src/hooks/useContextMenu.ts、src/components/ContextMenu.tsx、
// src/core/tabs.ts 的 closeTabs / revealTab）。这里没有 Rust（替身环境），页面自己响应 contextmenu。

const TABS = [
  { id: "a", path: "D:\\笔记\\甲.hush" },
  { id: "b", path: null },
  { id: "c", path: "D:\\笔记\\丙.hush" },
];
const menu = (page: Page) => page.getByRole("menu", { name: "标签页" });
const item = (page: Page, name: string) => menu(page).getByRole("menuitem", { name });
const tabOf = (page: Page, id: string) => page.locator(`.tabbar .tab[data-tab="${id}"]`);
const tabIds = (page: Page) =>
  page.locator(".tabbar .tab").evaluateAll((tabs) => tabs.map((tab) => (tab as HTMLElement).dataset.tab));
const activeId = (page: Page) =>
  page.locator(".tabbar .tab.active").evaluate((tab) => (tab as HTMLElement).dataset.tab);
const states = (page: Page) =>
  menu(page)
    .getByRole("menuitem")
    .evaluateAll((items) =>
      items.map((el) => `${(el as HTMLButtonElement).disabled ? "-" : "+"}${el.textContent}`),
    );
/** 右键标签页 `id` 的名字；返回 contextmenu 事件是否被 preventDefault（不弹自带菜单）。 */
async function rightClickTab(page: Page, id: string) {
  await page.evaluate(() => {
    const w = window as any;
    w.menuPrevented = null;
    if (w.watchingMenu) return;
    w.watchingMenu = true;
    window.addEventListener("contextmenu", (e) => (w.menuPrevented = e.defaultPrevented));
  });
  await tabOf(page, id).locator(".tab-name").click({ button: "right" });
  return page.evaluate(() => (window as any).menuPrevented);
}

test("标签页右键：自绘菜单的各项与快捷键，不切换标签页；最右的禁用“关闭右侧”，无标题的禁用“打开文件所在位置”", async ({
  page,
}) => {
  const errors = await load(page, { tabs: TABS });
  expect(await activeId(page)).toBe("a");

  expect(await rightClickTab(page, "c")).toBe(true);
  await expect(menu(page)).toBeVisible();
  expect(await states(page)).toEqual([
    "+新建标签页Ctrl+N",
    "+关闭标签页Ctrl+W",
    "+关闭其他标签页",
    "-关闭右侧标签页",
    "+打开文件所在位置",
  ]);
  await expect(menu(page).getByRole("separator")).toHaveCount(1);
  // 菜单开着时不切换标签页，焦点留在编辑器里。
  expect(await activeId(page)).toBe("a");
  await expect(editorOf(page)).toBeFocused();
  // 与编辑区菜单同样的外观：每项 32px 高、白底。
  const look = await menu(page).evaluate((el) => ({
    background: getComputedStyle(el).backgroundColor,
    item: el.querySelector("button")!.getBoundingClientRect().height,
  }));
  expect(look).toEqual({ background: "rgb(255, 255, 255)", item: 32 });
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  await rightClickTab(page, "b");
  expect(await states(page)).toEqual([
    "+新建标签页Ctrl+N",
    "+关闭标签页Ctrl+W",
    "+关闭其他标签页",
    "+关闭右侧标签页",
    "-打开文件所在位置",
  ]);
  // 点菜单外关掉，什么也不做。
  await page.mouse.click(400, 300);
  await expect(menu(page)).toHaveCount(0);
  expect(await tabIds(page)).toEqual(["a", "b", "c"]);
  expect(errors).toEqual([]);
});

test("标签页右键：只有一个标签页时“关闭其他 / 关闭右侧”禁用；标签栏空白处不弹菜单", async ({
  page,
}) => {
  await load(page);
  await rightClickTab(page, "t1");
  expect(await states(page)).toEqual([
    "+新建标签页Ctrl+N",
    "+关闭标签页Ctrl+W",
    "-关闭其他标签页",
    "-关闭右侧标签页",
    "-打开文件所在位置",
  ]);
  await page.keyboard.press("Escape");
  // 标签栏空白处（“+”右侧的拖动区）：不弹任何菜单，也不弹自带的。
  const bar = (await page.locator(".tabbar").boundingBox())!;
  const plus = (await page.locator(".tab-new").boundingBox())!;
  await page.mouse.click(plus.x + plus.width + 20, bar.y + bar.height / 2, { button: "right" });
  expect(await page.evaluate(() => (window as any).menuPrevented)).toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("打开文件所在位置：调用 reveal_in_explorer（右键的那个标签页的路径）；失败时在当前标签页显示原因", async ({
  page,
}) => {
  await load(page, {
    tabs: [...TABS, { id: "d", path: "D:\\已删除\\丁.hush" }],
  });
  await rightClickTab(page, "c");
  await item(page, "打开文件所在位置").click();
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => calls(page, "reveal_in_explorer")).toEqual([{ path: "D:\\笔记\\丙.hush" }]);
  expect(await activeId(page)).toBe("a");

  await rightClickTab(page, "d");
  await item(page, "打开文件所在位置").click();
  await expect(page.locator(".tab-pane:not([hidden]) .error-banner")).toContainText(
    "无法打开文件所在位置：文件不存在：D:\\已删除\\丁.hush",
  );
});

test("关闭其他标签页：逐个关闭，有修改的照常询问；取消则停下，其余保留", async ({ page }) => {
  await load(page, { tabs: [...TABS, { id: "d", path: null }] });
  // 改动 c，再回到 a。
  await tabOf(page, "c").click();
  await editorOf(page).pressSequentially("改");
  await tabOf(page, "a").click();

  await rightClickTab(page, "b");
  await item(page, "关闭其他标签页").click();
  // a 没有修改直接关；c 有修改：切过去询问。
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("是否保存对“丙.hush”的更改？");
  expect(await activeId(page)).toBe("c");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await tabIds(page)).toEqual(["b", "c", "d"]);
  expect(await activeId(page)).toBe("c");
  expect((await calls(page, "close_tab")).map((a: any) => a.tab)).toEqual(["a"]);

  // 再来一次，这次不保存：只剩 b，并成为当前标签页。
  await rightClickTab(page, "b");
  await item(page, "关闭其他标签页").click();
  await dialog.getByRole("button", { name: "不保存" }).click();
  await expect.poll(() => tabIds(page)).toEqual(["b"]);
  expect(await activeId(page)).toBe("b");
  expect((await calls(page, "close_tab")).map((a: any) => a.tab)).toEqual(["a", "c", "d"]);
  await expect(editorOf(page)).toBeFocused();
});

test("关闭右侧标签页 / 关闭标签页 / 新建标签页：作用在右键的那个标签页上", async ({ page }) => {
  await load(page, { tabs: [...TABS, { id: "d", path: null }] });
  await tabOf(page, "d").click();
  // 当前标签页 d 在右侧被关掉：由右键的 b 接替。
  await rightClickTab(page, "b");
  await item(page, "关闭右侧标签页").click();
  await expect.poll(() => tabIds(page)).toEqual(["a", "b"]);
  expect(await activeId(page)).toBe("b");

  // “关闭标签页”关右键的那个（不是当前的）。
  await rightClickTab(page, "a");
  await item(page, "关闭标签页").click();
  await expect.poll(() => tabIds(page)).toEqual(["b"]);

  await rightClickTab(page, "b");
  await item(page, "新建标签页").click();
  await expect.poll(() => tabIds(page)).toEqual(["b", "n1"]);
  expect(await activeId(page)).toBe("n1");
});

test("对话框开着时标签页右键不弹菜单", async ({ page }) => {
  await load(page, { tabs: TABS });
  await page.locator(".settings-button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // 标签栏 inert，按 dispatchEvent 直接发给标签页也不弹。
  await tabOf(page, "c").dispatchEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
  await expect(page.getByRole("menu")).toHaveCount(0);
});
