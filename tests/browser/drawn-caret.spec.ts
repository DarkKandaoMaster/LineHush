import { test, expect, type Page } from "@playwright/test";
import {
  calls,
  caretOf,
  clickHalf,
  content,
  editorOf,
  frames,
  load,
  loadSample,
  near,
  pixel,
  selection,
  setDoc,
  shoot,
  tile,
  type Shot,
} from "./helpers";

// The editor's own caret and selection (2026-10-23, src/editor/caret.ts):
// the selected line break, pixel width at 150%, corners, composition, long
// documents, the line of the caret at a soft wrap.

test("选中换行：选区在行末多出半个字宽，空行同样，行高不变，收起后消失", async ({
  page,
}) => {
  const errors = await load(page);
  const editor = editorOf(page);
  await editor.evaluate((el: any) => {
    const line = (text: string) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    });
    el.editor.commands.setContent({ type: "doc", content: [line("我"), line(""), line("你")] });
    el.editor.commands.focus();
    el.editor.commands.setTextSelection(2); // after "我"
  });
  /**
   * Per line: whether the drawn selection (caret.ts) covers the points a
   * quarter and three quarters of a character after the line's text, at its
   * middle and near its top and bottom.
   */
  const lines = () =>
    editor.evaluate((el: any) => {
      const layer = el.parentElement.querySelector(".selection-layer");
      const origin = layer.getBoundingClientRect();
      const path = layer.querySelector("path");
      const filled = (x: number, y: number) => {
        const point = layer.createSVGPoint();
        point.x = x - origin.left;
        point.y = y - origin.top;
        return !!path.getAttribute("d") && path.isPointInFill(point);
      };
      return Array.from(el.querySelectorAll(":scope > p")).map((p: any) => {
        const box = p.getBoundingClientRect();
        const em = parseFloat(getComputedStyle(p).fontSize);
        const range = document.createRange();
        range.selectNodeContents(p);
        const end = p.textContent ? range.getBoundingClientRect().right : box.left;
        const middle = (box.top + box.bottom) / 2;
        return {
          height: box.height,
          half: filled(end + em / 4, middle),
          beyond: filled(end + (em * 3) / 4, middle),
          full: filled(end + em / 4, box.top + 1) && filled(end + em / 4, box.bottom - 1),
        };
      });
    });
  const before = await lines();
  expect(before.some((l) => l.half)).toBe(false);

  // "我|" + Shift+→: the selection is just the line break of the first line,
  // half a character wide, the line's full height.
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 4 });
  let now = await lines();
  expect(now.map((l) => l.half)).toEqual([true, false, false]);
  expect(now[0].beyond).toBe(false);
  expect(now[0].full).toBe(true);
  expect(now.map((l) => l.height)).toEqual(before.map((l) => l.height));

  // Across the empty line too: half a character at its start.
  await page.keyboard.press("Shift+ArrowRight");
  expect(await selection(page)).toEqual({ type: "text", anchor: 2, head: 6 });
  now = await lines();
  expect(now.map((l) => l.half)).toEqual([true, true, false]);
  expect(now[1].beyond).toBe(false);
  expect(now[1].full).toBe(true);
  expect(now.map((l) => l.height)).toEqual(before.map((l) => l.height));

  // Select all: the last line has no line break after it.
  await page.keyboard.press("Control+a");
  now = await lines();
  expect(now.map((l) => l.half)).toEqual([true, true, false]);

  // Collapsing the selection removes the shape.
  await page.keyboard.press("ArrowRight");
  now = await lines();
  expect(now.some((l) => l.half)).toBe(false);
  expect(now.map((l) => l.height)).toEqual(before.map((l) => l.height));
  expect(errors).toEqual([]);
});

/** Each column of the shot: "caret" (#060606 all the way down), "background" (#f9f9f9), or "other". */
const columns = (shot: Shot) =>
  Array.from({ length: shot.width }, (_, x) => {
    const column = Array.from({ length: shot.height }, (_, y) => pixel(shot, x, y));
    if (column.every((rgb) => near(rgb, "#060606"))) return "caret";
    if (column.every((rgb) => near(rgb, "#f9f9f9"))) return "background";
    return `other(${column[Math.floor(column.length / 2)]})`;
  });
