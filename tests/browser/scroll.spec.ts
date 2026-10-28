import { test, expect, type Page } from "@playwright/test";
import { editorOf, frames, loadSample } from "./helpers";

// Scrolling to the caret: the safe zone, fast repeated keys, PageUp / PageDown (2026-10-22).

const LONG = (k: number) => `长段落${k}：` + "今天天气很好，我们去公园散步，看到很多花。".repeat(5);
type Spec = ["t", string] | ["i", number, number, boolean?];
// 40 blocks: short, wrapping and empty text lines, images of three sizes
// (shown 200×100, 267×200, 60×200), runs of two to five, some rows after a
// line break (true).
const LONG_DOC: Spec[] = [
  ["t", "开头第一行"], ["t", LONG(1)], ["i", 200, 100], ["i", 320, 240], ["i", 120, 400],
  ["t", "图后文字"], ["t", ""], ["i", 320, 240], ["i", 200, 100, true], ["t", LONG(2)],
  ["t", ""], ["t", ""], ["i", 120, 400], ["t", "短行"], ["i", 200, 100],
  ["i", 200, 100], ["i", 320, 240, true], ["i", 120, 400], ["t", LONG(3)], ["i", 320, 240],
  ["t", ""], ["i", 200, 100], ["i", 120, 400, true], ["i", 320, 240, true], ["t", "短行二"],
  ["t", LONG(4)], ["i", 120, 400], ["i", 120, 400], ["i", 320, 240], ["i", 200, 100],
  ["i", 320, 240], ["t", ""], ["t", LONG(5)], ["i", 200, 100], ["t", "短行三"],
  ["i", 320, 240], ["i", 120, 400, true], ["t", "倒数第二行"], ["i", 200, 100], ["i", 320, 240],
];

/** One step: coordinates relative to the editor host's visible top. */
type Snap = {
  sel: any;
  stop: boolean;
  scrollTop: number;
  maxScroll: number;
  clientHeight: number;
  lineHeight: number;
  padding: number;
  /** The caret as drawn: the DOM selection in text, the image a caret between blocks is drawn on. */
  box: { top: number; bottom: number; how: string } | null;
};

/**
 * Loads LONG_DOC and installs `window.snap()` and a log (`window.log`) of
 * every scroll position and selection the editor goes through.
 */
