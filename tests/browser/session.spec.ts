import { test, expect } from "@playwright/test";

// Only the native boundary is replaced here; React, Tiptap and SaveQueue are real.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const document = {
      blocks: [
        { type: "line", text: "已有日记" },
        { type: "line", text: "" },
      ],
    };
    const state = (w.testNative = {
      document,
      path: "D:/已有.hush",
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
            blocks: [{ type: "line", text: state.path ? "打开的内容" : "" }],
          };
          return {
            document: state.document,
            path: state.path,
            recovered: false,
          };
        }
        // Any bytes will do: a tile that cannot decode them still opens the preview.
        if (cmd === "read_image") return new Uint8Array([1, 2, 3]).buffer;
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
    (window as any).testNative.savePath = "D:/另存.hush";
  });
  await page.keyboard.press("Control+Shift+s");
  await expect(page.locator(".document-name")).toHaveText("另存.hush");
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
  expect(exported.images).toEqual([]);
  await page.evaluate(() => {
    (window as any).testNative.openPath = "D:/打开.hush";
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
  await page.evaluate(async () => {
    const state = (window as any).testNative;
    await state.callbacks.get(state.closeHandler)({
      event: "tauri://close-requested",
      id: state.closeHandler,
      payload: null,
    });
  });
  // Unreferenced images are dropped only after the last save, right before the window goes.
  const commands = await page.evaluate(() =>
    (window as any).testNative.calls.map((c: any) => c.cmd),
  );
  expect(commands.filter((c: string) => c === "close_document")).toHaveLength(
    1,
  );
  expect(commands.slice(-2)).toEqual([
    "close_document",
    "plugin:window|destroy",
  ]);
  expect(await page.evaluate(() => (window as any).testNative.destroyed)).toBe(
    true,
  );
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
    state.savePath = "D:/救回.hush";
  });
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.insertText("新");
  await expect(page.getByRole("alert")).toContainText("测试写入失败");
  await page.keyboard.press("Control+Shift+s");
  await expect(page.locator(".document-name")).toHaveText("救回.hush");
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
  expect(Object.keys(exported).sort()).toEqual(["content", "images", "path"]);
  expect(exported.path).toBe("D:/救回.hush");
  expect(exported.content).toContain('<div class="line">新&lt;草稿&gt;</div>');
  expect(exported.images).toEqual([]);
});

test("缩略图与原图按 id 读取，可保存原图，HTML 导出列出附件", async ({
  page,
}) => {
  const id = "c".repeat(12) + "d".repeat(52);
  await page.addInitScript((id) => {
    const state = (window as any).testNative;
    state.document = {
      blocks: [
        { type: "line", text: "带图" },
        {
          type: "images",
          images: [{ id, name: "相片.jpg", width: 40, height: 30 }],
        },
        { type: "line", text: "" },
      ],
    };
  }, id);
  await page.goto("/");
  const tile = page.getByRole("button", { name: "查看图片 相片.jpg" });
  await expect(tile.locator("img")).toHaveAttribute("src", /^blob:/);
  await tile.dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("相片.jpg");
  await page.evaluate(() => {
    (window as any).testNative.savePath = "D:/导出/相片.jpg";
  });
  await dialog.getByRole("button", { name: "保存原图", exact: true }).click();
  await expect(page.getByText("已保存原图。", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).testNative.calls);
  const find = (cmd: string) =>
    calls.filter((c: any) => c.cmd === cmd).map((c: any) => c.args);
  // Thumbnails may be read more than once (the dev editor mounts several node views).
  const reads = find("read_image");
  expect(reads.filter((args: any) => args.original)).toEqual([
    { id, original: true },
  ]);
  expect(new Set(reads.map((args: any) => JSON.stringify(args)))).toEqual(
    new Set([
      JSON.stringify({ id, original: false }),
      JSON.stringify({ id, original: true }),
    ]),
  );
  expect(find("plugin:dialog|save")[0].options.defaultPath).toBe("相片.jpg");
  expect(find("export_image")).toEqual([{ id, path: "D:/导出/相片.jpg" }]);
  await dialog.getByRole("button", { name: "关闭原图" }).click();
  await expect(dialog).toBeHidden();
  await page.evaluate(() => {
    (window as any).testNative.savePath = "D:/导出/带图.html";
  });
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
  const file = "cccccccccccc-相片.jpg";
  expect(exported.images).toEqual([{ id, file }]);
  expect(exported.content).toContain(
    `src="附件/${encodeURIComponent(file)}"`,
  );
});
