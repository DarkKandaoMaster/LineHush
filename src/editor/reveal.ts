import { Extension } from "@tiptap/core";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Selection,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  BlockRange,
  caretAt,
  isImage,
  rangeSelection,
  rowBreak,
  spotBeside,
  spotBy,
} from "./image-view.ts";

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
 * drawn on a whole image (`.gap-before` / `.gap-after`), so the image could be
 * left below the viewport. Here the box revealed is the caret as drawn.
 */
export const SAFE_ZONE_LINES = 5;

export interface RevealInput {
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
  let height = probe.getBoundingClientRect().height;
  if (!height) {
    // Without `lh` support: one line of text.
    probe.style.height = "auto";
    probe.textContent = "国";
    height = probe.getBoundingClientRect().height;
  }
  probe.remove();
  height ||= parseFloat(style.fontSize) * 1.3 || 17;
  lineHeights.set(key, height);
  return height;
}

/** A caret's box in client coordinates; `x` is where it is drawn across. */
export interface CaretBox {
  top: number;
  bottom: number;
  x: number;
}

const rectOf = (view: EditorView, pos: number) =>
  (view.nodeDOM(pos) as HTMLElement | null)?.getBoundingClientRect() ?? null;

/**
 * The caret as drawn, of the selection's head (the end that moves; Shift+keys
 * only reveal that end). In a text line, the caret at the head. Between blocks
 * the caret is drawn on a whole image (image-view's decorations): after the
 * image before it (`.gap-after`), except at the start of a row after a line
 * break (side 1) or with no image before it, where it is before the image
 * after it (`.gap-before`); the box is that image. For a range ending between
 * blocks, the block inside the range at its head: an image whole, a text line
 * at its near end. A selected image: the image.
 */
export function caretBox(view: EditorView): CaretBox | null {
  const sel = view.state.selection;
  const $head = sel.$head;
  const text = (pos: number): CaretBox => {
    const $pos = view.state.doc.resolve(pos);
    // An empty line: its line box. (With its line break selected the trailing
    // <br> is hidden, see newline-selection.ts, and coordsAtPos then reports
    // a zero-height rectangle elsewhere.)
    if ($pos.parent.isTextblock && !$pos.parent.content.size && $pos.depth) {
      const rect = rectOf(view, $pos.before());
      if (rect?.height) return { top: rect.top, bottom: rect.bottom, x: rect.left };
    }
    const c = view.coordsAtPos(pos, 1);
    return { top: c.top, bottom: c.bottom, x: c.left };
  };
  const image = (pos: number, after: boolean): CaretBox | null => {
    const rect = rectOf(view, pos);
    return rect && rect.height
      ? { top: rect.top, bottom: rect.bottom, x: after ? rect.right : rect.left }
      : null;
  };
  if ($head.parent.inlineContent) return text(sel.head);
  if (sel instanceof NodeSelection) return image(sel.from, false);
  const before = $head.nodeBefore;
  const after = $head.nodeAfter;
  if (sel.empty) {
    if (
      before &&
      isImage(before) &&
      !(rowBreak($head) && sel instanceof BlockRange && sel.side > 0)
    )
      return image(sel.head - before.nodeSize, true) ?? text(sel.head);
    if (after && isImage(after)) return image(sel.head, false) ?? text(sel.head);
    return text(sel.head);
  }
  // A range: the block inside it next to the head.
  const forward = sel.head > sel.anchor;
  const node = forward ? before : after;
  if (!node) return text(sel.head);
  const start = forward ? sel.head - node.nodeSize : sel.head;
  if (isImage(node)) return image(start, forward) ?? text(sel.head);
  return text(forward ? sel.head - 1 : sel.head + 1);
}

/** Where the last selection change came from: a click or anything else. */
export type RevealSource = "mouse" | "keyboard";

const sources = new WeakMap<EditorView, RevealSource>();

/**
 * Scrolls the editor so the caret shows: with the safe zone after keys,
 * typing, pastes and drops; just visible after a click (`minimalReveal`).
 * Returns false when there is nothing to measure (ProseMirror then scrolls
 * as it would).
 */
