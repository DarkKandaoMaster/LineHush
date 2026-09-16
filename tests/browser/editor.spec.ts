import { test, expect } from "@playwright/test";
test("真实编辑区保留连续末尾换行，撤销重做正常", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await editor.click();
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
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await editor.click();
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
  await page.screenshot({ path: "test-results/editor.png" });
});
