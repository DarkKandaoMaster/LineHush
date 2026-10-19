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
import { closeHistory, redo, undo } from "@tiptap/pm/history";
import { extensions } from "./schema";
import { BlockRange, clipboardImages, selectedPictures } from "./image-view";
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
  /** `fromClipboard`: pasted, possibly the files of a LineHush copy. */
  onFiles: (files: File[], fromClipboard?: boolean) => void;
  /** Images copied in LineHush, pasted under the same ids. */
  onImages: (pictures: Picture[]) => void;
  /** See ImageOptions.copy. */
  onCopy: (pictures: Picture[], afterBrowser: boolean) => boolean;
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
    extensions: extensions({
      preview: (pic) => latest.current.onPreview(pic),
      copy: (pictures, afterBrowser) =>
        latest.current.onCopy(pictures, afterBrowser),
    }),
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
      handleDOMEvents: {
        // Undo / redo are bound here as well as in UndoRedo's keymap, by the
        // letter or, when an input method reports the key as "Process", by its
        // position. This handler runs before ProseMirror's composition check,
        // which can hold back the keymap; Ctrl+Z still worked then (the browser's
        // own undo reaches the history as a beforeinput event) but Ctrl+Y did
        // not, as the browser never had anything to redo.
        keydown(view, event) {
          if (
            !event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.isComposing ||
            !view.editable
          )
            return false;
          const letter = /^[a-z]$/i.test(event.key)
            ? event.key.toLowerCase()
            : ({ KeyZ: "z", KeyY: "y" } as Record<string, string>)[event.code];
          const command =
            (letter === "y" && !event.shiftKey) ||
            (letter === "z" && event.shiftKey)
              ? redo
              : letter === "z"
                ? undo
                : null;
          if (!command) return false;
          event.preventDefault();
          command(view.state, view.dispatch);
          return true;
        },
      },
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data) return true;
        // Copied in LineHush: the same images, not imported again. WebView2 hides
        // the HTML when there are files too (a copy from Rust), so those are
        // recognised in onFiles; this covers HTML without files.
        const pictures = clipboardImages(data.getData("text/html"));
        if (pictures) {
          latest.current.onImages(pictures);
          return true;
        }
        const files = imageFiles(data.files);
        if (files.length) {
          latest.current.onFiles(files, true);
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
        if (selectedPictures(state)) {
          // After the selected image(s), inside their group.
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
        // The new images end up selected, so a second paste follows them and
        // Ctrl+C / Delete act on them.
        tr.setSelection(
          nodes.length === 1
            ? NodeSelection.create(tr.doc, at)
            : new BlockRange(tr.doc.resolve(at), tr.doc.resolve(end)),
        );
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
    prev.onImages === next.onImages &&
    prev.onCopy === next.onCopy &&
    prev.onPreview === next.onPreview,
);