/** Exactly `n` caret columns side by side, the rest background (no grey, half-covered column). */
function expectColumns(cols: string[], n: number) {
  const first = cols.indexOf("caret");
  expect(cols.filter((c) => c === "caret").length, cols.join(" ")).toBe(n);
  expect(cols.slice(first, first + n).every((c) => c === "caret"), cols.join(" ")).toBe(true);
  expect(cols.filter((c) => c.startsWith("other")), cols.join(" ")).toEqual([]);
}
/** A text line, an empty line (the caret there, nothing drawn around it), a row of two images. */
async function caretInEmptyLine(page: Page) {
  await setDoc(page, ["文字", "", { id: "a" }, { id: "b" }, "下面"]);
  await editorOf(page).evaluate((el: any) => {
    el.editor.commands.focus();
    el.editor.commands.setTextSelection(5);
  });
}
/** Around the caret, narrow enough to stay inside the 8px gap between images. */
const caretClip = (c: { x: number; y: number; height: number }, n: number) => ({
  x: Math.floor(c.x) - 2,
  y: Math.ceil(c.y) + 2,
  width: n === 1 ? 5 : 6,
  height: Math.floor(c.height) - 4,
});
/**
 * Three lines of different lengths selected from after the second character of
 * line 1 to after the fifth of line 3, the editor blurred so no caret is drawn
 * (the selection still is).
 */
const SHAPE_LINES = [
  "短短的一行文字",
  "这一行比上一行和下一行都要长很多很多很多",
  "中等长度的一行文字",
  "后面",
];
/**
 * Selects the shape with the editor focused, so the selection has the active
 * colour (#97c6eb; blurred it is the inactive one), and hides the caret drawn
 * at its end.
 */
const selectShape = (page: Page) =>
  editorOf(page).evaluate((el: any) => {
    el.editor.view.focus();
    el.editor.commands.setTextSelection({ from: 3, to: 37 });
    if (!document.getElementById("hide-caret")) {
      const style = document.createElement("style");
      style.id = "hide-caret";
      style.textContent = ".editor-caret { display: none !important; }";
      document.head.append(style);
    }
  });
/** The selection's path data. */
const shapePath = (page: Page) =>
  editorOf(page).evaluate(
    (el: any) => el.parentElement.querySelector(".selection-layer path").getAttribute("d") as string,
  );

