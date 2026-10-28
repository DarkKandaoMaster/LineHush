import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, type Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { blockDOMs, rangeSelection } from "./image-view.ts";
import { pointerInput } from "./input.ts";
import { scroller } from "./reveal.ts";
import type { MarginSelection } from "../core/settings.ts";

/**
 * 左栏选行：像 VS Code 点行号、Win11 记事本点左侧选择栏。左栏就是 `.tiptap` 的左内边距
 * （App.css，16px），由一个盖在它上面的透明层（`.margin-gutter`，放在编辑器根节点的父元素
 * 里，与自绘光标、选区层同处）接收鼠标，不进 ProseMirror。
 *
 * - 单击：选中点击处的一行，从行首到下一行行首（包含换行，`selectedNewlines` 据此在行尾
 *   多画半个字宽）；文档最后一行没有换行，只到行尾。首行上方选首行，末行下方（底部 40vh
 *   空白）选末行。
 * - “行”的口径是设置“左栏选行”（`marginSelection`）：`line` 整个逻辑行（一个文字段落，
 *   或一整行图片：从 newline 的首图到下一个 newline 之前），`visualLine` 只选指针所在的
 *   那一折（文字按软折行的行盒，图片行按折到同一高度的那几张）；非最后一折选到这一折末
 *   （= 下一折首），光标画在这一折末尾，最后一折包含换行。
 * - 拖动：按下的那一行为锚行，选区是锚行与当前行的并集（整行含换行）；向下拖 anchor 在
 *   锚行首、head 在当前行的下一行行首，向上拖 anchor 在锚行末、head 在当前行首（VS Code）。
 *   指针越出编辑区可见范围时按可见范围的顶 / 底取行。没有自动滚动（现有拖选靠浏览器自己的
 *   拖选滚动，这里没有可复用的机制）；拖动中用滚轮滚动时按指针处重新取行。
 * - Shift+单击：上一次选区由左栏产生（且未变）时保持它的锚行，取锚行与点击行的并集；否则
 *   以当前选区的 anchor 为点，点击行在下方扩到它的行末（下一行行首），在上方扩到它的行首。
 * - 按下时 `preventDefault`（不产生浏览器原生落点，焦点不离开编辑器）后 `view.focus()`
 *   （组字中例外：不拦截，由浏览器提交组字）；
 *   选区来源记为鼠标（input.ts `pointerInput`），折行处光标画在当前行上。不滚动：点击的
 *   行就在眼前。
 *
 * 上半部分是纯函数（Node 单元测试直接加载），下半部分是 DOM。
 */

/** 一行（逻辑行或一折）的选区：from 为行首，to 为下一行行首（最后一行为行尾）。 */
export interface Span {
  from: number;
  to: number;
}

/** 一个逻辑行：行首位置与它占的顶层块（first..last，含两端）。 */
export interface LogicalLine {
  start: number;
  first: number;
  last: number;
}

const isImage = (node: PmNode | null | undefined) => node?.type.name === "image";

/**
 * 文档的逻辑行（与状态栏的行号、`.hush` 的 block 一致）：每个文字段落一行，行首在段内开头；
 * 一行图片从 newline 的首图（或紧跟文字行的图片）到下一个另起一行的图片之前，行首在首图之前
 * （块间位置）。
 */
export function logicalLines(doc: PmNode): LogicalLine[] {
  const lines: LogicalLine[] = [];
  doc.forEach((node, offset, index) => {
    const joins = isImage(node) && isImage(doc.maybeChild(index - 1)) && !node.attrs.newline;
    if (joins) lines[lines.length - 1].last = index;
    else lines.push({ start: isImage(node) ? offset : offset + 1, first: index, last: index });
  });
  return lines;
}

/** 文档最后一行的行尾：文字行在其文字末尾，图片行在最后一张图片之后。 */
export function documentEnd(doc: PmNode): number {
  const last = doc.lastChild;
  if (!last) return 0;
  return isImage(last) ? doc.content.size : doc.content.size - 1;
}

/** 第 i 个逻辑行的选区（含换行；最后一行到行尾）。 */
export function lineSpan(doc: PmNode, lines: LogicalLine[], i: number): Span {
  return {
    from: lines[i].start,
    to: i + 1 < lines.length ? lines[i + 1].start : documentEnd(doc),
  };
}

/**
 * 从上到下排好的 `count` 行里，离 y 最近的那一行：在某行上下边之间即是它，首行上方为首行，
 * 末行下方为末行，两行之间的空隙归更近的那一行（一样近归下面一行）。`rectOf` 按需量，二分查找，
 * 长文档也只量几行。没有行时为 -1。
 */
