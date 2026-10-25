import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  DEFAULT_CARET_METRICS,
  blinkIterations,
  caretBox,
  caretWidth,
  toDevicePixel,
  type CaretMetrics,
  type CaretSpot,
} from "./caret-math.ts";
import { drawnCaret, textCaret } from "./caret-geometry.ts";
import { headSide } from "./input.ts";
import { lineHeight, scroller } from "./reveal.ts";
import {
  cornerRadius,
  selectedNewlines,
  selectionPath,
  type Row,
} from "./selection-shape.ts";
import type { CaretWidth, SelectionCorners } from "../core/settings.ts";

/**
 * The editor draws its own caret and text selection; the browser's are made
 * transparent (App.css), except while an input method composes, when the
 * editor's state lags behind the text being composed and the browser draws
 * both (the editor's parent gets `.composing`).
 *
 * The caret is as wide as the Windows caret setting in screen pixels (one by
 * default, as Notepad's; the browser's is one CSS pixel, two screen pixels at
 * 150%), or two / three times that with the “光标粗细” setting at "中" / "粗",
 * on whole screen pixels, blinking at the system's rate and standing still
 * after the system's timeout. The selection is VS Code's rounded shape
 * (selection-shape.ts), or the same shape with square corners with the
 * “选区边角” setting at "方角" (see `configureCaret`).
 *
 * Both are elements next to the editable root, in its parent (Tiptap's
 * EditorContent element, positioned in App.css), not inside it: ProseMirror
 * owns every node in the root. That parent scrolls with the content, so
 * neither needs redrawing on scroll. The selection is an SVG below the text
 * (z-index -1 in the parent's stacking context); the caret is above it.
 */

/** Fired on the window when something changes the layout without resizing the editor (settings). */
export const LAYOUT_CHANGED = "linehush-layout-changed";

interface CaretConfig {
  /** The system caret settings, read by Rust. */
  metrics: CaretMetrics;
  /** The “光标粗细” setting (`caretWidth`). */
  width: CaretWidth;
  /** The “选区边角” setting (`cornerRadius`). */
  corners: SelectionCorners;
}
let config: CaretConfig = {
  metrics: DEFAULT_CARET_METRICS,
  width: "thin",
  corners: "rounded",
};
const redraws = new Set<() => void>();
const relayouts = new Set<() => void>();

/**
 * 立即重画窗口里每个编辑器的光标与选区：编辑区的布局在绘制前同步变化、根节点内容大小却不变时
 * 用（查找条在正文顶部加的空白，components/FindWidget.tsx；ResizeObserver 看不到内边距的变化）。
 */
export function redrawCarets() {
  for (const redraw of relayouts) redraw();
}

/** Applies caret settings (useSettings, useCaretMetrics) to every editor in the window. */
export function configureCaret(partial: Partial<CaretConfig>) {
  const next = { ...config, ...partial };
  const { metrics } = next;
  if (
    next.width === config.width &&
    next.corners === config.corners &&
    metrics.width === config.metrics.width &&
    metrics.blinkMs === config.metrics.blinkMs &&
    metrics.timeoutMs === config.metrics.timeoutMs
  )
    return;
  config = next;
  for (const redraw of redraws) redraw();
}

/**
 * The selected text, one row per visual line in client coordinates, from the
 * text lines in the selection (images show their own layer, `.image-selected`).
 * Each line's part is one DOM Range (its rects, by line); an empty line is its
 * line box with no width. A selected line break adds half a character after the
 * line's text (as Notepad draws it; see `selectedNewlines`). Rows of the
 * same or neighbouring lines are stretched to meet, so they make one shape.
 *
 * Only lines inside `band` (client coordinates) are measured, so a long
 * selection (Ctrl+A in a long document) costs what the screen shows; `clipped`
 * tells that lines were left out.
 */
