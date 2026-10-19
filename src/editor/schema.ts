import { Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo, Gapcursor } from "@tiptap/extensions";
import { NodeSelection, TextSelection, type Selection } from "@tiptap/pm/state";
import {
  BlockRange,
  image,
  removeRange,
  type ImageOptions,
} from "./image-view";

const PlainKeys = Extension.create({
  name: "plainKeys",
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => this.editor.commands.enter(),
      Tab: () => this.editor.commands.insertContent("\t"),
      Enter: () => {
        if (this.editor.view.composing) return false;
        const { state, view } = this.editor;
        const tr = state.tr;
        let sel = tr.selection;
        const inLine = (s: Selection) =>
          s.$from.parent.type.name === "paragraph";
        if (
          sel instanceof BlockRange ||
          (!sel.empty && !(sel instanceof NodeSelection) && !inLine(sel))
        ) {
          // A range that starts or ends between blocks (images, or everything) is replaced by the new line.
          sel = removeRange(tr, sel.from, sel.to, -1).selection;
        } else if (inLine(sel)) return false;
        if (inLine(sel)) tr.split(sel.from);
        else {
          // A selected image or a gap cursor: a new empty line after it, which splits a row of images.
          const pos = sel.to;
          tr.insert(pos, state.schema.nodes.paragraph.create());
          tr.setSelection(TextSelection.create(tr.doc, pos + 1));
        }
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
});
export function extensions(images: ImageOptions) {
  return [
    Document,
    Paragraph.extend({ content: "text*", marks: "", whitespace: "pre" }),
    Text,
    UndoRedo.configure({ depth: 300 }),
    Gapcursor,
    // Paragraph must stay the first block type (the default for new lines and the
    // gap cursor). Later extensions get keys first, so the image keys (Up / Down)
    // run before the gap cursor's.
    image(images),
    PlainKeys,
  ];
}
