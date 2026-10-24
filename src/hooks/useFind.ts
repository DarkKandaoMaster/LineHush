import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { DiaryEditorHandle } from "../editor/DiaryEditor";
import {
  findMatches,
  findState,
  firstFrom,
  nextMatch,
  prevMatch,
  replaceAll,
  replaceMatch,
  selectMatch,
  setFind,
} from "../editor/find";

/** 一个标签页的查找条：开 / 关、查询、选项、替换行，切换标签页时各自保留。 */
export interface FindUi {
  open: boolean;
  /** 替换行展开。 */
  replace: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}
export type FindOption = "caseSensitive" | "wholeWord";
/** 匹配个数与当前匹配（选区正好是第几个匹配，-1 为不是）。 */
export interface FindInfo {
  count: number;
  current: number;
}
/** 窗口快捷键（useWindowGuards）调到当前标签页的动作。 */
export interface FindCommands {
  /** Ctrl+F。 */
  find: () => void;
  /** Ctrl+H。 */
  replace: () => void;
  /** F3 / Shift+F3（查找条关着也有效）。 */
  next: () => void;
  prev: () => void;
  /** Alt+C / Alt+W（查找条开着时）。 */
  toggle: (option: FindOption) => void;
  isOpen: () => boolean;
}

const INITIAL: FindUi = {
  open: false,
  replace: false,
  query: "",
  replacement: "",
  caseSensitive: false,
  wholeWord: false,
};

const registry = new Map<string, FindCommands>();
/** 标签页 `tab` 的查找动作（它的 TabPane 挂着时）。 */
export const findCommandsOf = (tab: string | undefined) =>
  tab === undefined ? undefined : registry.get(tab);

/**
 * 编辑器里同一段落内的非空文字选区：打开查找条时用它预填查询；否则为 null。
 */
function seedOf(state: EditorState): string | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return null;
  if (!sel.$from.sameParent(sel.$to) || !sel.$from.parent.isTextblock) return null;
  return state.doc.textBetween(sel.from, sel.to);
}

/**
 * 一个标签页的查找 / 替换（状态放在 TabPane 一级，见 components/FindWidget.tsx 与
 * editor/find.ts）。`generation` 变化即编辑器重建（换了文档）：新编辑器的插件重新拿到
 * 查询。
 */
