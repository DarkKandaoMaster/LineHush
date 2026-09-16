import { Node, Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo, Gapcursor } from "@tiptap/extensions";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { Picture } from "../document";

export const ImageGroup = Node.create({
  name: "imageGroup",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({ images: { default: [] } }),
  parseHTML: () => [],
  renderHTML: () => ["div", { "data-image-group": "" }],
});
// An empty paragraph is a real line and must stop image merging.
export const MergeImages = Extension.create({
  name: "mergeImages",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const tr = state.tr;
          let previous: { pos: number; images: Picture[] } | undefined;
          state.doc.forEach((node, pos) => {
            if (node.type.name !== "imageGroup") {
              previous = undefined;
              return;
            }
            if (previous) {
              previous.images = [...previous.images, ...node.attrs.images];
              tr.setNodeMarkup(tr.mapping.map(previous.pos), undefined, {
                images: previous.images,
              });
              tr.delete(
                tr.mapping.map(pos),
                tr.mapping.map(pos + node.nodeSize),
              );
            } else previous = { pos, images: node.attrs.images };
          });
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});
const PlainKeys = Extension.create({
  name: "plainKeys",
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => this.editor.commands.enter(),
      Tab: () => this.editor.commands.insertContent("\t"),
      Enter: () => {
        if (this.editor.view.composing) return false;
        const { state, view } = this.editor;
        if (state.selection.$from.parent.type.name === "paragraph")
          return false;
        const pos = state.selection.to;
        const tr = state.tr.insert(pos, state.schema.nodes.paragraph.create());
        view.dispatch(
          tr
            .setSelection(TextSelection.create(tr.doc, pos + 1))
            .scrollIntoView(),
        );
        return true;
      },
    };
  },
});
export function extensions(image = ImageGroup) {
  return [
    Document,
    Paragraph.extend({ content: "text*", marks: "", whitespace: "pre" }),
    Text,
    image,
    UndoRedo.configure({ depth: 300 }),
    Gapcursor,
    PlainKeys,
    MergeImages,
  ];
}
