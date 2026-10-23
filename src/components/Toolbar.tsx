import { useEffect, useRef, useState } from "react";
import type { ExportFormat, Session } from "../core/session";
import type { Settings } from "../core/settings";

interface Props {
  /** The current tab's document; 保存、另存为、导出 act on it. */
  session: Session | undefined;
  /** Save and export wait for a running operation or import in the current tab. */
  fileDisabled: boolean;
  /** The font and size a PDF export is printed in. */
  settings: Settings;
  onNew: () => void;
  onOpen: () => void;
  onSettings: () => void;
}

/** 线条风格齿轮（8 个齿、中间圆孔），参照 Win11 记事本右上角的设置图标。 */
function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.79,2.74L6.97,1.08A7,7 0 0 1 9.03,1.08L9.21,2.74A5.4,5.4 0 0 1 10.86,3.42L12.16,2.37A7,7 0 0 1 13.63,3.84L12.58,5.14A5.4,5.4 0 0 1 13.26,6.79L14.92,6.97A7,7 0 0 1 14.92,9.03L13.26,9.21A5.4,5.4 0 0 1 12.58,10.86L13.63,12.16A7,7 0 0 1 12.16,13.63L10.86,12.58A5.4,5.4 0 0 1 9.21,13.26L9.03,14.92A7,7 0 0 1 6.97,14.92L6.79,13.26A5.4,5.4 0 0 1 5.14,12.58L3.84,13.63A7,7 0 0 1 2.37,12.16L3.42,10.86A5.4,5.4 0 0 1 2.74,9.21L1.08,9.03A7,7 0 0 1 1.08,6.97L2.74,6.79A5.4,5.4 0 0 1 3.42,5.14L2.37,3.84A7,7 0 0 1 3.84,2.37L5.14,3.42A5.4,5.4 0 0 1 6.79,2.74Z" />
      <circle cx="8" cy="8" r="2.25" />
    </svg>
  );
}

export default function Toolbar(props: Props) {
  const { session, fileDisabled, onSettings } = props;
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // An open export menu closes on a press outside it or on Esc.
  useEffect(() => {
    if (!exportOpen) return;
    const close = () => {
      if (exportMenu.current) exportMenu.current.open = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!exportMenu.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [exportOpen]);
  const exportAs = (format: ExportFormat) => {
    if (exportMenu.current) exportMenu.current.open = false;
    void session?.exportDocument(format, props.settings);
  };
  return (
    <header className="toolbar" aria-label="文件操作">
      <button title="新建标签页 (Ctrl+N)" onClick={props.onNew}>
        新建
      </button>
      <button title="打开 (Ctrl+O)" onClick={props.onOpen}>
        打开
      </button>
      <button
        disabled={fileDisabled}
        title="保存 (Ctrl+S)"
        onClick={() => void session?.saveDocument()}
      >
        保存
      </button>
      <button
        disabled={fileDisabled}
        title="另存为 (Ctrl+Shift+S)"
        onClick={() => void session?.saveDocumentAs()}
      >
        另存为
      </button>
      <details
        className="export-menu"
        ref={exportMenu}
        onToggle={(event) => setExportOpen(event.currentTarget.open)}
      >
        <summary>导出</summary>
        <div className="menu-items">
          <button
            disabled={fileDisabled}
            onClick={() => exportAs("txt")}
          >
            纯文本 (.txt)
          </button>
          <button
            disabled={fileDisabled}
            onClick={() => exportAs("html")}
          >
            图文网页 (.html)
          </button>
          <button
            disabled={fileDisabled}
            onClick={() => exportAs("pdf")}
          >
            PDF 文档 (.pdf)
          </button>
        </div>
      </details>
      <span className="spacer" />
      <button
        className="settings-button"
        title="设置"
        aria-label="设置"
        onClick={onSettings}
      >
        <GearIcon />
      </button>
    </header>
  );
}
