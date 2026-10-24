import { test, expect, type Page } from "@playwright/test";
import { calls, destroyed, editorOf, load as loadApp } from "./helpers";

// 对话框非模态（useDialogs）：开着时工具栏与标签页 inert、自绘遮罩，标题栏照常可用；
// Esc / 点遮罩 / 标题栏 × 的处理；打开后报位置给 Rust（reveal_rect）。
// 只替换原生边界（helpers 的 mockDesktop），React、Tiptap 与会话逻辑都是真的。

const PICTURE = {
  id: "a".repeat(64),
  name: "照片.png",
  width: 400,
  height: 300,
};
/** 一个标签页：“第一行”与一张图（原图预览载入后对话框会变大）。 */
const load = (page: Page) =>
  loadApp(page, {
    blocks: [
      { type: "line", text: "第一行" },
      { type: "images", images: [PICTURE] },
    ],
    images: "png",
  });

/** 对话框开着时的页面状态。 */
const state = (page: Page) =>
  page.evaluate(() => {
    const editor = document.querySelector(".tiptap") as HTMLElement;
    const titlebar = document.querySelector(".titlebar") as HTMLElement;
    const mask = document.querySelector(".dialog-mask") as HTMLElement | null;
    return {
      editorInert: !!editor.closest("[inert]"),
      toolbarInert: !!document.querySelector(".toolbar")!.closest("[inert]"),
      tabbarInert: !!document.querySelector(".tabbar")!.closest("[inert]"),
      titlebarInert: !!titlebar.closest("[inert]"),
      captionInert: Array.from(
        document.querySelectorAll(".caption-buttons button"),
      ).some((b) => !!b.closest("[inert]")),
      dimmed: titlebar.classList.contains("dimmed"),
      // 标题栏上叠的半透明层：与遮罩同色，正好到 40px（遮罩从那里开始）。
      overlay: titlebar.classList.contains("dimmed")
        ? {
            background: getComputedStyle(titlebar, "::after").backgroundColor,
            height: parseFloat(getComputedStyle(titlebar, "::after").height),
          }
        : null,
      // 半透明层不挡鼠标：拖动区与关闭按钮照样是命中目标。
      hit: (() => {
        const at = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
        };
        return { drag: at(".titlebar-drag"), close: at(".caption-close") };
      })(),
      mask: mask && {
        top: mask.getBoundingClientRect().top,
        bottom: mask.getBoundingClientRect().bottom,
        width: mask.getBoundingClientRect().width,
        background: getComputedStyle(mask).backgroundColor,
      },
      active: document.activeElement?.closest("dialog")?.className ?? null,
    };
  });
/** 程序里聚焦编辑器：inert 时无效。 */
const tryFocusEditor = (page: Page) =>
  page.evaluate(() => {
    (document.querySelector(".tiptap") as HTMLElement).focus();
    return document.activeElement?.classList.contains("tiptap") ?? false;
  });
/** 连按 Tab，焦点始终不进编辑器、工具栏与标签栏。 */
async function tabStaysOut(page: Page, times = 24) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      if (el.closest(".tab-pane, .toolbar, .tabbar")) return "page";
      return el.closest("dialog") ? "dialog" : el.className;
    });
    expect(where, `第 ${i + 1} 次 Tab`).not.toBe("page");
  }
}
/** 对话框在页面里的位置（物理像素，dpr 1）。 */
const physical = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    const s = devicePixelRatio;
    const x = Math.round(box.left * s);
    const y = Math.round(box.top * s);
    return {
      x,
      y,
      w: Math.round(box.right * s) - x,
      h: Math.round(box.bottom * s) - y,
    };
  }, selector);
/** 点遮罩上对话框之外的一点（左下角）。 */
async function clickMask(page: Page) {
  const box = (await page.locator(".dialog-mask").boundingBox())!;
  await page.mouse.click(box.x + 10, box.y + box.height - 10);
}