test.describe("150% 缩放", () => {
  test.use({ deviceScaleFactor: 1.5 });

  // “细” follows Windows (1 screen pixel here), “中” / “粗” are 2× / 3× it.
  for (const [choice, n] of [
    ["thin", 1],
    ["medium", 2],
    ["thick", 3],
  ] as const)
    test(`光标粗细 ${choice}：自绘光标恰好 ${n} 个屏幕像素宽、#060606，左右没有灰色半透明列；块间光标同宽、在间隙正中`, async ({
      page,
    }) => {
      const errors = await load(page, { settings: { caretWidth: choice } });
      expect(await page.evaluate(() => devicePixelRatio)).toBe(1.5);
      await caretInEmptyLine(page);
      let caret = await caretOf(page);
      expect(caret.display).toBe("block");
      expect(caret.color).toBe("rgb(6, 6, 6)");
      // n screen pixels in layout units (1/64 px), painted as n screen pixels (below).
      expect(caret.width).toBeCloseTo(n / 1.5, 1);
      // The browser's own caret is transparent.
      expect(await editorOf(page).evaluate((el) => getComputedStyle(el).caretColor)).toBe(
        "rgba(0, 0, 0, 0)",
      );
      expectColumns(
        columns(await shoot(page, caretClip(caret, n), test.info().outputPath(`caret-150-${choice}-text.png`))),
        n,
      );

      // Between the two images: as tall as the image, the same columns, in the gap's middle.
      await clickHalf(tile(page, 0), "right");
      caret = await caretOf(page);
      const image = (await tile(page, 0).boundingBox())!;
      expect(caret.display).toBe("block");
      expect(Math.abs(caret.height - image.height)).toBeLessThan(1);
      expect(caret.width).toBeCloseTo(n / 1.5, 1);
      expect(Math.abs(caret.x + caret.width / 2 - (image.x + image.width + 4))).toBeLessThan(1);
      expectColumns(
        columns(await shoot(page, caretClip(caret, n), test.info().outputPath(`caret-150-${choice}-gap.png`))),
        n,
      );
      expect(errors).toEqual([]);
    });

  test("光标粗细在设置里从“粗”改为“细”：即时变 1 列，并写入设置", async ({ page }) => {
    const errors = await load(page, { settings: { caretWidth: "thick" } });
    await caretInEmptyLine(page);
    await page.locator(".settings-button").click();
    const dialog = page.locator("dialog.settings-dialog");
    await expect(dialog).toBeVisible();
    const group = dialog.getByRole("radiogroup", { name: "光标粗细" });
    await expect(group.getByRole("radio", { name: "粗" })).toBeChecked();
    await group.getByRole("radio", { name: "细" }).check();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await editorOf(page).evaluate((el: any) => {
      el.editor.commands.focus();
      el.editor.commands.setTextSelection(5);
    });
    const caret = await caretOf(page);
    expect(caret.width).toBeCloseTo(1 / 1.5, 1);
    expectColumns(columns(await shoot(page, caretClip(caret, 1))), 1);
    await expect
      .poll(async () => (await calls(page, "write_settings")).at(-1)?.settings.caretWidth)
      .toBe("thin");
    expect(errors).toEqual([]);
  });

  test("选区边角设为“方角”：同一形状直角，外角最外像素为 #97c6eb、无反向圆角；在设置里改为“圆角”即时变回背景色", async ({
    page,
  }) => {
    const errors = await load(page, { settings: { selectionCorners: "square" } });
    await setDoc(page, SHAPE_LINES);
    await selectShape(page);
    expect(await selection(page)).toEqual({ type: "text", anchor: 3, head: 37 });
    // The shape alone: the text made transparent.
    await page.addStyleTag({ content: ".tiptap { color: transparent !important; }" });
    const first = await editorOf(page).evaluate((el: any) => {
      const p = el.querySelector(":scope > p")!;
      const range = document.createRange();
      range.setStart(p.firstChild!, 2);
      range.setEnd(p.firstChild!, p.firstChild!.textContent!.length);
      return range.getBoundingClientRect().toJSON() as DOMRect;
    });
    // From the page's corner, so screen pixel (i, j) is CSS (i, j) / 1.5.
    const region = { x: 0, y: 0, width: 520, height: 200 };
    const corners = async (path?: string) => {
      const shot = await shoot(page, region, path);
      // Line 1's part starts at screen pixel (left, top) (rows are rounded to screen pixels).
      const left = Math.round(first.left * 1.5);
      const top = Math.round(first.top * 1.5);
      const bottom = Math.round(first.bottom * 1.5);
      return {
        // The outermost pixel of the top-left corner of line 1's part.
        outer: pixel(shot, left, top),
        // Just left of line 1's part and just above line 2: the inner corner.
        inner: pixel(shot, left - 1, bottom - 1),
        // The middle of line 1's part.
        middle: pixel(shot, Math.round(((first.left + first.right) / 2) * 1.5), Math.round(((first.top + first.bottom) / 2) * 1.5)),
        // The pixel above the outer one: outside the shape.
        above: pixel(shot, left, top - 1),
      };
    };
    let px = await corners(test.info().outputPath("square-selection-shape.png"));
    expect(near(px.outer, "#97c6eb", 1), `outer corner ${px.outer}`).toBe(true);
    expect(near(px.above, "#f9f9f9", 1), `above the corner ${px.above}`).toBe(true);
    // No reverse rounding: the inner corner stays background.
    expect(near(px.inner, "#f9f9f9", 1), `inner corner ${px.inner}`).toBe(true);
    expect(near(px.middle, "#97c6eb", 1), `middle ${px.middle}`).toBe(true);
    expect(await shapePath(page)).not.toMatch(/A/);

    // “圆角” in the settings dialog: applies at once, and is written.
    await page.locator(".settings-button").click();
    const dialog = page.locator("dialog.settings-dialog");
    await expect(dialog).toBeVisible();
    const group = dialog.getByRole("radiogroup", { name: "选区边角" });
    await expect(group.getByRole("radio", { name: "方角" })).toBeChecked();
    await group.getByRole("radio", { name: "圆角" }).check();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await selectShape(page);
    expect(await shapePath(page)).toMatch(/A/);
    px = await corners(test.info().outputPath("square-to-rounded-selection-shape.png"));
    expect(near(px.outer, "#f9f9f9", 1), `outer corner ${px.outer}`).toBe(true);
    expect(px.inner[0], `inner corner ${px.inner}`).toBeLessThan(215);
    expect(near(px.middle, "#97c6eb", 1), `middle ${px.middle}`).toBe(true);
    await expect
      .poll(async () => (await calls(page, "write_settings")).at(-1)?.settings.selectionCorners)
      .toBe("rounded");
    expect(errors).toEqual([]);
  });
});

