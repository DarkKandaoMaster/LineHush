import test from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { extensions } from "../../src/editor/schema.ts";
import { rangeSelection } from "../../src/editor/image-view.ts";
import { selectedNewlines } from "../../src/editor/selection-shape.ts";
import {
  documentEnd,
  firstPos,
  foldStarts,
  lineAt,
  lineSpan,
  logicalLines,
  marginRange,
} from "../../src/editor/margin.ts";

// 左栏选行（src/editor/margin.ts）的纯函数部分，用编辑器真实的 schema。
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
const spans = (d) => logicalLines(d).map((_, i, lines) => lineSpan(d, lines, i));

test("逻辑行：每个文字段落一行，一行图片从另起一行的首图到下一个另起一行之前", () => {
  // "上面" 0-4，a 4-5、b 5-6 同一行，c 6-7 另起一行，"" 7-9，d 9-10。
  const d = doc("上面", img("a", true), img("b"), img("c", true), "", img("d"));
  assert.deepEqual(logicalLines(d), [
    { start: 1, first: 0, last: 0 },
    { start: 4, first: 1, last: 2 },
    { start: 6, first: 3, last: 3 },
    { start: 8, first: 4, last: 4 },
    { start: 9, first: 5, last: 5 },
  ]);
  // 紧跟文字行的图片即使 newline 为假也开一行；文档开头的图片同样。
  assert.deepEqual(
    logicalLines(doc(img("a"), img("b"), "x", img("c"))).map((l) => [l.start, l.first, l.last]),
    [[0, 0, 1], [3, 2, 2], [5, 3, 3]],
  );
});

test("每行的选区：到下一行行首（含换行），最后一行只到行尾", () => {
  const d = doc("上面", img("a", true), img("b"), img("c", true), "", img("d"));
  assert.deepEqual(spans(d), [
    { from: 1, to: 4 },
    { from: 4, to: 6 },
    { from: 6, to: 8 },
    { from: 8, to: 9 },
    { from: 9, to: 10 },
  ]);
  // 最后一行是文字：到它的文字末尾。
  const t = doc("我", "", "你们");
  assert.equal(documentEnd(t), 8);
  assert.deepEqual(spans(t), [
    { from: 1, to: 4 },
    { from: 4, to: 6 },
    { from: 6, to: 8 },
  ]);
  // 空文档只有一个空行：选区为空（就是光标）。
  assert.deepEqual(spans(doc("")), [{ from: 1, to: 1 }]);
});

test("选中一行文字时它的换行算作选中，最后一行没有换行", () => {
  const d = doc("我", "", "你");
  const [first, empty, last] = spans(d);
  const newlines = (span) =>
    selectedNewlines(d, rangeSelection(d, span.from, span.to));
  assert.deepEqual(newlines(first), [0]);
  assert.deepEqual(newlines(empty), [3]);
  assert.deepEqual(newlines(last), []);
  // 文字行后面是图片行：选区到图片行之前，是 BlockRange，换行同样选中。
  const m = doc("我", img("a"));
  const [line] = spans(m);
  const sel = rangeSelection(m, line.from, line.to);
  assert.equal(sel.toJSON().type, "blockRange");
  assert.deepEqual(selectedNewlines(m, sel), [0]);
  // 图片行后面是文字行：从图片之前到下一行行首。
  const r = doc(img("a"), "你");
  assert.deepEqual(spans(r)[0], { from: 0, to: 2 });
  assert.deepEqual(rangeSelection(r, 0, 2).toJSON(), { type: "blockRange", anchor: 0, head: 2 });
});

