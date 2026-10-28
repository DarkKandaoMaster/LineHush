import { Node } from "@tiptap/core";
import {
  Slice,
  type Node as PmNode,
  type ResolvedPos,
  type Schema,
} from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { Mappable } from "@tiptap/pm/transform";
import { dropPoint } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  fromEditor,
  toEditor,
  type Block,
  type Picture,
} from "../core/document.ts";
import { pointerInput, pressedIn } from "./input.ts";
import { foldStarts } from "./margin.ts";

/**
 * The side of a position between blocks a caret is on: -1 drawn after the
 * image before it, 1 before the image after it. It only shows at a line break
 * between two rows of images (see `rowBreak`): -1 is the end of the upper row,
 * 1 the start of the lower one; and, measured, where a row of images wraps
 * (`caretImage`).
 */
type Side = -1 | 1;

/**
 * A range whose ends may sit between blocks, so a run of images can be selected
 * without the text around it (a TextSelection must end inside a text line).
 *
 * Collapsed, it is the caret between blocks, which only stops next to an image
 * (see `caretSpot`): an image behaves like one big character. That caret is
 * drawn beside the image at its full height (caret.ts, `besideImage`), so the
 * browser's own caret is hidden (`visible`). At a line break between two rows
 * of images it has two places, the end of the upper row and the start of the
 * lower one, told apart by `side`. A range keeps the side of its head, where
 * its caret is drawn (2026-10-28; `eq` and `toJSON` still ignore it there).
 */
export class BlockRange extends Selection {
  readonly side: Side;
  constructor(
    $anchor: ResolvedPos,
    $head: ResolvedPos = $anchor,
    side: Side = -1,
  ) {
    super($anchor, $head);
    this.visible = $anchor.pos !== $head.pos;
    this.side = side;
  }
  map(doc: PmNode, mapping: Mappable): Selection {
    return rangeSelection(
      doc,
      mapping.map(this.anchor),
      mapping.map(this.head),
      1,
      this.side,
    );
  }
  eq(other: Selection): boolean {
    return (
      other instanceof BlockRange &&
      other.anchor === this.anchor &&
      other.head === this.head &&
      (!this.empty || other.side === this.side)
    );
  }
  /** Deleting the range (`tr.deleteSelection`) keeps the rows of images around it. */
  replace(tr: Transaction, content: Slice = Slice.empty) {
    if (content.size) super.replace(tr, content);
    else removeRange(tr, this.from, this.to, 1);
  }
  toJSON() {
    return this.empty
      ? {
          type: "blockRange",
          anchor: this.anchor,
          head: this.head,
          side: this.side,
        }
      : { type: "blockRange", anchor: this.anchor, head: this.head };
  }
  // The default bookmark would turn the range into a text selection when the
  // history or an insertion restores it.
  getBookmark() {
    return new RangeBookmark(this.anchor, this.head, this.side);
  }
}
class RangeBookmark {
  anchor: number;
  head: number;
  side: Side;
  constructor(anchor: number, head: number, side: Side) {
    this.anchor = anchor;
    this.head = head;
    this.side = side;
  }
  map(mapping: Mappable) {
    return new RangeBookmark(
      mapping.map(this.anchor),
      mapping.map(this.head),
      this.side,
    );
  }
  resolve(doc: PmNode) {
    return rangeSelection(doc, this.anchor, this.head, 1, this.side);
  }
}

const isImage = (node: PmNode | null | undefined) =>
  node?.type.name === "image";
const imageAt = (state: EditorState) =>
  state.selection instanceof NodeSelection && isImage(state.selection.node);

/**
 * Whether the caret may sit between blocks at `$pos`: next to an image on at
 * least one side (image | image, image | line, line | image, document edge |
 * image). Never between two text lines, where the caret belongs in a line.
 */
export const caretSpot = ($pos: ResolvedPos) =>
  $pos.depth === 0 && (isImage($pos.nodeBefore) || isImage($pos.nodeAfter));

/**
 * Whether `$pos` is a line break between two rows of images: an image on both
 * sides, the one after it starting a new row (`newline`). Images next to each
 * other without one share a row, which wraps where it does not fit.
 */
export const rowBreak = ($pos: ResolvedPos) =>
  $pos.depth === 0 &&
  isImage($pos.nodeBefore) &&
  isImage($pos.nodeAfter) &&
  !!$pos.nodeAfter!.attrs.newline;

/**
 * The image a caret between blocks at `$pos` on `side` is drawn beside (also
 * the drop position of dragged images): after the image before it (`after`),
 * except at the start of a row after a line break (side 1) or with no image
 * before it, where it is before the image after it. Null next to no image.
 */
export function besideImage(
  $pos: ResolvedPos,
  side: Side,
): { pos: number; after: boolean } | null {
  const before = $pos.nodeBefore;
  if (before && isImage(before) && !(rowBreak($pos) && side > 0))
    return { pos: $pos.pos - before.nodeSize, after: true };
  return isImage($pos.nodeAfter) ? { pos: $pos.pos, after: false } : null;
}

/** The position of a caret between blocks, or null for any other selection. */
const caretBetween = (state: EditorState) => {
  const sel = state.selection;
  return sel instanceof BlockRange && sel.empty ? sel.head : null;
};

/**
 * The selection between two positions: a caret, a text range or a block range.
 * A caret between blocks (or the head of a block range) is on `side`, by
 * default the side it is reached from when moving toward `dir`.
 */
export function rangeSelection(
  doc: PmNode,
  anchor: number,
  head: number,
  dir: -1 | 1 = 1,
  side: Side = -dir as Side,
): Selection {
  const $anchor = doc.resolve(anchor);
  const $head = doc.resolve(head);
  if (anchor === head) return caretAt(doc, head, dir, side);
  if ($anchor.parent.inlineContent && $head.parent.inlineContent)
    return new TextSelection($anchor, $head);
  return new BlockRange($anchor, $head, side);
}

/**
 * The selection for a DOM selection from `$anchor` to `$head`, or null to leave
 * it to ProseMirror. An end between blocks next to an image (a click beside a
 * row of images, a drag past the last image or from beside images) stays there:
 * ProseMirror's `TextSelection.between` would snap it into the nearest text,
 * dropping the images from the range.
 */
export function selectionBetween(
  $anchor: ResolvedPos,
  $head: ResolvedPos,
): Selection | null {
  const ends = [$anchor, $head].filter(($pos) => !$pos.parent.inlineContent);
  if (!ends.length || !ends.every(caretSpot)) return null;
  return rangeSelection($head.doc, $anchor.pos, $head.pos);
}

/**
 * A caret at `pos`: between blocks next to an image (on `side`), otherwise the
 * near end of the text line next to it, on side `dir` if both sides are lines.
 * Never a selected image (typing would replace it).
 */
export function caretAt(
  doc: PmNode,
  pos: number,
  dir: -1 | 1,
  side: Side = -dir as Side,
): Selection {
  const $pos = doc.resolve(pos);
  if ($pos.parent.inlineContent) return new TextSelection($pos);
  if (caretSpot($pos)) return new BlockRange($pos, $pos, side);
  for (const near of [dir, -dir])
    if ((near > 0 ? $pos.nodeAfter : $pos.nodeBefore)?.isTextblock)
      return TextSelection.create(doc, pos + near);
  return Selection.near($pos, dir);
}

/**
 * Deletes `from`..`to` and keeps the rows of images around it: when this leaves
 * two images next to each other, the second starts a new row if anything
 * deleted was a line break (a text line, or an image starting a row). Every
 * deletion of images goes through here (Backspace / Delete, cut, Enter over a
 * range, dragging images away, `tr.deleteSelection` of a BlockRange).
 */
export function deleteBlocks(tr: Transaction, from: number, to: number) {
  let lineBreak = false;
  tr.doc.nodesBetween(from, to, (node) => {
    if (!isImage(node) || node.attrs.newline) lineBreak = true;
    return false;
  });
  tr.delete(from, to);
  const $pos = tr.doc.resolve(from);
  const after = $pos.nodeAfter;
  if (
    lineBreak &&
    $pos.depth === 0 &&
    isImage($pos.nodeBefore) &&
    isImage(after) &&
    !after!.attrs.newline
  )
    tr.setNodeAttribute(from, "newline", true);
  return tr;
}

/**
 * Deletes `from`..`to` (see `deleteBlocks`) and leaves the caret where the
 * content was: at the start of a row if the content started one.
 */
export function removeRange(
  tr: Transaction,
  from: number,
  to: number,
  dir: -1 | 1,
) {
  const side: Side = rowBreak(tr.doc.resolve(from)) ? 1 : -1;
  deleteBlocks(tr, from, to);
  return tr.setSelection(caretAt(tr.doc, from, dir, side));
}

/**
 * Typing at the caret between blocks: images never share a line with text, so
 * the text starts a new line there (an empty one for a composition, which then
 * fills it), whichever side of a line break the caret is on.
 */
export function typeBetween(text: string): Command {
  return (state, dispatch) => {
    const pos = caretBetween(state);
    if (pos === null || /[\r\n]/.test(text)) return false;
    if (dispatch) {
      const { schema } = state;
      const tr = state.tr.insert(
        pos,
        schema.nodes.paragraph.create(null, text ? schema.text(text) : null),
      );
      dispatch(
        tr
          .setSelection(TextSelection.create(tr.doc, pos + 1 + text.length))
          .scrollIntoView(),
      );
    }
    return true;
  };
}

/**
 * Enter at the caret between blocks at `pos`. Inside a row of images: a line
 * break, the images after the caret start a new row, the caret at its start.
 * At a line break between rows: at the start of the lower row an empty line
 * goes before it and the caret stays before its first image (as Enter at the
 * start of a text line moves the line down); at the end of the upper row an
 * empty line goes after it with the caret in it. Elsewhere (next to a text
 * line, at the document's edges) an empty line with the caret in it.
 */
function breakAt(tr: Transaction, pos: number, side: Side) {
  const $pos = tr.doc.resolve(pos);
  const after = $pos.nodeAfter;
  if (isImage($pos.nodeBefore) && isImage(after) && !after!.attrs.newline) {
    tr.setNodeAttribute(pos, "newline", true);
    return tr.setSelection(new BlockRange(tr.doc.resolve(pos), undefined, 1));
  }
  const line = tr.doc.type.schema.nodes.paragraph.create();
  tr.insert(pos, line);
  if (rowBreak($pos) && side > 0)
    return tr.setSelection(
      new BlockRange(tr.doc.resolve(pos + line.nodeSize), undefined, 1),
    );
  return tr.setSelection(TextSelection.create(tr.doc, pos + 1));
}

/**
 * Enter outside a text line (inside one, also for a text range, the editor's
 * own Enter splits it). A range that starts or ends between blocks is replaced
 * by the line break (`breakAt`); a selected image gets an empty line after it.
 */