test("圆角选区：三行参差的文字连成一块，外角圆、内角反向圆，中部为 #97c6eb；截图", async ({
  page,
}) => {
  const errors = await load(page);
  await setDoc(page, SHAPE_LINES);
  await selectShape(page);
  expect(await selection(page)).toEqual({ type: "text", anchor: 3, head: 37 });
  const box = (await editorOf(page).boundingBox())!;
  const region = { x: box.x, y: box.y, width: 520, height: 110 };
  await shoot(page, region, test.info().outputPath("rounded-selection.png"));
  // The shape alone: the text made transparent.
  await page.addStyleTag({ content: ".tiptap { color: transparent !important; }" });
  const geometry = await editorOf(page).evaluate((el: any) => {
    const ps = el.querySelectorAll(":scope > p");
    const part = (p: Element, start: number, end?: number) => {
      const range = document.createRange();
      range.setStart(p.firstChild!, start);
      range.setEnd(p.firstChild!, end ?? p.firstChild!.textContent!.length);
      return range.getBoundingClientRect().toJSON() as DOMRect;
    };
    return { first: part(ps[0], 2), second: part(ps[1], 0), third: part(ps[2], 0, 5) };
  });
  const shot = await shoot(page, region, test.info().outputPath("rounded-selection-shape.png"));
  const at = (x: number, y: number) =>
    pixel(shot, Math.floor(x - region.x), Math.floor(y - region.y));
  const { first, second, third } = geometry;
  // Outer corner (top left of line 1's part): its corner pixel stays background.
  const outer = at(Math.round(first.left), Math.round(first.top));
  expect(outer[0], `outer corner ${outer}`).toBeGreaterThan(240);
  // Inside that corner, the selection colour.
  expect(near(at(first.left + 4, first.top + 4), "#97c6eb", 1)).toBe(true);
  // The middle of line 2.
  const middle = at((second.left + second.right) / 2, (second.top + second.bottom) / 2);
  expect(near(middle, "#97c6eb", 1), `middle ${middle}`).toBe(true);
  // Inner corner where line 2 starts further left than line 1: the pixel just
  // left of line 1's part and just above line 2 is filled by the reverse
  // rounding (it would be background with square corners).
  const inner = at(Math.round(first.left) - 1, Math.round(first.bottom) - 1);
  expect(inner[0], `inner corner ${inner}`).toBeLessThan(215);
  // Below line 3's part (line 4, not selected): background.
  expect(at(third.right - 1, third.bottom + 3)[0]).toBeGreaterThan(240);
  // The editor blurred (the focus elsewhere): the same shape in the inactive colour.
  await editorOf(page).evaluate((el: HTMLElement) => el.blur());
  await frames(page);
  const blurred = await shoot(page, region);
  const still = pixel(
    blurred,
    Math.floor((second.left + second.right) / 2 - region.x),
    Math.floor((second.top + second.bottom) / 2 - region.y),
  );
  expect(near(still, "#d5dde6", 1), `blurred middle ${still}`).toBe(true);
  expect(errors).toEqual([]);
});

