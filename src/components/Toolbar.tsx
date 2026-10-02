import type { MouseEvent } from "react";
import type { Session } from "../core/session";

interface Props {
  session: Session;
  /** File commands need the desktop backend and no running operation or import. */
  fileDisabled: boolean;
  busy: boolean;
  dirty: boolean;
  title: string;
  path: string | null;
  onInsertImage: () => void;
  onUndo: () => void;
  onRedo: () => void;
}
// Keeps focus in the editor so undo/redo and image insertion act on its selection.
const keepFocus = (event: MouseEvent) => event.preventDefault();

export default function Toolbar(props: Props) {
  const { session, fileDisabled, busy } = props;
  return (
    <header className="toolbar" aria-label="文件和编辑操作">
      <button
        disabled={fileDisabled}
        title="新建 (Ctrl+N)"
        onClick={() => void session.newDocument()}
      >
        新建
      </button>
      <button
        disabled={fileDisabled}
        title="打开 (Ctrl+O)"
        onClick={() => void session.openDocument()}
      >
        打开
      </button>
      <button
        disabled={fileDisabled}
        title="保存 (Ctrl+S)"
        onClick={() => void session.saveDocument()}
      >
        保存
      </button>
      <button
        disabled={fileDisabled}
        title="另存为 (Ctrl+Shift+S)"
        onClick={() => void session.saveDocumentAs()}
      >
        另存为
      </button>
      <span className="toolbar-divider" />
      <button
        disabled={fileDisabled}
        onMouseDown={keepFocus}
        onClick={props.onInsertImage}
      >
        插入图片
      </button>
      <details className="export-menu">
        <summary>导出</summary>
        <div className="menu-items">
          <button
            disabled={fileDisabled}
            onClick={() => void session.exportDocument("txt")}
          >
            纯文本 (.txt)
          </button>
          <button
            disabled={fileDisabled}
            onClick={() => void session.exportDocument("html")}
          >
            图文网页 (.html)
          </button>
        </div>
      </details>
      <span className="spacer" />
      <span className="document-name" title={props.path ?? "未命名"}>
        {props.dirty ? "● " : ""}
        {props.title}
      </span>
      <button
        disabled={busy}
        title="撤销 (Ctrl+Z)"
        onMouseDown={keepFocus}
        onClick={props.onUndo}
      >
        撤销
      </button>
      <button
        disabled={busy}
        title="重做 (Ctrl+Y)"
        onMouseDown={keepFocus}
        onClick={props.onRedo}
      >
        重做
      </button>
    </header>
  );
}