export const enterKey: Command = (state, dispatch, view) => {
  if (view?.composing) return false;
  const tr = state.tr;
  let sel = tr.selection;
  const inLine = (s: Selection) => s.$from.parent.type.name === "paragraph";
  if (
    sel instanceof BlockRange ||
    (!sel.empty && !(sel instanceof NodeSelection) && !inLine(sel))
  ) {
    if (!sel.empty) sel = removeRange(tr, sel.from, sel.to, -1).selection;
  } else if (inLine(sel)) return false;
  if (inLine(sel)) tr.split(sel.from);
  else if (sel instanceof BlockRange && sel.empty)
    breakAt(tr, sel.head, sel.side);
  else {
    const pos = sel.to;
    tr.insert(pos, state.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  }
  dispatch?.(tr.scrollIntoView());
  return true;
};

/**
 * Backspace / Delete. Selected images, or the image next to a caret between
 * blocks, go on their own. At a line break between rows of images, Backspace at
 * the start of the lower row / Delete at the end of the upper row removes the
 * line break instead (the rows join). Next to an image a text line counts as a
 * line break: an empty one goes (the caret then sits by the image), a line with
 * text stays and the key does nothing. This holds for the caret at the start
 * (Backspace) / end (Delete) of a line beside an image and for the caret
 * between blocks.
 */
export function removeNear(dir: -1 | 1): Command {
  return (state, dispatch, view) => {
    if (view?.composing) return false;
    const sel = state.selection;
    let from: number;
    let to: number;
    if (imageAt(state) || (sel instanceof BlockRange && !sel.empty)) {
      ({ from, to } = sel);
    } else if (sel instanceof BlockRange) {
      if (rowBreak(sel.$head) && sel.side === -dir) {
        dispatch?.(
          state.tr
            .setNodeAttribute(sel.head, "newline", false)
            .scrollIntoView(),
        );
        return true;
      }
      const node = dir < 0 ? sel.$head.nodeBefore : sel.$head.nodeAfter;
      if (!node || (!isImage(node) && node.content.size)) return true;
      from = dir < 0 ? sel.head - node.nodeSize : sel.head;
      to = from + node.nodeSize;
    } else if (sel instanceof TextSelection && sel.$cursor) {
      const $cursor = sel.$cursor;
      if (
        $cursor.depth !== 1 ||
        $cursor.parentOffset !== (dir < 0 ? 0 : $cursor.parent.content.size)
      )
        return false;
      const $edge = state.doc.resolve(
        dir < 0 ? $cursor.before() : $cursor.after(),
      );
      if (!isImage(dir < 0 ? $edge.nodeBefore : $edge.nodeAfter)) return false;
      if ($cursor.parent.content.size) return true;
      from = $cursor.before();
      to = $cursor.after();
    } else return false;
    dispatch?.(removeRange(state.tr, from, to, dir).scrollIntoView());
    return true;
  };
}

/**
 * Left / Right step over an image as over one character, and over a line break
 * between rows of images as over a line break in text: the end of the upper
 * row and the start of the lower one are two stops. Stops: every text position
 * and every position between blocks next to an image; crossing from one text
 * line into the next is left to the browser (one step, no stop).
 */
export function moveCaret(dir: -1 | 1): Command {
  return (state, dispatch, view) => {
    if (view?.composing) return false;
    const sel = state.selection;
    const doc = state.doc;
    let next: Selection;
    if (imageAt(state) || (sel instanceof BlockRange && !sel.empty)) {
      // Collapse toward the key.
      next = caretAt(doc, dir < 0 ? sel.from : sel.to, dir);
    } else if (sel instanceof BlockRange) {
      const node = dir < 0 ? sel.$head.nodeBefore : sel.$head.nodeAfter;
      if (rowBreak(sel.$head) && sel.side === -dir)
        next = new BlockRange(sel.$head, sel.$head, dir);
      else if (!node) return true;
      else
        next = isImage(node)
          ? caretAt(doc, sel.head + dir * node.nodeSize, dir)
          : TextSelection.create(doc, sel.head + dir); // the line's near end
    } else if (sel instanceof TextSelection && sel.$cursor) {
      const $cursor = sel.$cursor;
      if (
        $cursor.depth !== 1 ||
        $cursor.parentOffset !== (dir < 0 ? 0 : $cursor.parent.content.size)
      )
        return false;
      const $edge = doc.resolve(dir < 0 ? $cursor.before() : $cursor.after());
      if (!isImage(dir < 0 ? $edge.nodeBefore : $edge.nodeAfter)) return false;
      next = new BlockRange($edge);
    } else return false;
    dispatch?.(state.tr.setSelection(next).scrollIntoView());
    return true;
  };
}

/**
 * Shift+Left / Shift+Right extend the selection by one whole image. With
 * `word` (Ctrl+Shift+Left / Right), a step inside a text line from a range
 * that starts between blocks goes to the position it gives instead of one
 * character (the browser's word move, see `wordStep`); next to an image the
 * image is one word.
 */
export function extendByImage(
  dir: -1 | 1,
  word?: (view: EditorView, pos: number) => number | null,
): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    let anchor = sel.anchor;
    let head = sel.head;
    if (imageAt(state)) {
      // Keep the selected image inside the range whichever way it grows.
      anchor = dir > 0 ? sel.from : sel.to;
      head = dir > 0 ? sel.to : sel.from;
    } else if (!(sel instanceof BlockRange) && !(sel instanceof TextSelection))
      return false;
    const doc = state.doc;
    const $head = doc.resolve(head);
    const beyond = ($pos: ResolvedPos) =>
      dir > 0 ? $pos.nodeAfter : $pos.nodeBefore;
    // With the anchor between blocks, the browser's own extension would snap it
    // into text and drop the images, so the range is extended here throughout.
    const between = sel instanceof BlockRange;
    // Stops: every text position, every position next to an image; not the
    // position between two text lines (crossing a line break is one step).
    let next: number;
    if (!$head.parent.inlineContent) {
      const node = beyond($head);
      if (!node) return true;
      if (isImage(node)) {
        next = head + dir * node.nodeSize;
        // Back at the line the range started from: collapse onto the anchor.
        const $next = doc.resolve(next);
        if (beyond($next)?.isTextblock && anchor === next + dir) next = anchor;
      } else next = head + dir; // a text line, entered at its near end
    } else if (
      dir > 0
        ? $head.parentOffset === $head.parent.content.size
        : $head.parentOffset === 0
    ) {
      const edge = dir > 0 ? $head.after() : $head.before();
      const node = beyond(doc.resolve(edge));
      if (!node) return true;
      if (isImage(node))
        // From a range between blocks, stop next to the image first, mirroring
        // the step into this line; from text, take the image at once.
        next = between ? edge : edge + dir * node.nodeSize;
      else if (between) next = edge + dir;
      else return false;
    } else if (between) {
      const byWord = word && view ? word(view, head) : null;
      if (byWord !== null && byWord !== head) next = byWord;
      else {
        // One character, keeping surrogate pairs together (lines hold only text).
        const text = $head.parent.textContent;
        const code = text.charCodeAt(
          dir > 0 ? $head.parentOffset : $head.parentOffset - 1,
        );
        const pair =
          dir > 0
            ? code >= 0xd800 && code < 0xdc00
            : code >= 0xdc00 && code < 0xe000;
        next = head + dir * (pair ? 2 : 1);
      }
    } else return false;
    dispatch?.(
      state.tr
        .setSelection(rangeSelection(doc, anchor, next, dir))
        .scrollIntoView(),
    );
    return true;
  };
}

/**
 * Up / Down from a caret between blocks (or selected images) leave the whole
 * run of images, which is laid out as rows, instead of walking it image by image.
 */
export function leaveImages(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (caretBetween(state) === null && !selectedImages(sel)) return false;
    const doc = state.doc;
    const pos = pastImages(doc, dir < 0 ? sel.from : sel.to, dir);
    const $pos = doc.resolve(pos);
    dispatch?.(
      state.tr
        .setSelection(
          $pos.parent.inlineContent ? TextSelection.create(doc, pos) : new BlockRange($pos),
        )
        .scrollIntoView(),
    );
    return true;
  };
}

/**
 * Where Up / Down take the caret between blocks at `pos` (`leaveImages`): past
 * the run of images in that direction, into the near end of the text line
 * beyond it (Up: its end, Down: its start), or to the document's edge right
 * after the run.
 */
export function pastImages(doc: PmNode, pos: number, dir: -1 | 1): number {
  for (;;) {
    const $pos = doc.resolve(pos);
    const node = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
    if (!isImage(node)) break;
    pos += dir * node!.nodeSize;
  }
  const $pos = doc.resolve(pos);
  return (dir < 0 ? $pos.nodeBefore : $pos.nodeAfter) ? pos + dir : pos;
}

/**
 * Up / Down from a text line into the run of images right above / below it:
 * from the line's first / last visual line, the caret goes next to the run,
 * between it and this line (drawn after the run's last image / before its
 * first); one more Up / Down then leaves the run.
 *
 * ProseMirror's own check (`endOfTextblock`) measures the caret at the position
 * after it, so at a soft wrap a caret drawn at the end of the upper visual line
 * counts as on the lower one; the browser's native move then skips the
 * uneditable images. Caret rectangles do not help either: a collapsed range at a
 * wrap reports both lines whichever one the caret is drawn on. Only the
 * browser's own line move knows, so it is asked (`Selection.modify`): if it
 * stays inside this line, that move is kept; if it leaves (or cannot move), the
 * caret was on the edge line. A non-empty selection first collapses toward the
 * key, as the browser does. Shift+Up / Down: `extendLines`.
 */
function enterImages(view: EditorView, dir: -1 | 1): boolean {
  const sel = view.state.selection;
  if (view.composing || !(sel instanceof TextSelection)) return false;
  const $pos = dir < 0 ? sel.$from : sel.$to;
  if ($pos.depth !== 1 || !$pos.parent.isTextblock) return false;
  const edge = dir < 0 ? $pos.before() : $pos.after();
  const $edge = view.state.doc.resolve(edge);
  const neighbour = dir < 0 ? $edge.nodeBefore : $edge.nodeAfter;
  if (!neighbour || !isImage(neighbour)) return false;
  if (!sel.empty)
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, $pos.pos),
      ),
    );
  const line = view.nodeDOM($pos.before()) as HTMLElement | null;
  const domSel = view.dom.ownerDocument.getSelection();
  const measurable =
    !!line &&
    !!domSel?.rangeCount &&
    domSel.isCollapsed &&
    !!domSel.focusNode &&
    line.contains(domSel.focusNode) &&
    typeof domSel.modify === "function";
  if (measurable) {
    const { focusNode, focusOffset } = domSel!;
    domSel!.modify("move", dir < 0 ? "backward" : "forward", "line");
    const moved =
      domSel!.focusNode !== focusNode || domSel!.focusOffset !== focusOffset;
    if (moved && domSel!.focusNode && line!.contains(domSel!.focusNode)) {
      // Another visual line of this text line. ProseMirror leaves an
      // equivalent DOM selection alone, so the caret keeps the line it is drawn on.
      const pos = view.posAtDOM(domSel!.focusNode, domSel!.focusOffset);
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, pos))
          .scrollIntoView(),
      );
      return true;
    }
  } else if (!view.endOfTextblock(dir < 0 ? "up" : "down")) return false;
  // An empty line has one visual line and lands here too.
  view.dispatch(
    view.state.tr
      .setSelection(new BlockRange(view.state.doc.resolve(edge)))
      .scrollIntoView(),
  );
  return true;
}

