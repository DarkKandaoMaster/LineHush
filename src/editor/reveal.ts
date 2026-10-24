import { Extension } from "@tiptap/core";
import {
  NodeSelection,
  Plugin,
  TextSelection,
  type Selection,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { CaretSpot } from "./caret-math.ts";
import { drawnCaret } from "./caret-geometry.ts";
import { headSide, pointAt, sourceOf } from "./input.ts";
import { BlockRange, caretAt, pointSpot, rangeSelection } from "./image-view.ts";

/**
 * Keeping the caret in view, as VS Code does (`viewLines.ts`,
 * `_computeScrollTopToRevealRange` / `_computeMinimumScrolling`, with
 * `editor.cursorSurroundingLines` = 5): after a move by keyboard the caret
 * keeps this many lines of the viewport above and below it (a "safe zone"),
 * scrolling as little as possible; a click only makes sure the caret shows.
 *
 * ProseMirror's own scrolling (`scrollRectIntoView`) only keeps
 * `coordsAtPos(head)` 5px inside the viewport. For the caret between blocks
 * that is a zero-height line at the top of the next block, while the caret is
 * drawn beside a whole image (caret-geometry.ts), so the image could be left
 * below the viewport. Here the box revealed is the caret as drawn.
 */
export const SAFE_ZONE_LINES = 5;

interface RevealInput {
  /** The scroll container's current scrollTop. */
  scrollTop: number;
  /** Its visible height (clientHeight). */
  viewportHeight: number;
  /** The caret's top / bottom, in the container's content coordinates. */
  boxTop: number;
  boxBottom: number;
  /** Space to keep above and below the caret. */
  padding: number;
}

/**
 * The scrollTop that shows the caret's box with `padding` around it while
 * scrolling as little as possible: unchanged when it already shows, the box
 * at the top when above the viewport, at the bottom when below; the box's top
 * when the box with its padding is taller than the viewport (a tall image
 * shows from its top). Not clamped to the scroll range.
 */
export function revealScrollTop({
  scrollTop,
  viewportHeight,
  boxTop,
  boxBottom,
  padding,
}: RevealInput): number {
  const top = boxTop - padding;
  const bottom = boxBottom + padding;
  if (bottom - top > viewportHeight) return top;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return scrollTop;
}

/** The safe zone in pixels: `SAFE_ZONE_LINES` lines, at most half the viewport. */
export const safeZone = (lineHeight: number, viewportHeight: number) =>
  Math.min(SAFE_ZONE_LINES * lineHeight, viewportHeight / 2);

/**
 * VS Code's page (`cursorConfig.pageSize`): the lines that fit in the
 * viewport less two, at least one.
 */
export const pageLines = (lineHeight: number, viewportHeight: number) =>
  Math.max(1, Math.floor(viewportHeight / lineHeight) - 2);

/** The editor's scroll container. */
export const scroller = (view: EditorView) =>
  view.dom.closest<HTMLElement>(".editor-host");

const lineHeights = new Map<string, number>();

/**
 * The editor's line height in CSS pixels. `line-height: normal` (the default,
 * see App.css) depends on the font and size from the settings, so it is
 * measured (as `1lh`) with an element outside the editable content, once per
 * font and size.
 */
export function lineHeight(view: EditorView): number {
  const style = getComputedStyle(view.dom);
  const px = parseFloat(style.lineHeight);
  if (Number.isFinite(px) && px > 0) return px;
  const key = `${style.fontFamily}|${style.fontSize}`;
  const known = lineHeights.get(key);
  if (known) return known;
  const probe = view.dom.ownerDocument.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;left:0;top:0;width:0;height:1lh;line-height:normal;";
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  (view.dom.parentElement ?? view.dom.ownerDocument.body).append(probe);
  const height =
    probe.getBoundingClientRect().height || parseFloat(style.fontSize) * 1.3 || 17;
  probe.remove();
  lineHeights.set(key, height);
  return height;
}

const rectOf = (view: EditorView, pos: number) =>
  (view.nodeDOM(pos) as HTMLElement | null)?.getBoundingClientRect() ?? null;

/**
 * What to keep in view: the caret as drawn, at the selection's head (the end
 * that moves; Shift+keys only reveal that end), or a selected image.
 */
function revealBox(view: EditorView): CaretSpot | null {
  const sel = view.state.selection;
  if (!(sel instanceof NodeSelection)) return drawnCaret(view, headSide(view));
  const rect = rectOf(view, sel.from);
  return rect?.height ? { x: rect.left, top: rect.top, bottom: rect.bottom } : null;
}

/**
 * Scrolls the editor so the caret shows: with the safe zone after keys,
 * typing, pastes and drops; just visible after a click (input.ts, `sourceOf`).
 * Returns false when there is nothing to measure (ProseMirror then scrolls
 * as it would).
 */
function revealCaret(view: EditorView): boolean {
  const host = scroller(view);
  const box = host && revealBox(view);
  if (!host || !box) return false;
  const hostTop = host.getBoundingClientRect().top + host.clientTop;
  const viewportHeight = host.clientHeight;
  const padding =
    sourceOf(view) === "mouse" ? 0 : safeZone(lineHeight(view), viewportHeight);
  const wanted = revealScrollTop({
    scrollTop: host.scrollTop,
    viewportHeight,
    boxTop: box.top - hostTop + host.scrollTop,
    boxBottom: box.bottom - hostTop + host.scrollTop,
    padding,
  });
  const next = Math.min(
    Math.max(wanted, 0),
    Math.max(host.scrollHeight - viewportHeight, 0),
  );
  if (Math.abs(next - host.scrollTop) >= 0.5) host.scrollTop = next;
  return true;
}

/**
 * 不经 ProseMirror 的滚动请求揭示选区（编辑器没有焦点时，`tr.scrollIntoView()` 因 DOM 选区
 * 不在编辑器里而不滚动；查找条跳到匹配时用，find.ts）。规则同 `revealCaret`。
 */
export const revealSelection = (view: EditorView) => revealCaret(view);

/** A remembered across position for consecutive PageUp / PageDown, as in a text editor. */
const goals = new WeakMap<EditorView, { x: number; selection: Selection }>();

/**
 * PageUp / PageDown (`dir` -1 / 1), with Shift extending the selection from
 * its anchor: the editor scrolls by a page (VS Code's page: the lines that fit
 * less two, here in pixels of the line height, as images have no lines) and
 * the caret goes to the same place in the viewport, through the same
 * geometry a click there uses (on an image: the half it is in; beside images:
 * the near side of the nearest image). Beyond the document's first / last
 * block, to its start / end. The safe zone is then kept as after any key.
 */
function pageMove(view: EditorView, dir: -1 | 1, extend: boolean): boolean {
  if (view.composing) return false;
  const host = scroller(view);
  const box = host && revealBox(view);
  if (!host || !box) return false;
  const { state } = view;
  const { doc } = state;
  const goal = goals.get(view);
  const x = goal && goal.selection.eq(state.selection) ? goal.x : box.x;
  const page = pageLines(lineHeight(view), host.clientHeight) * lineHeight(view);
  // The target in content coordinates: the caret's middle, a page further.
  const hostTop = host.getBoundingClientRect().top + host.clientTop;
  const target =
    (box.top + box.bottom) / 2 - hostTop + host.scrollTop + dir * page;
  const max = Math.max(host.scrollHeight - host.clientHeight, 0);
  host.scrollTop = Math.min(Math.max(host.scrollTop + dir * page, 0), max);
  const y = target - host.scrollTop + hostTop;
  const first = rectOf(view, 0);
  const last = doc.lastChild
    ? rectOf(view, doc.content.size - doc.lastChild.nodeSize)
    : null;
  let head: Selection | null = null;
  if (!first || !last || y < hostTop || y > hostTop + host.clientHeight) {
    head = null;
  } else if (y < first.top) head = caretAt(doc, 0, -1);
  else if (y > last.bottom) head = caretAt(doc, doc.content.size, 1);
  else {
    const left = view.dom.getBoundingClientRect();
    const px = Math.min(Math.max(x, left.left + 1), left.right - 1);
    const spot = pointSpot(view, px, y);
    const hit = spot ? null : view.posAtCoords({ left: px, top: y });
    if (spot) head = new BlockRange(doc.resolve(spot.pos), undefined, spot.side);
    else if (hit)
      head = doc.resolve(hit.pos).parent.inlineContent
        ? TextSelection.create(doc, hit.pos)
        : caretAt(doc, hit.pos, dir);
  }
  // Past the scroll range (or nothing found there): the document's edge.
  // (caretAt's side: at the end after the last image, at the start before the first.)
  head ??= dir > 0 ? caretAt(doc, doc.content.size, 1) : caretAt(doc, 0, -1);
  const side = head instanceof BlockRange ? head.side : undefined;
  const next = extend
    ? rangeSelection(doc, state.selection.anchor, head.head, dir, side)
    : head;
  // At a soft wrap the caret goes to the line at that point.
  pointAt(view, y, "page");
  view.dispatch(state.tr.setSelection(next).scrollIntoView());
  goals.set(view, { x, selection: view.state.selection });
  return true;
}

/**
 * The safe zone and PageUp / PageDown: ProseMirror's scrolling to the
 * selection (every `tr.scrollIntoView()`, including the browser's own caret
 * moves read back) is replaced with `revealCaret`.
 */
export const Reveal = Extension.create({
  name: "reveal",
  addKeyboardShortcuts() {
    const page = (dir: -1 | 1, extend: boolean) => () =>
      pageMove(this.editor.view, dir, extend);
    return {
      PageUp: page(-1, false),
      PageDown: page(1, false),
      "Shift-PageUp": page(-1, true),
      "Shift-PageDown": page(1, true),
    };
  },
  addProseMirrorPlugins: () => [
    new Plugin({ props: { handleScrollToSelection: (view) => revealCaret(view) } }),
  ],
});
