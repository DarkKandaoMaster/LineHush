import { useLayoutEffect, type KeyboardEvent, type MouseEvent } from "react";
import type { Find } from "../hooks/useFind";

/**
 * 查找条：照 VS Code 的查找小部件，贴在编辑区右上角、盖在正文之上（components 之外的
 * 状态与动作见 hooks/useFind.ts，匹配与高亮见 editor/find.ts）。
 *
 * 第一行：展开 / 收起替换、查找框（内嵌“区分大小写”“全字匹配”）、计数、上一个、下一个、
 * 关闭；第二行（展开时）：替换框、替换、全部替换。焦点在查找条里时 Esc 关闭。
 */

const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 按图标按钮不把焦点从输入框（或编辑器）拿走；键盘 Tab 仍能到达。 */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** Enter 等键：输入法组字中不响应。 */
const composing = (event: KeyboardEvent) =>
  event.nativeEvent.isComposing || event.keyCode === 229;

export default function FindWidget({ find }: { find: Find }) {
  const { ui, info, actions, widget, findInput, replaceInput, generation } = find;

  // 右边距 14px 加编辑区滚动条的宽度（滚动条随内容出现 / 消失）。
  useLayoutEffect(() => {
    const el = widget.current;
    const host = el?.parentElement?.querySelector<HTMLElement>(".editor-host");
    if (!el || !host) return;
    const place = () => {
      el.style.right = `${14 + Math.max(host.offsetWidth - host.clientWidth, 0)}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(host);
    return () => observer.disconnect();
  }, [widget, generation]);

  const none = !!ui.query && info.count === 0;
  const count = !ui.query
    ? ""
    : none
      ? "无结果"
      : info.current >= 0
        ? `${info.current + 1} / ${info.count}`
        : `共 ${info.count} 项`;

  function onKeyDown(event: KeyboardEvent) {
    if (composing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      actions.close();
    } else if (event.key === "Enter" && event.ctrlKey && event.altKey) {
      event.preventDefault();
      if (ui.replace) actions.replaceAll();
    }
  }
  const plainEnter = (event: KeyboardEvent) =>
    event.key === "Enter" && !event.ctrlKey && !event.altKey && !composing(event);

  return (
    <div
      ref={widget}
      className={`find-widget${ui.replace ? " replacing" : ""}`}
      role="search"
      aria-label="查找与替换"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="find-expand"
        title="切换替换"
        aria-expanded={ui.replace}
        onMouseDown={keepFocus}
        onClick={actions.toggleReplace}
      >
        <Icon d="M6 4l4 4-4 4" />
      </button>
      <div className="find-grid">
        <div className="find-field">
          <input
            ref={findInput}
            aria-label="查找"
            placeholder="查找"
            spellCheck={false}
            value={ui.query}
            onChange={(event) => actions.setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (!plainEnter(event)) return;
              event.preventDefault();
              if (event.shiftKey) actions.prev();
              else actions.next();
            }}
          />
          <button
            type="button"
            className={`find-option${ui.caseSensitive ? " on" : ""}`}
            title="区分大小写 (Alt+C)"
            aria-pressed={ui.caseSensitive}
            onMouseDown={keepFocus}
            onClick={() => actions.toggle("caseSensitive")}
          >
            Aa
          </button>
          <button
            type="button"
            className={`find-option${ui.wholeWord ? " on" : ""}`}
            title="全字匹配 (Alt+W)"
            aria-pressed={ui.wholeWord}
            onMouseDown={keepFocus}
            onClick={() => actions.toggle("wholeWord")}
          >
            <span className="find-word">ab</span>
          </button>
        </div>
        <div className="find-actions">
          <span className={`find-count${none ? " none" : ""}`} aria-live="polite">
            {count}
          </span>
          <button
            type="button"
            className="find-icon"
            title="上一个匹配项 (Shift+Enter)"
            aria-label="上一个匹配项"
            disabled={info.count === 0}
            onMouseDown={keepFocus}
            onClick={actions.prev}
          >
            <Icon d="M8 13V3M4 7l4-4 4 4" />
          </button>
          <button
            type="button"
            className="find-icon"
            title="下一个匹配项 (Enter)"
            aria-label="下一个匹配项"
            disabled={info.count === 0}
            onMouseDown={keepFocus}
            onClick={actions.next}
          >
            <Icon d="M8 3v10M4 9l4 4 4-4" />
          </button>
          <button
            type="button"
            className="find-icon"
            title="关闭 (Esc)"
            aria-label="关闭"
            onMouseDown={keepFocus}
            onClick={actions.close}
          >
            <Icon d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </button>
        </div>
        {ui.replace && (
          <>
            <div className="find-field">
              <input
                ref={replaceInput}
                aria-label="替换"
                placeholder="替换"
                spellCheck={false}
                value={ui.replacement}
                onChange={(event) => actions.setReplacement(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (!plainEnter(event) || event.shiftKey) return;
                  event.preventDefault();
                  actions.replace();
                }}
              />
            </div>
            <div className="find-actions">
              <button
                type="button"
                className="find-text"
                title="替换 (Enter)"
                disabled={info.count === 0}
                onMouseDown={keepFocus}
                onClick={actions.replace}
              >
                替换
              </button>
              <button
                type="button"
                className="find-text"
                title="全部替换 (Ctrl+Alt+Enter)"
                disabled={info.count === 0}
                onMouseDown={keepFocus}
                onClick={actions.replaceAll}
              >
                全部替换
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