test("输入法组字期间：自绘光标与选区隐藏，浏览器画光标；结束后恢复", async ({ page }) => {
  const errors = await loadSample(page);
  await editorOf(page).evaluate((el: any) => {
    el.editor.commands.focus();
    el.editor.commands.setTextSelection(3);
  });
  expect((await caretOf(page)).display).toBe("block");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  const during = await editorOf(page).evaluate((el) => ({
    composing: el.parentElement!.classList.contains("composing"),
    caret: getComputedStyle(el.parentElement!.querySelector(".editor-caret")!).display,
    layer: getComputedStyle(el.parentElement!.querySelector(".selection-layer")!).display,
    native: getComputedStyle(el).caretColor,
  }));
  expect(during).toEqual({ composing: true, caret: "none", layer: "none", native: "rgb(6, 6, 6)" });
  await cdp.send("Input.insertText", { text: "你" });
  await expect.poll(() => content(page)).toEqual(["上面你", "[a]", "[b]", "下面"]);
  await expect
    .poll(() => editorOf(page).evaluate((el) => el.parentElement!.classList.contains("composing")))
    .toBe(false);
  // Drawn again, after the composed text.
  const caret = await caretOf(page);
  expect(caret.display).toBe("block");
  const end = await editorOf(page).evaluate((el: any) => el.editor.view.coordsAtPos(4, 1).left);
  expect(Math.abs(caret.x - end)).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test("全选长文档：画选区不卡（量一次全选的耗时）", { tag: "@slow" }, async ({ page }) => {
  const errors = await loadSample(page);
  await setDoc(
    page,
    Array.from({ length: 3000 }, (_, i) =>
      i % 7 === 3 ? "" : `第 ${i} 行：这是一行用来量画选区耗时的文字，长短不一${"。".repeat(i % 13)}`,
    ),
  );
  await editorOf(page).evaluate((el: any) => el.editor.commands.focus("start"));
  const ms = await editorOf(page).evaluate((el: any) => {
    const t = performance.now();
    el.editor.commands.selectAll();
    return performance.now() - t;
  });
  console.log(`3000 行全选：${ms.toFixed(1)} ms`);
  expect(
    await editorOf(page).evaluate(
      (el) => !!el.parentElement!.querySelector(".selection-layer path")!.getAttribute("d"),
    ),
  ).toBe(true);
  expect(ms).toBeLessThan(500);
  // Only lines near the viewport are measured; scrolled far away, the lines
  // shown are measured then and drawn selected.
  for (const at of [0.5, 1]) {
    await editorOf(page).evaluate((el: any, at: number) => {
      const host = el.closest(".editor-host");
      host.scrollTop = (host.scrollHeight - host.clientHeight) * at;
    }, at);
    await frames(page);
    const covered = await editorOf(page).evaluate((el: any) => {
      const host = el.closest(".editor-host").getBoundingClientRect();
      const layer = el.parentElement.querySelector(".selection-layer");
      const origin = layer.getBoundingClientRect();
      const path = layer.querySelector("path");
      const lines = Array.from(el.querySelectorAll(":scope > p")).filter((p: any) => {
        const r = p.getBoundingClientRect();
        return p.textContent && r.top > host.top && r.bottom < host.bottom;
      }) as HTMLElement[];
      return lines.map((p) => {
        const r = p.getBoundingClientRect();
        const point = layer.createSVGPoint();
        point.x = r.left + 4 - origin.left;
        point.y = (r.top + r.bottom) / 2 - origin.top;
        return path.isPointInFill(point);
      });
    });
    expect(covered.length).toBeGreaterThan(10);
    expect(covered.every(Boolean), `scrolled to ${at}`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("自动换行处光标所在行与浏览器一致：End / 点上一行末尾空白在上一行末，→ / ← / 点下一行行首在下一行首", async ({
  page,
}) => {
  const errors = await loadSample(page);
  const text =
    "今天天气很好，我们去公园散步，看见湖边有很多人在钓鱼。孩子们在草地上奔跑，老人坐在长椅上晒太阳聊天。" +
    "中午在附近的小馆子吃了一碗面，味道一般但是分量很足。下午回家整理了书架，把不再看的旧书装进箱子里准备捐出去。";
  await setDoc(page, ["上面", text, "下面"]);
  // The first wrap of the long line (it starts at 4, its text at 5).
  const wrap = await editorOf(page).evaluate((el: any) => {
    const view = el.editor.view;
    for (let pos = 6; pos < 5 + view.state.doc.child(1).content.size; pos++) {
      const up = view.coordsAtPos(pos, -1);
      const down = view.coordsAtPos(pos, 1);
      if (Math.abs(up.top - down.top) > 2) return { pos, up, down };
    }
    return null;
  });
  expect(wrap).not.toBeNull();
  const { pos, up, down } = wrap!;
  const set = (at: number) =>
    editorOf(page).evaluate((el: any, at: number) => {
      el.editor.commands.focus();
      el.editor.commands.setTextSelection(at);
    }, at);
  /** Which line the drawn caret is on at the wrap: "up" (end of the upper line) or "down". */
  const line = async () => {
    expect((await selection(page)).head).toBe(pos);
    await frames(page);
    const c = await caretOf(page);
    expect(c.display).toBe("block");
    const near = (r: { top: number; left: number }) => Math.abs(c.y - r.top) < 1.5 && Math.abs(c.x - r.left) < 1.5;
    return near(up) ? "up" : near(down) ? "down" : `elsewhere ${JSON.stringify(c)}`;
  };
  await set(5);
  await page.keyboard.press("End");
  expect(await line()).toBe("up");
  await set(pos - 1);
  await page.keyboard.press("ArrowRight");
  expect(await line()).toBe("down");
  await page.keyboard.press("End");
  expect((await selection(page)).head).toBeGreaterThan(pos); // the end of the lower line
  await set(pos + 1);
  await page.keyboard.press("ArrowLeft");
  expect(await line()).toBe("down");
  // A click right of the upper line's end, then one on the lower line's first
  // character (the same position: no new selection in ProseMirror).
  const right = (await editorOf(page).boundingBox())!;
  await page.mouse.click(right.x + right.width - 4, (up.top + up.bottom) / 2);
  expect(await line()).toBe("up");
  await page.mouse.click(down.left + 1, (down.top + down.bottom) / 2);
  expect(await line()).toBe("down");
  // Shift+End: the head (a range) at the end of the upper line.
  await set(5);
  await page.keyboard.press("Shift+End");
  expect(await line()).toBe("up");
  expect(errors).toEqual([]);
});
