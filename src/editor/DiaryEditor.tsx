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
import { Fragment, Slice, type Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { extensions } from "./schema";
import { caretAt } from "./image-view";
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
}
interface Props {
  /** Read only on mount; the parent remounts the editor (via `key`) to load another document. */
  initial: Diary;
  disabled: boolean;
  ref: Ref<DiaryEditorHandle>;
  onChange: (doc: Diary) => void;
  onSelection: (position: { line: number; column: number }) => void;
  onFiles: (files: File[]) => void;
  onPreview: (pic: Picture) => void;
}
/** Status bar line of top-level node `index`: a run of images is one line, as in the file. */
function lineOf(doc: PmNode, index: number) {
  let line = 0;
  for (let i = 0; i <= index && i < doc.childCount; i++)
    if (
      doc.child(i).type.name !== "image" ||
      doc.maybeChild(i - 1)?.type.name !== "image"
    )
      line++;
  return Math.max(line, 1);
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
    extensions: extensions((pic) => latest.current.onPreview(pic)),
    content: toEditor(props.initial),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "日记正文",
        "aria-multiline": "true",
        spellcheck: "false",
      },
      // One line per text line or run of images, like the TXT export.
      clipboardTextSerializer: (slice) => {
        const lines: string[] = [];
        let images = false;
        slice.content.forEach((node) => {
          const image = node.type.name === "image";
          if (image && images) lines[lines.length - 1] += " [图片]";
          else lines.push(image ? "[图片]" : node.textContent);
          images = image;
        });
        return lines.join("\n");
      },
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data) return true;
        const files = imageFiles(data.files);
        if (files.length) {
          latest.current.onFiles(files);
          return true;
        }
        const nodes = fromText(data.getData("text/plain")).blocks.map((block) =>
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
    onUpdate: ({ editor }) =>
      latest.current.onChange(fromEditor(editor.getJSON())),
    onSelectionUpdate: ({ editor }) => {
      const pos = editor.state.selection.$from;
      latest.current.onSelection({
        line: lineOf(editor.state.doc, pos.index(0)),
        // Between or on images there is no column.
        column: pos.parent.inlineContent ? pos.parentOffset + 1 : 1,
      });
    },
  });
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
        const { state, view } = editor;
        const tr = closeHistory(state.tr);
        const image = state.schema.nodes.image;
        // Each picture is its own node; neighbouring images make up one group.
        const nodes = pictures.map((pic) => image.create(pic));
        let at = state.selection.to;
        if (
          state.selection instanceof NodeSelection &&
          state.selection.node.type === image
        ) {
          // After the selected image, inside its group.
          tr.insert(at, nodes);
        } else if (
          state.selection.empty &&
          state.selection.$from.parent.type.name === "paragraph" &&
          !state.selection.$from.parent.content.size &&
          state.doc.childCount > 1
        ) {
          // Existing blank lines are content. Insert after one instead of consuming it.
          at = state.selection.$from.after();
          tr.insert(at, nodes);
        } else {
          // replaceSelectionWith places a block next to a line instead of splitting it
          // at either end; the other pictures follow the first one.
          tr.replaceSelectionWith(nodes[0]);
          tr.doc.forEach((node, offset) => {
            if (node === nodes[0]) at = offset;
          });
          tr.insert(at + nodes[0].nodeSize, nodes.slice(1));
        }
        const end = at + nodes.reduce((size, node) => size + node.nodeSize, 0);
        if (tr.doc.lastChild?.type === image)
          tr.insert(tr.doc.content.size, state.schema.nodes.paragraph.create());
        // The caret goes right after the new images (a gap cursor if more images follow).
        tr.setSelection(caretAt(tr.doc, end, 1));
        view.dispatch(tr.scrollIntoView());
        view.focus();
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
