import test from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { extensions } from "../../src/editor/schema.ts";
import {
  findMatches,
  findKey,
  findPlugin,
  firstFrom,
  foldCase,
  isWholeWord,
  isWordChar,
  matchAt,
  matchesIn,
  nextMatch,
  prevMatch,
  replaceAll,
  replaceMatch,
} from "../../src/editor/find.ts";

// 查找 / 替换（src/editor/find.ts）的纯函数部分，用编辑器真实的 schema。
const schema = getSchema(
  extensions({ preview() {}, source: async () => "", copy() {}, stage() {} }),
);
const img = (id, newline = false) =>
  schema.nodes.image.create({ id, name: `${id}.png`, width: 40, height: 30, newline });
/** 字符串为文字行（可空），其余为图片节点。 */
const doc = (...nodes) =>
  schema.nodes.doc.create(
    null,
    nodes.map((node) =>
      typeof node === "string"
        ? schema.nodes.paragraph.create(null, node ? schema.text(node) : null)
        : node,
    ),
  );
const plain = { caseSensitive: false, wholeWord: false };
const exact = { caseSensitive: true, wholeWord: false };
const words = { caseSensitive: false, wholeWord: true };
/** 匹配到的文字。 */
const texts = (d, matches) => matches.map((m) => d.textBetween(m.from, m.to));

test("段落内匹配给出文档位置；空查询没有匹配", () => {
  // "今天天气好" 文字 1-6；"天气" 在 3-5。
  const d = doc("今天天气好", "明天天气也好");
  assert.deepEqual(findMatches(d, "天气", plain), [
    { from: 3, to: 5 },
    { from: 10, to: 12 },
  ]);
  assert.deepEqual(findMatches(d, "", plain), []);
  assert.deepEqual(findMatches(d, "下雨", plain), []);
});

test("不区分大小写（默认）与区分大小写", () => {
  const d = doc("Apple apple APPLE");
  assert.deepEqual(texts(d, findMatches(d, "apple", plain)), ["Apple", "apple", "APPLE"]);
  assert.deepEqual(texts(d, findMatches(d, "APPLE", plain)), ["Apple", "apple", "APPLE"]);
  assert.deepEqual(texts(d, findMatches(d, "apple", exact)), ["apple"]);
  assert.deepEqual(findMatches(d, "Apple", exact), [{ from: 1, to: 6 }]);
});

test("逐字符转小写保持位置：长度会变的字符原样保留，其后的匹配位置不偏", () => {
  // "İ".toLowerCase() 是两个 UTF-16 单元，整串转小写会让后面的位置错一位。
  assert.equal("İ".toLowerCase().length, 2);
  assert.equal(foldCase("İAb"), "İab");
  assert.deepEqual(matchesIn("İ ABC abc", "abc", plain), [
    [2, 5],
    [6, 9],
  ]);
  assert.equal(foldCase("已经是小写 abc"), "已经是小写 abc");
});

test("匹配不重叠，从左到右贪心", () => {
  assert.deepEqual(matchesIn("aaaa", "aa", plain), [
    [0, 2],
    [2, 4],
  ]);
  assert.deepEqual(matchesIn("aaa", "aa", plain), [[0, 2]]);
  const d = doc("哈哈哈哈哈");
  assert.deepEqual(texts(d, findMatches(d, "哈哈", plain)), ["哈哈", "哈哈"]);
});

test("不跨段落、不跨图片匹配；图片跳过", () => {
  // "前半" 0-4，"后半" 4-8；图片 a 8-9，"末尾" 9-13。
  const d = doc("前半", "后半", img("a", true), "末尾");
  assert.deepEqual(findMatches(d, "半后", plain), []);
  assert.deepEqual(findMatches(d, "半", plain), [
    { from: 2, to: 3 },
    { from: 6, to: 7 },
  ]);
  assert.deepEqual(findMatches(d, "末尾", plain), [{ from: 10, to: 12 }]);
  assert.deepEqual(findMatches(doc(img("a", true), img("b")), "a", plain), []);
});

test("全字匹配：两端相邻的不是词字符；中文、数字、下划线算词字符", () => {
  assert.deepEqual(matchesIn("cat concat cat_ cat.", "cat", words), [
    [0, 3],
    [16, 19],
  ]);
  assert.deepEqual(matchesIn("我的日记本", "日记", words), []);
  assert.deepEqual(matchesIn("看 日记 本", "日记", words), [[2, 4]]);
  assert.deepEqual(matchesIn("a1 a", "a", words), [[3, 4]]);
  // 候选被拒后从下一个字符接着找，不跳过与它重叠的合格匹配。
  assert.deepEqual(matchesIn("xaa aa", "aa", words), [[4, 6]]);
  // 与 VS Code 相同：匹配自身的首 / 末字符不是词字符时，那一端也算边界。
  assert.equal(isWholeWord("a-b", 1, 3), true);
  assert.equal(isWholeWord("ab", 1, 2), false);
  assert.equal(isWordChar("_"), true);
  assert.equal(isWordChar("字"), true);
  assert.equal(isWordChar("。"), false);
  assert.equal(isWordChar(" "), false);
  // 代理对：𠀀（扩展 B 汉字）是一个字母。
  assert.deepEqual(matchesIn("𠀀ab", "ab", words), []);
});

test("全字匹配与大小写可同时打开", () => {
  const options = { caseSensitive: true, wholeWord: true };
  assert.deepEqual(matchesIn("Cat cat Cats", "Cat", options), [[0, 3]]);
});

const ms = [
  { from: 2, to: 4 },
  { from: 8, to: 10 },
  { from: 15, to: 17 },
];