/**
 * Where the browser's own caret move by `unit` (`Selection.modify`) takes a
 * caret at the text position `pos`, or null when it cannot tell (no DOM
 * selection, or the move ends outside the editor). Only measured: the DOM
 * selection is put back as it was, and the caller dispatches a selection of its
 * own or leaves the key to the browser. The move starts from a fresh caret, so
 * at a soft wrap it is the start of the lower line, and a vertical move does
 * not keep the column of the moves before it.
 */
function nativeMove(
  view: EditorView,
  pos: number,
  dir: -1 | 1,
  unit: "word" | "line" | "lineboundary",
): number | null {
  const domSel = view.dom.ownerDocument.getSelection();
  if (!domSel || typeof domSel.modify !== "function") return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = domSel;
  const start = view.domAtPos(pos);
  domSel.collapse(start.node, start.offset);
  domSel.modify("move", dir < 0 ? "backward" : "forward", unit);
  const end = domSel.focusNode;
  const moved =
    end && view.dom.contains(end) ? view.posAtDOM(end, domSel.focusOffset) : null;
  if (anchorNode && focusNode)
    domSel.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  else domSel.removeAllRanges();
  return moved;
}

/**
 * Ctrl+Shift+Left / Right from a range that starts between blocks, its head
 * inside a text line: the browser's word move from the head (on Windows to
 * the start of the next / previous word), kept inside the line (its end /
 * start when the move leaves it). Left to the browser, the extension would
 * move the anchor into text too and drop the images.
 */
const wordStep = (dir: -1 | 1) => (view: EditorView, pos: number) => {
  const moved = nativeMove(view, pos, dir, "word");
  if (moved === null) return null;
  const $pos = view.state.doc.resolve(pos);
  return Math.min(Math.max(moved, $pos.start()), $pos.end());
};

/**
 * The visual line of the `k`th of a row's images, `tops` the tops of all of
 * them in order (images wrap like words): the indexes [first, end) of the
 * images on it. Tops less than 1px apart are one line (margin.ts's
 * `foldStarts`).
 */
export function foldOf(tops: number[], k: number): [number, number] {
  const starts = foldStarts(tops);
  let i = starts.length - 1;
  while (i > 0 && starts[i] > k) i--;
  return [starts[i], starts[i + 1] ?? tops.length];
}

/**
 * The visual line of images the image at `pos` is on, measured: `from` before
 * its first image, `to` after its last. A row of images (from an image
 * starting a row to the next one that does) wraps where it does not fit.
 */
function imageFold(view: EditorView, pos: number) {
  const { doc } = view.state;
  const index = doc.resolve(pos).index(0);
  const joins = (i: number) =>
    isImage(doc.maybeChild(i - 1)) &&
    isImage(doc.maybeChild(i)) &&
    !doc.child(i).attrs.newline;
  let first = index;
  let last = index;
  while (joins(first)) first--;
  while (joins(last + 1)) last++;
  // Images are leaves of size 1, so the row's positions follow each other.
  const start = pos - (index - first);
  const tops: number[] = [];
  for (let i = 0; i <= last - first; i++) tops.push(imageRect(view, start + i).top);
  const [a, b] = foldOf(tops, index - first);
  return { from: start + a, to: start + b };
}

/**
 * The image the caret between blocks at `$pos` on `side` is drawn beside:
 * `besideImage`, except at a soft wrap inside a row of images (the image after
 * `$pos` on the visual line below the one before it), where side 1 is the
 * start of the lower line, before the image after it, as the browser draws the
 * caret at a soft wrap in text reached by Left (input.ts). For the drawn caret
 * (caret-geometry.ts) and Home / End.
 */
export function caretImage(
  view: EditorView,
  $pos: ResolvedPos,
  side: Side,
): { pos: number; after: boolean } | null {
  const image = besideImage($pos, side);
  if (!image?.after || side < 0 || !isImage($pos.nodeAfter)) return image;
  const before = view.nodeDOM(image.pos) as HTMLElement | null;
  const after = view.nodeDOM($pos.pos) as HTMLElement | null;
  if (!before || !after) return image;
  return after.getBoundingClientRect().top - before.getBoundingClientRect().top >= 1
    ? { pos: $pos.pos, after: false }
    : image;
}

/**
 * Home / End (with Shift, `extend`) with the selection's head between blocks:
 * the start / end of the visual line of images its caret is drawn on
 * (`caretImage`, `imageFold`), the anchor kept with Shift. An image is one big
 * character, so its line is the images beside it; left to the browser, the
 * caret would go to the start / end of a text line next to them. With the
 * head in a text line and the anchor between blocks, Shift+Home / End go where
 * the browser's would (`nativeMove`) but keep the anchor, which the browser's
 * extension would move into text. Otherwise the browser's.
 */
function lineEdge(view: EditorView, dir: -1 | 1, extend: boolean): boolean {
  const { state } = view;
  const sel = state.selection;
  if (view.composing || !(sel instanceof BlockRange)) return false;
  const { doc } = state;
  const $head = sel.$head;
  let target: number;
  if ($head.parent.inlineContent) {
    if (!extend) return false;
    const moved = nativeMove(view, sel.head, dir, "lineboundary");
    if (moved === null) return false;
    target = Math.min(Math.max(moved, $head.start()), $head.end());
  } else {
    const image = caretImage(view, $head, sel.side);
    if (!image) return false;
    const fold = imageFold(view, image.pos);
    target = dir < 0 ? fold.from : fold.to;
  }
  // At the start of a visual line the caret is drawn before its first image,
  // at the end after its last.
  const side: Side = dir < 0 ? 1 : -1;
  view.dispatch(
    state.tr
      .setSelection(
        extend
          ? rangeSelection(doc, sel.anchor, target, dir, side)
          : caretAt(doc, target, dir, side),
      )
      .scrollIntoView(),
  );
  return true;
}

/**
 * Shift+Up / Shift+Down: the head goes where Up / Down would take a caret
 * there, the anchor stays. From between blocks: past the run of images
 * (`pastImages`, as `leaveImages`); from the first / last visual line of a text
 * line next to images: beside them, between them and the line (as
 * `enterImages`, measured the same way). Left to the browser, the first would
 * move the anchor too (its DOM position between blocks reads back after the
 * image next to it) and the second would skip the images. Inside a text line,
 * and from a text line to the next, the browser's own extension, except with
 * the anchor between blocks (it would move into text): there the browser's
 * line move is measured and taken (`nativeMove`).
 */
function extendLines(view: EditorView, dir: -1 | 1): boolean {
  const { state } = view;
  const sel = state.selection;
  if (view.composing) return false;
  const { doc } = state;
  const $head = sel.$head;
  const between = sel instanceof BlockRange;
  let target: number;
  if (!$head.parent.inlineContent) {
    if (!between) return false;
    target = pastImages(doc, sel.head, dir);
  } else {
    if ($head.depth !== 1) return false;
    const $edge = doc.resolve(dir < 0 ? $head.before() : $head.after());
    const images = isImage(dir < 0 ? $edge.nodeBefore : $edge.nodeAfter);
    if (!images && !between) return false;
    const moved = nativeMove(view, sel.head, dir, "line");
    const away = moved !== null && moved !== sel.head;
    if (away && moved >= $head.start() && moved <= $head.end()) {
      // Another visual line of this text line.
      if (!between) return false;
      target = moved;
    } else if (images) target = $edge.pos;
    else if (away) target = moved;
    else target = dir < 0 ? $head.start() : $head.end();
  }
  view.dispatch(
    state.tr
      .setSelection(rangeSelection(doc, sel.anchor, target, dir))
      .scrollIntoView(),
  );
  return true;
}

const isImageSlice = (slice: Slice) =>
  !slice.openStart &&
  !slice.openEnd &&
  slice.content.childCount > 0 &&
  Array.from({ length: slice.content.childCount }, (_, i) =>
    slice.content.child(i),
  ).every(isImage);

const pictureOf = (node: PmNode): Picture => ({
  id: node.attrs.id,
  name: node.attrs.name,
  width: node.attrs.width,
  height: node.attrs.height,
});

/**
 * The images of a selection made only of whole images (one, or a range of
 * them), else null: the pictures and, for each, whether it starts a new row
 * after the one before it (`rows[0]` is false: where the first goes is up to
 * the paste).
 */
export function selectedImages(
  sel: Selection,
): { pictures: Picture[]; rows: boolean[] } | null {
  if (!(sel instanceof NodeSelection || sel instanceof BlockRange) || sel.empty)
    return null;
  const slice = sel.content();
  if (!isImageSlice(slice)) return null;
  const nodes: PmNode[] = [];
  slice.content.forEach((node) => nodes.push(node));
  return {
    pictures: nodes.map(pictureOf),
    rows: nodes.map((node, i) => i > 0 && !!node.attrs.newline),
  };
}

/**
 * Where images inserted at a position between blocks go: -1 into the row
 * before it (after its last image), 1 into the row after it (before its first
 * image), 0 into a row of their own.
 */
type Join = -1 | 0 | 1;

/**
 * The row images inserted at `$pos` join. Inside a row, that row; at a line
 * break between rows, the upper row from its end (side -1), the lower one from
 * its start (side 1); next to a single run of images, that run; elsewhere a
 * row of their own.
 */
export function joinAt($pos: ResolvedPos, side: Side): Join {
  const before = isImage($pos.nodeBefore);
  const after = isImage($pos.nodeAfter);
  if (before && after) return rowBreak($pos) && side > 0 ? 1 : -1;
  return before ? -1 : after ? 1 : 0;
}

/**
 * Sets the rows of content just inserted at `from`..`to` (see `Join`): whether
 * its first image starts a new row, and whether the image after its last image
 * does. The others keep their own line breaks (a copied or dragged range of
 * rows); content that starts or ends with a text line leaves that end alone.
 */
export function placeRows(
  tr: Transaction,
  from: number,
  to: number,
  join: Join,
) {
  const $from = tr.doc.resolve(from);
  if (isImage($from.nodeAfter))
    tr.setNodeAttribute(
      from,
      "newline",
      !(join < 0 && isImage($from.nodeBefore)),
    );
  const $to = tr.doc.resolve(to);
  if (isImage($to.nodeBefore) && isImage($to.nodeAfter) && join >= 0)
    tr.setNodeAttribute(to, "newline", join === 0);
  return tr;
}

