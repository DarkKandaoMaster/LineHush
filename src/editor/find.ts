import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PmNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { keyboardInput } from "./input.ts";
import { lineHeight, revealSelection, scroller } from "./reveal.ts";

/**
 * 查找 / 替换（Ctrl+F / Ctrl+H；界面见 components/FindWidget.tsx，每个标签页的状态与
 * 动作见 hooks/useFind.ts）。
 *
 * - 只在文字段落里找：每个段落的文字分别匹配，不跨段落、不跨图片；匹配不重叠，从左到右贪心。
 * - 选项只有“区分大小写”与“全字匹配”。不区分大小写时逐个字符转小写再比较（`foldCase`，
 *   转换后长度不同的字符保持原样），位置与原文一一对应。全字匹配照 VS Code：匹配左端是词
 *   边界（前面没有字符、前一个字符不是词字符，或匹配的首字符本身不是词字符），右端同理；
 *   词字符 = 字母（含中文）、数字、下划线。
 * - 所有匹配用淡黄色的 inline 装饰（`.find-match`）标出；与当前选区正好相同的那一个不加
 *   装饰，由自绘选区层（caret.ts）照常画成选区色。插件状态的 query 为空（查找条关着）时
 *   没有匹配也没有装饰。
 *
 * 上半部分是纯函数（Node 单元测试直接加载），下半部分是插件与 DOM。
 */

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}
/** 一个匹配（或选区）：文档位置，from 在首字符之前，to 在末字符之后。 */
export interface Match {
  from: number;
  to: number;
}

const WORD = /^[\p{L}\p{N}_]$/u;
/** 词字符：字母（含中文）、数字、下划线（与 VS Code 一致，中文算词字符）。 */
export const isWordChar = (ch: string | undefined) => !!ch && WORD.test(ch);

