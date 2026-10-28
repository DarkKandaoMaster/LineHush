import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { CaretSpot } from "./caret-math.ts";
import { BlockRange, caretImage } from "./image-view.ts";

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
 * blocks it is drawn beside the image `caretImage` gives for the BlockRange's
 * side (a range's too, 2026-10-28), as tall as that image, its left edge on a
 * boundary as in text: after an image, on the image's right edge; before one,
 * on the right edge of the image before it on the same visual line, so both
 * sides of a spot between two images draw one caret; before the first image
 * of a visual line, on that image's left edge (its 1px border), where a text
 * line's caret starts. A range ending between two text lines: at the end of
 * the one before. A selected image (NodeSelection) has no caret.
 */
export function drawnCaret(view: EditorView, side: -1 | 1): CaretSpot | null {
  const sel = view.state.selection;
  if (sel instanceof NodeSelection) return null;
  const $head = sel.$head;
  if ($head.parent.inlineContent) return textCaret(view, sel.head, side);
  const image = caretImage(view, $head, sel instanceof BlockRange ? sel.side : -1);
  if (image) {
    const rect = (view.nodeDOM(image.pos) as HTMLElement | null)?.getBoundingClientRect();
    if (!rect?.height) return null;
    if (image.after) return { x: rect.right, top: rect.top, bottom: rect.bottom };
    const before = view.state.doc.resolve(image.pos).nodeBefore;
    if (before?.type.name === "image") {
      const prev = (
        view.nodeDOM(image.pos - before.nodeSize) as HTMLElement | null
      )?.getBoundingClientRect();
      if (prev?.height && Math.abs(prev.top - rect.top) < 1) {
        return { x: prev.right, top: prev.top, bottom: prev.bottom };
      }
    }
    return { x: rect.left, top: rect.top, bottom: rect.bottom };
  }
  if ($head.nodeBefore?.isTextblock) return textCaret(view, sel.head - 1);
  if ($head.nodeAfter?.isTextblock) return textCaret(view, sel.head + 1);
  return null;
}
