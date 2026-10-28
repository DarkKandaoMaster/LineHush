import { expect, type Locator, type Page } from "@playwright/test";

// Shared by the browser tests. Only the native boundary is replaced
// (`__TAURI_INTERNALS__`, see `mockDesktop`); React, Tiptap and the session
// logic are the app's own.

export const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "笔记正文" });

type Block =
  | { type: "line"; text: string }
  | { type: "images"; images: { id: string; name: string; width: number; height: number }[] };

export interface DesktopOptions {
  /** The one untitled tab's document (restore_window); one empty line by default. */
  blocks?: Block[];
  /** What read_settings hands out (normalized by the app); the defaults by default. */
  settings?: Record<string, unknown>;
  /**
   * read_image: "png" answers every picture with a 400×300 PNG; "fail" (the
   * default) rejects, so tiles show their placeholder at the picture's size.
   */
  images?: "png" | "fail";
  /**
   * restore_window 交出的标签页（代替只有一个无标题 t1）：各自的 id 与文件路径（null 为无标题），
   * 正文为一个空行；当前标签页为第一个。
   */
  tabs?: { id: string; path: string | null }[];
}

/**
 * The desktop app's native side: one window win-1 with one untitled tab t1
 * (or `options.tabs`); new_tab hands out untitled tabs n1, n2, ….
 * Every call is recorded in `window.testNative.calls` (see `calls`); `close`
 * emits close-requested as Tauri does, `destroy` sets `destroyed`.
 */
export async function mockDesktop(page: Page, options: DesktopOptions = {}) {
  await page.addInitScript((options: DesktopOptions) => {
    const w = window as any;
    const state = (w.testNative = {
      calls: [] as { cmd: string; args: any }[],
      callbacks: new Map<number, (event: any) => void>(),
      listeners: new Map<string, number[]>(),
      destroyed: false,
      settings: options.settings ?? {},
      newTabs: 0,
    });
    const opened = (path: string | null, blocks?: Block[]) => ({
      document: { blocks: blocks ?? [{ type: "line", text: "" }] },
      path,
      recovered: false,
      notice: null,
    });
    const emit = (event: string, payload: unknown) => {
      for (const id of state.listeners.get(event) ?? [])
        state.callbacks.get(id)?.({ event, id, payload });
    };
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "win-1" },
        currentWebview: { windowLabel: "win-1", label: "win-1" },
      },
      transformCallback: (callback: (event: any) => void) => {
        const id = state.callbacks.size + 1;
        state.callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => state.callbacks.delete(id),
      invoke: async (cmd: string, args: any) => {
        state.calls.push({ cmd, args });
        switch (cmd) {
          case "restore_window": {
            const tabs = options.tabs ?? [{ id: "t1", path: null }];
            return {
              tabs: tabs.map((tab, i) => ({
                tab: tab.id,
                opened: opened(tab.path, i === 0 ? options.blocks : undefined),
                error: null,
              })),
              active: tabs[0].id,
            };
          }
          case "new_tab":
            return { tab: `n${++state.newTabs}`, opened: opened(null), error: null };
          case "read_settings":
            return state.settings;
          case "write_settings":
            state.settings = args.settings;
            return;
          case "caret_metrics":
            return { width: 1, blinkMs: 530, timeoutMs: 5000 };
          case "is_last_window":
            return true;
          case "paste_images":
            return [];
          // 无标题笔记保存对话框的默认路径：没有文件夹，名字原样。
          case "suggest_save_path":
            return `${args.base}.hush`;
          // 路径里带“已删除”的文件当作不存在（Rust 的中文原因）。
          case "reveal_in_explorer":
            if (String(args.path).includes("已删除")) throw `文件不存在：${args.path}`;
            return;
          case "read_image": {
            if (options.images !== "png") throw "测试：没有缩略图";
            // A real picture: the preview grows once the original has loaded.
            const canvas = new OffscreenCanvas(400, 300);
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#4a7";
            context.fillRect(0, 0, 400, 300);
            const blob = await canvas.convertToBlob({ type: "image/png" });
            return await blob.arrayBuffer();
          }
          case "plugin:event|listen": {
            const list = state.listeners.get(args.event) ?? [];
            list.push(args.handler);
            state.listeners.set(args.event, list);
            return args.handler;
          }
          case "plugin:window|is_maximized":
            return false;
          // As in Tauri: close emits close-requested, the page's guard decides on destroy.
          case "plugin:window|close":
            emit("tauri://close-requested", null);
            return;
          case "plugin:window|destroy":
            state.destroyed = true;
            return;
        }
        // Everything else (stash_document, copy_images, reveal_rect, …) answers nothing.
      },
    };
  }, options);
}

/** The arguments of every call of `cmd` so far. */
export const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (cmd) =>
      (window as any).testNative.calls
        .filter((c: any) => c.cmd === cmd)
        .map((c: any) => c.args),
    cmd,
  );
export const destroyed = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).testNative.destroyed);

