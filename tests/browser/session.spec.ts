import { test, expect, type Page } from "@playwright/test";

// Only the native boundary is replaced here; React, Tiptap and SaveQueue are real.
const commands = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as any).testNative.calls.map((c: any) => c.cmd));
const count = async (page: Page, cmd: string) =>
  (await commands(page)).filter((c) => c === cmd).length;
/** Fires the window's close request without waiting: it may be held by the unsaved-changes prompt. */
const requestClose = (page: Page) =>
  page.evaluate(() => {
    const state = (window as any).testNative;
    void state.callbacks.get(state.closeHandler)({
      event: "tauri://close-requested",
      id: state.closeHandler,
      payload: null,
    });
  });
/** 最近一次设置的窗口标题（工具栏已不显示文档名，改为检查窗口标题）。 */
const windowTitle = (page: Page): Promise<string | undefined> =>
  page.evaluate(
    () =>
      (window as any).testNative.calls
        .filter((c: any) => c.cmd === "plugin:window|set_title")
        .at(-1)?.args.value,
  );
const expectTitle = (page: Page, name: string) =>
  expect.poll(() => windowTitle(page)).toBe(name);
const unsavedPrompt = (page: Page) =>
  page.getByRole("dialog", { name: /^是否保存对“.+”的更改？$/ });
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
      failStash: false,
      savePath: null as string | null,
      openPath: null as string | null,
      callbacks: new Map(),
      closeHandler: 0,
      destroyed: false,
      imported: 0,
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
        if (cmd === "stash_document" && state.failStash)
          throw Error("测试暂存失败");
        if (cmd === "save_document") {
          if (state.failSave) throw Error("测试写入失败");
          state.document = args.document;
        }
        if (cmd === "plugin:dialog|save") return state.savePath;
        if (cmd === "plugin:dialog|open") return state.openPath;
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
        if (cmd === "import_image") {
          state.imported += 1;
          return {
            id: state.imported.toString(16).padStart(64, "0"),
            name: "",
            width: 40,
            height: 30,
          };
        }
        // Any bytes will do: a tile that cannot decode them still opens the preview.
        if (cmd === "read_image") return new Uint8Array([1, 2, 3]).buffer;
        if (cmd === "plugin:event|listen") {
          // The open-requested listener registers too; only the close guard is driven here.
          if (args.event === "tauri://close-requested")
            state.closeHandler = args.handler;
          return args.handler;
        }
        if (cmd === "plugin:window|destroy") state.destroyed = true;
      },
    };
  });
});

test("恢复和只读切换不触发暂存或保存，StrictMode 不重复初始化或监听", async ({
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
  // Wait beyond the stash debounce to detect spurious document updates on mount/toggle.
  await page.waitForTimeout(800);
  const cmds = await commands(page);
  expect(cmds.filter((c) => c === "restore")).toHaveLength(1);
  // The close guard and the open-requested listener, once each.
  expect(cmds.filter((c) => c === "plugin:event|listen")).toHaveLength(2);
  expect(cmds.filter((c) => c === "stash_document")).toHaveLength(0);
  expect(cmds.filter((c) => c === "save_document")).toHaveLength(0);
  await expectTitle(page, "已有.hush");
  expect(errors).toEqual([]);
});

test("输入只暂存不写文件，Ctrl+S 保存后清除未保存标记，光标、DOM 和撤销历史保留", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expectTitle(page, "已有.hush");
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowRight");
  const original = await editor.elementHandle();
  await page.keyboard.insertText("中");
  await expectTitle(page, "● 已有.hush");
  await expect.poll(() => count(page, "stash_document")).toBe(1);
  const stashed = await page.evaluate(
    () =>
      (window as any).testNative.calls.find(
        (c: any) => c.cmd === "stash_document",
      ).args.document,
  );
  expect(stashed.blocks.map((b: any) => b.text)).toEqual(["已中有日记", ""]);
  expect(await count(page, "save_document")).toBe(0);
  await expectTitle(page, "● 已有.hush");

  await page.keyboard.press("Control+s");
  await expectTitle(page, "已有.hush");
  expect(await count(page, "save_document")).toBe(1);
  const saved = await page.evaluate(() => (window as any).testNative.document);
  expect(saved.blocks.map((b: any) => b.text)).toEqual(["已中有日记", ""]);
  expect(
    await original!.evaluate(
      (node) => node === document.querySelector("[role=textbox]"),
    ),
  ).toBe(true);
  await expect(editor).toBeFocused();
  await expect(
    page.getByText("第 1 行，第 3 列", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(editor.locator("p")).toHaveText(["已有日记", ""]);
  await expectTitle(page, "● 已有.hush");
  await page.keyboard.press("Control+y");
  await expect(editor.locator("p")).toHaveText(["已中有日记", ""]);
  await expect(page.getByText("5 字符", { exact: true })).toBeVisible();
  // Saving from the toolbar does the same.
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expectTitle(page, "已有.hush");
  expect(await count(page, "save_document")).toBe(2);
});

test("暂存失败另行提示，不提供重试保存，下次暂存成功后清除", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.evaluate(() => {
    (window as any).testNative.failStash = true;
  });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("一");
  await expect(page.getByRole("alert")).toContainText("暂存失败");
  await expect(page.getByRole("alert")).toContainText("测试暂存失败");
  await expect(page.getByRole("button", { name: "重试保存" })).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).testNative.failStash = false;
  });
  await page.keyboard.insertText("二");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectTitle(page, "● 已有.hush");
  expect(await count(page, "save_document")).toBe(0);
});

