import { useSyncExternalStore, type MouseEvent } from "react";
import { displayName, type Tab } from "../core/tabs";

interface Props {
  tabs: Tab[];
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** 有对话框开着时不可操作（鼠标落到下面的标题栏拖动区）。 */
  inert?: boolean;
}

/** Pressing a tab or its buttons must not take the focus away from the editor. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * 标签栏：参照 Win11 记事本，位于自绘标题栏（TitleBar）左侧，末尾“+”新建标签页。
 * 标签之间与上方的空白可拖动窗口（标签与按钮本身不是拖动区）。
 * 标签页上右键弹出标签页菜单（hooks/useContextMenu.ts，按 `data-tab` 认标签页）。
 */
export default function TabBar(props: Props) {
  return (
    <div
      className="tabbar"
      role="tablist"
      aria-label="标签页"
      data-tauri-drag-region
      inert={props.inert}
    >
      {props.tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={tab.id === props.active}
          onActivate={props.onActivate}
          onClose={props.onClose}
        />
      ))}
      <button
        className="tab-new"
        title="新建标签页 (Ctrl+N)"
        aria-label="新建标签页"
        tabIndex={-1}
        onMouseDown={keepFocus}
        onClick={props.onNew}
      >
        +
      </button>
    </div>
  );
}

function TabItem(props: {
  tab: Tab;
  active: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const { tab, active } = props;
  const { path, dirty } = useSyncExternalStore(
    tab.session.subscribe,
    tab.session.getSnapshot,
  );
  const name = displayName(tab);
  return (
    <div
      role="tab"
      // 右键菜单按它找出右键的是哪个标签页（hooks/useContextMenu.ts）。
      data-tab={tab.id}
      aria-selected={active}
      className={`tab${active ? " active" : ""}`}
      title={path?.replace(/^\\\\\?\\/, "") ?? name}
      onMouseDown={(event) => {
        keepFocus(event);
        if (event.button === 0) props.onActivate(tab.id);
      }}
      // Middle click closes, as in Notepad and browsers.
      onAuxClick={(event) => {
        if (event.button === 1) props.onClose(tab.id);
      }}
    >
      <span className="tab-name">
        {dirty ? "● " : ""}
        {name}
      </span>
      <button
        className="tab-close"
        title="关闭标签页 (Ctrl+W)"
        aria-label={`关闭 ${name}`}
        tabIndex={-1}
        onMouseDown={(event) => {
          keepFocus(event);
          event.stopPropagation();
        }}
        onClick={() => props.onClose(tab.id)}
      >
        ×
      </button>
    </div>
  );
}
