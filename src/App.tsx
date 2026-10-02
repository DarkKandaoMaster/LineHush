import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { fileName, stats } from "./core/document";
import { createSession } from "./core/session";
import DiaryEditor, { type DiaryEditorHandle } from "./editor/DiaryEditor";
import { useImageImport } from "./hooks/useImageImport";
import { useImagePreview } from "./hooks/useImagePreview";
import { useWindowGuards, useWindowTitle } from "./hooks/useWindowGuards";
import Banners from "./components/Banners";
import ImagePreviewDialog from "./components/ImagePreviewDialog";
import StatusBar from "./components/StatusBar";
import Toolbar from "./components/Toolbar";
import "./App.css";

export default function App() {
  const [session] = useState(createSession);
  const {
    document,
    path,
    generation,
    ready,
    busy,
    dirty,
    error,
    notice,
    status,
  } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { desktop } = session;
  const title = fileName(path);
  const editor = useRef<DiaryEditorHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const counts = useMemo(() => stats(document), [document]);
  const preview = useImagePreview(session);
  const { importing, importLock, importFiles } = useImageImport(
    session,
    editor,
  );

  // Effect order matters: session start + shortcuts + close guard, then title, then focus.
  useWindowGuards(session, importLock, preview.dialog, preview.close);
  useWindowTitle(session, title, dirty);
  useEffect(() => {
    setPosition({ line: 1, column: 1 });
    if (ready) editor.current?.focus();
  }, [generation, ready]);
  const selection = useCallback((line: number, column: number) => {
    setPosition({ line, column });
  }, []);
  const fileDisabled = !desktop || busy || importing;
  return (
    <main className="app">
      <Toolbar
        session={session}
        fileDisabled={fileDisabled}
        busy={busy}
        dirty={dirty}
        title={title}
        path={path}
        onInsertImage={() => picker.current?.click()}
        onUndo={() => editor.current?.undo()}
        onRedo={() => editor.current?.redo()}
      />
      <Banners session={session} error={error} notice={notice} />
      {ready ? (
        <DiaryEditor
          key={generation}
          ref={editor}
          initial={document}
          disabled={busy}
          onChange={session.update}
          onFiles={importFiles}
          onPreview={preview.show}
          onSelection={selection}
        />
      ) : (
        <div className="loading">正在打开…</div>
      )}
      <StatusBar
        line={position.line}
        column={position.column}
        characters={counts.characters}
        images={counts.images}
        status={status}
      />
      <input
        ref={picker}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        multiple
        tabIndex={-1}
        onChange={(event) => {
          void importFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <ImagePreviewDialog
        dialogRef={preview.dialog}
        name={preview.name}
        source={preview.source}
        onClose={preview.close}
      />
    </main>
  );
}
