import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  EditorContent,
  useEditor,
  type Editor,
  type UseEditorOptions,
} from "@tiptap/react";
import { Fragment, Slice, type Node as PmNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { closeHistory, redo, undo } from "@tiptap/pm/history";
import { extensions } from "./schema";
import {
  BLOCKS_MIME,
  blockNodes,
  blockPictures,
  clipboardBlocks,
  insertBlocks,
  insertImages,
  lineOf,
} from "./image-view";
import {
  PLACEHOLDER,
  fromEditor,
  fromText,
  kindOf,
  toEditor,
  type Block,
  type Diary,
  type Picture,
} from "../core/document";
import { letterOf } from "../core/keys";
import { isMediaFile } from "../core/media-probe";
import { imageUrl, mediaUrl } from "../core/native";
export interface DiaryEditorHandle {
  reserveInsertion: () => {
    cancel: () => void;
    /** `rows`: which pictures start a new row (a paste of copied rows). */
    insert: (pictures: Picture[], rows: boolean[]) => void;
    /** Pasted lines and images (see `insertBlocks`). */
    insertBlocks: (blocks: Block[]) => void;
  };
  focus: () => void;
  /** 查找 / 替换（hooks/useFind.ts）直接读写编辑器状态。随编辑器重建（换文档）而换。 */
  editor: Editor;
}
interface Props {
  /** The tab whose document this is; thumbnails are read from it. Fixed for the editor's lifetime. */
  tab: string;
  /** Read only on mount; the parent remounts the editor (via `key`) to load another document. */
  initial: Diary;
  disabled: boolean;
  ref: Ref<DiaryEditorHandle>;
  onChange: (doc: Diary) => void;
  onSelection: (position: { line: number; column: number }) => void;
  images: EditorImages;
  onPreview: (pic: Picture) => void;
}
/** What the editor hands to the tab for images (useImageImport). */
export interface EditorImages {
  /** Dropped or pasted files; `fromClipboard`: pasted, possibly the files of a LineHush copy. */
  importFiles: (files: File[], fromClipboard?: boolean) => void;
  /**
   * Images with text lines copied in LineHush, some of whose images this
   * document may not hold yet (copied from another one).
   */
  pasteBlocks: (blocks: Block[]) => void;
  /** See ImageOptions.copy. */
  copy: (pictures: Picture[], rows: boolean[]) => void;
  /** See ImageOptions.stage. */
  stage: (pictures: Picture[]) => void;
}
// Images, videos and recordings (by MIME type or extension). Files without a
// MIME type still go to Rust, which rejects anything that is not an image.
const imageFiles = (files: FileList | undefined) =>
  Array.from(files ?? []).filter(
    (file) =>
      !file.type || file.type.startsWith("image/") || isMediaFile(file),
  );

function DiaryEditor(props: Props) {
  // Handlers below are created once and read the latest callbacks through this ref,
  // so re-renders never hand Tiptap new options (which would call editor.setOptions).
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  // Every image this editor has shown: the tab's document holds their
  // originals (unreferenced ones go only when the document is left, which
  // remounts the editor), so pasting them needs nothing from Rust.
  const [known] = useState(
    () => new Set(blockPictures(props.initial.blocks).map((pic) => pic.id)),
  );
  const remember = (doc: PmNode) =>
    doc.forEach((node) => {
      if (node.type.name === "image") known.add(node.attrs.id);
    });
  const [options] = useState((): UseEditorOptions => ({
    extensions: extensions({
      preview: (pic) => latest.current.onPreview(pic),
      source: (pic) => imageUrl(latest.current.tab, pic),
      media: (pic) => mediaUrl(latest.current.tab, pic.id),
      copy: (pictures, rows) => latest.current.images.copy(pictures, rows),
      stage: (pictures) => latest.current.images.stage(pictures),
    }),
    content: toEditor(props.initial),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "笔记正文",
        "aria-multiline": "true",
        spellcheck: "false",
      },
      // One line per text line or row of images, like the TXT export.
      clipboardTextSerializer: (slice) => {
        const lines: string[] = [];
        let images = false;
        slice.content.forEach((node: PmNode) => {
          const image = node.type.name === "image";
          const text = image
            ? `[${PLACEHOLDER[kindOf(node.attrs)]}]`
            : node.textContent;
          if (image && images && !node.attrs.newline)
            lines[lines.length - 1] += ` ${text}`;
          else lines.push(text);
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
          if (!event.ctrlKey || event.altKey || event.isComposing || !view.editable)
            return false;
          const letter = letterOf(event);
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
        // Images with text lines copied in LineHush. With all the images known
        // here (the same document) they go in at once.
        const blocks = clipboardBlocks(data.getData(BLOCKS_MIME));
        if (blocks) {
          remember(view.state.doc);
          if (blockPictures(blocks).every((pic) => known.has(pic.id)))
            view.dispatch(pasteBlocks(view.state.tr, blocks));
          else latest.current.images.pasteBlocks(blocks);
          return true;
        }
        // Images alone, also those copied in LineHush (Rust writes them as
        // files; importFiles recognises its own copy and keeps the same images).
        const files = imageFiles(data.files);
        if (files.length) {
          latest.current.images.importFiles(files, true);
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
        if (files.length) latest.current.images.importFiles(files);
        return true;
      },
    },
  }));
  const editor = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editable: !props.disabled,
    ...options,
    // Images an edit removes (a cut, say) are remembered from the document
    // before it; new ones, by the next edit or the paste itself.
    onUpdate: ({ editor, transaction }) => {
      remember(transaction.before);
      latest.current.onChange(fromEditor(editor.getJSON()));
    },
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
  /** Inserts pasted lines and images at `tr`'s selection, one undo step. */
  function pasteBlocks(tr: Transaction, blocks: Block[]) {
    closeHistory(tr);
    insertBlocks(tr, blockNodes(tr.doc.type.schema, blocks));
    return tr.scrollIntoView();
  }
  function reserveInsertion() {
    let bookmark = editor.state.selection.getBookmark();
    const map = ({ transaction }: { transaction: Transaction }) => {
      bookmark = bookmark.map(transaction.mapping);
    };
    editor.on("transaction", map);
    const restore = () => {
      editor.off("transaction", map);
      editor.view.dispatch(
        editor.state.tr.setSelection(bookmark.resolve(editor.state.doc)),
      );
    };
    return {
      cancel: () => editor.off("transaction", map),
      insertBlocks: (blocks: Block[]) => {
        restore();
        editor.view.dispatch(pasteBlocks(editor.state.tr, blocks));
        editor.view.focus();
      },
      insert: (pictures: Picture[], rows: boolean[]) => {
        restore();
        const { state, view } = editor;
        // One undo step for the whole batch.
        const tr = closeHistory(state.tr);
        // Each picture is its own node; neighbouring images share a row unless
        // a line break (`newline`) starts a new one. Selected images are
        // replaced in place; at the caret between blocks the new ones join the
        // row there; on a text line they make a row of their own. Nothing
        // ends up selected: the caret sits at the end of their row, where a
        // second paste joins them and Enter starts a new row.
        insertImages(
          tr,
          pictures.map((pic, i) =>
            state.schema.nodes.image.create({ ...pic, newline: !!rows[i] }),
          ),
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
      editor,
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
    prev.tab === next.tab &&
    prev.disabled === next.disabled &&
    prev.ref === next.ref &&
    prev.onChange === next.onChange &&
    prev.onSelection === next.onSelection &&
    prev.images === next.images &&
    prev.onPreview === next.onPreview,
);