/**
 * Inserts imported or pasted images (one node each) at `tr`'s selection and
 * leaves the caret between blocks after the last of them (the end of their
 * row); returns where they are.
 *
 * Selected images (only images) are replaced: the new ones take their place
 * and their rows, the first starting a row where the first selected one did
 * (so a whole row selected becomes a row of their own), the image after them
 * staying in their row or starting the next as before. The caret between
 * blocks: right there, in the row there (see `joinAt`). Otherwise (a text
 * selection, or images and text lines) the images take the place of an
 * empty line the caret is on, go before / after a line with the caret at its
 * start / end, split it in the middle, or replace selected text; they then make
 * a row of their own: they start a new row after an image above, and an image
 * right after them starts a new row too. No empty line is added. A second
 * insertion at the caret left after them joins their row.
 *
 * Every node keeps its own `newline` except the first, so a paste of copied
 * rows keeps them.
 */
export function insertImages(
  tr: Transaction,
  nodes: PmNode[],
): { from: number; to: number } {
  const sel = tr.selection;
  let from = sel.to;
  if (!nodes.length) return { from, to: from };
  const size = nodes.reduce((sum, node) => sum + node.nodeSize, 0);
  let join: Join = 0;
  if (selectedImages(sel)) {
    // Replaced in place (one step, undone as one): the first new image starts
    // a row where the first selected one did; the image after the selection
    // keeps its own line break, so it stays in their row or below it.
    from = sel.from;
    const $from = tr.doc.resolve(from);
    const newline =
      !isImage($from.nodeBefore) || !!$from.nodeAfter!.attrs.newline;
    tr.replaceWith(from, sel.to, nodes);
    tr.setNodeAttribute(from, "newline", newline);
    const to = from + size;
    tr.setSelection(new BlockRange(tr.doc.resolve(to), undefined, -1));
    return { from, to };
  } else if (sel instanceof BlockRange && sel.empty) {
    join = joinAt(sel.$head, sel.side);
    tr.insert(from, nodes);
  } else {
    // replaceSelectionWith places a block next to a line instead of splitting
    // it at either end, and replaces an empty line; the other images follow
    // the first one.
    tr.replaceSelectionWith(nodes[0]);
    tr.doc.forEach((node, offset) => {
      if (node === nodes[0]) from = offset;
    });
    tr.insert(from + nodes[0].nodeSize, nodes.slice(1));
  }
  const to = from + size;
  placeRows(tr, from, to, join);
  tr.setSelection(new BlockRange(tr.doc.resolve(to), undefined, -1));
  return { from, to };
}

/**
 * Status bar line of top-level node `index`: one per text line and one per row
 * of images (a row that wraps is still one line), as in the file.
 */
export function lineOf(doc: PmNode, index: number) {
  let line = 0;
  for (let i = 0; i <= index && i < doc.childCount; i++) {
    const node = doc.child(i);
    if (!isImage(node) || !isImage(doc.maybeChild(i - 1)) || node.attrs.newline)
      line++;
  }
  return Math.max(line, 1);
}

/**
 * The clipboard format of a copy holding images and text lines (see
 * `mixedSlice`): `{v: 1, blocks}`, the document model's blocks (each row of
 * images one `images` block). Only LineHush reads it, so other programs paste
 * the plain text written with it.
 */
export const BLOCKS_MIME = "application/x-linehush-blocks";

/** Whether a slice holds an image (images are top-level nodes). */
function hasImage(slice: Slice) {
  let images = false;
  slice.content.forEach((node) => {
    if (isImage(node)) images = true;
  });
  return images;
}

/**
 * The selection's content when it holds images and something else (text
 * lines, empty ones included); null for no images or only images, which are
 * copied as before (see `selectedImages`).
 */
export function mixedSlice(state: EditorState): Slice | null {
  const sel = state.selection;
  if (sel.empty) return null;
  const slice = sel.content();
  return !isImageSlice(slice) && hasImage(slice) ? slice : null;
}

/** A slice of the document as blocks of the document model (partial lines cut). */
export const sliceBlocks = (slice: Slice): Block[] =>
  fromEditor({ type: "doc", content: slice.content.toJSON() ?? [] }).blocks;

/** The pictures of `blocks`, each id once. */
export function blockPictures(blocks: Block[]): Picture[] {
  const seen = new Map<string, Picture>();
  for (const block of blocks)
    if (block.type === "images")
      for (const pic of block.images)
        if (!seen.has(pic.id)) seen.set(pic.id, pic);
  return [...seen.values()];
}

/**
 * The blocks of a LineHush copy of images and text (`BLOCKS_MIME`, written by
 * `copyMixed`), or null unless it looks like one: version 1, blocks that are
 * lines of text or non-empty rows of images.
 */
export function clipboardBlocks(data: string): Block[] | null {
  let parsed: { v?: unknown; blocks?: unknown } | null;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const blocks = parsed?.v === 1 ? parsed.blocks : null;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const valid = blocks.every((block) =>
    block?.type === "line"
      ? typeof block.text === "string"
      : block?.type === "images" &&
        Array.isArray(block.images) &&
        block.images.length > 0 &&
        block.images.every((pic: Picture | null) => typeof pic?.id === "string"),
  );
  return valid ? (blocks as Block[]) : null;
}

/** `blocks` without the pictures in `missing`; a row left empty goes too. */
export function withoutPictures(
  blocks: Block[],
  missing: Iterable<string>,
): Block[] {
  const gone = new Set(missing);
  if (!gone.size) return blocks;
  return blocks.flatMap((block): Block[] => {
    if (block.type === "line") return [block];
    const images = block.images.filter((pic) => !gone.has(pic.id));
    return images.length ? [{ type: "images", images }] : [];
  });
}

/** Editor nodes for `blocks`: a paragraph per line, an image node per picture. */
export const blockNodes = (schema: Schema, blocks: Block[]): PmNode[] =>
  (toEditor({ blocks }).content ?? []).map((json) => schema.nodeFromJSON(json));

/**
 * Inserts pasted (or dropped) lines and images, `nodes` being top-level nodes
 * as `blockNodes` makes them, at `tr`'s selection, which goes first (through
 * `deleteBlocks`, as Backspace would take it). Returns where the new content
 * is and leaves the caret at its end: in its last line (before the rest of the
 * line it was pasted into), or between blocks after its last image.
 *
 * On a text line, as a paste of plain text: the first and last pasted lines
 * join the text before / after the caret; pasted images at either end make a
 * row of their own (an empty line the caret was on is replaced, a line is not
 * split at its start or end; an image right after them starts a new row).
 * At the caret between blocks: the content goes right there, its first / last
 * images joining the row there as inserted images do (`joinAt`); lines stay
 * lines of their own. Rows inside the content keep their line breaks.
 */
export function insertBlocks(
  tr: Transaction,
  nodes: PmNode[],
): { from: number; to: number } {
  if (!tr.selection.empty) {
    const { from, to } = tr.selection;
    const side: Side = rowBreak(tr.doc.resolve(from)) ? 1 : -1;
    deleteBlocks(tr, from, to);
    tr.setSelection(caretAt(tr.doc, from, 1, side));
  }
  const sel = tr.selection;
  if (!nodes.length) return { from: sel.from, to: sel.from };
  const sizeOf = (list: PmNode[]) =>
    list.reduce((sum, node) => sum + node.nodeSize, 0);
  const last = nodes[nodes.length - 1];
  const caretAfter = (to: number) =>
    tr.setSelection(
      isImage(last)
        ? new BlockRange(tr.doc.resolve(to), undefined, -1)
        : TextSelection.create(tr.doc, to),
    );
  if (sel instanceof BlockRange) {
    const pos = sel.head;
    const join = joinAt(sel.$head, sel.side);
    tr.insert(pos, nodes);
    const end = pos + sizeOf(nodes);
    placeRows(tr, pos, end, join);
    const to = isImage(last) ? end : end - 1;
    caretAfter(to);
    return { from: pos, to };
  }
  // A text caret: its line is rebuilt around the content.
  const { schema } = tr.doc.type;
  const line = (text: string) =>
    schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
  const $caret = sel.$from;
  const start = $caret.before();
  const text = $caret.parent.textContent;
  const head = text.slice(0, $caret.parentOffset);
  const tail = text.slice($caret.parentOffset);
  const out = nodes.slice();
  const first = nodes[0];
  let from = start;
  if (!isImage(first)) {
    out[0] = line(head + first.textContent);
    from = start + 1 + head.length;
  } else if (head) {
    out.unshift(line(head));
    from = start + out[0].nodeSize;
  }
  const lastIndex = out.length - 1;
  const lastStart = start + sizeOf(out.slice(0, lastIndex));
  let to: number;
  if (!isImage(last)) {
    const lastText = out[lastIndex].textContent;
    out[lastIndex] = line(lastText + tail);
    to = lastStart + 1 + lastText.length;
  } else {
    to = lastStart + last.nodeSize;
    if (tail) out.push(line(tail));
  }
  tr.replaceWith(start, $caret.after(), out);
  // Images at either end make a row of their own.
  if (isImage(out[0])) tr.setNodeAttribute(start, "newline", true);
  const end = start + sizeOf(out);
  if (isImage(out[out.length - 1]) && isImage(tr.doc.resolve(end).nodeAfter))
    tr.setNodeAttribute(end, "newline", true);
  caretAfter(to);
  return { from, to };
}

/** Removes the selected images, as Ctrl+X does. */
function removeSelected(view: EditorView) {
  const { from, to } = view.state.selection;
  view.dispatch(
    removeRange(view.state.tr, from, to, -1)
      .scrollIntoView()
      .setMeta("uiEvent", "cut"),
  );
}

/**
 * Copy / cut events (Ctrl+C / Ctrl+X, the context menu). Images alone go to
 * the system clipboard through Rust (see ImageOptions.copy): the event is
 * cancelled with nothing set, so the browser leaves the clipboard alone. Images
 * with text lines: see `copyMixed`. A cut then deletes the selection as
 * Backspace does.
 */
function copyEvent(
  view: EditorView,
  event: ClipboardEvent,
  copy: ImageOptions["copy"],
  stage: ImageOptions["stage"],
  cut: boolean,
) {
  const images = selectedImages(view.state.selection);
  if (!images) return copyMixed(view, event, stage, cut);
  event.preventDefault();
  copy(images.pictures, images.rows);
  if (cut && view.editable) removeSelected(view);
  return true;
}

/**
 * Copies images with text lines: the browser writes the plain text (the
 * editor's text serializer, images as placeholders) and the blocks
 * (`BLOCKS_MIME`), no HTML, so other programs paste only the text. Rust keeps
 * copies of the originals (`stage`) for a paste into another document. A cut
 * then deletes the selection as Backspace does (`deleteBlocks`).
 */
