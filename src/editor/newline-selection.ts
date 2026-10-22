import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Like Notepad / VS Code, a selected line break shows as a small block in the
 * selection colour after the line's text. The browser draws nothing for it
 * when the selection starts at the end of the line (e.g. "我|" to the start of
 * the next line), so the line gets a class (.newline-selected) and CSS draws
 * the block with ::after. A node decoration only changes the paragraph's
 * class attribute, nothing inside the editable content.
 */
export const newlineSelectionKey = new PluginKey<DecorationSet>("newlineSelection");

/**
 * Positions of the top-level paragraphs whose line break is inside the
 * selection: the paragraph at p of size n ends with a line break between
 * p + n - 1 and p + n, which is selected when from <= p + n - 1 and to >= p + n.
 * The last block of the document has no line break after it.
 */
export function selectedNewlines(doc: PmNode, selection: Selection): number[] {
  const { from, to, empty } = selection;
  if (empty) return [];
  const out: number[] = [];
  const last = doc.childCount - 1;
  doc.nodesBetween(from, to, (node, pos, _parent, index) => {
    const end = pos + node.nodeSize;
    if (node.type.name === "paragraph" && index < last && from <= end - 1 && to >= end)
      out.push(pos);
    return false;
  });
  return out;
}

export const NewlineSelection = Extension.create({
  name: "newlineSelection",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: newlineSelectionKey,
        props: {
          decorations(state) {
            const lines = selectedNewlines(state.doc, state.selection);
            if (!lines.length) return null;
            return DecorationSet.create(
              state.doc,
              lines.map((pos) =>
                Decoration.node(pos, pos + state.doc.nodeAt(pos)!.nodeSize, {
                  class: "newline-selected",
                }),
              ),
            );
          },
        },
      }),
    ];
  },
});