export function lineAt(
  count: number,
  rectOf: (i: number) => { top: number; bottom: number },
  y: number,
): number {
  if (count <= 0) return -1;
  // 第一个下边不在 y 上方的行。
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rectOf(mid).bottom < y) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= count) return count - 1;
  if (lo === 0) return 0;
  const below = rectOf(lo);
  if (y >= below.top) return lo;
  const above = rectOf(lo - 1);
  return y - above.bottom < below.top - y ? lo - 1 : lo;
}

/** [lo, hi] 里第一个满足 `after` 的位置（`after` 随位置单调：先假后真）；都不满足为 hi。 */
export function firstPos(lo: number, hi: number, after: (pos: number) => boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (after(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 按顶边把从左到右、从上到下的若干个框分成几折（顶边相差不到 1px 为同一折），返回每折首个的下标。 */
export function foldStarts(tops: number[]): number[] {
  const out: number[] = [];
  tops.forEach((top, i) => {
    if (!i || Math.abs(top - tops[i - 1]) >= 1) out.push(i);
  });
  return out;
}

/**
 * 左栏选区的锚：由左栏单击 / 拖动产生时为锚行（`line`），Shift+单击而上一次选区不是左栏的
 * 时为当前选区的 anchor（`point`）。
 */
export type MarginAnchor = { kind: "line"; span: Span } | { kind: "point"; pos: number };

/**
 * 锚与当前行（指针所在的行）给出的选区两端：
 * - 锚行：两行的并集。当前行不在锚行上方时 anchor 在锚行首、head 在当前行的下一行行首；
 *   在上方时 anchor 在锚行末（下一行行首）、head 在当前行首。
 * - 锚点：当前行在它下方（或含着它）时扩到当前行末，在它上方（锚点在当前行末或之后）时扩到当前行首。
 */
export function marginRange(anchor: MarginAnchor, line: Span): { anchor: number; head: number } {
  if (anchor.kind === "line")
    return line.from >= anchor.span.from
      ? { anchor: anchor.span.from, head: line.to }
      : { anchor: anchor.span.to, head: line.from };
  return { anchor: anchor.pos, head: line.to <= anchor.pos ? line.from : line.to };
}

// ---- DOM ----

/** “左栏选行”的口径，所有窗口的编辑器共用（useSettings 调 `configureMargin`）。 */
let mode: MarginSelection = "line";

/** 应用设置“左栏选行”。 */
export function configureMargin(next: MarginSelection) {
  mode = next;
}

type Rect = { top: number; bottom: number };

/** 几个框合起来的上下边。 */
const union = (rects: Rect[]): Rect => ({
  top: Math.min(...rects.map((r) => r.top)),
  bottom: Math.max(...rects.map((r) => r.bottom)),
});

/** 指针所在的行：它的选区与它在屏幕上的位置（client 坐标）。 */
interface Picked {
  span: Span;
  rect: Rect;
}

/**
 * 一个文字段落的各折：其文字的 client rects 按行合并（与 caret.ts 量选区相同，几种字体的框
 * 高度不同、大半重叠即为同一行）。空行或量不到时为整个段落一折。
 */
function textFolds(view: EditorView, pos: number, node: PmNode, dom: HTMLElement): Rect[] {
  const whole = dom.getBoundingClientRect();
  if (!node.content.size) return [whole];
  const range = view.dom.ownerDocument.createRange();
  const a = view.domAtPos(pos + 1);
  const b = view.domAtPos(pos + 1 + node.content.size);
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const lines: Rect[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (!(rect.height > 0)) continue;
    const line = lines.find(
      (l) =>
        Math.min(l.bottom, rect.bottom) - Math.max(l.top, rect.top) >
        Math.min(l.bottom - l.top, rect.height) / 2,
    );
    if (line) {
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else lines.push({ top: rect.top, bottom: rect.bottom });
  }
  lines.sort((x, y) => x.top - y.top);
  return lines.length ? lines : [whole];
}

/**
 * 视觉行模式下，逻辑行 `span` 里离 y 最近的那一折。文字：第 k 折从“其后字符落在这一折或更下”
 * 的第一个位置开始（`coordsAtPos(pos, 1)`，二分查找）。图片行：各图按顶边分折，一折从它的首图之前开始。
 * 非最后一折选到下一折首，最后一折到逻辑行的 to（含换行）。
 */
function foldAt(
  view: EditorView,
  line: LogicalLine,
  span: Span,
  doms: HTMLElement[],
  y: number,
): Picked {
  const { doc } = view.state;
  const node = doc.child(line.first);
  if (!isImage(node)) {
    const folds = textFolds(view, line.start - 1, node, doms[line.first]);
    const k = lineAt(folds.length, (i) => folds[i], y);
    const end = line.start + node.content.size;
    const startOf = (i: number) =>
      i === 0
        ? line.start
        : firstPos(line.start, end, (pos) => {
            const c = view.coordsAtPos(pos, 1);
            return (c.top + c.bottom) / 2 > folds[i].top;
          });
    return {
      span: { from: startOf(k), to: k + 1 < folds.length ? startOf(k + 1) : span.to },
      rect: folds[k],
    };
  }
  const items = doms.slice(line.first, line.last + 1).map((dom) => dom.getBoundingClientRect());
  const starts = foldStarts(items.map((r) => r.top));
  const folds = starts.map((s, i) => union(items.slice(s, starts[i + 1] ?? items.length)));
  const k = lineAt(folds.length, (i) => folds[i], y);
  // 图片都是大小为 1 的原子节点。
  return {
    span: {
      from: line.start + starts[k],
      to: k + 1 < starts.length ? line.start + starts[k + 1] : span.to,
    },
    rect: folds[k],
  };
}

/** client 坐标 y 处的行（按当前的“左栏选行”口径）；文档为空时为 null。 */
function pick(view: EditorView, y: number): Picked | null {
  const { doc } = view.state;
  const lines = logicalLines(doc);
  const doms = blockDOMs(view);
  if (!lines.length || doms.length !== doc.childCount) return null;
  const rects = new Map<number, Rect>();
  const rectOf = (i: number) => {
    let rect = rects.get(i);
    if (!rect) {
      const { first, last } = lines[i];
      rect = union(doms.slice(first, last + 1).map((dom) => dom.getBoundingClientRect()));
      rects.set(i, rect);
    }
    return rect;
  };
  const i = lineAt(lines.length, rectOf, y);
  const span = lineSpan(doc, lines, i);
  if (mode === "visualLine") return foldAt(view, lines[i], span, doms, y);
  return { span, rect: rectOf(i) };
}

/** 一个编辑器的左栏（见文件开头）。 */
class Margin {
  private view: EditorView;
  private el: HTMLDivElement;
  private resize: ResizeObserver;
  /** 拖动中：锚与指针最后的 y。 */
  private drag: { anchor: MarginAnchor; y: number } | null = null;
  /** 上一次由左栏产生的选区与它的锚（Shift+单击接着用）。 */
  private last: { selection: Selection; anchor: MarginAnchor } | null = null;
  private scroller: HTMLElement | null = null;

  constructor(view: EditorView) {
    this.view = view;
    const doc = view.dom.ownerDocument;
    const win = doc.defaultView!;
    this.el = doc.createElement("div");
    this.el.className = "margin-gutter";
    this.el.setAttribute("aria-hidden", "true");
    this.el.addEventListener("mousedown", this.onDown);
    // 根节点由 Tiptap 挪进 EditorContent 的元素之后才有父元素；它的大小随之变化。
    this.resize = new win.ResizeObserver(() => this.attach(true));
    this.resize.observe(view.dom);
    view.dom.addEventListener("mousedown", this.onTextDown, true);
    win.addEventListener("mousemove", this.onMove);
    win.addEventListener("mouseup", this.onUp, true);
    win.addEventListener("blur", this.onUp);
    win.addEventListener("dragenter", this.onDragEnter, true);
    win.addEventListener("dragleave", this.onDragLeave, true);
    win.addEventListener("drop", this.onUp, true);
    win.addEventListener("dragend", this.onUp, true);
    this.attach(true);
  }

  /**
   * 放进根节点的父元素（与 caret.ts 的光标、选区层同处）；`measure` 时（根节点大小变化、
   * 刚挂上父元素时）宽度重取根节点的左内边距，不在每次输入时读样式。CSS 不写宽度，只以此为准。
   */
  attach(measure = false) {
    const host = this.view.dom.parentElement;
    if (!host) return;
    if (this.el.parentNode !== host) {
      host.append(this.el);
      measure = true;
    }
    if (measure) {
      const width = getComputedStyle(this.view.dom).paddingLeft;
      if (this.el.style.width !== width) this.el.style.width = width;
    }
    const container = scroller(this.view);
    if (container !== this.scroller) {
      this.scroller?.removeEventListener("scroll", this.onScroll);
      this.scroller = container;
      container?.addEventListener("scroll", this.onScroll, { passive: true });
    }
  }

  /**
   * 从正文开始的按下（浏览器自己的拖选、图片旁的拖选）：松开前左栏不接收指针，拖过左栏时
   * 照常由浏览器 / image-view 定端点，不被这一层挡住。
   */
  private onTextDown = (event: MouseEvent) => {
    if (event.button === 0) this.el.classList.add("passive");
  };

  /**
   * HTML5 拖放（外部文件、拖动图片或选区）进入窗口：放下前左栏同样不接收指针，dragover /
   * drop 落在左栏里也进 ProseMirror（落点、DiaryEditor 的 handleDrop）。drop、dragend、
   * 离开窗口时恢复；拖放结束后没有 mouseup，之后第一次不按键的 mousemove 也会恢复（onMove）。
   */
  private onDragEnter = () => {
    this.drag = null;
    this.el.classList.add("passive");
  };

  private onDragLeave = (event: DragEvent) => {
    const win = this.view.dom.ownerDocument.defaultView!;
    const { clientX: x, clientY: y } = event;
    if (!event.relatedTarget && (x <= 0 || y <= 0 || x >= win.innerWidth || y >= win.innerHeight))
      this.el.classList.remove("passive");
  };

  private onDown = (event: MouseEvent) => {
    const { view } = this;
    // 组字中：不拦截也不选行，像点在编辑器外一样由浏览器提交组字。
    if (view.composing) return;
    // 不产生浏览器的落点，焦点留在编辑器（右键也不让焦点离开）。
    event.preventDefault();
    if (event.button !== 0 || !view.editable) return;
    view.focus();
    const line = pick(view, event.clientY);
    if (!line) return;
    let anchor: MarginAnchor = { kind: "line", span: line.span };
    if (event.shiftKey) {
      const known = this.last;
      // 选区自那以后没变过（任何改动都会换一个新的 Selection 对象）。
      anchor =
        known && known.selection === view.state.selection
          ? known.anchor
          : { kind: "point", pos: view.state.selection.anchor };
    }
    this.drag = { anchor, y: event.clientY };
    this.select(anchor, line);
  };

  /** 选中锚与当前行给出的范围；光标画在当前行上（折行处）。 */
  private select(anchor: MarginAnchor, line: Picked) {
    const { view } = this;
    const { anchor: a, head } = marginRange(anchor, line.span);
    pointerInput(view, (line.rect.top + line.rect.bottom) / 2);
    const { state } = view;
    // 向上选时 head 在当前行行首：块间的 head 画在这一行首图之前（side 1），而不是上一行末尾。
    const next = rangeSelection(state.doc, a, head, 1, head < a ? 1 : -1);
    // 同一个选区不再派发（拖动中每次 mousemove 都会来）；折行处画在哪一行仍按这次的指针。
    if (!next.eq(state.selection))
      view.dispatch(state.tr.setSelection(next).setMeta("pointer", true));
    this.last = { selection: view.state.selection, anchor };
  }

  /** 拖动中的 y：夹在编辑区可见范围内。 */
  private follow(y: number) {
    const drag = this.drag;
    if (!drag) return;
    drag.y = y;
    const box = this.scroller?.getBoundingClientRect();
    const at = box ? Math.min(Math.max(y, box.top), box.bottom - 1) : y;
    const line = pick(this.view, at);
    if (line) this.select(drag.anchor, line);
  }

  private onMove = (event: MouseEvent) => {
    if (!(event.buttons & 1)) {
      this.drag = null;
      this.el.classList.remove("passive");
      return;
    }
    if (this.drag) this.follow(event.clientY);
  };

  private onScroll = () => {
    if (this.drag) this.follow(this.drag.y);
  };

  /** 松开、拖放结束、窗口失焦（之后的滚轮不再改选区）：结束拖动，左栏恢复接收指针。 */
  private onUp = () => {
    this.drag = null;
    this.el.classList.remove("passive");
  };

  destroy() {
    const win = this.view.dom.ownerDocument.defaultView;
    this.resize.disconnect();
    this.el.removeEventListener("mousedown", this.onDown);
    this.view.dom.removeEventListener("mousedown", this.onTextDown, true);
    win?.removeEventListener("mousemove", this.onMove);
    win?.removeEventListener("mouseup", this.onUp, true);
    win?.removeEventListener("blur", this.onUp);
    win?.removeEventListener("dragenter", this.onDragEnter, true);
    win?.removeEventListener("dragleave", this.onDragLeave, true);
    win?.removeEventListener("drop", this.onUp, true);
    win?.removeEventListener("dragend", this.onUp, true);
    this.scroller?.removeEventListener("scroll", this.onScroll);
    this.el.remove();
  }
}

/** 左栏选行（见文件开头）。 */
export const MarginSelect = Extension.create({
  name: "marginSelect",
  addProseMirrorPlugins: () => [
    new Plugin({
      view(view) {
        const margin = new Margin(view);
        return {
          update: () => margin.attach(),
          destroy: () => margin.destroy(),
        };
      },
    }),
  ],
});