function copyMixed(
  view: EditorView,
  event: ClipboardEvent,
  stage: ImageOptions["stage"],
  cut: boolean,
) {
  const slice = mixedSlice(view.state);
  const data = event.clipboardData;
  if (!slice || !data) return false;
  event.preventDefault();
  const blocks = sliceBlocks(slice);
  const text =
    view.someProp("clipboardTextSerializer", (f) => f(slice, view)) ??
    slice.content.textBetween(0, slice.content.size, "\n");
  data.clearData();
  data.setData("text/plain", text);
  data.setData(BLOCKS_MIME, JSON.stringify({ v: 1, blocks }));
  stage(blockPictures(blocks));
  if (cut && view.editable) removeSelected(view);
  return true;
}

/** A position next to an image and the side of it the caret is on there. */
interface Spot {
  pos: number;
  side: Side;
}

/**
 * The side of the image at `pos` a point falls on: before it over its left
 * half (the start of the image's row, side 1), after it over its right half
 * (the end, side -1). Images flow in rows, so this decides both where a click
 * puts the caret and where dragged images drop.
 */
export const spotBy = (
  pos: number,
  node: PmNode,
  clientX: number,
  rect: { left: number; right: number },
): Spot =>
  clientX < (rect.left + rect.right) / 2
    ? { pos, side: 1 }
    : { pos: pos + node.nodeSize, side: -1 };

const imageRect = (view: EditorView, pos: number) =>
  (view.nodeDOM(pos) as HTMLElement).getBoundingClientRect();

/**
 * The DOM of each top-level block, in document order, from one pass over the
 * editor's children (`nodeDOM` for each block would take time quadratic in the
 * length of the document; a drag selection measures them on every move).
 */
export function blockDOMs(view: EditorView): HTMLElement[] {
  const { doc } = view.state;
  const doms = Array.from(view.dom.children).filter((el) =>
    el.matches("p, .image-item"),
  ) as HTMLElement[];
  if (doms.length === doc.childCount) return doms;
  const each: HTMLElement[] = [];
  doc.forEach((_node, offset) => each.push(view.nodeDOM(offset) as HTMLElement));
  return each;
}

/** The spacer of a line break between rows of images under an event, if any. */
const rowSpacer = (event: MouseEvent) =>
  (event.target as Element | null)?.closest?.(".image-row-break") ?? null;

/**
 * Drop position for dragged images. Over an image the left or right half
 * decides (ProseMirror would use the upper or lower half); over the spacer of
 * a line break between rows, the upper half drops at the end of the upper row,
 * the lower half at the start of the lower row. Images with text lines may
 * also drop inside a text line, where the pointer is.
 */
function dropAt(view: EditorView, event: DragEvent, slice: Slice): Spot | null {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const doc = view.state.doc;
  const inside = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
  if (inside && isImage(inside))
    return spotBy(
      hit.inside,
      inside,
      event.clientX,
      imageRect(view, hit.inside),
    );
  const pos = isImageSlice(slice) ? dropPoint(doc, hit.pos, slice) : hit.pos;
  if (pos === null) return null;
  const spacer = rowSpacer(event)?.getBoundingClientRect();
  return {
    pos,
    side: spacer && event.clientY > (spacer.top + spacer.bottom) / 2 ? 1 : -1,
  };
}

/** Puts the caret between blocks at `spot`, as a click does. */
function setCaretSpot(view: EditorView, spot: Spot) {
  view.dispatch(
    view.state.tr
      .setSelection(
        new BlockRange(view.state.doc.resolve(spot.pos), undefined, spot.side),
      )
      .setMeta("pointer", true),
  );
  return true;
}

/**
 * Below the last block, a text line (the editor's bottom padding, also out of
 * the window below it): its end. A press there is at the document's end
 * whatever its x, as in Notepad and VS Code; left to the browser it would put
 * the caret in the last line under the pointer. Below a final image
 * `spotBeside` already gives the end. Not for PageUp / PageDown (reveal.ts),
 * which go to the end past the last block themselves. The left margin is
 * margin.ts's: presses there never reach the editor. While an input method
 * composes, the browser's own placing stays.
 */
function belowLastLine(view: EditorView, y: number): Spot | null {
  const { doc } = view.state;
  const last = doc.lastChild;
  if (!last || isImage(last) || view.composing) return null;
  const dom = view.nodeDOM(doc.content.size - last.nodeSize) as HTMLElement | null;
  if (!dom || !(y > dom.getBoundingClientRect().bottom)) return null;
  return { pos: doc.content.size - 1, side: -1 };
}

/**
 * A click on an image puts the caret before or after it (by the half clicked)
 * instead of selecting it. The node stays selectable, which ProseMirror needs
 * to drag it.
 */
function clickImage(
  view: EditorView,
  node: PmNode,
  pos: number,
  event: MouseEvent,
  direct: boolean,
) {
  if (!direct || !isImage(node)) return false;
  // 右键（弹菜单）按在选区里的图片上时选区不变，像浏览器在文字上右键：选中的图片才能“复制”。
  if (rightInSelection(view, event, pos, pos + node.nodeSize)) return true;
  return setCaretSpot(
    view,
    spotBy(pos, node, event.clientX, imageRect(view, pos)),
  );
}

/** 右键按在当前（非空）选区里的 [from, to] 上。 */
function rightInSelection(
  view: EditorView,
  event: MouseEvent,
  from: number,
  to: number,
) {
  const sel = view.state.selection;
  return event.button === 2 && !sel.empty && sel.from <= from && to <= sel.to;
}

/** How far above / below rows of images a click beside them still goes to the nearest image. */
const ROW_REACH = 12;

/**
 * A click beside images rather than on one, or below the last text line (to
 * its end, `belowLastLine`). Level with a row of images (in a
 * gap, or the empty space left / right of the row) the caret goes to the near
 * side of the nearest image in that row; below a final image (above a first
 * one), to the document's end (start). Between rows (the spacer of a line
 * break, the images' margins) and not level with a text line, it goes to the
 * near side of the nearest image; on the spacer itself, to the line break, at
 * the end of the upper row or the start of the lower one, whichever image is
 * nearer. Left to the browser, such a click would put the caret in a
 * neighbouring line, or ProseMirror's `Selection.near` would select an image.
 */
function clickBesideImages(view: EditorView, event: MouseEvent) {
  const spot = spotBeside(
    view,
    event.clientX,
    event.clientY,
    event.target as Element | null,
  );
  if (spot && rightInSelection(view, event, spot.pos, spot.pos)) return true;
  if (spot) return setCaretSpot(view, spot);
  const end = belowLastLine(view, event.clientY);
  if (!end) return false;
  if (rightInSelection(view, event, end.pos, end.pos)) return true;
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, end.pos))
      .setMeta("pointer", true),
  );
  return true;
}

/**
 * A double / triple click beside images (where a click puts the caret beside
 * one, `spotBeside`; also below a final image): selects that image, as a double
 * click selects a word, or its visual line of images, as a triple click selects
 * a line. Left to the browser it would select a word of a line nearby, or a
 * range across blocks that typing would then put into the next line. A double
 * click on an image itself opens it instead (handleDoubleClickOn).
 */
function pressBesideImages(view: EditorView, event: MouseEvent, line: boolean) {
  if (event.button !== 0) return false;
  const spot = spotBeside(
    view,
    event.clientX,
    event.clientY,
    event.target as Element | null,
  );
  if (!spot) return false;
  return selectImages(view, spot.side > 0 ? spot.pos : spot.pos - 1, line);
}

/**
 * Selects the image at `pos` or, with `line`, its visual line of images
 * (`imageFold`), for a press: ProseMirror then cancels it, so no drag
 * selection follows.
 */
function selectImages(view: EditorView, pos: number, line: boolean) {
  const { from, to } = line ? imageFold(view, pos) : { from: pos, to: pos + 1 };
  const drag = drags.get(view);
  if (drag) endDrag(drag);
  view.dispatch(
    view.state.tr
      .setSelection(rangeSelection(view.state.doc, from, to))
      .setMeta("pointer", true),
  );
  return true;
}

/**
 * Where a point beside images (not on one) puts the caret, `target` being the
 * element there: see `clickBesideImages`. Null when it is on a text line or
 * level with one, which the browser / `posAtCoords` places.
 */
function spotBeside(
  view: EditorView,
  x: number,
  y: number,
  target: Element | null,
): Spot | null {
  if (target?.closest?.("p")) return null;
  const { doc } = view.state;
  const away = (rect: DOMRect) =>
    Math.hypot(
      Math.max(rect.left - x, x - rect.right, 0),
      Math.max(rect.top - y, y - rect.bottom, 0),
    );
  let spot: Spot | null = null;
  const spacer = target?.closest?.(".image-row-break") ?? null;
  if (spacer) {
    const pos = view.posAtDOM(spacer, 0);
    if (rowBreak(doc.resolve(pos)))
      spot = {
        pos,
        side:
          away(imageRect(view, pos - 1)) <= away(imageRect(view, pos)) ? -1 : 1,
      };
  }
  let distance = Infinity;
  const onSpacer = spot !== null;
  const blocks = onSpacer ? [] : blockDOMs(view);
  const rectAt = (i: number) => blocks[i].getBoundingClientRect();
  for (
    let i = 0, offset = 0;
    !onSpacer && i < doc.childCount;
    offset += doc.child(i++).nodeSize
  ) {
    const node = doc.child(i);
    if (!isImage(node)) continue;
    const rect = rectAt(i);
    if (y < rect.top || y > rect.bottom) continue;
    const gap = Math.max(rect.left - x, x - rect.right, 0);
    if (gap < distance) {
      distance = gap;
      spot = spotBy(offset, node, x, rect);
    }
  }
  const { firstChild, lastChild } = doc;
  if (spot === null && isImage(lastChild)) {
    const end = doc.content.size;
    if (y > rectAt(doc.childCount - 1).bottom) spot = { pos: end, side: -1 };
  }
  if (spot === null && isImage(firstChild) && y < rectAt(0).top)
    spot = { pos: 0, side: 1 };
  if (spot === null) {
    let level = false;
    for (let i = 0, offset = 0; i < doc.childCount; offset += doc.child(i++).nodeSize) {
      const node = doc.child(i);
      const rect = rectAt(i);
      if (!isImage(node)) {
        level = y >= rect.top && y <= rect.bottom;
        if (level) break;
        continue;
      }
      if (Math.max(rect.top - y, y - rect.bottom, 0) > ROW_REACH) continue;
      if (away(rect) < distance) {
        distance = away(rect);
        spot = spotBy(offset, node, x, rect);
      }
    }
    if (level) spot = null;
  }
  return spot;
}

