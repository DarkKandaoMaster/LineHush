import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { CaretSpot } from "./caret-math.ts";
import { BlockRange, besideImage } from "./image-view.ts";

/**
 * Where the caret is drawn, for the editor's own caret (caret.ts), the box
 * kept in view (reveal.ts) and the line a vertical move starts from (input.ts).
 */

/**
 * The caret at text position `pos`: the character box after it, or before it
 * (`side` -1) where the line wraps and the browser would draw it at the end of
 * the upper line (see input.ts, `headSide`). An empty line: its line box
 * (`coordsAtPos` would measure the trailing <br>).
 */
export function textCaret(view: EditorView, pos: number, side: -1 | 1 = 1): CaretSpot {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.content.size && $pos.depth) {
    const rect = (view.nodeDOM($pos.before()) as HTMLElement | null)?.getBoundingClientRect();
    if (rect?.height) return { x: rect.left, top: rect.top, bottom: rect.bottom };
  }
  const c = view.coordsAtPos(pos, side);
  return { x: c.left, top: c.top, bottom: c.bottom };
}

/**
 * The caret at the selection's head (also for a range, as in Notepad and
 * VS Code), `side` being the head's side at a soft wrap (`headSide`). Between
 * blocks it is drawn beside the image `besideImage` gives: as tall as the
 * image, its middle in the middle of the gap beside it (the image's right
 * margin). A range ending between two text lines: at the end of the one
 * before. A selected image (NodeSelection) has no caret.
 */
export function drawnCaret(view: EditorView, side: -1 | 1): CaretSpot | null {
  const sel = view.state.selection;
  if (sel instanceof NodeSelection) return null;
  const $head = sel.$head;
  if ($head.parent.inlineContent) return textCaret(view, sel.head, side);
  const image = besideImage($head, sel instanceof BlockRange && sel.empty ? sel.side : -1);
  if (image) {
    const item = view.nodeDOM(image.pos) as HTMLElement | null;
    const rect = item?.getBoundingClientRect();
    if (!item || !rect?.height) return null;
    const gap = parseFloat(getComputedStyle(item).marginRight) || 0;
    return {
      x: image.after ? rect.right + gap / 2 : rect.left - gap / 2,
      top: rect.top,
      bottom: rect.bottom,
      centered: true,
    };
  }
  if ($head.nodeBefore?.isTextblock) return textCaret(view, sel.head - 1);
  if ($head.nodeAfter?.isTextblock) return textCaret(view, sel.head + 1);
  return null;
}