export function revealCaret(view: EditorView): boolean {
  const host = scroller(view);
  const box = host && caretBox(view);
  if (!host || !box) return false;
  const hostTop = host.getBoundingClientRect().top + host.clientTop;
  const viewportHeight = host.clientHeight;
  const padding =
    sources.get(view) === "mouse"
      ? 0
      : safeZone(lineHeight(view), viewportHeight);
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
 * Reads a DOM selection change ProseMirror has not seen yet. The browser
 * reports its own caret moves with `selectionchange`, an event dispatched as a
 * separate task; keys repeated quickly enough (auto-repeat, input queued while
 * the page was busy) arrive before it, and ProseMirror's keydown only flushes
 * an observer flush that is already scheduled (`DOMObserver.forceFlush`), not
 * one whose event is still to come. Key handlers would then decide from the
 * caret's previous position: at the end of a text line that an image follows
 * they would leave the key to the browser, which takes the caret out of the
 * line into the gap before the image (no caret rectangle there; its own
 * scrolling then jumps to the top) or past the images. This does what the
 * pending `selectionchange` would (`DOMObserver.onSelectionChange` → `flush`).
 */
export function readDOMSelection(view: EditorView) {
  const internal = view as unknown as {
    domObserver?: { forceFlush(): void; flush(): void };
    input?: { mouseDown: unknown };
  };
  const observer = internal.domObserver;
  if (!observer || view.composing || internal.input?.mouseDown) return;
  observer.forceFlush();
  observer.flush();
}

/** A remembered across position for consecutive PageUp / PageDown, as in a text editor. */
const goals = new WeakMap<EditorView, { x: number; selection: Selection }>();

/**
 * PageUp / PageDown (`dir` -1 / 1), with Shift extending the selection from
 * its anchor: the editor scrolls by a page (VS Code's page: the lines that fit
 * less two, here in pixels of the line height, as images have no lines) and
 * the caret goes to the same place in the viewport, through the same
 * geometry a click there uses (beside images: the near side of the nearest
 * image; on an image: the half it is in). Beyond the document's first / last
 * block, to its start / end. The safe zone is then kept as after any key.
 */
export function pageMove(
  view: EditorView,
  dir: -1 | 1,
  extend: boolean,
): boolean {
  if (view.composing) return false;
  const host = scroller(view);
  const box = host && caretBox(view);
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
    const element = view.dom.ownerDocument.elementFromPoint(px, y);
    const spot = spotBeside(view, px, y, element);
    if (spot) head = new BlockRange(doc.resolve(spot.pos), undefined, spot.side);
    else {
      const hit = view.posAtCoords({ left: px, top: y });
      const inside = hit && hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
      if (hit && inside && isImage(inside)) {
        const s = spotBy(
          hit.inside,
          inside,
          px,
          rectOf(view, hit.inside) ?? { left: px, right: px },
        );
        head = new BlockRange(doc.resolve(s.pos), undefined, s.side);
      } else if (hit) {
        const $pos = doc.resolve(hit.pos);
        head = $pos.parent.inlineContent
          ? TextSelection.create(doc, hit.pos)
          : caretAt(doc, hit.pos, dir);
      }
    }
  }
  // Past the scroll range (or nothing found there): the document's edge.
  // (caretAt's side: at the end after the last image, at the start before the first.)
  head ??= dir > 0 ? caretAt(doc, doc.content.size, 1) : caretAt(doc, 0, -1);
  const side = head instanceof BlockRange ? head.side : undefined;
  const next = extend
    ? rangeSelection(doc, state.selection.anchor, head.head, dir, side)
    : head;
  view.dispatch(state.tr.setSelection(next).scrollIntoView());
  goals.set(view, { x, selection: view.state.selection });
  return true;
}

const revealKey = new PluginKey("reveal");

/**
 * Tracks where selection changes come from, reads pending DOM selection
 * changes before keys are handled (see `readDOMSelection`) and replaces
 * ProseMirror's scrolling to the selection (every `tr.scrollIntoView()`,
 * including the browser's own caret moves read back) with `revealCaret`.
 */
export function revealPlugin() {
  return new Plugin({
    key: revealKey,
    view(view) {
      const mouse = () => sources.set(view, "mouse");
      const keyboard = () => sources.set(view, "keyboard");
      // In the capture phase on the editor, ahead of ProseMirror's handlers and
      // the keymaps (handleKeyDown).
      const key = (event: KeyboardEvent) => {
        keyboard();
        if (!event.isComposing && event.keyCode !== 229) readDOMSelection(view);
      };
      const others = ["beforeinput", "compositionstart", "paste", "drop"];
      view.dom.addEventListener("mousedown", mouse, true);
      view.dom.addEventListener("keydown", key, true);
      for (const type of others) view.dom.addEventListener(type, keyboard, true);
      return {
        destroy() {
          view.dom.removeEventListener("mousedown", mouse, true);
          view.dom.removeEventListener("keydown", key, true);
          for (const type of others)
            view.dom.removeEventListener(type, keyboard, true);
          sources.delete(view);
          goals.delete(view);
        },
      };
    },
    props: {
      handleScrollToSelection: (view) => revealCaret(view),
    },
  });
}

/** The safe zone and PageUp / PageDown (see `revealPlugin`, `pageMove`). */
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
  addProseMirrorPlugins: () => [revealPlugin()],
});