test("快捷键切换文件重建编辑器并清空旧撤销，另存为保留正文与导出", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+n"); // nothing unsaved: no prompt
  await expect(editor.locator("p")).toHaveText([""]);
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("新草稿\n\n");
  await page.evaluate(() => {
    (window as any).testNative.savePath = "D:/另存.hush";
  });
  await page.keyboard.press("Control+Shift+s");
  await expectTitle(page, "另存.hush");
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
  await expect(unsavedPrompt(page)).toHaveCount(0);
});

test("有修改时关闭先询问：取消和 Esc 保留窗口，不保存则清理后关闭", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("尚未保存");
  await requestClose(page);
  const prompt = unsavedPrompt(page);
  await expect(prompt).toHaveAccessibleName("是否保存对“已有.hush”的更改？");
  await expect(
    prompt.getByRole("button", { name: "保存", exact: true }),
  ).toBeFocused();
  await prompt.getByRole("button", { name: "取消", exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("！");
  await expect(editor.locator("p")).toHaveText(["已有日记", "尚未保存！"]);

  await requestClose(page);
  await expect(prompt).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(prompt).toBeHidden();
  await expect(editor).toBeFocused();
  expect(await count(page, "close_document")).toBe(0);
  expect(await page.evaluate(() => (window as any).testNative.destroyed)).toBe(
    false,
  );

  await requestClose(page);
  await prompt.getByRole("button", { name: "不保存", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testNative.destroyed))
    .toBe(true);
  const cmds = await commands(page);
  expect(cmds.filter((c) => c === "save_document")).toHaveLength(0);
  expect(cmds.filter((c) => c === "close_document")).toHaveLength(1);
  expect(cmds.slice(-2)).toEqual(["close_document", "plugin:window|destroy"]);
  const kept = await page.evaluate(() => (window as any).testNative.document);
  expect(kept.blocks.map((b: any) => b.text)).toEqual(["已有日记", ""]);
});

test("关闭时选保存：先写文件再清理并关闭", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("要保存");
  await requestClose(page);
  await unsavedPrompt(page)
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testNative.destroyed))
    .toBe(true);
  const cmds = (await commands(page)).filter(
    (c) =>
      !["stash_document", "plugin:window|set_title"].includes(c) &&
      !c.startsWith("plugin:event"),
  );
  expect(cmds.slice(-3)).toEqual([
    "save_document",
    "close_document",
    "plugin:window|destroy",
  ]);
  const saved = await page.evaluate(() => (window as any).testNative.document);
  expect(saved.blocks.map((b: any) => b.text)).toEqual(["已有日记", "要保存"]);
});

test("保存失败时关闭保留窗口，重试保存后无需询问即可关闭", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.evaluate(() => {
    (window as any).testNative.failSave = true;
  });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("尚未保存");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText("测试写入失败");
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
  await requestClose(page);
  await unsavedPrompt(page)
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "保存失败：Error: 测试写入失败，窗口未关闭。",
  );
  expect(await page.evaluate(() => (window as any).testNative.destroyed)).toBe(
    false,
  );
  expect(await count(page, "close_document")).toBe(0);
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expectTitle(page, "● 已有.hush");
  await page.evaluate(() => {
    (window as any).testNative.failSave = false;
  });
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectTitle(page, "已有.hush");
  const saved = await page.evaluate(() => (window as any).testNative.document);
  expect(saved.blocks.map((b: any) => b.text)).toEqual([
    "已有日记",
    "尚未保存",
  ]);
  await requestClose(page);
  // Unreferenced images are dropped only after the last save, right before the window goes.
  await expect
    .poll(() => page.evaluate(() => (window as any).testNative.destroyed))
    .toBe(true);
  await expect(unsavedPrompt(page)).toHaveCount(0);
  const cmds = await commands(page);
  expect(cmds.filter((c) => c === "close_document")).toHaveLength(1);
  expect(cmds.slice(-2)).toEqual(["close_document", "plugin:window|destroy"]);
});