async function loadLong(page: Page) {
  const errors = await loadSample(page);
  await editorOf(page).evaluate((el: any, layout: Spec[]) => {
    let n = 0;
    const content = layout.map((s) => {
      if (s[0] === "t") return { type: "paragraph", content: s[1] ? [{ type: "text", text: s[1] }] : [] };
      n++;
      return { type: "image", attrs: { id: n.toString(16).padStart(64, "0"), name: `p${n}.png`, width: s[1], height: s[2], newline: !!s[3] } };
    });
    el.editor.commands.setContent({ type: "doc", content });
    const view = el.editor.view;
    const host: HTMLElement = el.closest(".editor-host");
    const w = window as any;
    // The line height (line-height: normal): the height of the first text line.
    const lh = (el.querySelector("p") as HTMLElement).getBoundingClientRect().height;
    const stopAt = (sel: any) => {
      const $h = sel.$head;
      const type = sel.toJSON().type;
      if ($h.parent.inlineContent) return type === "text";
      const img = (node: any) => node?.type.name === "image";
      return type === "blockRange" && (img($h.nodeBefore) || img($h.nodeAfter));
    };
    w.snap = () => {
      const sel = view.state.selection;
      const hr = host.getBoundingClientRect();
      const rel = (r: DOMRect, how: string) => ({ top: r.top - hr.top, bottom: r.bottom - hr.top, how });
      let box = null;
      // The image a caret between blocks is drawn beside (image-view's besideImage).
      const $h = sel.$head;
      const img = (node: any) => node?.type.name === "image";
      const rowBreak = img($h.nodeBefore) && img($h.nodeAfter) && $h.nodeAfter.attrs.newline;
      const beside =
        sel.toJSON().type !== "blockRange" || !sel.empty
          ? null
          : img($h.nodeBefore) && !(rowBreak && sel.side > 0)
            ? sel.head - $h.nodeBefore.nodeSize
            : img($h.nodeAfter)
              ? sel.head
              : null;
      if (beside !== null) box = rel(view.nodeDOM(beside).getBoundingClientRect(), "image");
      else {
        const ds = getSelection()!;
        if (ds.rangeCount) {
          const rects = Array.from(ds.getRangeAt(0).getClientRects());
          if (rects.length) box = rel(rects[rects.length - 1], "range");
          else {
            // An empty line: no caret rectangle; its line box.
            const f: any = ds.focusNode;
            const line = f?.nodeType === 1 ? f.closest("p") : f?.parentElement?.closest("p");
            if (line) box = rel(line.getBoundingClientRect(), "empty line");
          }
        }
      }
      return {
        sel: sel.toJSON(),
        stop: stopAt(sel),
        scrollTop: host.scrollTop,
        maxScroll: host.scrollHeight - host.clientHeight,
        clientHeight: host.clientHeight,
        lineHeight: lh,
        padding: Math.min(5 * lh, host.clientHeight / 2),
        box,
      };
    };
    w.log = [];
    host.addEventListener("scroll", () => w.log.push({ scroll: host.scrollTop }));
    el.editor.on("transaction", ({ transaction }: any) => {
      const sel = transaction.selection;
      w.log.push({ sel: sel.toJSON(), stop: stopAt(sel) });
    });
  }, LONG_DOC);
  return errors;
}
const snap = (page: Page): Promise<Snap> => page.evaluate(() => (window as any).snap());
/** Puts the caret at the document's start (or end) with the host scrolled there. */
async function caretToEdge(page: Page, end: boolean) {
  await editorOf(page).evaluate((el: any, end: boolean) => {
    el.editor.commands.focus(end ? "end" : "start");
    const host = el.closest(".editor-host");
    host.scrollTop = end ? host.scrollHeight : 0;
  }, end);
  await frames(page);
  await page.evaluate(() => ((window as any).log = []));
}
/**
 * Where `s` breaks the safe zone, unless the scroll range does not allow it:
 * near the document's start the caret cannot have the zone above it (scrollTop
 * is already 0); near its end it always can (the 40vh bottom padding), so that
 * exemption only covers a scroll range ending early.
 */
function safeZoneMiss(s: Snap) {
  const out: string[] = [];
  if (!s.box) return ["no caret box"];
  const tol = 1;
  if (s.box.top < s.padding - tol && s.scrollTop > tol) out.push(`top ${s.box.top.toFixed(2)} < ${s.padding.toFixed(2)}`);
  if (s.box.bottom > s.clientHeight - s.padding + tol && s.scrollTop < s.maxScroll - tol)
    out.push(`bottom ${s.box.bottom.toFixed(2)} > ${(s.clientHeight - s.padding).toFixed(2)}`);
  return out;
}
const exempt = (s: Snap) =>
  !!s.box &&
  ((s.box.top < s.padding - 1 && s.scrollTop <= 1) ||
    (s.box.bottom > s.clientHeight - s.padding + 1 && s.scrollTop >= s.maxScroll - 1));

/** Walks with the key, two frames after each press, checking every step. */
async function walk(page: Page, key: "ArrowRight" | "ArrowLeft") {
  const dir = key === "ArrowRight" ? 1 : -1;
  const problems: string[] = [];
  const exempted: string[] = [];
  let prev = await snap(page);
  let same = 0;
  let steps = 0;
  for (let i = 1; i <= 2000 && same < 3; i++) {
    await page.keyboard.press(key);
    await frames(page);
    const s = await snap(page);
    steps = i;
    const where = `step ${i} ${JSON.stringify(s.sel)}`;
    if (!s.stop) problems.push(`${where}: not a caret stop`);
    if (dir * (s.scrollTop - prev.scrollTop) < -0.5) problems.push(`${where}: scrollTop ${prev.scrollTop} -> ${s.scrollTop}`);
    for (const miss of safeZoneMiss(s)) problems.push(`${where}: ${miss}`);
    if (exempt(s)) exempted.push(`${i}:${s.sel.head}`);
    same = JSON.stringify(prev.sel) === JSON.stringify(s.sel) ? same + 1 : 0;
    prev = s;
  }
  return { problems, steps, exempted, last: prev };
}

/**
 * Key presses as fast as the page takes them (auto-repeat): keydowns sent
 * through CDP `count` at a time, nothing awaited in between.
 */