/**
 * 整页截图（存到 `file`），取标题栏拖动区中间一列 y = 0…59 的灰度：标题栏与内容区之间
 * 不能有没盖到或盖了两层的行。
 */
async function column(page: Page, file: string) {
  const shot = await page.screenshot({ path: file });
  const box = (await page.locator(".titlebar-drag").boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  return page.evaluate(
    async ({ data, x }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data: px } = context.getImageData(x, 0, 1, 60);
      return Array.from({ length: 60 }, (_, y) => px[y * 4]);
    },
    { data: shot.toString("base64"), x },
  );
}
/** 标题栏 #ececec、工具栏 #f9f9f9 叠上透明度 `alpha` 的黑色后的灰度：0…39 为前者，40 起为后者。 */
function expectUniformDim(values: number[], alpha: number) {
  const title = Math.round(0xec * (1 - alpha));
  const toolbar = Math.round(0xf9 * (1 - alpha));
  values.forEach((v, y) => {
    // 拖动区这一列上没有文字与按钮；工具栏下边线在 y = 72，不在这 60 行里。
    const want = y < 40 ? title : toolbar;
    expect(Math.abs(v - want), `y=${y}: ${values.join(",")}`).toBeLessThanOrEqual(2);
  });
}

test("设置：非模态，页面其余部分 inert、标题栏可用且盖同色半透明层、遮罩、整窗均匀灰；点遮罩 / Esc / 关闭按钮关掉，焦点回编辑器", async ({
  page,
}) => {
  const errors = await load(page);
  const dialog = page.locator("dialog.settings-dialog");
  await page.locator(".settings-button").click();
  await expect(dialog).toBeVisible();
  // 焦点在对话框本身，不落到第一个控件“字体”上。
  await expect(dialog).toBeFocused();
  // show() 而非 showModal()：不在顶层。
  expect(await dialog.evaluate((d) => d.matches(":modal"))).toBe(false);
  let s = await state(page);
  expect(s).toMatchObject({
    editorInert: true,
    toolbarInert: true,
    tabbarInert: true,
    titlebarInert: false,
    captionInert: false,
    dimmed: true,
    active: "settings-dialog",
    overlay: { background: "rgba(0, 0, 0, 0.2)", height: 40 },
    hit: { drag: true, close: true },
  });
  // 遮罩从标题栏下缘到窗口底、全宽，#0003。
  expect(s.mask).toEqual({
    top: 40,
    bottom: 720,
    width: 1000,
    background: "rgba(0, 0, 0, 0.2)",
  });
  // 对话框在整个视口里居中，盖在遮罩上。
  const box = (await dialog.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 500)).toBeLessThan(1);
  expect(Math.abs(box.y + box.height / 2 - 360)).toBeLessThan(1);
  expect(
    await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest("dialog"),
      [box.x + box.width / 2, box.y + 10],
    ),
  ).toBe(true);
  // 按一次 Tab 进第一项“字体”。
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("字体")).toBeFocused();
  // 编辑器拿不到焦点，Tab 也进不去。
  expect(await tryFocusEditor(page)).toBe(false);
  // 整扇窗口一块均匀的灰：标题栏与内容区之间没有接缝。截图给人看。
  expectUniformDim(
    await column(page, test.info().outputPath("dialog-dim-settings.png")),
    0.2,
  );
  await tabStaysOut(page);
  // 打开后报了一次位置。
  await expect
    .poll(async () => (await calls(page, "reveal_rect")).length)
    .toBe(1);
  expect((await calls(page, "reveal_rect"))[0].rect).toEqual(
    await physical(page, "dialog.settings-dialog"),
  );

  // 点遮罩关掉。
  await clickMask(page);
  await expect(dialog).toBeHidden();
  s = await state(page);
  expect(s).toMatchObject({
    editorInert: false,
    toolbarInert: false,
    tabbarInert: false,
    dimmed: false,
    mask: null,
    overlay: null,
  });
  await expect(editorOf(page)).toBeFocused();

  // Esc 关掉（焦点在对话框里的输入框上）。
  await page.locator(".settings-button").click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("字体").focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(editorOf(page)).toBeFocused();

  // 焦点不在对话框里（如点过标题栏）时 Esc 也有效。
  await page.locator(".settings-button").click();
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(editorOf(page)).toBeFocused();

  // “关闭”按钮。
  await page.locator(".settings-button").click();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toBeHidden();
  await expect(editorOf(page)).toBeFocused();
  // 每次打开都报一次位置。
  expect((await calls(page, "reveal_rect")).length).toBe(4);
  // 点遮罩与 Esc 都经设置的 onClose 写入了设置（flush）；之后页面照常可用。
  await editorOf(page).click();
  await page.keyboard.type("x");
  expect(errors).toEqual([]);
});

