import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Picture } from "../core/document";
import { stats } from "../core/document";
import type { Session } from "../core/session";
import type { Tab } from "../core/tabs";
import DiaryEditor, { type DiaryEditorHandle } from "../editor/DiaryEditor";
import { useContextMenuTarget } from "../hooks/useContextMenu";
import { useFind } from "../hooks/useFind";
import { useImageImport } from "../hooks/useImageImport";
import Banners from "./Banners";
import FindWidget from "./FindWidget";
import StatusBar from "./StatusBar";

interface Props {
  tab: Tab;
  /** Not the current tab: kept (with its editor and undo history) but not shown. */
  hidden: boolean;
  /** Bumped by the window to move the keyboard focus into the current editor. */
  focus: number;
  /** The window's text zoom in percent (hooks/useZoom.ts), shown in the status bar. */
  zoom: number;
  onPreview: (session: Session, pic: Picture) => void;
}

/** One tab: its banners, editor and status bar. */
export default function TabPane({ tab, hidden, focus, zoom, onPreview }: Props) {
  const { session } = tab;
  const { document, generation, busy, error, notice, saveFailed } =
    useSyncExternalStore(session.subscribe, session.getSnapshot);
  const editor = useRef<DiaryEditorHandle>(null);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const counts = useMemo(() => stats(document), [document]);
  const images = useImageImport(session, editor);
  // 查找 / 替换：每个标签页一份，切换标签页时各自保留（快捷键经 useWindowGuards 调到当前标签页）。
  const find = useFind(tab.id, editor, generation);
  // 右键菜单的动作作用在这个编辑器上。
  useContextMenuTarget(tab.id, editor);
  const preview = useCallback(
    (pic: Picture) => onPreview(session, pic),
    [onPreview, session],
  );
  useEffect(() => {
    setPosition({ line: 1, column: 1 });
  }, [generation]);
  // The current editor takes the focus when its tab is shown, loads another
  // document, or the window asks for it. A disabled editor cannot take focus back
  // from a closing dialog, so it is returned when the operation ends.
  useEffect(() => {
    if (!hidden && !busy) editor.current?.focus();
  }, [hidden, busy, generation, focus]);
  return (
    <div className="tab-pane" hidden={hidden} role="tabpanel">
      <Banners
        session={session}
        error={error}
        notice={notice}
        saveFailed={saveFailed}
      />
      {/* 查找条盖在编辑区右上角（相对这一层定位，不随正文滚动）。 */}
      <div className="editor-area">
        <DiaryEditor
          key={generation}
          ref={editor}
          tab={tab.id}
          initial={document}
          disabled={busy}
          onChange={session.update}
          images={images}
          onPreview={preview}
          onSelection={setPosition}
        />
        {find.ui.open && <FindWidget find={find} />}
      </div>
      <StatusBar
        line={position.line}
        column={position.column}
        characters={counts.characters}
        images={counts.images}
        zoom={zoom}
      />
      {/* 工具栏已无“插入图片”按钮，界面上无法打开此选择框；保留它只因 tests/native/native.mjs 经它导入图片。 */}
      <input
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        multiple
        tabIndex={-1}
        onChange={(event) => {
          void images.importFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