/**
 * Whether a pointer event is over the selected text (where a press drags the
 * selection). Only the text's own boxes count: the range's client rects also
 * hold the border box of every element wholly inside it, so a text line or an
 * empty line selected from end to end would count across the editor's width,
 * right of its text too, where nothing is drawn (the drawn selection ends
 * 0.5em past the text, caret.ts). Images are pressed on as images (`dragPress`).
 */
function onSelection(view: EditorView, event: MouseEvent) {
  const doc = view.dom.ownerDocument;
  const domSel = doc.getSelection();
  if (!domSel?.rangeCount || domSel.isCollapsed) return false;
  const { clientX: x, clientY: y } = event;
  const over = (range: Range) =>
    Array.from(range.getClientRects()).some(
      (rect) =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
    );
  const range = domSel.getRangeAt(0);
  const root = range.commonAncestorContainer;
  if (root.nodeType === 3) return over(range);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const part = doc.createRange();
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!range.intersectsNode(text)) continue;
    part.selectNodeContents(text);
    if (text === range.startContainer) part.setStart(text, range.startOffset);
    if (text === range.endContainer) part.setEnd(text, range.endOffset);
    if (over(part)) return true;
  }
  return false;
}

/**
 * A drag selection: the primary button pressed in the editor but not on an
 * image (that drags the image) or on the selection (that drags it, see
 * dropMixed). The input plugin (input.ts) hands over the press, the moves (on
 * the window, so outside the editor too) and the release.
 */
interface DragSelection {
  /** The pointer while the drag lasts; null between drags. */
  pointer: { x: number; y: number } | null;
  /**
   * Pressed beside images (see `spotBeside`): the anchor, as for a click
   * there. The browser's own anchor is its canonical position, which skips
   * over a non-editable image: pressed before a row's first image it is after
   * that image. Pressed below the last text line: its end (`belowLastLine`),
   * where the browser's anchor would be in the line under the pointer.
   */
  anchor?: number;
  /**
   * The press was the second or third of a double / triple click: the browser
   * selects words / lines from the point pressed, and the pointer below the
   * last text line is not taken as the document's end (`belowLastLine`).
   */
  words?: boolean;
  /** The animation frame that draws the DOM selection (`drawDragSelection`). */
  frame: number;
  /** The DOM selection is the one drawn here, not the browser's. */
  drawn: boolean;
  /**
   * Pressed on the selection (`onSelection`), which the browser then holds for
   * a drag of it: the point and the selection. Dropped by a dragstart; if the
   * release comes first, it was a click (see `dragRelease`).
   */
  held?: { x: number; y: number; selection: Selection };
}
const drags = new WeakMap<EditorView, DragSelection>();

/** Over an image, the side of it under the point. */
function overImage(view: EditorView, x: number, y: number): Spot | null {
  const hit = view.posAtCoords({ left: x, top: y });
  const node = hit && hit.inside >= 0 ? view.state.doc.nodeAt(hit.inside) : null;
  if (!hit || !node || !isImage(node)) return null;
  return spotBy(hit.inside, node, x, imageRect(view, hit.inside));
}

/**
 * Where a point beside images puts an end of a drag selection: as for a click
 * there (`spotBeside`), with a point left / right of the text (in the editor's
 * padding or out of the window) taken at the edge of the text. Null on or level
 * with a text line, where the browser extends the selection. Left to the
 * browser, a point left of a row of images (in the padding or out of the
 * window) would read back as the position after the row's first image, the
 * browser's canonical position for the one before it.
 */
function dragBeside(view: EditorView, x: number, y: number): Spot | null {
  const dom = view.dom;
  const rect = dom.getBoundingClientRect();
  const style = getComputedStyle(dom);
  const left = rect.left + dom.clientLeft + parseFloat(style.paddingLeft);
  const right =
    rect.left + dom.clientLeft + dom.clientWidth - parseFloat(style.paddingRight);
  const at = Math.min(Math.max(x, left + 1), right - 1);
  const target = dom.ownerDocument.elementFromPoint(at, y);
  return spotBeside(view, at, y, target && dom.contains(target) ? target : null);
}

/**
 * The caret a point on or beside images gives: on an image the half it is
 * over, beside images as a click there (`dragBeside`); null on or level with a
 * text line. The ends of a drag selection and PageUp / PageDown (reveal.ts).
 */
export const pointSpot = (view: EditorView, x: number, y: number) =>
  overImage(view, x, y) ?? dragBeside(view, x, y);

/**
 * During a drag selection, the end set by the pointer on or beside images, or
 * below the last text line (its end, `belowLastLine`; not after a double /
 * triple click), if it is there.
 */
function dragHead(view: EditorView): Spot | null {
  const drag = drags.get(view);
  const pointer = drag?.pointer;
  if (!pointer) return null;
  return (
    pointSpot(view, pointer.x, pointer.y) ??
    (drag.words ? null : belowLastLine(view, pointer.y))
  );
}

/**
 * Puts the editor's selection into the DOM during a drag over an image, so the
 * text in it is highlighted as the pointer moves. While the browser drags a
 * selection in Chrome, ProseMirror leaves the DOM alone until mouseup
 * (`selectionToDOM` with `mouseDown.delaySelUpdate()`), and the browser's own
 * end stays in the text line (over an image, often back at the press), so
 * without this the text would light up only on release. Called in an animation
 * frame: the browser moves its end after the mousemove listeners (cancelling
 * the event does not stop it), and the frame comes after that and before the
 * paint. The selectionchange this causes reads back as the same selection (see
 * createSelectionBetween).
 */
function drawDragSelection(view: EditorView) {
  const { anchor, head } = view.state.selection;
  const domSel = view.dom.ownerDocument.getSelection();
  if (!domSel) return;
  const a = view.domAtPos(anchor);
  const h = view.domAtPos(head);
  if (
    domSel.anchorNode === a.node &&
    domSel.anchorOffset === a.offset &&
    domSel.focusNode === h.node &&
    domSel.focusOffset === h.offset
  )
    return;
  domSel.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
}

/**
 * A press off the selection as drawn (`onSelection`) starts a new one, and the
 * browser has to see it so too. Chromium asks instead whether the position
 * under the point is inside the selection, and below the last line (the
 * editor's bottom padding) or left / right of a line that position is in the
 * line, at the point's x: a selection reaching there (say, dragged down to the
 * end) would then be held for a drag of it. The release collapses it only if
 * the pointer did not move at all; moved a pixel it stays, moved a few it is
 * dragged (dragstart, then nothing dropped). The DOM selection is collapsed
 * first, so the browser handles the press as one outside a selection: the
 * caret goes under the pointer and a drag selects from there. Also on the
 * second press of a double click: the browser selects the word there only
 * from a caret (with a range selected it keeps the range), as after a first
 * click. Not with Shift (that extends the selection), on a triple click (that
 * selects the line from the word selected) or while an input method composes.
 */
function pressOffSelection(view: EditorView, event: MouseEvent) {
  if (view.state.selection.empty || event.shiftKey || event.detail > 2 || view.composing)
    return;
  const domSel = view.dom.ownerDocument.getSelection();
  if (domSel?.rangeCount && !domSel.isCollapsed) domSel.collapseToEnd();
}

/**
 * Shift+click on an image: the selection extends from its anchor to the side
 * of the image under the pointer (as a click there puts the caret, `spotBy`).
 * ProseMirror leaves a press with Shift to the browser, which extends nothing
 * from an image (it is draggable and not editable), so it is done here and the
 * press cancelled (no drag of the image, no native selection).
 */
function shiftClickImage(view: EditorView, event: MouseEvent) {
  if (view.composing || !view.editable) return;
  const spot = overImage(view, event.clientX, event.clientY);
  if (!spot) return;
  event.preventDefault();
  if (!view.hasFocus()) view.focus();
  const { state } = view;
  view.dispatch(
    state.tr
      .setSelection(
        rangeSelection(state.doc, state.selection.anchor, spot.pos, 1, spot.side),
      )
      .setMeta("pointer", true),
  );
}

/** A primary-button press in the editor (input.ts): starts a drag selection, see `DragSelection`. */
export function dragPress(view: EditorView, event: MouseEvent) {
  if (event.button !== 0) return;
  if ((event.target as Element).closest(".image-item")) {
    if (event.shiftKey) shiftClickImage(view, event);
    return;
  }
  let drag = drags.get(view);
  if (!drag) drags.set(view, (drag = { pointer: null, frame: 0, drawn: false }));
  drag.held = undefined;
  // A press inside the selection drags it (images with text lines move as a
  // whole, see dropMixed) instead of starting a new one. Not the second press
  // of a double click: with a range selected the browser keeps it then (no
  // word selected, no caret put), so it goes as a press off the selection.
  if (
    !view.state.selection.empty &&
    (event.detail !== 2 || event.shiftKey || view.composing) &&
    onSelection(view, event)
  ) {
    if (event.detail <= 1 && !event.shiftKey && !view.composing)
      drag.held = { x: event.clientX, y: event.clientY, selection: view.state.selection };
    return;
  }
  pressOffSelection(view, event);
  drag.pointer = { x: event.clientX, y: event.clientY };
  drag.words = event.detail > 1;
  // Shift extends the selection from its anchor; a double click selects words.
  drag.anchor =
    event.shiftKey || event.detail > 1
      ? undefined
      : (dragBeside(view, event.clientX, event.clientY) ??
          belowLastLine(view, event.clientY))?.pos;
}

const endDrag = (drag: DragSelection) => {
  drag.pointer = null;
  drag.anchor = undefined;
  drag.words = false;
  drag.drawn = false;
  drag.held = undefined;
};

/**
 * The pointer moved (input.ts). This runs bubbling to the window, after
 * ProseMirror's own mousemove listener (on the document) has marked the drag
 * as the browser's, so ProseMirror syncs the DOM selection only on mouseup.
 * Over an image the DOM selection is drawn in the next animation frame instead
 * (see drawDragSelection).
 */
export function dragMove(view: EditorView, event: MouseEvent) {
  const drag = drags.get(view);
  if (!drag) return;
  if (!(event.buttons & 1)) return endDrag(drag);
  if (!drag.pointer) return;
  drag.pointer = { x: event.clientX, y: event.clientY };
  // Over an image the browser's end stays in the nearest text line, often
  // without a selection change to read, and beside images (also out of the
  // window) it goes to the wrong side of one, so the range is set here.
  const head = dragHead(view);
  if (head === null) {
    // Off the image again, the browser's end takes over. It is moved after
    // this listener, but not if the browser deems the new end the same as the
    // drawn one (both ends of a final image are, so below it the range would
    // stay before it): the selection is first collapsed to its anchor, which
    // the browser then extends to the pointer.
    if (drag.drawn) {
      drag.drawn = false;
      const domSel = view.dom.ownerDocument.getSelection();
      const a = view.domAtPos(view.state.selection.anchor);
      domSel?.collapse(a.node, a.offset);
    }
    return;
  }
  const { doc, selection } = view.state;
  const anchor = drag.anchor ?? selection.anchor;
  if (head.pos !== selection.head || anchor !== selection.anchor)
    view.dispatch(
      view.state.tr
        .setSelection(rangeSelection(doc, anchor, head.pos, 1, head.side))
        .setMeta("pointer", true),
    );
  if (!drag.frame)
    drag.frame = view.dom.ownerDocument.defaultView!.requestAnimationFrame(() => {
      drag.frame = 0;
      if (!view.isDestroyed && dragHead(view) !== null) {
        drawDragSelection(view);
        drag.drawn = true;
      }
    });
}

