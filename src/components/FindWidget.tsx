import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import type { EditorView } from "@tiptap/pm/view";
import { redrawCarets } from "../editor/caret";
import type { Find } from "../hooks/useFind";

/**
 * 查找条：照 VS Code 的查找小部件，贴在编辑区右上角、盖在正文之上（components 之外的
 * 状态与动作见 hooks/useFind.ts，匹配与高亮见 editor/find.ts）。
 *
 * 第一行：展开 / 收起替换、查找框（内嵌“区分大小写”“全字匹配”）、计数、上一个、下一个、
 * 关闭；第二行（展开时）：替换框、替换、全部替换。焦点在查找条里时 Esc 关闭（焦点在别处时
 * 由 useWindowGuards 的窗口快捷键关闭）。
 *
 * 开着时正文顶部多一块与查找条等高（含它上方的间距）的空白，照 VS Code 的
 * `find.addExtraSpaceOnTop`（findWidget.ts 的 view zone）：滚到顶时首行不被盖住。
 */

/**
 * 计数区的最小宽度：出现过的最宽计数（只增不减，输入时不来回抖动），照 VS Code
 * `MAX_MATCHES_COUNT_WIDTH`（初值 69px，按英文 “No results” / “1 of 3” 定）；这里按本应用
 * 12px 字体下的 “无结果” “共 n 项” “k / n” 缩为 MIN_COUNT_WIDTH。窗口里所有查找条共用。
 */
const MIN_COUNT_WIDTH = 48;
let maxCountWidth = MIN_COUNT_WIDTH;

/**
 * 打开时是否把 scrollTop 加上空白的高度（视口内容不动）：VS Code `_reveal` 的
 * `adjustEditorScrollTop`——选区起点落在视口顶部空白高度以内，且选区跨行、或起点 / 终点横向在
 * 查找条左边界右侧（会被它盖住）时不加，让内容整体下移、露出选区。
 */
function keepsContent(view: EditorView | null, host: HTMLElement, widget: HTMLElement, zone: number) {
  if (!view) return true;
  try {
    const { from, to } = view.state.selection;
    const a = view.coordsAtPos(from, 1);
    const b = view.coordsAtPos(to, -1);
    const top = host.getBoundingClientRect().top + host.clientTop;
    if (a.bottom <= top || a.top - top >= zone) return true;
    if (b.top >= a.bottom - 1) return false;
    const left = widget.getBoundingClientRect().left;
    return a.left <= left && b.left <= left;
  } catch {
    return true;
  }
}

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
  const countRef = useRef<HTMLSpanElement>(null);

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

  // 正文顶部的空白（`.editor-area` 上的 --find-zone，App.css 里加到 .tiptap 的上内边距）：
  // 高 = 查找条的 top + 高度。出现时 scrollTop 加上同样的高度（视口不动，见 keepsContent），
  // 高度变化（展开 / 收起替换）按差值同步调整，消失时减回去（VS Code 的 _showViewZone /
  // _removeViewZone）。在绘制前完成，并立即重画自绘光标与选区（它们按文字的位置画）。
  useLayoutEffect(() => {
    const el = widget.current;
    const area = el?.parentElement;
    if (!el || !area) return;
    const host = () => area.querySelector<HTMLElement>(".editor-host");
    let zone = 0;
    const apply = (next: number, adjust: boolean) => {
      if (next === zone) return;
      const delta = next - zone;
      zone = next;
      if (next) area.style.setProperty("--find-zone", `${next}px`);
      else area.style.removeProperty("--find-zone");
      const scroller = host();
      if (scroller && adjust) scroller.scrollTop += delta;
      redrawCarets();
    };
    // 查找条底边到编辑区顶边（不取整：缩放 150% 时 1px 边框是 2/3 CSS 像素）；隐藏的标签页里为 0，不算。
    const height = () =>
      el.offsetHeight ? el.getBoundingClientRect().bottom - area.getBoundingClientRect().top : 0;
    const first = height();
    const scroller = host();
    if (first && scroller) apply(first, keepsContent(actions.view(), scroller, el, first));
    const observer = new ResizeObserver(() => {
      const next = height();
      if (next) apply(next, true);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      apply(0, true);
    };
  }, [widget, actions]);

  // 计数区宽度只增不减（VS Code 的 _updateMatchesCount）。
  useLayoutEffect(() => {
    const el = countRef.current;
    if (!el) return;
    el.style.minWidth = `${maxCountWidth}px`;
    maxCountWidth = Math.max(maxCountWidth, el.clientWidth);
  });

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
          <span
            ref={countRef}
            className={`find-count${none ? " none" : ""}`}
            aria-live="polite"
          >
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
