<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { Editor, EditorContent } from "@tiptap/vue-3";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { extensions } from "../editor/schema";
import { imageExtension } from "../editor/image-view";
import {
  fromEditor,
  fromText,
  toEditor,
  type Diary,
  type Picture,
} from "../document";
const props = defineProps<{ initial: Diary; disabled?: boolean }>();
const emit = defineEmits<{
  change: [doc: Diary];
  selection: [line: number, column: number];
  files: [files: File[]];
  preview: [pic: Picture];
}>();
const editor = new Editor({
  extensions: extensions(imageExtension((pic) => emit("preview", pic))),
  content: toEditor(props.initial),
  enableInputRules: false,
  enablePasteRules: false,
  editorProps: {
    attributes: {
      role: "textbox",
      "aria-label": "日记正文",
      "aria-multiline": "true",
      spellcheck: "false",
    },
    clipboardTextSerializer: (slice) =>
      slice.content.textBetween(0, slice.content.size, "\n", "[图片]"),
    handlePaste(view, event) {
      const files = Array.from(event.clipboardData?.files ?? []).filter(
        (file) => file.type.startsWith("image/"),
      );
      if (files.length) {
        emit("files", files);
        return true;
      }
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return true;
      const nodes = fromText(text).blocks.map((block) =>
        view.state.schema.nodes.paragraph.create(
          null,
          block.type === "line" && block.text
            ? view.state.schema.text(block.text)
            : null,
        ),
      );
      view.dispatch(
        view.state.tr
          .replaceSelection(new Slice(Fragment.from(nodes), 1, 1))
          .scrollIntoView(),
      );
      return true;
    },
    handleDrop(_view, event) {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) emit("files", files);
      return true;
    },
  },
  onUpdate: ({ editor }) => emit("change", fromEditor(editor.getJSON())),
  onSelectionUpdate: ({ editor }) => {
    const pos = editor.state.selection.$from;
    emit("selection", pos.index(0) + 1, pos.parentOffset + 1);
  },
});
function insertImages(images: Picture[]) {
  const { state, view } = editor;
  const tr = closeHistory(state.tr);
  if (
    state.selection instanceof NodeSelection &&
    state.selection.node.type.name === "imageGroup"
  ) {
    tr.setNodeMarkup(state.selection.from, undefined, {
      images: [...state.selection.node.attrs.images, ...images],
    });
  } else if (
    state.selection.empty &&
    state.selection.$from.parent.type.name === "paragraph" &&
    !state.selection.$from.parent.content.size &&
    state.doc.childCount > 1
  ) {
    // Existing blank lines are content. Insert after one instead of consuming it.
    tr.insert(
      state.selection.$from.after(),
      state.schema.nodes.imageGroup.create({ images }),
    );
  } else
    tr.replaceSelectionWith(state.schema.nodes.imageGroup.create({ images }));
  if (tr.doc.lastChild?.type.name === "imageGroup")
    tr.insert(tr.doc.content.size, state.schema.nodes.paragraph.create());
  tr.setSelection(
    TextSelection.near(
      tr.doc.resolve(Math.min(tr.selection.to, tr.doc.content.size)),
      1,
    ),
  );
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
onBeforeUnmount(() => editor.destroy());
watch(
  () => props.disabled,
  (value) => editor.setEditable(!value),
);
function reserveInsertion() {
  let bookmark = editor.state.selection.getBookmark();
  const map = ({
    transaction,
  }: {
    transaction: import("@tiptap/pm/state").Transaction;
  }) => {
    bookmark = bookmark.map(transaction.mapping);
  };
  editor.on("transaction", map);
  return {
    cancel: () => editor.off("transaction", map),
    insert: (pictures: Picture[]) => {
      editor.off("transaction", map);
      editor.view.dispatch(
        editor.state.tr.setSelection(bookmark.resolve(editor.state.doc)),
      );
      insertImages(pictures);
    },
  };
}
defineExpose({
  editor,
  reserveInsertion,
  insertImages,
  focus: () => editor.commands.focus(),
  undo: () => editor.chain().focus().undo().run(),
  redo: () => editor.chain().focus().redo().run(),
});
</script>
<template>
  <div class="editor-host" :class="{ disabled }">
    <EditorContent :editor="editor" />
  </div>
</template>
