import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { EditorContent, useEditor, type UseEditorOptions } from "@tiptap/react";
import { Fragment, Slice } from "@tiptap/pm/model";
import {
  NodeSelection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { extensions } from "./schema";
import { imageExtension } from "./image-view";
import {
  fromEditor,
  fromText,
  toEditor,
  type Diary,
  type Picture,
} from "../core/document";
export interface DiaryEditorHandle {
  reserveInsertion: () => {
    cancel: () => void;
    insert: (pictures: Picture[]) => void;
  };
  focus: () => void;
  undo: () => void;
  redo: () => void;
}
interface Props {
  /** Read only on mount; the parent remounts the editor (via `key`) to load another document. */
  initial: Diary;
  disabled: boolean;
  ref: Ref<DiaryEditorHandle>;
  onChange: (doc: Diary) => void;
  onSelection: (line: number, column: number) => void;
  onFiles: (files: File[]) => void;
  onPreview: (pic: Picture) => void;
}
// Files without a MIME type still go to Rust, which rejects anything that is not an image.
const imageFiles = (files: FileList | undefined) =>
  Array.from(files ?? []).filter(
    (file) => !file.type || file.type.startsWith("image/"),
  );

function DiaryEditor(props: Props) {
  // Handlers below are created once and read the latest callbacks through this ref,
  // so re-renders never hand Tiptap new options (which would call editor.setOptions).
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [options] = useState((): UseEditorOptions => ({
    extensions: extensions(
      imageExtension((pic) => latest.current.onPreview(pic)),
    ),
    content: toEditor(props.initial),
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
        const files = imageFiles(event.clipboardData?.files);
        if (files.length) {
          latest.current.onFiles(files);
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
        // Always consume drops: dropped HTML or text must not enter the document.
        const files = imageFiles(event.dataTransfer?.files);
        if (files.length) latest.current.onFiles(files);
        return true;
      },
    },
  }));
  const editor = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editable: !props.disabled,
    ...options,
    enableInputRules: false,
    enablePasteRules: false,
    onUpdate: ({ editor }) =>
      latest.current.onChange(fromEditor(editor.getJSON())),
    onSelectionUpdate: ({ editor }) => {
      const pos = editor.state.selection.$from;
      latest.current.onSelection(pos.index(0) + 1, pos.parentOffset + 1);
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
  useEffect(() => {
    // Changing editability is not a document edit and must not enqueue a save.
    editor.setEditable(!props.disabled, false);
  }, [editor, props.disabled]);
  function reserveInsertion() {
    let bookmark = editor.state.selection.getBookmark();
    const map = ({ transaction }: { transaction: Transaction }) => {
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
  useImperativeHandle(
    props.ref,
    () => ({
      reserveInsertion,
      focus: () => {
        editor.commands.focus();
      },
      undo: () => {
        editor.chain().focus().undo().run();
      },
      redo: () => {
        editor.chain().focus().redo().run();
      },
    }),
    [editor],
  );
  return (
    <div className={`editor-host${props.disabled ? " disabled" : ""}`}>
      <EditorContent editor={editor} />
    </div>
  );
}

// `initial` changes on every keystroke but is only read on mount, so it is
// excluded from the comparison; typing then no longer re-renders the editor.
export default memo(
  DiaryEditor,
  (prev, next) =>
    prev.disabled === next.disabled &&
    prev.ref === next.ref &&
    prev.onChange === next.onChange &&
    prev.onSelection === next.onSelection &&
    prev.onFiles === next.onFiles &&
    prev.onPreview === next.onPreview,
);
