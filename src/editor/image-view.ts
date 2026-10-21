import { Node } from "@tiptap/core";
import type { Node as PmNode, ResolvedPos, Slice } from "@tiptap/pm/model";
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
import type { Mappable } from "@tiptap/pm/transform";
import { dropPoint } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Picture } from "../core/document";

/**
 * A range whose ends may sit between blocks, so a run of images can be selected
 * without the text around it (a TextSelection must end inside a text line).
 *
 * Collapsed, it is the caret between blocks, which only stops next to an image
 * (see `caretSpot`): an image behaves like one big character on a line of its
 * own. That caret is drawn on the image at its full height (the plugin's
 * decorations), so the browser's own caret is hidden (`visible`).
 */
export class BlockRange extends Selection {
  constructor($anchor: ResolvedPos, $head: ResolvedPos = $anchor) {
    super($anchor, $head);
    this.visible = $anchor.pos !== $head.pos;
  }
  map(doc: PmNode, mapping: Mappable): Selection {
    return rangeSelection(
      doc,
      mapping.map(this.anchor),
      mapping.map(this.head),
    );
  }
  eq(other: Selection): boolean {
    return (
      other instanceof BlockRange &&
      other.anchor === this.anchor &&
      other.head === this.head
    );
  }
  toJSON() {
    return { type: "blockRange", anchor: this.anchor, head: this.head };
  }
  // The default bookmark would turn the range into a text selection when the
  // history or an insertion restores it.
  getBookmark() {
    return new RangeBookmark(this.anchor, this.head);
  }
}
class RangeBookmark {
  anchor: number;
  head: number;
  constructor(anchor: number, head: number) {
    this.anchor = anchor;
    this.head = head;
  }
  map(mapping: Mappable) {
    return new RangeBookmark(mapping.map(this.anchor), mapping.map(this.head));
  }
  resolve(doc: PmNode) {
    return rangeSelection(doc, this.anchor, this.head);
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

/** The position of a caret between blocks, or null for any other selection. */
const caretBetween = (state: EditorState) => {
  const sel = state.selection;
  return sel instanceof BlockRange && sel.empty ? sel.head : null;
};

/** The selection between two positions: a caret, a text range or a block range. */
export function rangeSelection(
  doc: PmNode,
  anchor: number,
  head: number,
  dir: -1 | 1 = 1,
): Selection {
  const $anchor = doc.resolve(anchor);
  const $head = doc.resolve(head);
  if (anchor === head) return caretAt(doc, head, dir);
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
 * A caret at `pos`: between blocks next to an image, otherwise the near end of
 * the text line next to it, on side `dir` if both sides are lines. Never a
 * selected image (typing would replace it).
 */
export function caretAt(doc: PmNode, pos: number, dir: -1 | 1): Selection {
  const $pos = doc.resolve(pos);
  if ($pos.parent.inlineContent) return new TextSelection($pos);
  if (caretSpot($pos)) return new BlockRange($pos);
  for (const side of [dir, -dir])
    if ((side > 0 ? $pos.nodeAfter : $pos.nodeBefore)?.isTextblock)
      return TextSelection.create(doc, pos + side);
  return Selection.near($pos, dir);
}

/** Deletes `from`..`to` and leaves the caret where the content was. */
export function removeRange(
  tr: Transaction,
  from: number,
  to: number,
  dir: -1 | 1,
) {
  tr.delete(from, to);
  return tr.setSelection(caretAt(tr.doc, from, dir));
}

/**
 * Typing at the caret between blocks: images never share a line, so the text
 * starts a new line there (an empty one for a composition, which then fills it).
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
 * Backspace / Delete. Selected images, or the image next to a caret between
 * blocks, go on their own. Next to an image a text line counts as a line break:
 * an empty one goes (the caret then sits by the image), a line with text stays
 * and the key does nothing. This holds for the caret at the start (Backspace) /
 * end (Delete) of a line beside an image and for the caret between blocks.
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
 * Left / Right step over an image as over one character. Stops: every text
 * position and every position between blocks next to an image; crossing from
 * one text line into the next is left to the browser (one step, no stop).
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
      if (!node) return true;
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

function picturesIn(sel: Selection): Picture[] | null {
  if (!(sel instanceof NodeSelection || sel instanceof BlockRange) || sel.empty)
    return null;
  const slice = sel.content();
  if (!isImageSlice(slice)) return null;
  const pictures: Picture[] = [];
  slice.content.forEach((node) => pictures.push(pictureOf(node)));
  return pictures;
}

/** The pictures of a selection made only of whole images (one, or a range of them); else null. */
export const selectedPictures = (state: EditorState) =>
  picturesIn(state.selection);

/**
 * Inserts imported or pasted images (one node each) at `tr`'s selection and
 * leaves the caret between blocks after the last of them; returns where they are.
 *
 * Selected images, or the caret between blocks: right there, inside the group
 * around it (the images join that group). Otherwise (a text selection) the
 * images take the place of an empty line the caret is on, go before / after a
 * line with the caret at its start / end, split it in the middle, or replace
 * selected text; they then start a group of their own: an image right before or
 * after them gets an empty line in between, as neighbouring images would merge
 * into one group. A second insertion at the caret left after them joins them.
 */
export function insertImages(
  tr: Transaction,
  nodes: PmNode[],
): { from: number; to: number } {
  const sel = tr.selection;
  let from = sel.to;
  if (!nodes.length) return { from, to: from };
  const size = nodes.reduce((sum, node) => sum + node.nodeSize, 0);
  if (picturesIn(sel) || (sel instanceof BlockRange && sel.empty)) {
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
    const blank = tr.doc.type.schema.nodes.paragraph.create();
    // The line after them first, so `from` stays put.
    if (isImage(tr.doc.resolve(from + size).nodeAfter))
      tr.insert(from + size, blank);
    if (isImage(tr.doc.resolve(from).nodeBefore)) {
      tr.insert(from, blank);
      from += blank.nodeSize;
    }
  }
  const to = from + size;
  tr.setSelection(new BlockRange(tr.doc.resolve(to)));
  return { from, to };
}

/**
 * HTML for copied images, as Rust's clipboard.rs writes it (there also with a
 * `file:` URL as `src`): what `clipboardImages` reads back.
 */
export function imagesHtml(pictures: Picture[]): string {
  return pictures
    .map((pic) => {
      const img = document.createElement("img");
      img.alt = pic.name;
      img.dataset.linehushId = pic.id;
      img.dataset.linehushName = pic.name;
      img.dataset.linehushWidth = String(pic.width);
      img.dataset.linehushHeight = String(pic.height);
      return img.outerHTML;
    })
    .join("");
}

/**
 * Images copied in LineHush, from the clipboard's HTML: pasted under the same
 * ids instead of being imported again. Null unless the HTML holds only such images.
 */
export function clipboardImages(html: string): Picture[] | null {
  if (!html.includes("data-linehush-id")) return null;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const images = Array.from(body.querySelectorAll("img"));
  if (
    !images.length ||
    body.textContent?.trim() ||
    images.some((img) => !/^[0-9a-f]{64}$/.test(img.dataset.linehushId ?? ""))
  )
    return null;
  return images.map((img) => ({
    id: img.dataset.linehushId!,
    name: img.dataset.linehushName ?? "",
    width: Number(img.dataset.linehushWidth) || 0,
    height: Number(img.dataset.linehushHeight) || 0,
  }));
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
  const pictures = selectedPictures(view.state);
  if (!pictures || !copy(pictures, false)) return false;
  if (cut && view.editable) removeSelected(view);
  return true;
}

/**
 * Copy / cut events (the context menu, or no desktop): the browser writes the
 * clipboard after this event, so it gets the images' HTML, enough to paste them
 * back in LineHush; Rust then replaces it with the full set of formats.
 */
function copyEvent(
  view: EditorView,
  event: ClipboardEvent,
  copy: ImageOptions["copy"],
  cut: boolean,
) {
  const pictures = selectedPictures(view.state);
  if (!pictures || !event.clipboardData) return false;
  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData("text/html", imagesHtml(pictures));
  copy(pictures, true);
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

const imageRect = (view: EditorView, pos: number) =>
  (view.nodeDOM(pos) as HTMLElement).getBoundingClientRect();

/**
 * Drop position for dragged images. Over an image the left or right half
 * decides; ProseMirror would use the upper or lower half.
 */
function dropAt(view: EditorView, event: DragEvent, slice: Slice) {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const doc = view.state.doc;
  const inside = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
  if (inside && isImage(inside))
    return imageSide(
      hit.inside,
      inside,
      event.clientX,
      imageRect(view, hit.inside),
    );
  return dropPoint(doc, hit.pos, slice);
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
  const side = imageSide(pos, node, event.clientX, imageRect(view, pos));
  view.dispatch(
    view.state.tr
      .setSelection(new BlockRange(view.state.doc.resolve(side)))
      .setMeta("pointer", true),
  );
  return true;
}

/**
 * A click beside images rather than on one. Level with a row of images (in a
 * gap, or the empty space left / right of the row) the caret goes to the near
 * side of the nearest image in that row; below a final image (above a first
 * one), to the document's end (start). Left to the browser, such a click would
 * put the caret in a neighbouring line, or ProseMirror's `Selection.near` would
 * select an image.
 */
function clickBesideImages(view: EditorView, event: MouseEvent) {
  if ((event.target as Element | null)?.closest?.("p")) return false;
  const { doc } = view.state;
  const { clientX: x, clientY: y } = event;
  let pos: number | null = null;
  let distance = Infinity;
  for (let i = 0, offset = 0; i < doc.childCount; offset += doc.child(i++).nodeSize) {
    const node = doc.child(i);
    if (!isImage(node)) continue;
    const rect = imageRect(view, offset);
    if (y < rect.top || y > rect.bottom) continue;
    const away = Math.max(rect.left - x, x - rect.right, 0);
    if (away < distance) {
      distance = away;
      pos = imageSide(offset, node, x, rect);
    }
  }
  const { firstChild, lastChild } = doc;
  if (pos === null && isImage(lastChild)) {
    const end = doc.content.size;
    if (y > imageRect(view, end - lastChild!.nodeSize).bottom) pos = end;
  }
  if (pos === null && isImage(firstChild) && y < imageRect(view, 0).top)
    pos = 0;
  if (pos === null) return false;
  view.dispatch(
    view.state.tr
      .setSelection(new BlockRange(doc.resolve(pos)))
      .setMeta("pointer", true),
  );
  return true;
}

/** The pointer during a drag selection in the editor. */
const pointers = new WeakMap<EditorView, { x: number; y: number }>();

/** During a drag selection over an image, the side of it under the pointer. */
function dragOverImage(view: EditorView) {
  const pointer = pointers.get(view);
  if (!pointer) return null;
  const hit = view.posAtCoords({ left: pointer.x, top: pointer.y });
  const node = hit && hit.inside >= 0 ? view.state.doc.nodeAt(hit.inside) : null;
  if (!hit || !node || !isImage(node)) return null;
  return imageSide(hit.inside, node, pointer.x, imageRect(view, hit.inside));
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

const marks = new PluginKey<number | null>("imageMarks");

/**
 * Draws the caret between blocks, the drop position and images inside a range
 * selection; places the caret on clicks and typing between blocks; moves
 * dragged images; copies selected images from copy / cut events.
 */
export function imagePlugin(copy: ImageOptions["copy"]) {
  const setDrop = (view: EditorView, pos: number | null) => {
    if (marks.getState(view.state) !== pos)
      view.dispatch(view.state.tr.setMeta(marks, pos));
  };
  // A composition must happen in a text line: one is made at the caret before
  // the input method writes anything, and the DOM selection moves into it (as
  // prosemirror-gapcursor does for its gap cursor).
  const lineForComposition = (view: EditorView) => {
    if (caretBetween(view.state) !== null)
      typeBetween("")(view.state, view.dispatch);
  };
  return new Plugin<number | null>({
    key: marks,
    // Follows the pointer through a drag selection: the primary button pressed
    // in the editor but not on an image (that drags the image). Listened to on
    // the window, so the drag is followed outside the editor too.
    view(view) {
      const win = view.dom.ownerDocument.defaultView!;
      const down = (event: MouseEvent) => {
        const target = event.target as Element;
        if (
          event.button === 0 &&
          view.dom.contains(target) &&
          !target.closest(".image-item")
        )
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
        if (head !== selection.head)
          view.dispatch(
            view.state.tr
              .setSelection(rangeSelection(doc, selection.anchor, head))
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
        return drop === null ? null : tr.mapping.map(drop);
      },
    },
    props: {
      decorations(state) {
        const { doc, selection } = state;
        const decorations: Decoration[] = [];
        // A caret between blocks is drawn on the image next to it (the one
        // before it if both are), at its full height.
        const caret = (pos: number, kind: "gap" | "drop") => {
          const $pos = doc.resolve(pos);
          const before = $pos.nodeBefore;
          const after = $pos.nodeAfter;
          if (before && isImage(before))
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
        const between = caretBetween(state);
        if (between !== null) caret(between, "gap");
        const drop = marks.getState(state);
        if (drop != null) caret(drop, "drop");
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
        return head === null
          ? selectionBetween($anchor, $head)
          : rangeSelection(view.state.doc, $anchor.pos, head);
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
        copy: (view, event) => copyEvent(view, event, copy, false),
        cut: (view, event) => copyEvent(view, event, copy, true),
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
          setDrop(
            view,
            slice && isImageSlice(slice) ? dropAt(view, event, slice) : null,
          );
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
        // Runs before ProseMirror clears `view.dragging`. Only images move inside
        // the document; dragged text stays put, and external drops (files) go on
        // to the editor's handleDrop.
        drop(view, event) {
          const dragging = view.dragging as
            | (NonNullable<EditorView["dragging"]> & { node?: NodeSelection })
            | null;
          if (!dragging) return false;
          setDrop(view, null);
          event.preventDefault();
          const { slice } = dragging;
          const target = isImageSlice(slice)
            ? dropAt(view, event, slice)
            : null;
          if (target === null) return true;
          const tr = view.state.tr;
          // Ctrl copies, as in ProseMirror's own drop on Windows.
          if (!event.ctrlKey) {
            if (dragging.node) dragging.node.replace(tr);
            else tr.deleteSelection();
          }
          const pos = tr.mapping.map(target);
          tr.insert(pos, slice.content);
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

export interface ImageOptions {
  /** Opens the original (double click). */
  preview: (pic: Picture) => void;
  /** A Blob URL of the picture's thumbnail, which the image revokes when it goes. */
  source: (pic: Picture) => Promise<string>;
  /**
   * Puts the originals on the system clipboard; `afterBrowser` when the browser
   * writes it too (copy events). Returns false when this is unavailable.
   */
  copy: (pictures: Picture[], afterBrowser: boolean) => boolean;
}

/**
 * One picture per node. Neighbouring image nodes form an image group: CSS lays
 * them out in wrapping rows, and the document model merges them into one
 * `images` block, so the file format does not change.
 */
export function image({ preview, source, copy }: ImageOptions) {
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
    addProseMirrorPlugins: () => [imagePlugin(copy)],
    addNodeView() {
      return ({ node }) => {
        const pic = pictureOf(node);
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