function selectionRows(
  view: EditorView,
  band: { top: number; bottom: number } | null,
): { rows: Row[]; clipped: boolean } {
  const { doc, selection } = view.state;
  let clipped = false;
  if (selection.empty) return { rows: [], clipped };
  const { from, to } = selection;
  const newlines = new Set(selectedNewlines(doc, selection));
  const style = getComputedStyle(view.dom);
  const em = parseFloat(style.fontSize) || 13;
  const range = view.dom.ownerDocument.createRange();
  const rows: (Row & { block: number })[] = [];
  doc.nodesBetween(from, to, (node, pos, _parent, block) => {
    if (!node.isTextblock) return false;
    if (band) {
      const box = (view.nodeDOM(pos) as HTMLElement | null)?.getBoundingClientRect();
      if (box && (box.bottom < band.top || box.top > band.bottom)) {
        clipped = true;
        return false;
      }
    }
    const start = pos + 1;
    const end = start + node.content.size;
    const s = Math.max(from, start);
    const e = Math.min(to, end);
    const lines: Row[] = [];
    if (s < e) {
      const a = view.domAtPos(s);
      const b = view.domAtPos(e);
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      for (const rect of Array.from(range.getClientRects())) {
        if (!(rect.width > 0) || !(rect.height > 0)) continue;
        // Parts of one visual line (several fonts) overlap by most of their height.
        const line = lines.find(
          (l) =>
            Math.min(l.bottom, rect.bottom) - Math.max(l.top, rect.top) >
            Math.min(l.bottom - l.top, rect.height) / 2,
        );
        if (line) {
          line.top = Math.min(line.top, rect.top);
          line.bottom = Math.max(line.bottom, rect.bottom);
          line.left = Math.min(line.left, rect.left);
          line.right = Math.max(line.right, rect.right);
        } else
          lines.push({
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
          });
      }
      lines.sort((x, y) => x.top - y.top);
    }
    if (newlines.has(pos)) {
      if (!lines.length) {
        // Nothing of the line's text is selected, only its line break.
        let spot: CaretSpot;
        if (!node.content.size) spot = textCaret(view, start);
        else {
          const c = view.coordsAtPos(end, -1);
          spot = { x: c.right, top: c.top, bottom: c.bottom };
        }
        lines.push({ top: spot.top, bottom: spot.bottom, left: spot.x, right: spot.x });
      }
      const last = lines[lines.length - 1];
      if (last) last.right += em / 2;
    }
    for (const line of lines) rows.push({ ...line, block });
    return false;
  });
  // Rows of one line or of neighbouring lines meet: a gap closes downwards,
  // an overlap (fonts with taller boxes) splits in the middle. Rows with an
  // image between them stay apart.
  const tall = lineHeight(view);
  for (let i = 0; i + 1 < rows.length; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    if (next.block - row.block > 1) continue;
    const gap = next.top - row.bottom;
    if (gap > tall / 2) continue;
    if (gap >= 0) row.bottom = next.top;
    else row.bottom = next.top = (row.bottom + next.top) / 2;
  }
  return { rows, clipped };
}

const SVG = "http://www.w3.org/2000/svg";

/** Draws the caret and the selection of one editor (see the comment at the top). */
class Drawing {
  private view: EditorView;
  private caret: HTMLDivElement;
  private layer: SVGSVGElement;
  private path: SVGPathElement;
  private blink: Animation | null = null;
  private resize: ResizeObserver;
  private media: MediaQueryList | null = null;
  private frame = 0;
  private composingEnd: ReturnType<typeof setTimeout> | undefined;
  /** The scroll container, and the part of the content the selection was measured in. */
  private scroller: HTMLElement | null = null;
  private measured: { top: number; bottom: number } | null = null;
  /**
   * Scrolling a long selection that was measured only near the viewport
   * (`selectionRows`): measured again before the viewport nears its edge.
   */
  private onScroll = () => {
    const band = this.measured;
    const host = this.host();
    if (!band || !host || !this.scroller) return;
    const view = this.scroller.getBoundingClientRect();
    const top = host.getBoundingClientRect().top + host.clientTop;
    const margin = view.height / 2;
    if (view.top - margin - top < band.top || view.bottom + margin - top > band.bottom)
      this.draw(false);
  };
  private onMedia = () => {
    this.watchScale();
    this.draw(true);
  };
  private onLayout = () => this.schedule();
  private onRelayout = () => this.draw(false);
  private onFocus = () => this.draw(true);
  private onCompositionStart = () => {
    clearTimeout(this.composingEnd);
    this.composingEnd = undefined;
    this.host()?.classList.add("composing");
  };
  // ProseMirror reads the composed text shortly after compositionend; until
  // then the state (and so the drawn caret) is where the composition began.
  private onCompositionEnd = () => {
    clearTimeout(this.composingEnd);
    this.composingEnd = setTimeout(() => this.endComposition(), 100);
  };

