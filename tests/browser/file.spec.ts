import { test, expect, type Page } from "@playwright/test";
import { calls, editorOf, itemBox, load, selection } from "./helpers";

// ---- Files (2026-11-01): image nodes of kind "file", any other file attached as it is. ----

const pic = { id: "a", name: "a.png", width: 200, height: 100 };
const report = {
  id: "e".repeat(64),
  name: "一份名字很长很长很长很长很长很长很长的年度报告终稿.docx",
  width: 0,
  height: 0,
  kind: "file" as const,
  size: 1258291,
};
const broken = { id: "b".repeat(64), name: "坏.xyz", width: 0, height: 0, kind: "file" as const, size: 10 };

const sample = (page: Page) =>
  load(page, {
    images: "png",
    blocks: [
      { type: "line", text: "上面" },
      { type: "images", images: [pic, report, broken] },
      { type: "line", text: "下面" },
    ],
  });
const preview = (page: Page) => page.locator("dialog.image-preview");

test("导入任意文件：经 import_file 原样存入，胶囊显示名字与大小，文档带 kind 与 size", async ({ page }) => {
  const errors = await load(page);
  const input = page.locator(".tab-pane input[type=file]").first();
  expect(await input.getAttribute("accept")).toBeNull();
  await input.setInputFiles({ name: "清单.txt", mimeType: "text/plain", buffer: Buffer.alloc(2500, 65) });
  const chip = editorOf(page).locator(".file-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".file-name")).toHaveText("清单.txt");
  await expect(chip.locator(".file-size")).toHaveText("2.4 KB");
  await expect(chip).toHaveAttribute("title", "清单.txt");
  const [imported] = await calls(page, "import_file");
  expect(imported).toEqual({ size: 2500, headers: { "x-linehush-tab": "t1" } });
  expect(await calls(page, "import_image")).toEqual([]);
  expect(await calls(page, "import_media")).toEqual([]);
  await expect
    .poll(async () => {
      const stashed = await calls(page, "stash_document");
      return stashed.at(-1)?.document.blocks.find((b: any) => b.type === "images")?.images[0];
    })
    .toEqual({ id: `${"f".repeat(63)}1`, name: "清单.txt", width: 0, height: 0, kind: "file", size: 2500 });
  // Files are not images in the status bar.
  await expect(page.locator(".statusbar")).not.toContainText("图片");
  expect(errors).toEqual([]);
});

test("文件胶囊：与图片并排、最宽 280px 高 32px 名字截断；双击打开对话框（打开 / 保存原文件 / 关闭），Enter 关闭", async ({
  page,
}) => {
  const errors = await sample(page);
  const chip = editorOf(page).locator(".file-chip").first();
  await expect(chip.locator(".file-name")).toHaveText(report.name);
  await expect(chip.locator(".file-size")).toHaveText("1.2 MB");
  const box = (await chip.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(280);
  expect(Math.round(box.height)).toBe(32);
  expect(await chip.locator(".file-name").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // Round corners of 6px, not a recording's round ends.
  expect(await chip.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("6px");
  const a = await itemBox(page, 0);
  const f = await itemBox(page, 1);
  expect(Math.abs(f.y - a.y)).toBeLessThan(1);
  expect(f.x).toBeGreaterThan(a.x + a.width);
  // The item is as wide as the chip, not as the whole name (clicks go by its halves).
  expect(Math.abs(f.width - box.width)).toBeLessThan(1);
  // Nothing is read for a file.
  expect((await calls(page, "read_image")).some((c: any) => c.id === report.id)).toBe(false);
  await chip.locator(".file-name").dblclick();
  const dialog = preview(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/file-preview/);
  await expect(dialog.locator(".file-preview-name")).toHaveText(report.name);
  await expect(dialog.locator(".file-preview-size")).toHaveText("1.2 MB");
  await expect(dialog.locator("img, video")).toHaveCount(0);
  expect(await dialog.locator("button").allTextContents()).toEqual(["打开", "保存原文件", "关闭"]);
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(361);
  await expect(dialog).toBeFocused();
  // Tab: 打开, 保存原文件, 关闭.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "打开" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "保存原文件" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭文件" })).toBeFocused();
  await dialog.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect(await calls(page, "open_attachment")).toEqual([]);
  await expect(editorOf(page)).toBeFocused();
  // Esc closes it too.
  await chip.locator(".file-name").dblclick();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".statusbar")).toContainText("1 张图片");
  expect(errors).toEqual([]);
});

test("文件对话框：打开交给 Rust 并关闭，失败显示在横幅；保存原文件经 export_image 写出原字节", async ({ page }) => {
  const errors = await sample(page);
  const dialog = preview(page);
  await editorOf(page).locator(".file-chip").first().dblclick();
  await dialog.getByRole("button", { name: "打开" }).click();
  await expect(dialog).toBeHidden();
  expect(await calls(page, "open_attachment")).toEqual([{ tab: "t1", id: report.id, name: report.name }]);
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  // Rust cannot open it: the dialog closes all the same, the reason shows in the tab.
  await editorOf(page).locator(".file-chip").nth(1).dblclick();
  await dialog.getByRole("button", { name: "打开" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".error-banner")).toContainText("无法打开文件“坏.xyz”：找不到打开它的程序");
  // 保存原文件: the save dialog suggests the file's name, Rust writes its original bytes.
  await page.evaluate(() => ((window as any).testNative.savePath = "D:\\out\\报告.docx"));
  await editorOf(page).locator(".file-chip").first().dblclick();
  await dialog.getByRole("button", { name: "保存原文件" }).click();
  await expect.poll(() => calls(page, "export_image")).toEqual([
    { tab: "t1", id: report.id, path: "D:\\out\\报告.docx" },
  ]);
  const [asked] = await calls(page, "plugin:dialog|save");
  expect(asked.options).toMatchObject({ title: "保存原文件", defaultPath: report.name });
  expect(errors).toEqual([]);
});

test("文件胶囊：点图标按钮打开对话框，不移动光标；单击胶囊按半区放光标", async ({ page }) => {
  const errors = await sample(page);
  await editorOf(page).locator("p").first().click();
  await page.keyboard.press("End");
  const before = await selection(page);
  const chip = editorOf(page).locator(".file-chip").first();
  await chip.locator(".file-icon").click();
  const dialog = preview(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".file-preview-name")).toHaveText(report.name);
  await dialog.getByRole("button", { name: "关闭文件" }).click();
  await expect(dialog).toBeHidden();
  expect(await selection(page)).toEqual(before);
  await expect(editorOf(page)).toBeFocused();
  // Its right half: the caret after it (between the file and the next file).
  const box = (await chip.boundingBox())!;
  await chip.click({ position: { x: box.width - 6, y: box.height / 2 } });
  expect(await selection(page)).toMatchObject({ type: "blockRange", anchor: 6, head: 6 });
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test("导出 TXT：文件写作 [文件：名字]", async ({ page }) => {
  const errors = await sample(page);
  await page.evaluate(() => ((window as any).testNative.savePath = "D:\\out\\笔记.txt"));
  await page.locator(".export-menu summary").click();
  await page.getByRole("button", { name: "纯文本 (.txt)" }).click();
  await expect.poll(async () => (await calls(page, "export_document")).length).toBe(1);
  const [exported] = await calls(page, "export_document");
  expect(exported.content).toBe(`上面\n[图片：a.png] [文件：${report.name}] [文件：坏.xyz]\n下面`);
  expect(exported.images).toEqual([]);
  expect(errors).toEqual([]);
});

test("拖进无 MIME 的文件：走 import_file 而不是 import_image", async ({ page }) => {
  const errors = await load(page);
  await editorOf(page).evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(1500)], "数据.bin", { type: "" }));
    const box = el.querySelector("p")!.getBoundingClientRect();
    el.querySelector("p")!.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        clientX: box.left + 2,
        clientY: box.top + box.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const chip = editorOf(page).locator(".file-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".file-name")).toHaveText("数据.bin");
  await expect(chip.locator(".file-size")).toHaveText("1.5 KB");
  expect(await calls(page, "import_file")).toEqual([{ size: 1500, headers: { "x-linehush-tab": "t1" } }]);
  expect(await calls(page, "import_image")).toEqual([]);
  expect(errors).toEqual([]);
});
