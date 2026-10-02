import { test, expect } from "@playwright/test";

// Only the native boundary is replaced here; React, Tiptap and SaveQueue are real.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const document = {
      version: 1,
      blocks: [
        { type: "line", text: "已有日记" },
        { type: "line", text: "" },
      ],
    };
    const state = (w.testNative = {
      document,
      path: "D:/已有.linehush",
      calls: [] as any[],
      failSave: false,
      savePath: null as string | null,
      openPath: null as string | null,
      confirm: false,
      callbacks: new Map(),
      closeHandler: 0,
      destroyed: false,
    });
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      transformCallback: (callback: any) => {
        const id = state.callbacks.size + 1;
        state.callbacks.set(id, callback);
        return id;
      },
      invoke: async (cmd: string, args: any) => {
        state.calls.push({ cmd, args });
        if (cmd === "restore")
          return {
            document: state.document,
            path: state.path,
            recovered: false,
          };
        if (cmd === "save_document") {
          if (state.failSave) throw Error("测试写入失败");
          state.document = args.document;
        }
        if (cmd === "plugin:dialog|save") return state.savePath;
        if (cmd === "plugin:dialog|open") return state.openPath;
        if (cmd === "plugin:dialog|message") return state.confirm;
        if (cmd === "save_as") {
          state.document = args.document;
          state.path = args.path;
          return {
            document: state.document,
            path: state.path,
            recovered: false,
          };
        }
        if (cmd === "new_document" || cmd === "open_document") {
          state.path = cmd === "new_document" ? null : args.path;
          state.document = {
            version: 1,
            blocks: [{ type: "line", text: state.path ? "打开的内容" : "" }],
          };
          return {
            document: state.document,
            path: state.path,
            recovered: false,
          };
        }
        if (cmd === "plugin:event|listen") {
          state.closeHandler = args.handler;
          return args.handler;
        }
        if (cmd === "plugin:window|destroy") state.destroyed = true;
      },
    };
  });
});

test("恢复和只读切换不触发保存，StrictMode 不重复初始化或监听", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) errors.push(msg.text());
  });
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.getByRole("button", { name: "另存为", exact: true }).click(); // cancel
  await expect(editor).toHaveAttribute("contenteditable", "true");
  // Wait beyond autosave debounce to detect spurious document updates on mount/toggle.
  await page.waitForTimeout(800);
  const commands = await page.evaluate(() =>
    (window as any).testNative.calls.map((c: any) => c.cmd),
  );
  expect(commands.filter((c: string) => c === "restore")).toHaveLength(1);
  expect(
    commands.filter((c: string) => c === "plugin:event|listen"),
  ).toHaveLength(1);
  expect(commands.filter((c: string) => c === "save_document")).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("自动保存和状态重渲染保留光标、正文 DOM 和撤销历史", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowRight");
  const original = await editor.elementHandle();
  await page.keyboard.insertText("中");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  expect(
    await original!.evaluate(
      (node) => node === document.querySelector("[role=textbox]"),
    ),
  ).toBe(true);
  await expect(editor).toBeFocused();
  await expect(
    page.getByText("第 1 行，第 3 列", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(editor.locator("p")).toHaveText(["已有日记", ""]);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(editor.locator("p")).toHaveText(["已中有日记", ""]);
  await expect(page.getByText("5 字符", { exact: true })).toBeVisible();
});

test("快捷键切换文件重建编辑器并清空旧撤销，另存为保留正文与导出", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+n");
  await expect(editor.locator("p")).toHaveText([""]);
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("新草稿\n\n");
  await page.evaluate(() => {
    (window as any).testNative.savePath = "D:/另存.linehush";
  });
  await page.keyboard.press("Control+Shift+s");
  await expect(page.locator(".document-name")).toHaveText("另存.linehush");
  await page.getByText("导出", { exact: true }).click();
  await page
    .getByRole("button", { name: "纯文本 (.txt)", exact: true })
    .click();
  await expect(page.getByText("已导出。", { exact: true })).toBeVisible();
  const exported = await page.evaluate(
    () =>
      (window as any).testNative.calls.find(
        (c: any) => c.cmd === "export_document",
      ).args,
  );
  expect(exported.content).toBe("新草稿\n\n");
  await page.evaluate(() => {
    (window as any).testNative.openPath = "D:/打开.linehush";
  });
  await page.keyboard.press("Control+o");
  await expect(editor.locator("p")).toHaveText(["打开的内容"]);
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(editor.locator("p")).toHaveText(["打开的内容"]);
});

test("保存失败时关闭保护保留窗口，重试后保存最新正文", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.evaluate(() => {
    (window as any).testNative.failSave = true;
  });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("尚未保存");
  await expect(page.getByRole("alert")).toContainText("测试写入失败");
  await page.evaluate(async () => {
    const state = (window as any).testNative;
    await state.callbacks.get(state.closeHandler)({
      event: "tauri://close-requested",
      id: state.closeHandler,
      payload: null,
    });
  });
  await expect(page.getByRole("alert")).toContainText("未关闭窗口");
  expect(await page.evaluate(() => (window as any).testNative.destroyed)).toBe(
    false,
  );
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await page.evaluate(() => {
    (window as any).testNative.failSave = false;
  });
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const saved = await page.evaluate(() => (window as any).testNative.document);
  expect(saved.blocks.map((b: any) => b.text)).toEqual([
    "已有日记",
    "尚未保存",
  ]);
});

test("保存失败仍可另存为，取消草稿切换保留内容，HTML 导出使用最新文档", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+n");
  await expect(editor.locator("p")).toHaveText([""]);
  await page.keyboard.insertText("<草稿>\n\n");
  await page.keyboard.press("Control+n"); // cancel the save-draft prompt
  await expect(editor.locator("p")).toHaveText(["<草稿>", "", ""]);
  await page.evaluate(() => {
    const state = (window as any).testNative;
    state.failSave = true;
    state.savePath = "D:/救回.linehush";
  });
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.insertText("新");
  await expect(page.getByRole("alert")).toContainText("测试写入失败");
  await page.keyboard.press("Control+Shift+s");
  await expect(page.locator(".document-name")).toHaveText("救回.linehush");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByText("导出", { exact: true }).click();
  await page
    .getByRole("button", { name: "图文网页 (.html)", exact: true })
    .click();
  await expect(page.getByText("已导出。", { exact: true })).toBeVisible();
  const exported = await page.evaluate(
    () =>
      (window as any).testNative.calls.find(
        (c: any) => c.cmd === "export_document",
      ).args,
  );
  expect(exported.html).toBe(true);
  expect(exported.content).toContain("新&lt;草稿&gt;");
  expect(exported.document.blocks.map((b: any) => b.text)).toEqual([
    "新<草稿>",
    "",
    "",
  ]);
});