  constructor(view: EditorView) {
    this.view = view;
    const doc = view.dom.ownerDocument;
    const win = doc.defaultView!;
    this.scroller = scroller(view);
    this.scroller?.addEventListener("scroll", this.onScroll, { passive: true });
    this.caret = doc.createElement("div");
    this.caret.className = "editor-caret";
    this.layer = doc.createElementNS(SVG, "svg");
    this.layer.classList.add("selection-layer");
    this.layer.setAttribute("aria-hidden", "true");
    this.path = doc.createElementNS(SVG, "path");
    this.layer.append(this.path);
    this.attach();
    // The editor's size changes when the window does (lines wrap anew) and
    // as content is added; the callback comes after layout, before paint.
    this.resize = new win.ResizeObserver(() => this.draw(false));
    this.resize.observe(view.dom);
    win.addEventListener(LAYOUT_CHANGED, this.onLayout);
    view.dom.addEventListener("focus", this.onFocus);
    view.dom.addEventListener("blur", this.onFocus);
    view.dom.addEventListener("compositionstart", this.onCompositionStart);
    view.dom.addEventListener("compositionend", this.onCompositionEnd);
    // A click on the caret's own position changes no state but may change the
    // line it is drawn on at a wrap (input.ts, `headSide`).
    win.addEventListener("mouseup", this.onLayout);
    this.watchScale();
    redraws.add(this.onMedia);
    relayouts.add(this.onRelayout);
  }

  private host() {
    return this.view.dom.parentElement;
  }

  /** Puts the elements next to the root (Tiptap moves the root into EditorContent's element). */
  private attach() {
    const host = this.host();
    if (!host) return false;
    if (this.layer.parentNode !== host) host.prepend(this.layer);
    if (this.caret.parentNode !== host) host.append(this.caret);
    // The root is placed in the scroll container after the view is made.
    const container = scroller(this.view);
    if (container !== this.scroller) {
      this.scroller?.removeEventListener("scroll", this.onScroll);
      this.scroller = container;
      container?.addEventListener("scroll", this.onScroll, { passive: true });
    }
    return true;
  }

  /** Redraws when the window moves to a display with another scale. */
  private watchScale() {
    const win = this.view.dom.ownerDocument.defaultView!;
    this.media?.removeEventListener("change", this.onMedia);
    this.media = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    this.media.addEventListener("change", this.onMedia);
  }

  private endComposition() {
    this.composingEnd = undefined;
    if (this.view.composing) return;
    this.host()?.classList.remove("composing");
    this.draw(true);
  }

