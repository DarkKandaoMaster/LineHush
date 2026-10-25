import { Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import type { EditorView } from "@tiptap/pm/view";
// With the extension, as the Node tests load this file directly.
import {
  enterKey,
  image,
  typeBetween,
  type ImageOptions,
} from "./image-view.ts";
import { DrawnCaret } from "./caret.ts";
import { FindHighlight } from "./find.ts";
import { InputSource } from "./input.ts";
import { MarginSelect } from "./margin.ts";
import { Reveal } from "./reveal.ts";

/**
 * A plain Enter through the keymaps (image-view's enterKey, then the core
 * one), each dispatching its own transaction. Not `commands.enter()`: that
 * keeps only Enter's steps and maps the old selection, so the caret could end
 * up elsewhere (on the wrong side of a new row of images, say).
 */
function enter(view: EditorView) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
}

const PlainKeys = Extension.create({
  name: "plainKeys",
  addKeyboardShortcuts() {
    return {
      // Exactly as Enter (Ctrl+Enter would otherwise reach the core keymap's
      // exitCode and do nothing here).
      "Shift-Enter": () => enter(this.editor.view),
      "Mod-Enter": () => enter(this.editor.view),
      "Mod-Shift-Enter": () => enter(this.editor.view),
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
    // Where selection changes come from (input.ts), read by the two below.
    InputSource,
    // Scrolling to the caret (safe zone) and PageUp / PageDown.
    Reveal,
    // The caret and the text selection, drawn by the editor (caret.ts).
    DrawnCaret,
    // 左栏选行（margin.ts）。
    MarginSelect,
    // 查找 / 替换的匹配高亮（find.ts）。
    FindHighlight,
  ];
}