/**
 * A press on the selection released before the browser started dragging it: a
 * click, which puts the caret under the press. The browser itself collapses
 * the selection only if the pointer did not move at all; a click with the
 * mouse often moves it a pixel or two, short of a drag (dragstart), and the
 * selection would stay.
 */
function clickOnSelection(view: EditorView, held: NonNullable<DragSelection["held"]>) {
  const { state } = view;
  if (view.composing || !state.selection.eq(held.selection)) return;
  const hit = view.posAtCoords({ left: held.x, top: held.y });
  if (!hit) return;
  pointerInput(view, held.y);
  view.dispatch(
    state.tr
      .setSelection(Selection.near(state.doc.resolve(hit.pos)))
      .setMeta("pointer", true),
  );
}

/** The button released (input.ts); with `destroyed`, the editor is gone. */
export function dragRelease(view: EditorView, destroyed = false) {
  const drag = drags.get(view);
  if (!drag) return;
  const { held } = drag;
  // A selection change of this press the browser has not reported yet (its
  // selectionchange can come after the release, a Shift+click's often does)
  // is read while the press still decides its ends (createSelectionBetween).
  if (drag.pointer && !destroyed)
    (view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush();
  endDrag(drag);
  if (held && !destroyed) clickOnSelection(view, held);
  if (!destroyed) return;
  view.dom.ownerDocument.defaultView?.cancelAnimationFrame(drag.frame);
  drags.delete(view);
}

/**
 * The press ended without a release reaching the page (input.ts): the window
 * lost the focus or was hidden, a key was pressed, an HTML5 drag started or
 * ended. When the window loses the mouse capture during a press (Alt+Tab, an
 * input method's window) Chromium sends no mouseup, and left alone the drag
 * would go on deciding the ends of every selection read back from the DOM
 * (`createSelectionBetween`): a key would extend a range from the old anchor.
 * As on a release, a pending DOM selection of the press is read first. With
 * `ownPress`, ProseMirror's own press ends too (`view.input.mouseDown`, which
 * would otherwise keep holding back the DOM selection and `readDOMSelection`);
 * not on dragstart, where ProseMirror ends it itself after reading it. The DOM
 * selection it held back is set at once (ProseMirror would set it in a timeout,
 * after the browser has acted on the key with the old one, and undo that).
 */
export function dragCancel(view: EditorView, ownPress = true) {
  const drag = drags.get(view);
  if (drag?.pointer)
    (view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush();
  if (drag) endDrag(drag);
  const input = (
    view as unknown as {
      input?: { mouseDown?: { done(): void; delayedSelectionSync?: boolean } | null };
    }
  ).input;
  const press = ownPress ? input?.mouseDown : null;
  if (!press) return;
  const delayed = press.delayedSelectionSync;
  press.delayedSelectionSync = false;
  press.done();
  if (delayed && view.hasFocus()) drawDragSelection(view);
}

/**
 * Whether the DOM selection's anchor, read back as `$read`, still stands for
 * the editor's anchor `pos` between blocks: it is where the editor put it, or
 * at the near end of the text line right beside it, where the browser moves a
 * DOM position between blocks when it extends the selection (it keeps only
 * positions it can show a caret at).
 */
function keptAnchor(view: EditorView, pos: number, $read: ResolvedPos) {
  if ($read.doc.resolve(pos).parent.inlineContent) return false;
  if (
    $read.depth === 1 &&
    ($read.pos === pos + 1
      ? $read.parentOffset === 0
      : $read.pos === pos - 1 && $read.parentOffset === $read.parent.content.size)
  )
    return true;
  const domSel = view.dom.ownerDocument.getSelection();
  if (!domSel?.anchorNode) return false;
  return ([-1, 1] as const).some((side) => {
    const at = view.domAtPos(pos, side);
    return at.node === domSel.anchorNode && at.offset === domSel.anchorOffset;
  });
}

/** The drop position of dragged images while they are over the editor. */
const marks = new PluginKey<Spot | null>("imageMarks");

/**
 * The spacer drawn for a line break between rows of images: a block that ends
 * the row before it, 8px tall (App.css), so rows a line break apart
 * are further apart than a row that wraps and closer than rows a text line apart.
 */
function rowSpacerDOM() {
  const spacer = document.createElement("div");
  spacer.className = "image-row-break";
  return spacer;
}

/** The drop position of dragged images between blocks: a line that takes no space. */
function dropLineDOM() {
  const line = document.createElement("div");
  line.className = "drop-line";
  return line;
}

/**
 * Draws the drop position, the line breaks between rows and images inside a
 * range selection; places the caret on clicks and typing between blocks; moves
 * dragged images; copies selected images from copy / cut events.
 */
export function imagePlugin(
  copy: ImageOptions["copy"],
  stage: ImageOptions["stage"],
) {
  const setDrop = (view: EditorView, spot: Spot | null) => {
    const drop = marks.getState(view.state);
    if (drop?.pos !== spot?.pos || drop?.side !== spot?.side)
      view.dispatch(view.state.tr.setMeta(marks, spot));
  };
  // A composition must happen in a text line: one is made at the caret before
  // the input method writes anything, and the DOM selection moves into it (as
  // prosemirror-gapcursor does for its gap cursor).
  const lineForComposition = (view: EditorView) => {
    if (caretBetween(view.state) !== null)
      typeBetween("")(view.state, view.dispatch);
  };
  return new Plugin<Spot | null>({
    key: marks,
    state: {
      init: () => null,
      apply(tr, drop) {
        const meta = tr.getMeta(marks);
        if (meta !== undefined) return meta;
        return drop && { pos: tr.mapping.map(drop.pos), side: drop.side };
      },
    },
    // An image is never left selected as a node (typing would replace it; a
    // click and the keys put the caret beside it instead). The browser's own
    // moves can still put the DOM caret inside an image (Ctrl+Left / Right
    // inside a text line, say), which ProseMirror reads back as the image
    // selected: that becomes the caret beside it on the side it was reached
    // from (before it from above, after it from below). ProseMirror's drag of
    // an image selects it only in the dragged slice, not in the state.
    appendTransaction(_trs, old, state) {
      const sel = state.selection;
      if (!(sel instanceof NodeSelection) || !isImage(sel.node)) return null;
      return state.tr.setSelection(
        old.selection.head <= sel.from
          ? new BlockRange(sel.$from, sel.$from, 1)
          : new BlockRange(sel.$to, sel.$to, -1),
      );
    },
    props: {
      decorations(state) {
        const { doc, selection } = state;
        const decorations: Decoration[] = [];
        // Dropped images go where a caret there is drawn: beside the image
        // there, at its full height, or as a line between two text lines.
        const drop = marks.getState(state);
        const beside = drop && besideImage(doc.resolve(drop.pos), drop.side);
        if (beside) {
          const end = beside.pos + doc.nodeAt(beside.pos)!.nodeSize;
          decorations.push(
            Decoration.node(beside.pos, end, {
              class: beside.after ? "drop-after" : "drop-before",
            }),
          );
        } else if (drop)
          decorations.push(
            Decoration.widget(drop.pos, dropLineDOM, { key: "drop-line" }),
          );
        // A line break between rows of images: a spacer before the row's first image.
        doc.forEach((node, offset, index) => {
          if (
            isImage(node) &&
            node.attrs.newline &&
            isImage(doc.maybeChild(index - 1))
          )
            decorations.push(
              Decoration.widget(offset, rowSpacerDOM, {
                key: "image-row-break",
                side: -1,
              }),
            );
        });
        if (!selection.empty && !(selection instanceof NodeSelection))
          doc.nodesBetween(selection.from, selection.to, (node, pos) => {
            if (
              isImage(node) &&
              pos >= selection.from &&
              pos + node.nodeSize <= selection.to
            )
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: "image-selected",
                }),
              );
            return false;
          });
        return decorations.length
          ? DecorationSet.create(doc, decorations)
          : null;
      },
      // A DOM selection between blocks next to an image (a click beside a row of
      // images, the browser's own moves, a drag past the last image) keeps that
      // end there, not snapped into text. Dragging over an image, the browser
      // puts the end in the nearest text line; the half under the pointer
      // decides instead, as for a click. Beside images (or out of the window
      // level with them) both ends of a drag go where a click there would.
      // The drag counts only while the button is held (input.ts): a press whose
      // release never came (see dragCancel) must not decide the ends of later
      // selections. Positions are in the document read back with the DOM
      // (`$head.doc`), which after typing is newer than the view's.
      createSelectionBetween: (view, $anchor, $head) => {
        const doc = $head.doc;
        const drag = pressedIn(view) ? drags.get(view) : undefined;
        const head = drag ? dragHead(view) : null;
        const anchor = drag?.anchor;
        if (head)
          return rangeSelection(doc, anchor ?? $anchor.pos, head.pos, 1, head.side);
        let $from = anchor === undefined ? $anchor : doc.resolve(anchor);
        // Without a press, a range the browser extended from the editor's
        // anchor between blocks (Ctrl+Shift+End, say): the anchor stays. The
        // browser moves its DOM position into the text line beside it, or it
        // reads back as another position; the images next to it would drop
        // out of the range.
        const current = view.state.selection;
        if (
          !pressedIn(view) &&
          $anchor.pos !== $head.pos &&
          doc === view.state.doc &&
          current.anchor !== $anchor.pos &&
          keptAnchor(view, current.anchor, $anchor)
        )
          $from = doc.resolve(current.anchor);
        // Pressed below the last text line, both ends in text: the browser's
        // anchor is in the line under the press, the drag's is the line's end.
        const sel =
          selectionBetween($from, $head) ??
          ($from !== $anchor && $head.parent.inlineContent
            ? rangeSelection(doc, $from.pos, $head.pos)
            : null);
        // The DOM cannot tell the two sides of a line break between rows
        // apart: the caret (or a range's head) keeps the side it is on.
        return sel instanceof BlockRange &&
          current instanceof BlockRange &&
          current.anchor === sel.anchor &&
          current.head === sel.head
          ? current
          : sel;
      },
      handleClickOn: (view, _pos, node, nodePos, event, direct) =>
        clickImage(view, node, nodePos, event, direct),
      // A triple click on an image selects its visual line, as beside it.
      handleTripleClickOn: (view, _pos, node, nodePos, event, direct) =>
        direct && isImage(node) && event.button === 0 && selectImages(view, nodePos, true),
      handleClick: (view, _pos, event) => clickBesideImages(view, event),
      // The first click placed the caret; the second must not select a word
      // next to the image. The tile's own dblclick listener opens the preview.
      handleDoubleClickOn: (_view, _pos, node, _nodePos, _event, direct) =>
        direct && isImage(node),
      handleDoubleClick: (view, _pos, event) => pressBesideImages(view, event, false),
      handleTripleClick: (view, _pos, event) => pressBesideImages(view, event, true),
      // Keys typed at the caret between blocks (ProseMirror hands over every
      // keypress outside a text selection).
      handleTextInput: (view, _from, _to, text) =>
        typeBetween(text)(view.state, view.dispatch),
      handleDOMEvents: {
        copy: (view, event) => copyEvent(view, event, copy, stage, false),
        cut: (view, event) => copyEvent(view, event, copy, stage, true),
        compositionstart(view) {
          lineForComposition(view);
          return false;
        },
        // Text inserted without a keypress (an input method's commit, the emoji
        // panel) at the caret between blocks; and a composition whose start
        // was missed.
        beforeinput(view, event) {
          if (caretBetween(view.state) === null) return false;
          if (event.inputType === "insertCompositionText") {
            lineForComposition(view);
            return false;
          }
          if (
            event.inputType !== "insertText" ||
            !event.data ||
            !typeBetween(event.data)(view.state, view.dispatch)
          )
            return false;
          event.preventDefault();
          return true;
        },
        dragover(view, event) {
          const slice = view.dragging?.slice;
          let spot = slice && hasImage(slice) ? dropAt(view, event, slice) : null;
          // Inside a text line the browser draws where the drop goes.
          if (spot && view.state.doc.resolve(spot.pos).parent.inlineContent)
            spot = null;
          setDrop(view, spot);
          return false;
        },
        dragleave(view, event) {
          if (!view.dom.contains(event.relatedTarget as globalThis.Node | null))
            setDrop(view, null);
          return false;
        },
        // The browser drags the selection pressed on: no click (see `dragRelease`).
        dragstart(view) {
          const drag = drags.get(view);
          if (drag) drag.held = undefined;
          return false;
        },
        dragend(view) {
          setDrop(view, null);
          return false;
        },
        // Runs before ProseMirror clears `view.dragging`. Only images, alone or
        // with text lines, move inside the document; dragged text stays put,
        // and external drops (files) go on to the editor's handleDrop.
        drop(view, event) {
          const dragging = view.dragging as
            | (NonNullable<EditorView["dragging"]> & { node?: NodeSelection })
            | null;
          if (!dragging) return false;
          setDrop(view, null);
          event.preventDefault();
          // Done with, as ProseMirror's own drop leaves it (dragend may not follow).
          view.dragging = null;
          const { slice } = dragging;
          const target = hasImage(slice) ? dropAt(view, event, slice) : null;
          if (target === null) return true;
          if (!isImageSlice(slice))
            return dropMixed(view, event.ctrlKey, slice, target);
          const tr = view.state.tr;
          // Ctrl copies, as in ProseMirror's own drop on Windows. Moved images
          // leave the rows around them as deleted ones do.
          if (!event.ctrlKey) {
            const { from, to } = dragging.node ?? tr.selection;
            deleteBlocks(tr, from, to);
          }
          const pos = tr.mapping.map(target.pos);
          // They join the row they are dropped into: beside an image, its row;
          // before the first image of a row (after a line break), that row
          // from its start.
          const join = joinAt(tr.doc.resolve(pos), target.side);
          tr.insert(pos, slice.content);
          placeRows(tr, pos, pos + slice.content.size, join);
          // The dropped images end up selected (a range, also for one image).
          tr.setSelection(rangeSelection(tr.doc, pos, pos + slice.content.size));
          view.focus();
          view.dispatch(tr.setMeta("uiEvent", "drop"));
          return true;
        },
      },
    },
  });
}