export function useFind(
  tab: string,
  editor: RefObject<DiaryEditorHandle | null>,
  generation: number,
) {
  const [ui, setUi] = useState(INITIAL);
  // 动作同步读写最新状态（连续几次调用之间 React 还没重新渲染）。
  const latest = useRef(ui);
  const [info, setInfo] = useState<FindInfo>({ count: 0, current: -1 });
  const [focusRequest, setFocusRequest] = useState<{
    target: "find" | "replace";
    n: number;
  } | null>(null);
  const widget = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);

  const actions = useMemo(() => {
    const update = (patch: Partial<FindUi>) => {
      latest.current = { ...latest.current, ...patch };
      setUi(latest.current);
    };
    const view = (): EditorView | null => {
      const instance = editor.current?.editor;
      return instance && !instance.isDestroyed ? instance.view : null;
    };
    /** 把查询与选项交给插件；关着或查询为空时清掉高亮。 */
    const sync = (v: EditorView) => {
      const { open, query, caseSensitive, wholeWord } = latest.current;
      setFind(v, open && query ? { query, options: { caseSensitive, wholeWord } } : null);
    };
    /** 查询或选项变化：重算匹配，选中起点 ≥ 当前选区起点的第一个（没有则第一个）。 */
    const search = () => {
      const v = view();
      if (!v) return;
      sync(v);
      const { matches } = findState(v.state);
      const i = firstFrom(matches, v.state.selection.from);
      if (i >= 0) selectMatch(v, matches[i], widget.current);
    };
    let requests = 0;
    const open = (replace: boolean) => {
      const v = view();
      const before = latest.current;
      const seed = v ? seedOf(v.state) : null;
      const query = seed ?? before.query;
      update({ open: true, replace: replace || before.replace, query });
      if (v) {
        if (seed !== null) search();
        else sync(v);
      }
      setFocusRequest({ target: replace && query ? "replace" : "find", n: ++requests });
    };
    const close = () => {
      update({ open: false });
      const v = view();
      if (!v) return;
      sync(v);
      // ProseMirror 的 focus：不滚动，选区原样写回 DOM。
      v.focus();
    };
    const go = (dir: -1 | 1) => {
      const { open: isOpen, query, caseSensitive, wholeWord } = latest.current;
      if (!query) {
        open(false);
        return;
      }
      const v = view();
      if (!v) return;
      const state = findState(v.state);
      const matches =
        isOpen && state.query === query
          ? state.matches
          : findMatches(v.state.doc, query, { caseSensitive, wholeWord });
      const sel = v.state.selection;
      const i = dir > 0 ? nextMatch(matches, sel) : prevMatch(matches, sel);
      if (i >= 0) selectMatch(v, matches[i], isOpen ? widget.current : null);
    };
    const setQuery = (query: string) => {
      update({ query });
      if (query) search();
      else {
        const v = view();
        if (v) sync(v);
      }
    };
    const toggle = (option: FindOption) => {
      update({ [option]: !latest.current[option] });
      if (latest.current.open && latest.current.query) search();
    };
    /** 当前选区正好是匹配：换掉它并选中下一个；否则只跳到下一个。 */
    const replaceOne = () => {
      const v = view();
      const { query, replacement } = latest.current;
      if (!v || !v.editable || !query) return;
      const { matches, current } = findState(v.state);
      if (current < 0) {
        go(1);
        return;
      }
      const match = matches[current];
      v.dispatch(replaceMatch(v.state, match, replacement));
      const next = findState(v.state).matches;
      const i = firstFrom(next, match.from + replacement.length);
      if (i >= 0) selectMatch(v, next[i], widget.current);
    };
    const replaceEvery = () => {
      const v = view();
      if (!v || !v.editable || !latest.current.query) return;
      const { matches } = findState(v.state);
      if (matches.length) v.dispatch(replaceAll(v.state, matches, latest.current.replacement));
    };
    const commands: FindCommands = {
      find: () => open(false),
      replace: () => open(true),
      next: () => go(1),
      prev: () => go(-1),
      toggle,
      isOpen: () => latest.current.open,
    };
    return {
      commands,
      sync,
      view,
      close,
      next: () => go(1),
      prev: () => go(-1),
      setQuery,
      setReplacement: (replacement: string) => update({ replacement }),
      toggle,
      toggleReplace: () => update({ replace: !latest.current.replace }),
      replace: replaceOne,
      replaceAll: replaceEvery,
    };
  }, [editor]);

  useEffect(() => {
    registry.set(tab, actions.commands);
    return () => {
      if (registry.get(tab) === actions.commands) registry.delete(tab);
    };
  }, [tab, actions]);

  // 编辑器（重建后为新的那个）：插件拿到当前查询；每个事务后更新计数。
  useEffect(() => {
    const instance = editor.current?.editor;
    const v = actions.view();
    if (!instance || !v) return;
    const refresh = () => {
      if (instance.isDestroyed) return;
      const { matches, current } = findState(instance.state);
      setInfo((prev) =>
        prev.count === matches.length && prev.current === current
          ? prev
          : { count: matches.length, current },
      );
    };
    instance.on("transaction", refresh);
    if (latest.current.open) actions.sync(v);
    refresh();
    return () => {
      instance.off("transaction", refresh);
    };
  }, [editor, actions, generation]);

  // 打开（Ctrl+F / Ctrl+H）后焦点到输入框并全选。
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const input = (focusRequest.target === "replace" ? replaceInput : findInput).current;
    input?.focus();
    input?.select();
  }, [focusRequest]);

  return { ui, info, actions, generation, widget, findInput, replaceInput };
}

export type Find = ReturnType<typeof useFind>;