async function burst(page: Page, key: "ArrowRight" | "ArrowLeft", total: number, count: number) {
  const client = await page.context().newCDPSession(page);
  const code = key === "ArrowRight" ? 39 : 37;
  const event = (type: string) =>
    client.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code } as any);
  for (let i = 0; i < total; i += count)
    await Promise.all(Array.from({ length: count }, () => event("rawKeyDown")));
  await event("keyUp");
  await frames(page);
  await page.waitForTimeout(50);
  await frames(page);
}
const pageLog = (page: Page) => page.evaluate(() => (window as any).log as any[]);
/** Scroll positions going against `dir`, and selections that are not caret stops. */
function logProblems(log: any[], dir: 1 | -1, start: number) {
  const problems: string[] = [];
  let last = start;
  for (const entry of log) {
    if ("scroll" in entry) {
      if (dir * (entry.scroll - last) < -0.5) problems.push(`scrollTop ${last} -> ${entry.scroll}`);
      last = entry.scroll;
    } else if (!entry.stop) problems.push(`not a caret stop: ${JSON.stringify(entry.sel)}`);
  }
  return problems;
}

test.describe("滚动：安全区与连按", () => {
  test.setTimeout(300_000);

  test("→ 从开头走到末尾：scrollTop 单调不减，每一步光标在安全区内、停在停靠点；连按（不等帧）同样", async ({ page }) => {
    const errors = await loadLong(page);
    await caretToEdge(page, false);
    const result = await walk(page, "ArrowRight");
    expect(result.problems).toEqual([]);
    const size = await editorOf(page).evaluate((el: any) => el.editor.state.doc.content.size);
    expect(result.last.sel).toEqual({ type: "blockRange", anchor: size, head: size, side: -1 });
    test.info().annotations.push({
      type: "→ 逐步",
      description: `${result.steps} 步；滚动范围不允许、安全区豁免的步（步:head）${result.exempted.join(" ")}`,
    });
    // Back to the start, then the same walk with keys back to back.
    await caretToEdge(page, false);
    await burst(page, "ArrowRight", 720, 3);
    expect(logProblems(await pageLog(page), 1, 0)).toEqual([]);
    const s = await snap(page);
    expect(s.sel).toEqual({ type: "blockRange", anchor: size, head: size, side: -1 });
    expect(safeZoneMiss(s)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("← 从末尾走回开头：scrollTop 单调不增，对称；连按同样", async ({ page }) => {
    const errors = await loadLong(page);
    await caretToEdge(page, true);
    const start = await snap(page);
    const result = await walk(page, "ArrowLeft");
    expect(result.problems).toEqual([]);
    expect(result.last.sel).toEqual({ type: "text", anchor: 1, head: 1 });
    expect(result.last.scrollTop).toBe(0);
    test.info().annotations.push({
      type: "← 逐步",
      description: `${result.steps} 步；豁免的步（步:head）${result.exempted.join(" ")}`,
    });
    await caretToEdge(page, true);
    await burst(page, "ArrowLeft", 720, 3);
    expect(logProblems(await pageLog(page), -1, start.scrollTop)).toEqual([]);
    const s = await snap(page);
    expect(s.sel).toEqual({ type: "text", anchor: 1, head: 1 });
    expect(s.scrollTop).toBe(0);
    expect(errors).toEqual([]);
  });

  test("两次按键连发（第二次在 selectionchange 之前到达）：行末 / 行首进入图片不跳到顶、不越过图片", async ({ page }) => {
    const errors = await loadLong(page);
    const client = await page.context().newCDPSession(page);
    const key = (type: string, k: string) =>
      client.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "ArrowRight" ? 39 : 37, nativeVirtualKeyCode: k === "ArrowRight" ? 39 : 37 } as any);
    // → one character before the end of a line an image follows; ← one
    // character after the start of a line an image precedes. Two keys: to the
    // line's end / start, then to the caret between blocks next to the image.
    const spots: { pos: number; dir: 1 | -1; expected: number }[] = await editorOf(page).evaluate((el: any) => {
      const out: { pos: number; dir: 1 | -1; expected: number }[] = [];
      const doc = el.editor.state.doc;
      doc.forEach((node: any, offset: number, index: number) => {
        if (node.type.name !== "paragraph" || node.content.size < 2) return;
        if (doc.maybeChild(index + 1)?.type.name === "image")
          out.push({ pos: offset + node.nodeSize - 2, dir: 1, expected: offset + node.nodeSize });
        if (doc.maybeChild(index - 1)?.type.name === "image")
          out.push({ pos: offset + 2, dir: -1, expected: offset });
      });
      return out;
    });
    expect(spots.length).toBeGreaterThan(8);
    const problems: string[] = [];
    for (const spot of spots) {
      await editorOf(page).evaluate((el: any, pos: number) => {
        const host = el.closest(".editor-host");
        el.editor.commands.focus();
        el.editor.commands.setTextSelection(pos);
        const c = el.editor.view.coordsAtPos(pos);
        host.scrollTop += c.top - host.getBoundingClientRect().top - host.clientHeight / 2;
      }, spot.pos);
      await frames(page);
      const before = await snap(page);
      await page.evaluate(() => ((window as any).log = []));
      const k = spot.dir > 0 ? "ArrowRight" : "ArrowLeft";
      await Promise.all([key("rawKeyDown", k), key("rawKeyDown", k)]);
      await key("keyUp", k);
      await frames(page);
      await page.waitForTimeout(50);
      await frames(page);
      const after = await snap(page);
      const log = await pageLog(page);
      const where = `${k} from ${spot.pos}`;
      for (const p of logProblems(log, spot.dir, before.scrollTop)) problems.push(`${where}: ${p}`);
      const scrolls = log.filter((e) => "scroll" in e).map((e) => e.scroll);
      if (scrolls.some((v) => Math.abs(v - before.scrollTop) > 120)) problems.push(`${where}: jumped ${JSON.stringify(scrolls)}`);
      if (JSON.stringify(after.sel) !== JSON.stringify({ type: "blockRange", anchor: spot.expected, head: spot.expected, side: -1 }))
        problems.push(`${where}: ended at ${JSON.stringify(after.sel)}, expected the caret between blocks at ${spot.expected}`);
      for (const miss of safeZoneMiss(after)) problems.push(`${where}: ${miss}`);
    }
    expect(problems).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("鼠标点击可见区底部附近的一行：不滚动；随后按 → 一次：滚到满足安全区", async ({ page }) => {
    const errors = await loadLong(page);
    await caretToEdge(page, false);
    // LONG(2), a line that wraps: its top 40px above the visible bottom.
    const point = await editorOf(page).evaluate((el: any) => {
      const host = el.closest(".editor-host");
      const line = Array.from(el.querySelectorAll("p") as NodeListOf<HTMLElement>).find((p) => p.textContent!.startsWith("长段落2"))!;
      const hr = host.getBoundingClientRect();
      host.scrollTop += line.getBoundingClientRect().top - (hr.top + host.clientHeight - 40);
      const r = line.getBoundingClientRect();
      return { x: r.left + 120, y: r.top + 8 };
    });
    await frames(page);
    const before = await snap(page);
    await page.mouse.click(point.x, point.y);
    await frames(page);
    const clicked = await snap(page);
    expect(clicked.sel.type).toBe("text");
    expect(clicked.scrollTop).toBe(before.scrollTop);
    // Inside the bottom safe zone, but visible.
    expect(clicked.box!.bottom).toBeGreaterThan(clicked.clientHeight - clicked.padding);
    expect(clicked.box!.bottom).toBeLessThanOrEqual(clicked.clientHeight);
    await page.keyboard.press("ArrowRight");
    await frames(page);
    const moved = await snap(page);
    expect(moved.scrollTop).toBeGreaterThan(before.scrollTop);
    expect(safeZoneMiss(moved)).toEqual([]);
    // The least scrolling: the caret at the bottom edge of the safe zone.
    expect(Math.abs(moved.box!.bottom - (moved.clientHeight - moved.padding))).toBeLessThan(1.5);
    expect(errors).toEqual([]);
  });

  test("PageDown / PageUp 按页移动光标、满足安全区；Shift+PageDown / PageUp 保持 anchor", async ({ page }) => {
    const errors = await loadLong(page);
    await caretToEdge(page, false);
    const size = await editorOf(page).evaluate((el: any) => el.editor.state.doc.content.size);
    const contentY = (s: Snap) => s.scrollTop + (s.box!.top + s.box!.bottom) / 2;
    const problems: string[] = [];
    let prev = await snap(page);
    const lh = prev.lineHeight;
    const pageSize = (Math.floor(prev.clientHeight / lh) - 2) * lh;
    const atEnd = (s: Snap) =>
      JSON.stringify(s.sel) === JSON.stringify({ type: "blockRange", anchor: size, head: size, side: -1 });
    let presses = 0;
    while (presses < 30 && !atEnd(prev)) {
      presses++;
      await page.keyboard.press("PageDown");
      await frames(page);
      const s = await snap(page);
      const where = `PageDown ${presses} ${JSON.stringify(s.sel)}`;
      if (!s.stop) problems.push(`${where}: not a caret stop`);
      if (s.scrollTop < prev.scrollTop - 0.5) problems.push(`${where}: scrolled up`);
      for (const miss of safeZoneMiss(s)) problems.push(`${where}: ${miss}`);
      const moved = contentY(s) - contentY(prev);
      // A page, give or take the block it lands on (images are up to 200px tall).
      if (!atEnd(s) && Math.abs(moved - pageSize) > 220)
        problems.push(`${where}: moved ${moved.toFixed(1)}, a page is ${pageSize.toFixed(1)}`);
      prev = s;
    }
    expect(problems).toEqual([]);
    expect(atEnd(prev)).toBe(true);
    expect(presses).toBeGreaterThan(2);
    for (let i = 1; i <= 30 && prev.sel.head !== 1; i++) {
      await page.keyboard.press("PageUp");
      await frames(page);
      const s = await snap(page);
      const where = `PageUp ${i} ${JSON.stringify(s.sel)}`;
      if (!s.stop) problems.push(`${where}: not a caret stop`);
      if (s.scrollTop > prev.scrollTop + 0.5) problems.push(`${where}: scrolled down`);
      for (const miss of safeZoneMiss(s)) problems.push(`${where}: ${miss}`);
      prev = s;
    }
    expect(problems).toEqual([]);
    expect(prev.sel).toEqual({ type: "text", anchor: 1, head: 1 });
    expect(prev.scrollTop).toBe(0);
    // Shift: the anchor stays at the start, the head goes a page at a time and
    // is the end kept in the safe zone.
    const headBox = () =>
      editorOf(page).evaluate((el: any) => {
        const view = el.editor.view;
        const hr = el.closest(".editor-host").getBoundingClientRect();
        const sel = view.state.selection;
        const $h = sel.$head;
        let r;
        if ($h.parent.inlineContent) r = view.coordsAtPos(sel.head, 1);
        else {
          // Between blocks: the block inside the range at the head, an image
          // whole, a text line at its near end. A head at the start of a row
          // of images (side 1, 2026-10-28) is drawn before the row's first image.
          const forward = sel.head > sel.anchor && !(sel.side === 1 && $h.nodeAfter?.type.name === "image");
          const node = forward ? $h.nodeBefore : $h.nodeAfter;
          // (An empty line: its box; with its line break selected coordsAtPos
          // has no line to measure.)
          r =
            node.type.name === "image" || !node.content.size
              ? view.nodeDOM(forward ? sel.head - node.nodeSize : sel.head).getBoundingClientRect()
              : view.coordsAtPos(forward ? sel.head - 1 : sel.head + 1, 1);
        }
        return { top: r.top - hr.top, bottom: r.bottom - hr.top, how: "head" };
      });
    let head = 1;
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+PageDown");
      await frames(page);
      const s = await snap(page);
      expect(s.sel.anchor).toBe(1);
      expect(s.sel.head).toBeGreaterThan(head);
      head = s.sel.head;
      expect(s.scrollTop).toBeGreaterThan(0);
      expect(safeZoneMiss({ ...s, box: await headBox() })).toEqual([]);
    }
    await page.keyboard.press("Shift+PageUp");
    await frames(page);
    const back = await snap(page);
    expect(back.sel.anchor).toBe(1);
    expect(back.sel.head).toBeLessThan(head);
    expect(safeZoneMiss({ ...back, box: await headBox() })).toEqual([]);
    expect(errors).toEqual([]);
  });
});