/**
 * Drops images with text lines (the selection being dragged) at `target`: a
 * cut and a paste there (`insertBlocks`) in one undo step; with Ctrl, a copy.
 * A drop inside the selection itself changes nothing. The dropped content ends
 * up selected.
 */
function dropMixed(
  view: EditorView,
  copying: boolean,
  slice: Slice,
  target: Spot,
) {
  const { from, to } = view.state.selection;
  if (target.pos >= from && target.pos <= to) return true;
  // Its own undo step, not merged with typing just before.
  const tr = closeHistory(view.state.tr);
  if (!copying) deleteBlocks(tr, from, to);
  const pos = tr.mapping.map(target.pos);
  tr.setSelection(
    tr.doc.resolve(pos).parent.inlineContent
      ? TextSelection.create(tr.doc, pos)
      : caretAt(tr.doc, pos, 1, target.side),
  );
  const range = insertBlocks(
    tr,
    blockNodes(view.state.schema, sliceBlocks(slice)),
  );
  tr.setSelection(rangeSelection(tr.doc, range.from, range.to));
  view.focus();
  view.dispatch(tr.setMeta("uiEvent", "drop"));
  return true;
}

export interface ImageOptions {
  /** Opens the original (double click). */
  preview: (pic: Picture) => void;
  /** A Blob URL of the picture's thumbnail, which the image revokes when it goes. */
  source: (pic: Picture) => Promise<string>;
  /**
   * Puts the originals on the system clipboard; `rows` marks the images that
   * start a new row (see `selectedImages`).
   */
  copy: (pictures: Picture[], rows: boolean[]) => void;
  /**
   * Keeps copies of the originals of images copied with text lines, for a
   * paste into another document; the clipboard itself is the browser's.
   */
  stage: (pictures: Picture[]) => void;
}

/**
 * One picture per node. Neighbouring image nodes share a row, which CSS wraps
 * where it does not fit; an image with `newline` starts a new row after the
 * image before it (a line break between them, drawn as a spacer by the plugin).
 * The document model makes each row one `images` block.
 */
export function image({ preview, source, copy, stage }: ImageOptions) {
  return Node.create({
    name: "image",
    group: "block",
    atom: true,
    // Selectable (the default) as ProseMirror drags only selectable nodes; a
    // click places the caret instead (see clickImage).
    selectable: true,
    draggable: true,
    addAttributes: () => ({
      id: { default: "", rendered: false },
      name: { default: "", rendered: false },
      width: { default: 0, rendered: false },
      height: { default: 0, rendered: false },
      // A line break before this image, if an image comes before it; no
      // meaning after a text line or at the document's start.
      newline: { default: false, rendered: false },
    }),
    parseHTML: () => [],
    renderHTML: () => ["div", { "data-image": "" }],
    addKeyboardShortcuts() {
      const run = (command: Command) =>
        command(this.editor.state, this.editor.view.dispatch, this.editor.view);
      const view = () => this.editor.view;
      // With Ctrl an image is one word: Ctrl+Left / Right step over it as Left /
      // Right do, Ctrl+Backspace / Delete (and Shift+Backspace) delete as
      // Backspace / Delete do (beside a text line with text, nothing), where
      // the core keymap would join the line into the image (deleting it). Not
      // next to an image they are the browser's / the core keymap's.
      return {
        Backspace: () => run(removeNear(-1)),
        Delete: () => run(removeNear(1)),
        "Mod-Backspace": () => run(removeNear(-1)),
        "Shift-Backspace": () => run(removeNear(-1)),
        "Mod-Delete": () => run(removeNear(1)),
        ArrowLeft: () => run(moveCaret(-1)),
        ArrowRight: () => run(moveCaret(1)),
        "Mod-ArrowLeft": () => run(moveCaret(-1)),
        "Mod-ArrowRight": () => run(moveCaret(1)),
        "Shift-ArrowLeft": () => run(extendByImage(-1)),
        "Shift-ArrowRight": () => run(extendByImage(1)),
        "Mod-Shift-ArrowLeft": () => run(extendByImage(-1, wordStep(-1))),
        "Mod-Shift-ArrowRight": () => run(extendByImage(1, wordStep(1))),
        ArrowUp: () => run(leaveImages(-1)) || enterImages(view(), -1),
        ArrowDown: () => run(leaveImages(1)) || enterImages(view(), 1),
        "Shift-ArrowUp": () => extendLines(view(), -1),
        "Shift-ArrowDown": () => extendLines(view(), 1),
        Home: () => lineEdge(view(), -1, false),
        End: () => lineEdge(view(), 1, false),
        "Shift-Home": () => lineEdge(view(), -1, true),
        "Shift-End": () => lineEdge(view(), 1, true),
      };
    },
    addProseMirrorPlugins: () => [imagePlugin(copy, stage)],
    addNodeView() {
      return ({ node }) => {
        const pic = pictureOf(node);
        const same = (other: PmNode) =>
          other.type === node.type &&
          (["id", "name", "width", "height"] as const).every(
            (key) => other.attrs[key] === node.attrs[key],
          );
        const dom = document.createElement("div");
        dom.className = "image-item";
        dom.contentEditable = "false";
        // Not a real <button>: a click would move focus into it, away from the
        // editor, and once the image was deleted keys would go nowhere. The tile
        // is still announced as a button; the preview opens with a double click.
        const tile = document.createElement("div");
        tile.setAttribute("role", "button");
        tile.className = "image-tile";
        tile.title = `${pic.name} · 双击查看原图`;
        tile.setAttribute("aria-label", `查看图片 ${pic.name}`);
        const scale = Math.min(1, 280 / pic.width, 200 / pic.height);
        tile.style.width = `${Math.max(48, Math.round(pic.width * scale))}px`;
        tile.style.height = `${Math.max(48, Math.round(pic.height * scale))}px`;
        const img = document.createElement("img");
        img.alt = pic.name;
        img.draggable = false;
        img.loading = "lazy";
        img.decoding = "async";
        tile.append(img);
        dom.append(tile);
        let url: string | undefined;
        let destroyed = false;
        void source(pic)
          .then((result) => {
            if (destroyed) {
              URL.revokeObjectURL(result);
              return;
            }
            url = result;
            img.src = result;
          })
          .catch(() => {
            if (!destroyed) {
              tile.textContent = "无法显示此图片";
              tile.classList.add("image-error");
            }
          });
        // A single click places the caret through the plugin's handleClickOn.
        tile.addEventListener("dblclick", () => preview(pic));
        return {
          dom,
          // A line break added or removed before the image keeps its tile
          // (and thumbnail); the spacer is the plugin's.
          update: (other: PmNode) => same(other),
          // Only the double click is ours; mousedown and dragstart stay with ProseMirror.
          stopEvent: (event) => event.type === "dblclick",
          ignoreMutation: () => true,
          destroy: () => {
            destroyed = true;
            if (url) URL.revokeObjectURL(url);
          },
        };
      };
    },
  });
}
