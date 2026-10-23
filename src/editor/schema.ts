import { Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
// With the extension, as the Node tests load this file directly.
import {
  enterKey,
  image,
  typeBetween,
  type ImageOptions,
} from "./image-view.ts";
import { DrawnCaret } from "./caret.ts";
import { NewlineSelection } from "./newline-selection.ts";
import { Reveal } from "./reveal.ts";

const PlainKeys = Extension.create({
  name: "plainKeys",
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => this.editor.commands.enter(),
      Tab: () => {
        const { state, view } = this.editor;
        return (
          typeBetween("\t")(state, view.dispatch) ||
          this.editor.commands.insertContent("\t")
        );
      },
      // Outside a text line: a line break between images (a new row), an
      // empty line next to a text line (see image-view's enterKey).
      Enter: () => {
        const { state, view } = this.editor;
        return enterKey(state, view.dispatch, view);
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
    // Paragraph must stay the first block type (the default for new lines).
    // Later extensions get keys first. There is no gap cursor extension: the
    // caret between blocks is image-view's collapsed BlockRange.
    image(images),
    PlainKeys,
    NewlineSelection,
    // Scrolling to the caret (safe zone) and PageUp / PageDown.
    Reveal,
    // The caret and the text selection, drawn by the editor (caret.ts).
    DrawnCaret,
  ];
}