  /** On the next frame (settings change the layout after their style is applied). */
  schedule() {
    const win = this.view.dom.ownerDocument.defaultView;
    if (!win || this.frame) return;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw(true);
    });
  }

  /** After a state change: the caret restarts blinking (it stays on while typing). */
  update() {
    if (this.composingEnd !== undefined && !this.view.composing) {
      clearTimeout(this.composingEnd);
      this.endComposition();
      return;
    }
    this.draw(true);
  }

  /** `restart`: start the caret's blinking over, on. */
  draw(restart: boolean) {
    if (this.view.isDestroyed || !this.attach()) return;
    const host = this.host()!;
    const win = this.view.dom.ownerDocument.defaultView!;
    const dpr = win.devicePixelRatio || 1;
    const rect = host.getBoundingClientRect();
    const origin = { left: rect.left + host.clientLeft, top: rect.top + host.clientTop };

    // The selection, its corners on screen pixels; measured a viewport's
    // height above and below the viewport.
    const px = (v: number) => toDevicePixel(v, dpr);
    const view = this.scroller?.getBoundingClientRect();
    const band =
      view && view.height > 0
        ? { top: view.top - view.height, bottom: view.bottom + view.height }
        : null;
    const { rows: found, clipped } = selectionRows(this.view, band);
    this.measured =
      clipped && band
        ? { top: band.top - origin.top, bottom: band.bottom - origin.top }
        : null;
    // Chromium paints an SVG's content from its origin rounded to a whole
    // screen pixel (the parent at 73 CSS px is 109.5 screen pixels at 150%,
    // painted from 110); measured from the unrounded origin every horizontal
    // edge would be half a pixel off and blended. (The caret, a div, has its
    // own edges rounded instead, so caretBox uses `origin`.)
    const layer = { left: px(origin.left), top: px(origin.top) };
    const rows = found.map((row) => ({
      top: px(row.top) - layer.top,
      bottom: px(row.bottom) - layer.top,
      left: px(row.left) - layer.left,
      right: px(row.right) - layer.left,
    }));
    const d = selectionPath(rows, cornerRadius(config.corners));
    if (this.path.getAttribute("d") !== d) {
      if (d) this.path.setAttribute("d", d);
      else this.path.removeAttribute("d");
    }

    const spot = drawnCaret(this.view, headSide(this.view));
    const style = this.caret.style;
    if (!spot) {
      style.visibility = "hidden";
      this.blink?.cancel();
      this.blink = null;
      return;
    }
    const box = caretBox(spot, origin, caretWidth(config.metrics, config.width), dpr);
    style.visibility = "";
    style.left = `${box.left}px`;
    style.top = `${box.top}px`;
    style.width = `${box.width}px`;
    style.height = `${box.height}px`;
    if (restart || !this.blink) this.startBlink();
  }

  /**
   * Blinks on for `blinkMs`, off for as long, starting on; after the system's
   * timeout the animation ends and the caret stays on.
   */
  private startBlink() {
    this.blink?.cancel();
    this.blink = null;
    const { metrics } = config;
    const iterations = blinkIterations(metrics);
    if (!iterations) return;
    this.blink = this.caret.animate(
      [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: 0.5 },
        { opacity: 0, offset: 0.5 },
        { opacity: 0, offset: 1 },
      ],
      { duration: 2 * metrics.blinkMs, iterations },
    );
  }

  destroy() {
    const win = this.view.dom.ownerDocument.defaultView;
    if (this.frame) win?.cancelAnimationFrame(this.frame);
    clearTimeout(this.composingEnd);
    this.resize.disconnect();
    this.scroller?.removeEventListener("scroll", this.onScroll);
    this.media?.removeEventListener("change", this.onMedia);
    win?.removeEventListener(LAYOUT_CHANGED, this.onLayout);
    win?.removeEventListener("mouseup", this.onLayout);
    this.view.dom.removeEventListener("focus", this.onFocus);
    this.view.dom.removeEventListener("blur", this.onFocus);
    this.view.dom.removeEventListener("compositionstart", this.onCompositionStart);
    this.view.dom.removeEventListener("compositionend", this.onCompositionEnd);
    redraws.delete(this.onMedia);
    relayouts.delete(this.onRelayout);
    this.blink?.cancel();
    this.host()?.classList.remove("composing");
    this.caret.remove();
    this.layer.remove();
  }
}

/** The editor's own caret and selection (see `Drawing`). */
export const DrawnCaret = Extension.create({
  name: "drawnCaret",
  addProseMirrorPlugins: () => [
    new Plugin({
      key: new PluginKey("drawnCaret"),
      view(view) {
        const drawing = new Drawing(view);
        drawing.draw(true);
        return {
          update: (view, prev) => {
            if (view.state.doc !== prev.doc || !view.state.selection.eq(prev.selection))
              drawing.update();
          },
          destroy: () => drawing.destroy(),
        };
      },
    }),
  ],
});