test("保存失败仍可另存为，取消切换保留内容，HTML 导出使用最新文档", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("<草稿>\n\n");
  await page.keyboard.press("Control+n");
  const prompt = unsavedPrompt(page);
  await prompt.getByRole("button", { name: "取消", exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(editor.locator("p")).toHaveText(["已有日记", "<草稿>", "", ""]);
  expect(await count(page, "new_document")).toBe(0);
  await page.evaluate(() => {
    const state = (window as any).testNative;
    state.failSave = true;
    state.savePath = "D:/救回.hush";
  });
  // Right after the prompt closes the editor re-applies its own selection, which can undo an early caret move.
  await expect(async () => {
    await page.keyboard.press("Control+Home");
    await expect(
      page.getByText("第 1 行，第 1 列", { exact: true }),
    ).toBeVisible({ timeout: 200 });
  }).toPass();
  await page.keyboard.insertText("新");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText("测试写入失败");
  await page.keyboard.press("Control+Shift+s");
  await expectTitle(page, "救回.hush");
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
  expect(exported.content).toContain('<div class="line">新已有日记</div>');
  expect(exported.content).toContain('<div class="line">&lt;草稿&gt;</div>');
  expect(exported.images).toEqual([]);
});

test("新建时选不保存直接切换，选保存则未命名文档走另存为", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("丢弃");
  await page.keyboard.press("Control+n");
  const prompt = unsavedPrompt(page);
  await prompt.getByRole("button", { name: "不保存", exact: true }).click();
  await expect(editor.locator("p")).toHaveText([""]);
  await expect(editor).toBeFocused();
  expect(await count(page, "save_document")).toBe(0);
  await page.keyboard.insertText("留下");
  await page.evaluate(() => {
    (window as any).testNative.savePath = "D:/留下.hush";
  });
  await page.keyboard.press("Control+n");
  await expect(prompt).toHaveAccessibleName("是否保存对“未命名”的更改？");
  await prompt.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.locator("p")).toHaveText([""]);
  const cmds = (await commands(page)).filter(
    (c) => !["stash_document", "plugin:window|set_title"].includes(c),
  );
  expect(cmds.slice(-3)).toEqual([
    "plugin:dialog|save",
    "save_as",
    "new_document",
  ]);
  expect(cmds.filter((c) => c === "save_document")).toHaveLength(0);
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

test("插入图片：光标在空行时替换该空行，不再补空行，文档可以以图片结尾", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "日记正文" });
  await expect(editor).toBeFocused();
  const insert = (name: string) =>
    page.locator("input[type=file]").setInputFiles({
      name,
      mimeType: "image/png",
      buffer: Buffer.from([1, 2, 3]),
    });
  /** Top-level lines and images, images as [name]. */
  const content = () =>
    editor.evaluate((el) =>
      Array.from(el.children)
        .filter((child) => !child.matches(".ProseMirror-gapcursor, .drop-line"))
        .map((child) =>
          child.classList.contains("image-item")
            ? `[${child.querySelector("img")?.alt}]`
            : child.textContent,
        ),
    );
  const saved = () =>
    page.evaluate(() =>
      (window as any).testNative.document.blocks.map((b: any) =>
        b.type === "line" ? b.text : b.images.map((p: any) => `[${p.name}]`).join(""),
      ),
    );
  // The caret on the last, empty line: the image takes its place; no line is added after it.
  await page.keyboard.press("Control+End");
  await insert("甲.png");
  await expect.poll(content).toEqual(["已有日记", "[甲.png]"]);
  await expect(editor.locator(".ProseMirror-selectednode")).toHaveCount(1);
  await page.keyboard.press("Control+s");
  await expectTitle(page, "已有.hush");
  expect(await saved()).toEqual(["已有日记", "[甲.png]"]);
  // Down on the last image only leaves it for the gap cursor after it; Enter there starts a line.
  await page.keyboard.press("ArrowDown");
  await expect.poll(content).toEqual(["已有日记", "[甲.png]"]);
  await expect(editor.locator(".ProseMirror-selectednode")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("之后");
  await expect.poll(content).toEqual(["已有日记", "[甲.png]", "之后"]);
  // An empty line between text lines is replaced too; one undo brings it back.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("末行");
  await page.keyboard.press("ArrowUp");
  await insert("乙.png");
  await expect
    .poll(content)
    .toEqual(["已有日记", "[甲.png]", "之后", "[乙.png]", "末行"]);
  await page.keyboard.press("Control+z");
  await expect
    .poll(content)
    .toEqual(["已有日记", "[甲.png]", "之后", "", "末行"]);
  await page.keyboard.press("Control+y");
  await expect
    .poll(content)
    .toEqual(["已有日记", "[甲.png]", "之后", "[乙.png]", "末行"]);
  // Several images on an empty line replace it as one group.
  await editor.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page
    .locator("input[type=file]")
    .setInputFiles(
      ["丙.png", "丁.png"].map((name) => ({
        name,
        mimeType: "image/png",
        buffer: Buffer.from([1, 2, 3]),
      })),
    );
  await expect
    .poll(content)
    .toEqual([
      "已有日记",
      "[丙.png]",
      "[丁.png]",
      "[甲.png]",
      "之后",
      "[乙.png]",
      "末行",
    ]);
  await page.keyboard.press("Control+s");
  await expectTitle(page, "已有.hush");
  expect(await saved()).toEqual([
    "已有日记",
    "[丙.png][丁.png][甲.png]",
    "之后",
    "[乙.png]",
    "末行",
  ]);
  expect(errors).toEqual([]);
});
