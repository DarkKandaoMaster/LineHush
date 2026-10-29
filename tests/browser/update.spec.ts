import { test, expect, type Page } from "@playwright/test";
import {
  announceUpdate,
  calls,
  editorOf,
  load,
  releaseInstall,
} from "./helpers";

// 自动检查更新的页面一侧（useUpdate / UpdateDialog）：Rust 发现新版本后发 update-available，
// 页面经 take_update 取说明弹对话框；“立即更新”经 install_update 回报进度，安装前应答
// flush-requested（立刻暂存所有标签页）。只替换原生边界（helpers 的 mockDesktop）。

const dialogOf = (page: Page) => page.locator("dialog.update-dialog");
const activeIn = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (el?.classList.contains("tiptap")) return "editor";
    if (el?.tagName === "DIALOG") return `dialog.${el.className}`;
    return el?.textContent?.trim() || el?.tagName || null;
  });

test("发现新版本：弹出对话框（版本、当前版本、更新说明），页面 inert、焦点在对话框本身，Tab 先到“立即更新”；Esc 关掉、焦点回编辑器，本次运行不再提示", async ({
  page,
}) => {
  const errors = await load(page);
  const dialog = dialogOf(page);
  await expect(dialog).not.toBeVisible();
  // 启动时页面先自己取过一次（那时还没有新版本）。
  expect((await calls(page, "take_update")).length).toBeGreaterThanOrEqual(1);

  await announceUpdate(page, {
    version: "0.9.0",
    current: "0.8.0",
    notes: "修复若干问题\n第二行说明",
    date: "2026-11-01T00:00:00Z",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#update-title")).toHaveText("发现新版本 0.9.0（当前 0.8.0）");
  await expect(dialog.locator(".update-notes")).toHaveText("修复若干问题\n第二行说明");
  await expect(dialog.getByRole("button", { name: "立即更新" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "以后再说" })).toBeEnabled();
  expect(await activeIn(page)).toBe("dialog.update-dialog");
  expect(
    await page.evaluate(() => !!document.querySelector(".tiptap")!.closest("[inert]")),
  ).toBe(true);
  await expect(page.locator(".dialog-mask")).toBeVisible();
  // 点遮罩不关（这是一个要回答的问题，同保存询问）。
  const mask = (await page.locator(".dialog-mask").boundingBox())!;
  await page.mouse.click(mask.x + 10, mask.y + mask.height - 10);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await activeIn(page)).toBe("立即更新");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(editorOf(page)).toBeFocused();
  expect(await calls(page, "install_update")).toEqual([]);

  // Rust 只交出一次：再来一次事件，take_update 为空，不再弹出。
  await page.evaluate(() => (window as any).testNative.emit("update-available", null));
  await page.waitForTimeout(200);
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("以后再说：关掉对话框、焦点回编辑器；没有说明时不显示说明框", async ({ page }) => {
  const errors = await load(page);
  await announceUpdate(page);
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".update-notes")).toHaveCount(0);
  await dialog.getByRole("button", { name: "以后再说" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(editorOf(page)).toBeFocused();
  expect(await calls(page, "install_update")).toEqual([]);
  expect(errors).toEqual([]);
});

test("设置开着时收到新版本：不叠两个对话框，等设置关掉再弹", async ({ page }) => {
  const errors = await load(page);
  await page.getByRole("button", { name: "设置" }).click();
  const settings = page.locator("dialog.settings-dialog");
  await expect(settings).toBeVisible();
  await announceUpdate(page);
  await page.waitForTimeout(200);
  await expect(dialogOf(page)).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  await expect(dialogOf(page)).toBeVisible();
  expect(await activeIn(page)).toBe("dialog.update-dialog");
  expect(errors).toEqual([]);
});

test("立即更新（对话框上按 Enter）：显示下载进度、按钮变灰、Esc 与标题栏 × 不响应；安装前刚打的字立刻暂存再答复；失败显示原因与“重试” / “关闭”", async ({
  page,
}) => {
  const errors = await load(page, {
    installFailure: "无法启动安装程序：没有访问权限（拒绝访问。）",
  });
  const dialog = dialogOf(page);
  // 刚打的字还在 650 ms 的防抖里。
  await editorOf(page).pressSequentially("更新前");
  await announceUpdate(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".update-status")).toHaveText("正在下载… 45%");
  await expect(dialog.getByRole("button", { name: "立即更新" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "以后再说" })).toBeDisabled();
  expect(await calls(page, "install_update")).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.locator(".caption-close").click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).testNative.destroyed)).toBe(false);

  const before = (await calls(page, "stash_document")).length;
  await releaseInstall(page);
  await expect(dialog.locator(".update-status")).toHaveText(
    "无法启动安装程序：没有访问权限（拒绝访问。）",
  );
  // 防抖还没到就已暂存了最新正文，然后才答复 stash_flushed。
  const stashes = await calls(page, "stash_document");
  expect(stashes.length).toBeGreaterThan(before);
  expect(stashes.at(-1).document.blocks).toEqual([{ type: "line", text: "更新前" }]);
  const order = await page.evaluate(() =>
    (window as any).testNative.calls
      .map((c: any) => c.cmd)
      .filter((cmd: string) => cmd === "stash_document" || cmd === "stash_flushed"),
  );
  expect(order.at(-1)).toBe("stash_flushed");
  // 替身不注销监听（StrictMode 挂载两次时会答复两次），只要求每次答复都成功。
  const answers = await calls(page, "stash_flushed");
  expect(answers.length).toBeGreaterThanOrEqual(1);
  for (const answer of answers) expect(answer).toEqual({ round: 1, error: null });

  await expect(dialog.getByRole("button", { name: "重试" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "关闭" })).toBeEnabled();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(editorOf(page)).toBeFocused();
  expect(errors).toEqual([]);
});

test("设置：“自动检查更新”默认勾选，取消勾选后写入 checkUpdates: false，再勾上写回 true", async ({
  page,
}) => {
  const errors = await load(page);
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.locator("dialog.settings-dialog");
  const box = dialog.getByRole("checkbox", { name: "自动检查更新" });
  await expect(box).toBeChecked();
  // 在“默认文件名”之后、“打开文件”之前。
  const labels = await dialog
    .locator(".settings-grid > span, .settings-grid > label")
    .allTextContents();
  expect(labels.indexOf("更新")).toBe(labels.indexOf("默认文件名") + 1);
  expect(labels.indexOf("打开文件")).toBe(labels.indexOf("更新") + 1);

  await box.uncheck();
  await expect
    .poll(async () => (await calls(page, "write_settings")).at(-1)?.settings.checkUpdates)
    .toBe(false);
  await box.check();
  await expect
    .poll(async () => (await calls(page, "write_settings")).at(-1)?.settings.checkUpdates)
    .toBe(true);
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("设置里存的 checkUpdates: false 读进来时不勾选", async ({ page }) => {
  await load(page, { settings: { checkUpdates: false } });
  await page.getByRole("button", { name: "设置" }).click();
  await expect(
    page.locator("dialog.settings-dialog").getByRole("checkbox", { name: "自动检查更新" }),
  ).not.toBeChecked();
});