test("由 y 求行：行内即该行，上下越界钳到首末行，空隙归更近的一行（一样近归下面）", () => {
  const rows = [
    { top: 10, bottom: 30 },
    { top: 30, bottom: 50 },
    { top: 60, bottom: 80 },
  ];
  let measured = 0;
  const rectOf = (i) => {
    measured++;
    return rows[i];
  };
  assert.equal(lineAt(3, rectOf, 20), 0);
  assert.equal(lineAt(3, rectOf, 30), 0);
  assert.equal(lineAt(3, rectOf, 31), 1);
  assert.equal(lineAt(3, rectOf, 70), 2);
  assert.equal(lineAt(3, rectOf, -100), 0);
  assert.equal(lineAt(3, rectOf, 1000), 2);
  assert.equal(lineAt(3, rectOf, 53), 1);
  assert.equal(lineAt(3, rectOf, 57), 2);
  assert.equal(lineAt(3, rectOf, 55), 2);
  assert.equal(lineAt(0, rectOf, 10), -1);
  assert.equal(lineAt(1, rectOf, 1000), 0);
  // 二分查找：一万行里也只量十几行。
  measured = 0;
  const many = (i) => {
    measured++;
    return { top: i * 20, bottom: i * 20 + 20 };
  };
  assert.equal(lineAt(10000, many, 123456), 6172);
  assert.ok(measured < 30, `measured ${measured}`);
});

test("折首位置：单调条件下二分查找第一个满足的位置", () => {
  assert.equal(firstPos(5, 20, (pos) => pos >= 12), 12);
  assert.equal(firstPos(5, 20, () => true), 5);
  assert.equal(firstPos(5, 20, () => false), 20);
  assert.equal(firstPos(7, 7, () => false), 7);
});

test("图片按顶边分折：顶边相差不到 1px 为同一折", () => {
  assert.deepEqual(foldStarts([10, 10, 10.4, 120, 120, 230]), [0, 3, 5]);
  assert.deepEqual(foldStarts([10]), [0]);
  assert.deepEqual(foldStarts([]), []);
});

test("锚行与当前行：向下 anchor 在锚行首、head 在当前行下一行行首；向上 anchor 在锚行末、head 在当前行首", () => {
  const d = doc("一", "二", "三", "四");
  const [a, b, c, e] = spans(d);
  const line = (span) => ({ kind: "line", span });
  // 同一行：整行。
  assert.deepEqual(marginRange(line(b), b), { anchor: b.from, head: b.to });
  // 向下。
  assert.deepEqual(marginRange(line(b), c), { anchor: b.from, head: c.to });
  assert.deepEqual(marginRange(line(b), e), { anchor: b.from, head: e.to });
  // 向上。
  assert.deepEqual(marginRange(line(c), a), { anchor: c.to, head: a.from });
  // 两行的并集含锚行与当前行的换行（最后一行没有）。
  const sel = (r) => rangeSelection(d, r.anchor, r.head);
  assert.deepEqual(selectedNewlines(d, sel(marginRange(line(b), c))), [3, 6]);
  assert.deepEqual(selectedNewlines(d, sel(marginRange(line(c), a))), [0, 3, 6]);
  assert.deepEqual(selectedNewlines(d, sel(marginRange(line(c), e))), [6]);
});

test("锚点（Shift+单击而上一次选区不是左栏的）：点击行在下方扩到行末，在上方扩到行首", () => {
  const d = doc("一二", "三四", "五六");
  const [a, b, c] = spans(d); // {1,5} {5,9} {9,11}
  const point = (pos) => ({ kind: "point", pos });
  // 锚点在第 2 行中间：点第 3 行扩到行末，点第 1 行扩到行首。
  assert.deepEqual(marginRange(point(6), c), { anchor: 6, head: c.to });
  assert.deepEqual(marginRange(point(6), a), { anchor: 6, head: a.from });
  // 点锚点所在的行：扩到它的行末（下一行行首）。
  assert.deepEqual(marginRange(point(6), b), { anchor: 6, head: b.to });
  // 锚点正在某行行首：那一行算在下方；正在上一行的下一行行首：上一行在上方。
  assert.deepEqual(marginRange(point(5), b), { anchor: 5, head: b.to });
  assert.deepEqual(marginRange(point(5), a), { anchor: 5, head: a.from });
});