test("matchAt：选区正好是某个匹配", () => {
  assert.equal(matchAt(ms, { from: 8, to: 10 }), 1);
  assert.equal(matchAt(ms, { from: 8, to: 9 }), -1);
  assert.equal(matchAt(ms, { from: 8, to: 8 }), -1);
  assert.equal(matchAt([], { from: 1, to: 2 }), -1);
});

test("firstFrom：起点 ≥ 位置的第一个，没有则回到第一个", () => {
  assert.equal(firstFrom(ms, 0), 0);
  assert.equal(firstFrom(ms, 8), 1);
  assert.equal(firstFrom(ms, 9), 2);
  assert.equal(firstFrom(ms, 16), 0);
  assert.equal(firstFrom([], 0), -1);
});

test("nextMatch / prevMatch：从选区两端出发，首尾循环", () => {
  // 选区是匹配 k：下一个 k+1、上一个 k-1。
  assert.equal(nextMatch(ms, ms[0]), 1);
  assert.equal(nextMatch(ms, ms[1]), 2);
  assert.equal(nextMatch(ms, ms[2]), 0);
  assert.equal(prevMatch(ms, ms[2]), 1);
  assert.equal(prevMatch(ms, ms[0]), 2);
  // 光标：正好在匹配开头时下一个就是它；在中间时上一个是它。
  assert.equal(nextMatch(ms, { from: 8, to: 8 }), 1);
  assert.equal(nextMatch(ms, { from: 11, to: 11 }), 2);
  assert.equal(prevMatch(ms, { from: 9, to: 9 }), 1);
  assert.equal(prevMatch(ms, { from: 1, to: 1 }), 2);
  assert.equal(nextMatch([], { from: 1, to: 1 }), -1);
  assert.equal(prevMatch([], { from: 1, to: 1 }), -1);
});

const stateOf = (d, from, to = from) =>
  EditorState.create({
    schema,
    doc: d,
    selection: TextSelection.create(d, from, to),
    plugins: [findPlugin()],
  });

test("替换一个：原样插入，空串即删除", () => {
  const d = doc("今天天气好");
  const state = stateOf(d, 3, 5);
  assert.equal(replaceMatch(state, { from: 3, to: 5 }, "心情").doc.textContent, "今天心情好");
  assert.equal(replaceMatch(state, { from: 3, to: 5 }, "").doc.textContent, "今天好");
  // 整段文字删光也只删文字，段落还在。
  const whole = replaceMatch(stateOf(doc("天气", "下面"), 1), { from: 1, to: 3 }, "");
  assert.equal(whole.doc.childCount, 2);
  assert.equal(whole.doc.firstChild.textContent, "");
});

test("全部替换：一个事务，各段落都换，选区折叠到映射后的位置", () => {
  const d = doc("a b a", "a", img("x", true), "ba");
  const matches = findMatches(d, "a", plain);
  assert.equal(matches.length, 4);
  // "a b a"：匹配 1-2、5-6；选区是第二个匹配。
  const tr = replaceAll(stateOf(d, 5, 6), matches, "xyz");
  const lines = [];
  tr.doc.forEach((node) => lines.push(node.type.name === "image" ? "[x]" : node.textContent));
  assert.deepEqual(lines, ["xyz b xyz", "xyz", "[x]", "bxyz"]);
  assert.equal(tr.steps.length, 4);
  assert.equal(tr.selection.empty, true);
  // 第二个匹配换成 xyz、前面的 a 也换成 xyz 后在 7-10，折叠到它的末尾。
  assert.equal(tr.selection.head, 10);
});

test("插件：meta 设查询后高亮匹配、当前匹配另一类装饰，随选区与文档变化重算，null 清掉", () => {
  const d = doc("猫和猫", "猫");
  let state = stateOf(d, 1, 2);
  const apply = (tr) => (state = state.apply(tr));
  apply(state.tr.setMeta(findKey, { query: "猫", options: plain }));
  let find = findKey.getState(state);
  assert.equal(find.matches.length, 3);
  assert.equal(find.current, 0);
  // 当前匹配（与选区相同）是 find-match-current，其余是 find-match。
  const classes = () =>
    findKey
      .getState(state)
      .decorations.find()
      .map((d) => [d.from, d.to, d.type.attrs.class]);
  assert.deepEqual(classes(), [
    [1, 2, "find-match-current"],
    [3, 4, "find-match"],
    [6, 7, "find-match"],
  ]);
  // 选区换到另一个匹配，当前装饰跟着换。
  apply(state.tr.setSelection(TextSelection.create(state.doc, 3, 4)));
  assert.equal(findKey.getState(state).current, 1);
  assert.deepEqual(classes(), [
    [1, 2, "find-match"],
    [3, 4, "find-match-current"],
    [6, 7, "find-match"],
  ]);
  // 选区比匹配大：没有当前匹配，全是 find-match。
  apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 4)));
  assert.equal(findKey.getState(state).current, -1);
  assert.deepEqual(
    classes().map((c) => c[2]),
    ["find-match", "find-match", "find-match"],
  );
  apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 2)));
  apply(state.tr.insertText("猫", 6));
  find = findKey.getState(state);
  assert.equal(find.matches.length, 4);
  apply(state.tr.setSelection(TextSelection.create(state.doc, 2, 2)));
  find = findKey.getState(state);
  assert.equal(find.current, -1);
  assert.equal(find.decorations.find().length, 4);
  assert.ok(classes().every((c) => c[2] === "find-match"));
  apply(state.tr.setMeta(findKey, null));
  find = findKey.getState(state);
  assert.equal(find.matches.length, 0);
  assert.equal(find.decorations.find().length, 0);
  // 关着时文档变化不重算。
  apply(state.tr.insertText("猫", 1));
  assert.equal(findKey.getState(state).matches.length, 0);
});