/** Opens the app over `mockDesktop(options)`; returns the page errors and console errors it collects. */
export async function load(page: Page, options: DesktopOptions = {}) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await mockDesktop(page, options);
  await page.goto("/");
  await expect(editorOf(page)).toBeFocused();
  return errors;
}

/** Strings are text lines; images as { id, newline } (shown 200×100 unless sized). */
export type Item =
  | string
  | { id: string; newline?: boolean; width?: number; height?: number };
export async function setDoc(page: Page, items: Item[]) {
  await editorOf(page).evaluate((el: any, items: Item[]) => {
    el.editor.commands.setContent({
      type: "doc",
      content: items.map((item) =>
        typeof item === "string"
          ? { type: "paragraph", content: item ? [{ type: "text", text: item }] : [] }
          : {
              type: "image",
              attrs: {
                id: item.id,
                name: `${item.id}.png`,
                width: item.width ?? 200,
                height: item.height ?? 100,
                newline: !!item.newline,
              },
            },
      ),
    });
  }, items);
}

/**
 * Loads the app with "上面", images a and b in one row, "下面", and records
 * every selection type the editor goes through (`window.selections`), to
 * catch a passing NodeSelection.
 */
export async function loadSample(page: Page, options: DesktopOptions = {}) {
  const errors = await load(page, options);
  await setDoc(page, ["上面", { id: "a" }, { id: "b" }, "下面"]);
  await editorOf(page).evaluate((el: any) => {
    (window as any).selections = [];
    el.editor.on("selectionUpdate", ({ editor }: any) =>
      (window as any).selections.push(editor.state.selection.toJSON().type),
    );
  });
  return errors;
}

/** Top-level lines and images, images as [id]. */
export const content = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const out: string[] = [];
    el.editor.state.doc.forEach((node: any) =>
      out.push(node.type.name === "image" ? `[${node.attrs.id}]` : node.textContent),
    );
    return out;
  });
/** Lines as text, each row of images as "[a b]". */
export const layout = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const out: string[] = [];
    let image = false;
    el.editor.state.doc.forEach((node: any) => {
      if (node.type.name !== "image") {
        out.push(node.textContent);
        image = false;
        return;
      }
      if (image && !node.attrs.newline)
        out[out.length - 1] = `${out[out.length - 1].slice(0, -1)} ${node.attrs.id}]`;
      else out.push(`[${node.attrs.id}]`);
      image = true;
    });
    return out;
  });
export const selection = (page: Page) =>
  editorOf(page).evaluate((el: any) => el.editor.state.selection.toJSON());
export const tile = (page: Page, i: number) =>
  editorOf(page).locator(".image-tile").nth(i);
export const itemBox = async (page: Page, i: number) =>
  (await editorOf(page).locator(".image-item").nth(i).boundingBox())!;
export async function clickHalf(target: Locator, side: "left" | "right") {
  const box = (await target.boundingBox())!;
  await target.click({
    position: { x: side === "left" ? 10 : box.width - 10, y: box.height / 2 },
  });
}
export const frames = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** The drawn caret (caret.ts): its box, whether it shows, its colour. */
export const caretOf = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const caret = el.parentElement.querySelector(".editor-caret");
    return {
      ...caret.getBoundingClientRect().toJSON(),
      display: getComputedStyle(caret).display,
      color: getComputedStyle(caret).backgroundColor,
    } as { x: number; y: number; width: number; height: number; display: string; color: string };
  });

/**
 * Per image, where the drawn caret is: "after" it or "before" it (as tall as
 * the image, its left edge on the image's right / left edge), else "". Between
 * two images of a row the caret is on the first one's right edge either way,
 * so it counts as "after" the first.
 */
export const caretBeside = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    const caret = el.parentElement.querySelector(".editor-caret").getBoundingClientRect();
    let found = false;
    return Array.from(el.querySelectorAll(".image-item") as NodeListOf<HTMLElement>).map((item) => {
      const r = item.getBoundingClientRect();
      if (found || Math.abs(caret.top - r.top) >= 1 || Math.abs(caret.bottom - r.bottom) >= 1)
        return "";
      const side =
        Math.abs(caret.left - r.right) < 1 ? "after" : Math.abs(caret.left - r.left) < 1 ? "before" : "";
      found = !!side;
      return side;
    });
  });

export type Shot = { width: number; height: number; data: number[] };
/** A screenshot of `clip` (CSS px) as RGBA screen pixels; finite animations end first (the caret on). */
export async function shoot(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  path?: string,
): Promise<Shot> {
  const png = await page.screenshot({ clip, animations: "disabled", path });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    return { width: img.width, height: img.height, data: Array.from(data) };
  }, png.toString("base64"));
}
export const pixel = (shot: Shot, x: number, y: number) => {
  const i = (y * shot.width + x) * 4;
  return shot.data.slice(i, i + 3);
};
export const near = (rgb: number[], hex: string, tolerance = 2) =>
  [1, 3, 5].every(
    (k, i) => Math.abs(rgb[i] - parseInt(hex.slice(k, k + 2), 16)) <= tolerance,
  );
