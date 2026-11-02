import { expect, type Locator, type Page } from "@playwright/test";

// Shared by the browser tests. Only the native boundary is replaced
// (`__TAURI_INTERNALS__`, see `mockDesktop`); React, Tiptap and the session
// logic are the app's own.

export const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "笔记正文" });

/** A picture as Rust hands it out; videos and recordings carry `kind` and `duration`, files `kind` and `size`. */
export interface TestPicture {
  id: string;
  name: string;
  width: number;
  height: number;
  kind?: "image" | "video" | "audio" | "file";
  duration?: number;
  size?: number;
}
type Block = { type: "line"; text: string } | { type: "images"; images: TestPicture[] };

export interface DesktopOptions {
  /** The one untitled tab's document (restore_window); one empty line by default. */
  blocks?: Block[];
  /** That document is unsaved changes recovered from its working copy (crash residue). */
  recovered?: boolean;
  /** What read_settings hands out (normalized by the app); the defaults by default. */
  settings?: Record<string, unknown>;
  /**
   * read_image: "png" answers every picture (a video's cover frame too) with a
   * 400×300 PNG; "fail" (the default) rejects, so tiles show their placeholder
   * at the picture's size, except for videos imported here (media_poster).
   */
  images?: "png" | "fail";
  /**
   * restore_window 交出的标签页（代替只有一个无标题 t1）：各自的 id 与文件路径（null 为无标题），
   * 正文为一个空行；当前标签页为第一个。
   */
  tabs?: { id: string; path: string | null }[];
  /**
   * save_document stays pending until the test calls `releaseSave`, so the page
   * can be inspected while a named file is being saved.
   */
  holdSave?: boolean;
  /**
   * install_update 走完下载、暂存、安装三步之后以此失败；不给则停在“正在安装”（真实程序此时已
   * 退出）。见 `announceUpdate` / `releaseInstall`。
   */
  installFailure?: string;
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
      /** import_media 交出的视频 / 音频个数（id 为 media1、media2…）。 */
      media: 0,
      /** media_poster 存过封面的 id。 */
      posters: [] as string[],
      /** import_file 交出的文件个数（id 为 63 个 f 加序号）。 */
      files: 0,
      /** zip_begin 开过的 zip（id 为 zip1、zip2…）：文件夹名与 zip_add 收到的字节数之和。 */
      zips: {} as Record<string, { name: string; size: number }>,
      zipCount: 0,
      /** zip_finish / import_folder 交出的 zip 个数（id 为 63 个 d 加序号）。 */
      folders: 0,
      /** upload_begin 开过、尚未取走的分块上传（id 为 upload1、upload2…）：所属标签页与已收到的字节数。 */
      uploads: {} as Record<string, { tab: string; size: number }>,
      uploadCount: 0,
      /** 测试放进来：第几次 upload_chunk（从 1 数）以此原因失败。 */
      failChunk: null as { at: number; reason: string } | null,
      /** import_image / import_image_upload 交出的图片个数（id 为 image1、image2…）。 */
      uploadedImages: 0,
      /** 测试放进来：这些命令每次调用先等这么多毫秒（模拟慢的导入，让导入慢到能看见进度横幅的每一步）。 */
      delays: {} as Record<string, number>,
      /** clipboard_folders 交出的剪贴板文件夹（测试放进来）。 */
      clipboardFolders: [] as { name: string; path: string }[],
      /** plugin:dialog|save 交出的路径（测试放进来）；null 为用户取消。 */
      savePath: null as string | null,
      releaseSave: () => {},
      /** take_update 交出一次的新版本说明（`announceUpdate` 放进来）。 */
      update: null as unknown,
      /** install_update 报完下载进度后等测试调 `releaseInstall`。 */
      releaseInstall: () => {},
      /** stash_flushed 到了。 */
      flushed: () => {},
      emit: (_event: string, _payload: unknown) => {},
    });
    const opened = (path: string | null, blocks?: Block[], recovered = false) => ({
      document: { blocks: blocks ?? [{ type: "line", text: "" }] },
      path,
      recovered,
      notice: null,
    });
    const emit = (event: string, payload: unknown) => {
      for (const id of state.listeners.get(event) ?? [])
        state.callbacks.get(id)?.({ event, id, payload });
    };
    state.emit = emit;
    // 导入替身交回的 Picture（名字为空），整块导入与分块导入共用。
    const storedMedia = (meta: { kind: string; width: number; height: number; duration: number }) => ({
      id: `media${++state.media}`,
      name: "",
      width: meta.width,
      height: meta.height,
      kind: meta.kind,
      duration: meta.duration,
    });
    const storedFile = (size: number) => ({
      id: `${"f".repeat(63)}${++state.files}`,
      name: "",
      width: 0,
      height: 0,
      kind: "file",
      size,
    });
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
      invoke: async (cmd: string, args: any, invokeOptions?: { headers?: HeadersInit }) => {
        // Raw-body commands (import_image, import_media, media_poster, import_file, zip_add,
        // upload_chunk) are recorded by their size and headers.
        const raw = args instanceof ArrayBuffer;
        const headers = Object.fromEntries(new Headers(invokeOptions?.headers ?? {}));
        state.calls.push({ cmd, args: raw ? { size: args.byteLength, headers } : args });
        if (state.delays[cmd]) await new Promise((done) => setTimeout(done, state.delays[cmd]));
        switch (cmd) {
          // 照 Rust：只存字节、不解码，按 header 交回 Picture（名字为空）。
          case "import_media":
            return storedMedia({
              kind: headers["x-linehush-kind"],
              width: Number(headers["x-linehush-width"]),
              height: Number(headers["x-linehush-height"]),
              duration: Number(headers["x-linehush-duration"]),
            });
          // 照 Rust：交回 Picture（名字为空）；替身不解码，宽高固定。
          case "import_image":
            return { id: `image${++state.uploadedImages}`, name: "", width: 400, height: 300 };
          case "media_poster":
            state.posters.push(headers["x-linehush-id"]);
            return;
          // 照 Rust：原样存任意文件，按字节数交回 size（名字为空）。
          case "import_file":
            return storedFile(args.byteLength);
          // 照 Rust（upload.rs）：大文件分块送来，按 x-linehush-upload 认上传、累加字节数；累计超过
          // 256 MB 或写入失败即放弃这次上传。import_*_upload 取走它，按拼好的整个文件照整块导入交回。
          case "upload_begin": {
            const id = `upload${++state.uploadCount}`;
            state.uploads[id] = { tab: args.tab, size: 0 };
            return id;
          }
          case "upload_chunk": {
            const id = headers["x-linehush-upload"];
            const upload = state.uploads[id];
            if (!upload) throw "文件传输已取消";
            const fail = state.failChunk;
            if (fail && state.calls.filter((c) => c.cmd === cmd).length === fail.at) {
              delete state.uploads[id];
              throw fail.reason;
            }
            upload.size += args.byteLength;
            if (upload.size > 256 * 1024 * 1024) {
              delete state.uploads[id];
              throw "文件过大（上限 256 MB）";
            }
            return;
          }
          case "upload_abort":
            delete state.uploads[args.id];
            return;
          case "import_image_upload":
          case "import_media_upload":
          case "import_file_upload": {
            const upload = state.uploads[args.upload];
            delete state.uploads[args.upload];
            if (!upload) throw "文件传输已取消";
            if (upload.tab !== args.tab) throw "文件传输不属于这个标签页";
            if (cmd === "import_file_upload") return storedFile(upload.size);
            if (cmd === "import_media_upload") return storedMedia(args);
            return { id: `image${++state.uploadedImages}`, name: "", width: 400, height: 300 };
          }
          // 照 Rust：文件夹逐个文件打包成 zip（store），结束时作为附件交回（名字为空）；
          // 相对路径里带“坏”的文件写不进去，超过 256 MB 报文件夹过大。
          case "zip_begin": {
            const id = `zip${++state.zipCount}`;
            state.zips[id] = { name: args.name, size: 0 };
            return id;
          }
          case "zip_add": {
            const zip = state.zips[headers["x-linehush-zip"]];
            if (!zip) throw "测试：没有这个 zip";
            if (decodeURIComponent(headers["x-linehush-path"]).includes("坏"))
              throw "写入压缩包失败：拒绝访问";
            zip.size += args.byteLength;
            if (zip.size > 256 * 1024 * 1024) throw "文件夹过大（上限 256 MB）";
            return;
          }
          case "zip_add_dir":
            return;
          case "zip_finish": {
            const zip = state.zips[args.zipId];
            delete state.zips[args.zipId];
            return {
              id: `${"d".repeat(63)}${++state.folders}`,
              name: "",
              width: 0,
              height: 0,
              kind: "file",
              size: zip.size,
            };
          }
          case "zip_abort":
            delete state.zips[args.zipId];
            return;
          case "clipboard_folders":
            return state.clipboardFolders;
          // 路径里带“坏”的文件夹读不了（Rust 的中文原因）。
          case "import_folder":
            if (String(args.path).includes("坏")) throw "无法读取文件夹：拒绝访问";
            return {
              id: `${"d".repeat(63)}${++state.folders}`,
              name: "",
              width: 0,
              height: 0,
              kind: "file",
              size: 4096,
            };
          // 名字里带“坏”的文件打不开（Rust 的中文原因）。
          case "open_attachment":
            if (String(args.name).includes("坏")) throw "找不到打开它的程序";
            return;
          case "plugin:dialog|save":
            return state.savePath;
          case "restore_window": {
            const tabs = options.tabs ?? [{ id: "t1", path: null }];
            return {
              tabs: tabs.map((tab, i) => ({
                tab: tab.id,
                opened:
                  i === 0
                    ? opened(tab.path, options.blocks, options.recovered)
                    : opened(tab.path),
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
          case "take_update": {
            const update = state.update;
            state.update = null;
            return update;
          }
          // 照 Rust（update.rs）：下载进度 → 请各窗口暂存并等答复 → 安装（随后进程退出）。
          case "install_update": {
            const send = (index: number, message: unknown) =>
              state.callbacks.get(args.onProgress.id)?.({ index, message });
            send(0, { phase: "downloading", downloaded: 45, total: 100 });
            await new Promise<void>((resolve) => (state.releaseInstall = resolve));
            send(1, { phase: "stashing" });
            const flushed = new Promise<void>((resolve) => (state.flushed = resolve));
            emit("flush-requested", { round: 1 });
            await flushed;
            send(2, { phase: "installing" });
            if (options.installFailure) throw options.installFailure;
            return new Promise(() => {});
          }
          case "stash_flushed":
            state.flushed();
            return;
          case "paste_images":
            return [];
          case "save_document":
            if (options.holdSave)
              await new Promise<void>((resolve) => (state.releaseSave = resolve));
            return;
          // 无标题笔记保存对话框的默认路径：没有文件夹，名字原样。
          case "suggest_save_path":
            return `${args.base}.hush`;
          // 路径里带“已删除”的文件当作不存在（Rust 的中文原因）。
          case "reveal_in_explorer":
            if (String(args.path).includes("已删除")) throw `文件不存在：${args.path}`;
            return;
          case "read_image": {
            if (options.images !== "png" && !state.posters.includes(args.id))
              throw "测试：没有缩略图";
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
/** Rust 发现了新版本：take_update 交出 `info` 一次，并发 update-available。 */
/** What the import banner showed: its text and bar width (null without one), or null when gone; `at` ms after `watchImportBanner`. */
export type BannerState = { text: string | null; width: string | null; at: number };
/**
 * Records every change of the import banner in `window.importBanners` from now
 * on (read them with `importBanners`).
 */
export const watchImportBanner = (page: Page) =>
  page.evaluate(() => {
    const start = performance.now();
    const seen: { text: string | null; width: string | null; at: number }[] = ((window as any).importBanners = []);
    const record = () => {
      const banner = document.querySelector(".import-banner");
      const text = banner?.querySelector("span")?.textContent ?? null;
      const width = banner?.querySelector<HTMLElement>(".import-progress > div")?.style.width ?? null;
      const last = seen.at(-1);
      if (last ? last.text !== text || last.width !== width : text !== null)
        seen.push({ text, width, at: performance.now() - start });
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
export const importBanners = (page: Page): Promise<BannerState[]> =>
  page.evaluate(() => (window as any).importBanners);
/** Has `cmd` wait `ms` milliseconds on every call (a slow import). */
export const delay = (page: Page, cmd: string, ms: number) =>
  page.evaluate(([cmd, ms]) => ((window as any).testNative.delays[cmd] = ms), [cmd, ms] as const);

export const announceUpdate = (
  page: Page,
  info = { version: "0.9.0", current: "0.8.0", notes: "", date: null as string | null },
) =>
  page.evaluate((info) => {
    const state = (window as any).testNative;
    state.update = info;
    state.emit("update-available", info);
  }, info);
/** 让 install_update 从下载进度往下走（暂存、安装）。 */
export const releaseInstall = (page: Page) =>
  page.evaluate(() => (window as any).testNative.releaseInstall());
/** Lets the save_document held by `holdSave` finish. */
export const releaseSave = (page: Page) =>
  page.evaluate(() => (window as any).testNative.releaseSave());
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

/**
 * Strings are text lines; images as { id, newline } (shown 200×100 unless
 * sized); `kind` / `duration` make a video (`<id>.mp4`) or a recording
 * (`<id>.mp3`).
 */
export type Item =
  | string
  | {
      id: string;
      newline?: boolean;
      width?: number;
      height?: number;
      kind?: "image" | "video" | "audio";
      duration?: number;
    };
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
                name: `${item.id}.${{ video: "mp4", audio: "mp3" }[item.kind ?? ""] ?? "png"}`,
                width: item.width ?? 200,
                height: item.height ?? 100,
                kind: item.kind ?? "image",
                duration: item.duration ?? null,
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
