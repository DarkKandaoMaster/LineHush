import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fileName, stats } from "./core/document";
import { createSession, type Session } from "./core/session";
import DiaryEditor, { type DiaryEditorHandle } from "./editor/DiaryEditor";
import { useImageImport } from "./hooks/useImageImport";
import { useImagePreview } from "./hooks/useImagePreview";
import { useUnsavedPrompt } from "./hooks/useUnsavedPrompt";
import { useWindowGuards } from "./hooks/useWindowGuards";
import Banners from "./components/Banners";
import ImagePreviewDialog from "./components/ImagePreviewDialog";
import StatusBar from "./components/StatusBar";
import Toolbar from "./components/Toolbar";
import UnsavedDialog from "./components/UnsavedDialog";
import "./App.css";

export default function App() {
  const unsaved = useUnsavedPrompt();
  const [session] = useState(() => createSession(unsaved.ask));
  const {
    document,
    path,
    generation,
    ready,
    busy,
    importing,
    dirty,
    error,
    notice,
    status,
  } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { desktop } = session;
  const title = fileName(path);
  const editor = useRef<DiaryEditorHandle>(null);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const counts = useMemo(() => stats(document), [document]);
  const preview = useImagePreview(session);
  const importFiles = useImageImport(session, editor);

  useWindowGuards(session, preview.dialog);
  useWindowTitle(session, title, dirty);
  // Focus waits for `ready` through the dependency list, not through hook order.
  useEffect(() => {
    setPosition({ line: 1, column: 1 });
    if (ready) editor.current?.focus();
  }, [generation, ready]);
  // A disabled editor cannot take focus back from a closing dialog, so return it here.
  useEffect(() => {
    if (!busy) editor.current?.focus();
  }, [busy]);
  const fileDisabled = !desktop || busy || importing;
  return (
    <main className="app">
      <Toolbar session={session} fileDisabled={fileDisabled} />
      <Banners
        session={session}
        error={error}
        notice={notice}
        status={status}
      />
      {ready ? (
        <DiaryEditor
          key={generation}
          ref={editor}
          initial={document}
          disabled={busy}
          onChange={session.update}
          onFiles={importFiles}
          onPreview={preview.show}
          onSelection={setPosition}
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
      {/* 工具栏已无“插入图片”按钮，界面上无法打开此选择框；保留它只因 tests/native.mjs 经它导入图片。 */}
      <input
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
        canSave={desktop}
        onSave={() => void preview.saveOriginal()}
        onClose={preview.close}
      />
      <UnsavedDialog
        dialogRef={unsaved.dialog}
        name={unsaved.name}
        onClose={unsaved.closed}
      />
    </main>
  );
}

/** Window title: "● " marks unsaved changes. */
function useWindowTitle(session: Session, title: string, dirty: boolean) {
  useEffect(() => {
    if (session.desktop)
      void getCurrentWindow()
        .setTitle(`${dirty ? "● " : ""}${title} — LineHush`)
        .catch(console.error);
  }, [session, title, dirty]);
}