/** 逐个字符转小写；转换后长度不同的字符（如 “İ”）保持原样，使位置与原文一一对应。 */
export function foldCase(text: string): string {
  if (text.toLowerCase() === text) return text;
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** `i` 之前的那个字符（代理对算一个），没有为 undefined。 */
function charBefore(text: string, i: number) {
  if (i <= 0) return undefined;
  const code = text.charCodeAt(i - 1);
  return code >= 0xdc00 && code <= 0xdfff && i >= 2 ? text.slice(i - 2, i) : text[i - 1];
}
/** `i` 处的那个字符（代理对算一个），没有为 undefined。 */
function charAt(text: string, i: number) {
  const code = text.codePointAt(i);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/** text 的 [start, end) 两端都是词边界（全字匹配，规则见文件开头）。 */
export function isWholeWord(text: string, start: number, end: number): boolean {
  const left = !isWordChar(charBefore(text, start)) || !isWordChar(charAt(text, start));
  const right = !isWordChar(charAt(text, end)) || !isWordChar(charBefore(text, end));
  return left && right;
}

/** 一段文字里的匹配（偏移量 [start, end)），不重叠、从左到右。 */
export function matchesIn(
  text: string,
  query: string,
  options: FindOptions,
): [number, number][] {
  if (!query || !text) return [];
  const hay = options.caseSensitive ? text : foldCase(text);
  const needle = options.caseSensitive ? query : foldCase(query);
  const out: [number, number][] = [];
  let i = hay.indexOf(needle);
  while (i >= 0) {
    const end = i + needle.length;
    if (!options.wholeWord || isWholeWord(text, i, end)) {
      out.push([i, end]);
      i = hay.indexOf(needle, end);
    } else i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/** 文档里的全部匹配，按位置排序；每个文字段落分别匹配，图片跳过。 */
export function findMatches(doc: PmNode, query: string, options: FindOptions): Match[] {
  const out: Match[] = [];
  if (!query) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return !node.isAtom;
    // 段落内容只有文字（schema：text*），textContent 的偏移就是位置偏移。
    for (const [s, e] of matchesIn(node.textContent, query, options))
      out.push({ from: pos + 1 + s, to: pos + 1 + e });
    return false;
  });
  return out;
}

/** 第一个 from ≥ pos 的匹配的下标，没有为 matches.length。 */
function lowerBound(matches: readonly Match[], pos: number) {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].from < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 与选区正好相同的匹配的下标，没有为 -1（空选区不算）。 */
export function matchAt(matches: readonly Match[], sel: Match): number {
  if (sel.from === sel.to) return -1;
  const i = lowerBound(matches, sel.from);
  const m = matches[i];
  return m && m.from === sel.from && m.to === sel.to ? i : -1;
}

/** 查询变化时的当前匹配：第一个起点 ≥ pos 的，没有则回到第一个；没有匹配为 -1。 */
export function firstFrom(matches: readonly Match[], pos: number): number {
  if (!matches.length) return -1;
  const i = lowerBound(matches, pos);
  return i < matches.length ? i : 0;
}

/** 下一个：第一个起点 ≥ 选区末尾的匹配，过了最后一个回到第一个；没有匹配为 -1。 */
export const nextMatch = (matches: readonly Match[], sel: Match) =>
  firstFrom(matches, sel.to);

/** 上一个：最后一个起点 < 选区开头的匹配，过了第一个回到最后一个；没有匹配为 -1。 */
export function prevMatch(matches: readonly Match[], sel: Match): number {
  if (!matches.length) return -1;
  const i = lowerBound(matches, sel.from) - 1;
  return i >= 0 ? i : matches.length - 1;
}

/** 把一个匹配换成 text 的事务（单独一步撤销）。替换文字原样插入，空串即删除。 */
export function replaceMatch(state: EditorState, match: Match, text: string): Transaction {
  const tr = closeHistory(state.tr);
  if (text) tr.replaceWith(match.from, match.to, state.schema.text(text));
  else tr.delete(match.from, match.to);
  return tr;
}

/**
 * 全部替换：一个事务（一步撤销），从后往前换，前面的位置不受影响。之后选区为映射后的
 * 位置，文字选区折叠到它的 head。
 */
export function replaceAll(
  state: EditorState,
  matches: readonly Match[],
  text: string,
): Transaction {
  const tr = closeHistory(state.tr);
  for (let i = matches.length - 1; i >= 0; i--) {
    const { from, to } = matches[i];
    if (text) tr.replaceWith(from, to, state.schema.text(text));
    else tr.delete(from, to);
  }
  const sel = tr.selection;
  if (!sel.empty && sel instanceof TextSelection)
    tr.setSelection(TextSelection.create(tr.doc, sel.head));
  return tr;
}

// ---- 插件与 DOM ----

export interface FindState {
  /** 空串：查找条关着或查询为空，没有匹配、没有装饰。 */
  query: string;
  options: FindOptions;
  matches: Match[];
  /** 与当前选区正好相同的匹配（`matchAt`），没有为 -1。 */
  current: number;
  decorations: DecorationSet;
}
/** 事务 meta：新的查询与选项；null 为关闭（清掉匹配与装饰）。 */
export type FindMeta = { query: string; options: FindOptions } | null;

export const findKey = new PluginKey<FindState>("findHighlight");

/** 编辑器当前的查找状态。 */
export const findState = (state: EditorState) => findKey.getState(state)!;

/** 把查询与选项交给插件（打开、查询或选项变化），null 为关闭。不是文档修改，不进撤销历史。 */
export function setFind(view: EditorView, meta: FindMeta) {
  view.dispatch(view.state.tr.setMeta(findKey, meta).setMeta("addToHistory", false));
}

function decorate(doc: PmNode, matches: readonly Match[], current: number) {
  if (!matches.length) return DecorationSet.empty;
  const list: Decoration[] = [];
  matches.forEach((m, i) => {
    if (i !== current) list.push(Decoration.inline(m.from, m.to, { class: "find-match" }));
  });
  return DecorationSet.create(doc, list);
}

const NO_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false };

/** 查找高亮的插件（`FindHighlight` 挂的就是它；单元测试直接用）。 */
export function findPlugin() {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({
        query: "",
        options: NO_OPTIONS,
        matches: [],
        current: -1,
        decorations: DecorationSet.empty,
      }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(findKey) as FindMeta | undefined;
        let { query, options, matches } = value;
        if (meta !== undefined) {
          query = meta?.query ?? "";
          options = meta?.options ?? options;
          matches = findMatches(state.doc, query, options);
        } else if (tr.docChanged && query) matches = findMatches(state.doc, query, options);
        const current = matchAt(matches, state.selection);
        if (matches === value.matches && current === value.current && meta === undefined)
          return value;
        return {
          query,
          options,
          matches,
          current,
          decorations: decorate(state.doc, matches, current),
        };
      },
    },
    props: {
      decorations: (state) => findKey.getState(state)?.decorations,
    },
  });
}

/** 查找高亮（见文件开头）。 */
export const FindHighlight = Extension.create({
  name: "findHighlight",
  addProseMirrorPlugins: () => [findPlugin()],
});

/**
 * 选中一个匹配（真实的编辑器选区，由自绘选区层显示），按键盘来源的规则滚动揭示（安全区）。
 * 揭示后若匹配被查找条（`widget`）盖住，再往回滚，让它落到查找条下方一行（VS Code 如此）；
 * 已滚到顶时无法避开。
 */
export function selectMatch(view: EditorView, match: Match, widget: HTMLElement | null) {
  keyboardInput(view);
  const { state } = view;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, match.from, match.to)));
  revealSelection(view);
  const host = scroller(view);
  if (!widget || !host) return;
  const a = view.coordsAtPos(match.from, 1);
  const b = view.coordsAtPos(match.to, -1);
  const top = Math.min(a.top, b.top);
  const bottom = Math.max(a.bottom, b.bottom);
  const left = Math.min(a.left, b.left);
  const right = Math.max(a.right, b.right);
  const w = widget.getBoundingClientRect();
  if (bottom <= w.top || top >= w.bottom || right <= w.left || left >= w.right) return;
  const next = Math.max(0, host.scrollTop - (w.bottom - top + lineHeight(view)));
  if (Math.abs(next - host.scrollTop) >= 0.5) host.scrollTop = next;
}
