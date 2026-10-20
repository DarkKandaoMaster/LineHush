import { Node, type Editor } from "@tiptap/core";
import type { Node as PmNode, ResolvedPos, Slice } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { dropPoint } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Picture } from "../core/document";

/**
 * A range whose ends may sit between blocks, so a run of images can be selected
 * without the text around it (a TextSelection must end inside a text line).
 */
export class BlockRange extends Selection {
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
 * Whether a gap cursor may sit at `$pos`: between blocks, with an image or the
 * document edge on both sides (what `GapCursor.valid`, which is internal, says
 * for this schema).
 */
const gapAt = ($pos: ResolvedPos) =>
  $pos.depth === 0 &&
  !!($pos.nodeBefore || $pos.nodeAfter) &&
  !$pos.nodeBefore?.isTextblock &&
  !$pos.nodeAfter?.isTextblock;

/** The selection between two positions: a gap cursor, a text range or a block range. */
function rangeSelection(
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
 * A caret at `pos`: a gap cursor between images, otherwise the near end of the
 * text line next to it, on side `dir` if both sides are lines. Never a selected
 * image (typing would replace it) and never a line beyond an image.
 */
export function caretAt(doc: PmNode, pos: number, dir: -1 | 1): Selection {
  const $pos = doc.resolve(pos);
  if ($pos.parent.inlineContent) return new TextSelection($pos);
  if (gapAt($pos)) return new GapCursor($pos);
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

/** Backspace / Delete on selected images, or next to a gap cursor, removes just those images. */
function removeImages(editor: Editor, dir: -1 | 1): boolean {
  const { state, view } = editor;
  const sel = state.selection;
  let from: number;
  let to: number;
  if (imageAt(state) || (sel instanceof BlockRange && !sel.empty)) {
    ({ from, to } = sel);
  } else if (sel instanceof GapCursor) {
    // Both sides of a gap cursor are images or the document edge.
    const node = dir < 0 ? sel.$head.nodeBefore : sel.$head.nodeAfter;
    if (!node) return true;
    from = dir < 0 ? sel.head - node.nodeSize : sel.head;
    to = from + node.nodeSize;
  } else return false;
  view.dispatch(removeRange(state.tr, from, to, dir).scrollIntoView());
  return true;
}

/** Shift+Left / Shift+Right extend the selection by one whole image. */
function extendByImage(editor: Editor, dir: -1 | 1): boolean {
  const { state, view } = editor;
  const sel = state.selection;
  let anchor = sel.anchor;
  let head = sel.head;
  if (imageAt(state)) {
    // Keep the selected image inside the range whichever way it grows.
    anchor = dir > 0 ? sel.from : sel.to;
    head = dir > 0 ? sel.to : sel.from;
  } else if (
    !(sel instanceof GapCursor) &&
    !(sel instanceof BlockRange) &&
    !(sel instanceof TextSelection)
  )
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
  view.dispatch(
    state.tr
      .setSelection(rangeSelection(doc, anchor, next, dir))
      .scrollIntoView(),
  );
  return true;
}

/**
 * Up / Down from a selected image or a gap cursor leave the whole run of images,
 * which is laid out as rows, instead of walking it image by image.
 */
function leaveImages(editor: Editor, dir: -1 | 1): boolean {
  const { state, view } = editor;
  const sel = state.selection;
  if (!imageAt(state) && !(sel instanceof GapCursor)) return false;
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
  view.dispatch(
    state.tr
      .setSelection(
        line ? TextSelection.create(doc, pos + dir) : new GapCursor($pos),
      )
      .scrollIntoView(),
  );
  return true;
}

/**
 * Up / Down from a text line into the run of images right above / below it:
 * from the line's first / last visual line, select the nearest image (the last
 * of the run above, the first of the run below).
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
function enterImages(editor: Editor, dir: -1 | 1): boolean {
  const { view } = editor;
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
      .setSelection(
        NodeSelection.create(
          view.state.doc,
          dir < 0 ? edge - neighbour.nodeSize : edge,
        ),
      )
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

/** The pictures of a selection made only of whole images (one, or a range of them); else null. */
export function selectedPictures(state: EditorState): Picture[] | null {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection || sel instanceof BlockRange) || sel.empty)
    return null;
  const slice = sel.content();
  if (!isImageSlice(slice)) return null;
  const pictures: Picture[] = [];
  slice.content.forEach((node) => pictures.push(pictureOf(node)));
  return pictures;
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
 * Drop position for dragged images. Images flow in rows, so over an image the
 * left or right half decides; ProseMirror would use the upper or lower half.
 */
function dropAt(view: EditorView, event: DragEvent, slice: Slice) {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const doc = view.state.doc;
  const inside = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
  if (inside && isImage(inside)) {
    const rect = (
      view.nodeDOM(hit.inside) as HTMLElement
    ).getBoundingClientRect();
    return event.clientX < (rect.left + rect.right) / 2
      ? hit.inside
      : hit.inside + inside.nodeSize;
  }
  return dropPoint(doc, hit.pos, slice);
}

const marks = new PluginKey<number | null>("imageMarks");

/**
 * Draws the gap cursor, the drop position and images inside a range selection;
 * moves dragged images; copies selected images from copy / cut events.
 */
function imagePlugin(copy: ImageOptions["copy"]) {
  const setDrop = (view: EditorView, pos: number | null) => {
    if (marks.getState(view.state) !== pos)
      view.dispatch(view.state.tr.setMeta(marks, pos));
  };
  return new Plugin<number | null>({
    key: marks,
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
        // A caret between images is drawn on the image next to it, at its full height.
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
        if (selection instanceof GapCursor) caret(selection.head, "gap");
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
      handleDOMEvents: {
        copy: (view, event) => copyEvent(view, event, copy, false),
        cut: (view, event) => copyEvent(view, event, copy, true),
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
          const end = pos + slice.content.size;
          tr.setSelection(
            slice.content.childCount === 1
              ? NodeSelection.create(tr.doc, pos)
              : rangeSelection(tr.doc, pos, end),
          );
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
      return {
        Backspace: () => removeImages(this.editor, -1),
        Delete: () => removeImages(this.editor, 1),
        "Shift-ArrowLeft": () => extendByImage(this.editor, -1),
        "Shift-ArrowRight": () => extendByImage(this.editor, 1),
        ArrowUp: () =>
          leaveImages(this.editor, -1) || enterImages(this.editor, -1),
        ArrowDown: () =>
          leaveImages(this.editor, 1) || enterImages(this.editor, 1),
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
        // A single click selects this node through ProseMirror's own atom handling.
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
