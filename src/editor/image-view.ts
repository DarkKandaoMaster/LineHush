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

/**
 * The side of a position between blocks a caret is on: -1 drawn after the
 * image before it, 1 before the image after it. It only shows at a line break
 * between two rows of images (see `rowBreak`): -1 is the end of the upper row,
 * 1 the start of the lower one.
 */
export type Side = -1 | 1;

/**
 * A range whose ends may sit between blocks, so a run of images can be selected
 * without the text around it (a TextSelection must end inside a text line).
 *
 * Collapsed, it is the caret between blocks, which only stops next to an image
 * (see `caretSpot`): an image behaves like one big character. That caret is
 * drawn on the image at its full height (the plugin's decorations), so the
 * browser's own caret is hidden (`visible`). At a line break between two rows
 * of images it has two places, the end of the upper row and the start of the
 * lower one, told apart by `side` (meaningless for a range).
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

/** The position of a caret between blocks, or null for any other selection. */
const caretBetween = (state: EditorState) => {
  const sel = state.selection;
  return sel instanceof BlockRange && sel.empty ? sel.head : null;
};

/**
 * The selection between two positions: a caret, a text range or a block range.
 * A caret between blocks is on `side`, by default the side it is reached from
 * when moving toward `dir`.
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
  return new BlockRange($anchor, $head);
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
export function breakAt(tr: Transaction, pos: number, side: Side) {
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

/** Shift+Left / Shift+Right extend the selection by one whole image. */
export function extendByImage(dir: -1 | 1): Command {
  return (state, dispatch) => {
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
    if (caretBetween(state) === null && !selectedPictures(state)) return false;
    const doc = state.doc;
    let pos = dir < 0 ? sel.from : sel.to;
    for (;;) {
      const $pos = doc.resolve(pos);
      const node = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
      if (!isImage(node)) break;
      pos += dir * node!.nodeSize;
    }
    const $pos = doc.resolve(pos);
    const line = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
    dispatch?.(
      state.tr
        .setSelection(
          line ? TextSelection.create(doc, pos + dir) : new BlockRange($pos),
        )
        .scrollIntoView(),
    );
    return true;
  };
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
 * key, as the browser does; Shift+Up / Down are not bound here.
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

/** The image nodes of a selection made only of whole images, else null. */
function imagesIn(sel: Selection): PmNode[] | null {
  if (!(sel instanceof NodeSelection || sel instanceof BlockRange) || sel.empty)
    return null;
  const slice = sel.content();
  if (!isImageSlice(slice)) return null;
  const nodes: PmNode[] = [];
  slice.content.forEach((node) => nodes.push(node));
  return nodes;
}
const picturesIn = (sel: Selection) => imagesIn(sel)?.map(pictureOf) ?? null;

/** The pictures of a selection made only of whole images (one, or a range of them); else null. */
export const selectedPictures = (state: EditorState) =>
  picturesIn(state.selection);

/**
 * Images to copy: the pictures and, for each, whether it starts a new row
 * after the one before it (`rows[0]` is false: where the first goes is up to
 * the paste). Null unless the selection is made only of whole images.
 */
export function selectedImages(
  state: EditorState,
): { pictures: Picture[]; rows: boolean[] } | null {
  const nodes = imagesIn(state.selection);
  if (!nodes) return null;
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
export type Join = -1 | 0 | 1;

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
 * Sets the rows of images just inserted at `from`..`to` (see `Join`): whether
 * the first starts a new row, and whether the image after them does. The
 * others keep their own line breaks (a copied or dragged range of rows).
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
  const after = tr.doc.resolve(to).nodeAfter;
  if (isImage(after) && join >= 0)
    tr.setNodeAttribute(to, "newline", join === 0);
  return tr;
}

/**
 * Inserts imported or pasted images (one node each) at `tr`'s selection and
 * leaves the caret between blocks after the last of them (the end of their
 * row); returns where they are.
 *
 * Selected images, or the caret between blocks: right there, in the row there
 * (see `joinAt`). Otherwise (a text selection) the images take the place of an
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
  if (picturesIn(sel)) {
    join = -1;
    tr.insert(from, nodes);
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
 * HTML for copied images, as Rust's clipboard.rs writes it (there also with a
 * `file:` URL as `src`): what `clipboardImages` reads back. `rows` marks the
 * images that start a new row (see `selectedImages`).
 */
export function imagesHtml(pictures: Picture[], rows: boolean[] = []): string {
  return pictures
    .map((pic, i) => {
      const img = document.createElement("img");
      img.alt = pic.name;
      img.dataset.linehushId = pic.id;
      img.dataset.linehushName = pic.name;
      img.dataset.linehushWidth = String(pic.width);
      img.dataset.linehushHeight = String(pic.height);
      if (rows[i]) img.dataset.linehushNewline = "true";
      return img.outerHTML;
    })
    .join("");
}

/**
 * Images copied in LineHush, from the clipboard's HTML: pasted under the same
 * ids instead of being imported again, in the same rows. Null unless the HTML
 * holds only such images.
 */
export function clipboardImages(
  html: string,
): { pictures: Picture[]; rows: boolean[] } | null {
  if (!html.includes("data-linehush-id")) return null;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const images = Array.from(body.querySelectorAll("img"));
  if (
    !images.length ||
    body.textContent?.trim() ||
    images.some((img) => !/^[0-9a-f]{64}$/.test(img.dataset.linehushId ?? ""))
  )
    return null;
  return {
    pictures: images.map((img) => ({
      id: img.dataset.linehushId!,
      name: img.dataset.linehushName ?? "",
      width: Number(img.dataset.linehushWidth) || 0,
      height: Number(img.dataset.linehushHeight) || 0,
    })),
    rows: images.map(
      (img, i) => i > 0 && img.dataset.linehushNewline === "true",
    ),
  };
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The blocks of a LineHush copy of images and text (`BLOCKS_MIME`), or null
 * unless the data is exactly that: version 1, lines of text without line
 * breaks, rows of at least one picture with a SHA-256 id.
 */
export function clipboardBlocks(data: string): Block[] | null {
  if (!data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.blocks))
    return null;
  const blocks: Block[] = [];
  for (const block of parsed.blocks) {
    if (!isRecord(block)) return null;
    if (block.type === "line") {
      if (typeof block.text !== "string" || /[\r\n]/.test(block.text))
        return null;
      blocks.push({ type: "line", text: block.text });
    } else if (block.type === "images") {
      if (!Array.isArray(block.images) || !block.images.length) return null;
      const images: Picture[] = [];
      for (const pic of block.images) {
        if (
          !isRecord(pic) ||
          typeof pic.id !== "string" ||
          !/^[0-9a-f]{64}$/.test(pic.id) ||
          typeof pic.name !== "string" ||
          typeof pic.width !== "number" ||
          typeof pic.height !== "number" ||
          !Number.isFinite(pic.width) ||
          !Number.isFinite(pic.height)
        )
          return null;
        images.push({
          id: pic.id,
          name: pic.name,
          width: pic.width,
          height: pic.height,
        });
      }
      blocks.push({ type: "images", images });
    } else return null;
  }
  return blocks.length ? blocks : null;
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
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const caretAfter = (to: number) =>
    tr.setSelection(
      isImage(last)
        ? new BlockRange(tr.doc.resolve(to), undefined, -1)
        : TextSelection.create(tr.doc, to),
    );
  if (sel instanceof BlockRange) {
    const pos = sel.head;
    const $pos = tr.doc.resolve(pos);
    const join = joinAt($pos, sel.side);
    const before = isImage($pos.nodeBefore);
    tr.insert(pos, nodes);
    const end = pos + sizeOf(nodes);
    if (isImage(first))
      tr.setNodeAttribute(pos, "newline", !(join < 0 && before));
    if (isImage(last) && isImage(tr.doc.resolve(end).nodeAfter) && join >= 0)
      tr.setNodeAttribute(end, "newline", join === 0);
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
 * Ctrl+C / Ctrl+X on images: they go to the system clipboard through Rust
 * (see ImageOptions.copy) and the browser writes nothing. False when the
 * selection is not just images or copying is unavailable (no desktop), so the
 * browser's copy event follows.
 */
function copyKey(view: EditorView, copy: ImageOptions["copy"], cut: boolean) {
  const images = selectedImages(view.state);
  if (!images || !copy(images.pictures, images.rows, false)) return false;
  if (cut && view.editable) removeSelected(view);
  return true;
}

/**
 * Copy / cut events (the context menu, or no desktop): the browser writes the
 * clipboard after this event, so it gets the images' HTML, enough to paste them
 * back in LineHush; Rust then replaces it with the full set of formats.
 *
 * Images with text lines (Ctrl+C / Ctrl+X come here too): see `copyMixed`.
 */
function copyEvent(
  view: EditorView,
  event: ClipboardEvent,
  copy: ImageOptions["copy"],
  stage: NonNullable<ImageOptions["stage"]>,
  cut: boolean,
) {
  const images = selectedImages(view.state);
  if (!images) return copyMixed(view, event, stage, cut);
  if (!event.clipboardData) return false;
  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData(
    "text/html",
    imagesHtml(images.pictures, images.rows),
  );
  copy(images.pictures, images.rows, true);
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
  stage: NonNullable<ImageOptions["stage"]>,
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

/**
 * The side of an image a point falls on: the position before it over its left
 * half, after it over its right half. Images flow in rows, so this decides both
 * where a click puts the caret and where dragged images drop.
 */
export function imageSide(
  pos: number,
  node: PmNode,
  clientX: number,
  rect: { left: number; right: number },
) {
  return clientX < (rect.left + rect.right) / 2 ? pos : pos + node.nodeSize;
}

/** A position next to an image and the side of it the caret is on there. */
interface Spot {
  pos: number;
  side: Side;
}

/**
 * `imageSide` with the caret's side: before the image it is at the start of the
 * image's row (1), after it at the end (-1).
 */
const spotBy = (
  pos: number,
  node: PmNode,
  clientX: number,
  rect: { left: number; right: number },
): Spot => {
  const at = imageSide(pos, node, clientX, rect);
  return { pos: at, side: at === pos ? 1 : -1 };
};

const imageRect = (view: EditorView, pos: number) =>
  (view.nodeDOM(pos) as HTMLElement).getBoundingClientRect();

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
  const spot = spotBy(pos, node, event.clientX, imageRect(view, pos));
  view.dispatch(
    view.state.tr
      .setSelection(
        new BlockRange(view.state.doc.resolve(spot.pos), undefined, spot.side),
      )
      .setMeta("pointer", true),
  );
  return true;
}

/** How far above / below rows of images a click beside them still goes to the nearest image. */
const ROW_REACH = 12;

/**
 * A click beside images rather than on one. Level with a row of images (in a
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
  if ((event.target as Element | null)?.closest?.("p")) return false;
  const { doc } = view.state;
  const { clientX: x, clientY: y } = event;
  const away = (rect: DOMRect) =>
    Math.hypot(
      Math.max(rect.left - x, x - rect.right, 0),
      Math.max(rect.top - y, y - rect.bottom, 0),
    );
  let spot: Spot | null = null;
  const spacer = rowSpacer(event);
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
  for (
    let i = 0, offset = 0;
    !onSpacer && i < doc.childCount;
    offset += doc.child(i++).nodeSize
  ) {
    const node = doc.child(i);
    if (!isImage(node)) continue;
    const rect = imageRect(view, offset);
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
    if (y > imageRect(view, end - lastChild!.nodeSize).bottom)
      spot = { pos: end, side: -1 };
  }
  if (spot === null && isImage(firstChild) && y < imageRect(view, 0).top)
    spot = { pos: 0, side: 1 };
  if (spot === null) {
    let level = false;
    for (let i = 0, offset = 0; i < doc.childCount; offset += doc.child(i++).nodeSize) {
      const node = doc.child(i);
      const rect = imageRect(view, offset);
      if (!isImage(node)) {
        level ||= y >= rect.top && y <= rect.bottom;
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
  if (spot === null) return false;
  view.dispatch(
    view.state.tr
      .setSelection(new BlockRange(doc.resolve(spot.pos), undefined, spot.side))
      .setMeta("pointer", true),
  );
  return true;
}

/** Whether a pointer event is over the selection as drawn (where the browser starts dragging it). */
function onSelection(view: EditorView, event: MouseEvent) {
  const domSel = view.dom.ownerDocument.getSelection();
  if (!domSel?.rangeCount || domSel.isCollapsed) return false;
  const { clientX: x, clientY: y } = event;
  return Array.from(domSel.getRangeAt(0).getClientRects()).some(
    (rect) =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
  );
}

/** The pointer during a drag selection in the editor. */
const pointers = new WeakMap<EditorView, { x: number; y: number }>();

/** During a drag selection over an image, the side of it under the pointer. */
function dragOverImage(view: EditorView): Spot | null {
  const pointer = pointers.get(view);
  if (!pointer) return null;
  const hit = view.posAtCoords({ left: pointer.x, top: pointer.y });
  const node = hit && hit.inside >= 0 ? view.state.doc.nodeAt(hit.inside) : null;
  if (!hit || !node || !isImage(node)) return null;
  return spotBy(hit.inside, node, pointer.x, imageRect(view, hit.inside));
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

/** The drop position of dragged images while they are over the editor. */
const marks = new PluginKey<Spot | null>("imageMarks");

/**
 * The spacer drawn for a line break between rows of images: a block that ends
 * the row before it, as tall as `--image-row-gap`, so rows a line break apart
 * are further apart than a row that wraps and closer than rows a text line apart.
 */
function rowSpacerDOM() {
  const spacer = document.createElement("div");
  spacer.className = "image-row-break";
  return spacer;
}

/**
 * Draws the caret between blocks, the drop position and images inside a range
 * selection; places the caret on clicks and typing between blocks; moves
 * dragged images; copies selected images from copy / cut events.
 */
export function imagePlugin(
  copy: ImageOptions["copy"],
  stage: NonNullable<ImageOptions["stage"]> = () => {},
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
    // Follows the pointer through a drag selection: the primary button pressed
    // in the editor but not on an image (that drags the image). Listened to on
    // the window, so the drag is followed outside the editor too.
    view(view) {
      const win = view.dom.ownerDocument.defaultView!;
      const down = (event: MouseEvent) => {
        const target = event.target as Element;
        if (
          event.button !== 0 ||
          !view.dom.contains(target) ||
          target.closest(".image-item")
        )
          return;
        // A press inside the selection drags it (images with text lines move
        // as a whole, see dropMixed) instead of starting a new one.
        if (!view.state.selection.empty && onSelection(view, event)) return;
        pointers.set(view, { x: event.clientX, y: event.clientY });
      };
      // Bubbling to the window, this runs after ProseMirror's own mousemove
      // listener (on the document) has marked the drag as the browser's, so
      // ProseMirror syncs the DOM selection only on mouseup. Over an image the
      // DOM selection is drawn in the next animation frame instead (see
      // drawDragSelection).
      let frame = 0;
      let drawn = false;
      const move = (event: MouseEvent) => {
        if (!(event.buttons & 1)) {
          pointers.delete(view);
          drawn = false;
          return;
        }
        if (!pointers.has(view)) return;
        pointers.set(view, { x: event.clientX, y: event.clientY });
        // Over an image the browser's end stays in the nearest text line, often
        // without a selection change to read, so the range is set here.
        const head = dragOverImage(view);
        if (head === null) {
          // Off the image again, the browser's end takes over. It is moved
          // after this listener, but not if the browser deems the new end the
          // same as the drawn one (both ends of a final image are, so below it
          // the range would stay before it): the selection is first collapsed
          // to its anchor, which the browser then extends to the pointer.
          if (drawn) {
            drawn = false;
            const domSel = view.dom.ownerDocument.getSelection();
            const a = view.domAtPos(view.state.selection.anchor);
            domSel?.collapse(a.node, a.offset);
          }
          return;
        }
        const { doc, selection } = view.state;
        if (head.pos !== selection.head)
          view.dispatch(
            view.state.tr
              .setSelection(
                rangeSelection(doc, selection.anchor, head.pos, 1, head.side),
              )
              .setMeta("pointer", true),
          );
        if (!frame)
          frame = win.requestAnimationFrame(() => {
            frame = 0;
            if (!view.isDestroyed && dragOverImage(view) !== null) {
              drawDragSelection(view);
              drawn = true;
            }
          });
      };
      const up = () => {
        pointers.delete(view);
        drawn = false;
      };
      win.addEventListener("mousedown", down, true);
      win.addEventListener("mousemove", move);
      win.addEventListener("mouseup", up, true);
      return {
        destroy() {
          win.cancelAnimationFrame(frame);
          win.removeEventListener("mousedown", down, true);
          win.removeEventListener("mousemove", move);
          win.removeEventListener("mouseup", up, true);
          pointers.delete(view);
        },
      };
    },
    state: {
      init: () => null,
      apply(tr, drop) {
        const meta = tr.getMeta(marks);
        if (meta !== undefined) return meta;
        return drop && { pos: tr.mapping.map(drop.pos), side: drop.side };
      },
    },
    props: {
      decorations(state) {
        const { doc, selection } = state;
        const decorations: Decoration[] = [];
        // A caret between blocks is drawn on the image next to it at its full
        // height: the one before it if both are, except at the start of a row
        // after a line break.
        const caret = ({ pos, side }: Spot, kind: "gap" | "drop") => {
          const $pos = doc.resolve(pos);
          const before = $pos.nodeBefore;
          const after = $pos.nodeAfter;
          if (before && isImage(before) && !(rowBreak($pos) && side > 0))
            decorations.push(
              Decoration.node(pos - before.nodeSize, pos, {
                class: `${kind}-after`,
              }),
            );
          else if (after && isImage(after))
            decorations.push(
              Decoration.node(pos, pos + after.nodeSize, {
                class: `${kind}-before`,
              }),
            );
          else if (kind === "drop")
            decorations.push(
              Decoration.widget(
                pos,
                () => {
                  const line = document.createElement("div");
                  line.className = "drop-line";
                  return line;
                },
                { key: "drop-line" },
              ),
            );
        };
        if (selection instanceof BlockRange && selection.empty)
          caret({ pos: selection.head, side: selection.side }, "gap");
        const drop = marks.getState(state);
        if (drop) caret(drop, "drop");
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
      // decides instead, as for a click.
      createSelectionBetween: (view, $anchor, $head) => {
        const head = dragOverImage(view);
        if (head)
          return rangeSelection(
            view.state.doc,
            $anchor.pos,
            head.pos,
            1,
            head.side,
          );
        const sel = selectionBetween($anchor, $head);
        // The DOM cannot tell the two sides of a line break between rows
        // apart: the caret keeps the side it is on.
        const current = view.state.selection;
        return sel instanceof BlockRange &&
          sel.empty &&
          current instanceof BlockRange &&
          current.empty &&
          current.head === sel.head
          ? current
          : sel;
      },
      handleClickOn: (view, _pos, node, nodePos, event, direct) =>
        clickImage(view, node, nodePos, event, direct),
      handleTripleClickOn: (view, _pos, node, nodePos, event, direct) =>
        clickImage(view, node, nodePos, event, direct),
      handleClick: (view, _pos, event) => clickBesideImages(view, event),
      // The first click placed the caret; the second must not select a word
      // next to the image. The tile's own dblclick listener opens the preview.
      handleDoubleClickOn: (_view, _pos, node, _nodePos, _event, direct) =>
        direct && isImage(node),
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
   * start a new row (see `selectedImages`); `afterBrowser` when the browser
   * writes it too (copy events). Returns false when this is unavailable.
   */
  copy: (
    pictures: Picture[],
    rows: boolean[],
    afterBrowser: boolean,
  ) => boolean;
  /**
   * Keeps copies of the originals of images copied with text lines, for a
   * paste into another document; the clipboard itself is the browser's.
   */
  stage?: (pictures: Picture[]) => void;
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
      return {
        Backspace: () => run(removeNear(-1)),
        Delete: () => run(removeNear(1)),
        ArrowLeft: () => run(moveCaret(-1)),
        ArrowRight: () => run(moveCaret(1)),
        "Shift-ArrowLeft": () => run(extendByImage(-1)),
        "Shift-ArrowRight": () => run(extendByImage(1)),
        ArrowUp: () =>
          run(leaveImages(-1)) || enterImages(this.editor.view, -1),
        ArrowDown: () =>
          run(leaveImages(1)) || enterImages(this.editor.view, 1),
        "Mod-c": () => copyKey(this.editor.view, copy, false),
        "Mod-x": () => copyKey(this.editor.view, copy, true),
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