test("设置开着时按标题栏 ×：先关掉设置，再走正常的关窗流程（有修改则询问）", async ({
  page,
}) => {
  const errors = await load(page);
  await editorOf(page).click();
  await page.keyboard.type("改了");
  await page.locator(".settings-button").click();
  const settings = page.locator("dialog.settings-dialog");
  await expect(settings).toBeVisible();
  await page.locator(".caption-close").click();
  await expect(settings).toBeHidden();
  const prompt = page.getByRole("dialog", { name: "是否保存对“无标题”的更改？" });
  await expect(prompt).toBeVisible();
  expect((await calls(page, "plugin:window|close")).length).toBe(1);
  await prompt.getByRole("button", { name: "不保存" }).click();
  await expect.poll(() => destroyed(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("保存询问：Esc 等于取消、点遮罩不关、标题栏 × 等于取消（不再发起关窗），按钮照常；关掉后焦点回编辑器", async ({
  page,
}) => {
  const errors = await load(page);
  await editorOf(page).click();
  await page.keyboard.type("未保存");
  const prompt = page.getByRole("dialog", { name: "是否保存对“无标题”的更改？" });
  // Ctrl+W 关最后一个标签页 = 关窗。
  await page.keyboard.press("Control+w");
  await expect(prompt).toBeVisible();
  expect(await prompt.evaluate((d) => d.matches(":modal"))).toBe(false);
  // 打开时焦点在第一个按钮“保存”上（show() 同样执行对话框的聚焦步骤）。
  await expect(prompt.getByRole("button", { name: "保存", exact: true })).toBeFocused();
  let s = await state(page);
  expect(s).toMatchObject({
    editorInert: true,
    toolbarInert: true,
    tabbarInert: true,
    titlebarInert: false,
    captionInert: false,
    dimmed: true,
  });
  expect(s.mask?.background).toBe("rgba(0, 0, 0, 0.2)");
  expect(s.overlay).toEqual({ background: "rgba(0, 0, 0, 0.2)", height: 40 });
  expect(s.hit).toEqual({ drag: true, close: true });
  expect(await tryFocusEditor(page)).toBe(false);
  await tabStaysOut(page, 12);
  await expect
    .poll(async () => (await calls(page, "reveal_rect")).length)
    .toBe(1);
  expect((await calls(page, "reveal_rect"))[0].rect).toEqual(
    await physical(page, "dialog.unsaved-dialog"),
  );

  // 点遮罩：不响应。
  await clickMask(page);
  await page.waitForTimeout(200);
  await expect(prompt).toBeVisible();

  // Esc：取消，窗口保留。
  await page.keyboard.press("Escape");
  await expect(prompt).toBeHidden();
  expect(await destroyed(page)).toBe(false);
  expect(await state(page)).toMatchObject({ editorInert: false, dimmed: false, mask: null });
  await expect(editorOf(page)).toBeFocused();
  // 取消后仍可编辑，修改还在。
  await page.keyboard.type("！");
  await expect(editorOf(page)).toContainText("未保存！");

  // 标题栏 × 打开询问；询问开着时再按 × = 取消，不再发起关窗。
  await page.locator(".caption-close").click();
  await expect(prompt).toBeVisible();
  const closes = (await calls(page, "plugin:window|close")).length;
  await page.locator(".caption-close").click();
  await expect(prompt).toBeHidden();
  await page.waitForTimeout(200);
  expect((await calls(page, "plugin:window|close")).length).toBe(closes);
  expect(await destroyed(page)).toBe(false);
  await expect(editorOf(page)).toBeFocused();

  // 询问开着时最小化 / 最大化按钮可按（不 inert，事件到达）。
  await page.keyboard.press("Control+w");
  await expect(prompt).toBeVisible();
  await page.locator(".caption-min").click();
  await page.locator(".caption-max").click();
  expect((await calls(page, "plugin:window|minimize")).length).toBe(1);
  expect((await calls(page, "plugin:window|toggle_maximize")).length).toBe(1);
  await expect(prompt).toBeVisible();

  // “取消”按钮。
  await prompt.getByRole("button", { name: "取消" }).click();
  await expect(prompt).toBeHidden();
  await expect(editorOf(page)).toBeFocused();

  // “不保存”：窗口关掉。
  await page.keyboard.press("Control+w");
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "不保存" }).click();
  await expect.poll(() => destroyed(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("原图预览：非模态、深色遮罩；载入原图后再报一次位置；点遮罩 / Esc / 关闭按钮关掉，焦点回编辑器", async ({
  page,
}) => {
  const errors = await load(page);
  const preview = page.locator("dialog.image-preview");
  const open = async () => {
    await editorOf(page).locator(".image-tile").first().dblclick();
    await expect(preview).toBeVisible();
    await expect(preview.locator("img")).toBeVisible();
    await expect
      .poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(400);
  };
  await open();
  expect(await preview.evaluate((d) => d.matches(":modal"))).toBe(false);
  const s = await state(page);
  expect(s).toMatchObject({
    editorInert: true,
    toolbarInert: true,
    tabbarInert: true,
    titlebarInert: false,
    captionInert: false,
    dimmed: true,
  });
  expect(s.mask?.background).toBe("rgba(0, 0, 0, 0.6)");
  // 标题栏同样盖深色层，与 .dialog-mask.dark 一致。
  expect(s.overlay).toEqual({ background: "rgba(0, 0, 0, 0.6)", height: 40 });
  expect(s.hit).toEqual({ drag: true, close: true });
  expect(await tryFocusEditor(page)).toBe(false);
  // 打开时一次（“正在读取原图…”），原图载入后对话框变大再一次，最后一次与现在的大小相同。
  await expect
    .poll(async () => (await calls(page, "reveal_rect")).length)
    .toBe(2);
  const [first, second] = (await calls(page, "reveal_rect")).map((a: any) => a.rect);
  expect(second.h).toBeGreaterThan(first.h);
  expect(second).toEqual(await physical(page, "dialog.image-preview"));
  // 居中，限制在 94vw × 94vh 之内。
  const box = (await preview.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 500)).toBeLessThan(1);
  expect(Math.abs(box.y + box.height / 2 - 360)).toBeLessThan(1);
  expect(box.height).toBeLessThanOrEqual(720 * 0.94 + 0.5);
  expectUniformDim(
    await column(page, test.info().outputPath("dialog-dim-preview.png")),
    0.6,
  );

  await clickMask(page);
  await expect(preview).toBeHidden();
  await expect(editorOf(page)).toBeFocused();
  expect(await state(page)).toMatchObject({ editorInert: false, dimmed: false, mask: null });

  await open();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(editorOf(page)).toBeFocused();

  await open();
  await preview.getByRole("button", { name: "关闭原图" }).click();
  await expect(preview).toBeHidden();
  await expect(editorOf(page)).toBeFocused();

  // 预览开着时按标题栏 ×：先关预览，再关窗（没有修改，不询问，直接 destroy）。
  await open();
  await page.locator(".caption-close").click();
  await expect(preview).toBeHidden();
  await expect.poll(() => destroyed(page)).toBe(true);
  expect(errors).toEqual([]);
});
