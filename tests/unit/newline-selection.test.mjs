import test from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { extensions } from "../../src/editor/schema.ts";
import { selectedNewlines, selectionCounts } from "../../src/editor/selection-shape.ts";
import { BlockRange, rangeSelection } from "../../src/editor/image-view.ts";
import { fromEditor, stats } from "../../src/core/document.ts";

// The editor's real schema (paragraphs of plain text, one node per image).
const schema = getSchema(
  extensions({ preview() {}, source: async () => "", copy() {}, stage() {} }),
);
/** Strings are text lines (possibly empty). */
const doc = (...lines) =>
  schema.nodes.doc.create(
    null,
    lines.map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null)),
  );
const range = (d, from, to) => selectedNewlines(d, TextSelection.create(d, from, to));

test("折叠的选区不选中任何换行", () => {
  const d = doc("我", "", "你");
  assert.deepEqual(range(d, 2, 2), []);
  assert.deepEqual(range(d, 4, 4), []);
});

test("从行末选到下一行行首：只有这一行的换行被选中", () => {
  // [我] at 0 (size 3), [] at 3 (size 2), [你] at 5.
  const d = doc("我", "", "你");
  assert.deepEqual(range(d, 2, 4), [0]);
  // Backwards selection: same newline.
  assert.deepEqual(selectedNewlines(d, TextSelection.create(d, 4, 2)), [0]);
  // Selecting text inside one line, up to its end: no newline.
  assert.deepEqual(range(d, 1, 2), []);
  // The empty line's own break, from its start to the next line's start.
  assert.deepEqual(range(d, 4, 6), [3]);
});

test("跨三行的选区：被跨过的每一行的换行都被选中，终点所在行不算", () => {
  // [ab] at 0, [cd] at 4, [ef] at 8, [gh] at 12.
  const d = doc("ab", "cd", "ef", "gh");
  assert.deepEqual(range(d, 2, 10), [0, 4]);
  assert.deepEqual(range(d, 1, 13), [0, 4, 8]);
  // Ending at the very end of a line (before its break): that break is not selected.
  assert.deepEqual(range(d, 1, 11), [0, 4]);
});

test("全选：最后一行后面没有换行，不算", () => {
  const d = doc("ab", "", "cd");
  assert.deepEqual(selectedNewlines(d, new AllSelection(d)), [0, 4]);
  assert.deepEqual(selectedNewlines(doc("ab"), new AllSelection(doc("ab"))), []);
});

// 状态栏的选中计数（selectionCounts）：文字按码点数，换行算 1 个字符，每个块（图片 / 视频 / 音频 / 文件）算一个附件。
const img = (id, newline = false, kind) =>
  schema.nodes.image.create({ id, name: `${id}.png`, width: 40, height: 30, newline, ...(kind ? { kind } : {}) });
/** 字符串为文字行（可空），其余为图片节点。 */
const mixed = (...nodes) =>
  schema.nodes.doc.create(
    null,
    nodes.map((node) =>
      typeof node === "string"
        ? schema.nodes.paragraph.create(null, node ? schema.text(node) : null)
        : node,
    ),
  );
const count = (d, from, to) => selectionCounts(d, rangeSelection(d, from, to));
const total = (d) => stats(fromEditor(d.toJSON())).characters;

test("选中计数：空选区为 null；一行内按码点数，emoji 与汉字各算 1", () => {
  // [我😀ab] at 0：我 1，😀 2-4（两个 UTF-16 单元），a 4，b 5，段尾 6。
  const d = mixed("我😀ab", "下");
  assert.equal(selectionCounts(d, TextSelection.create(d, 2, 2)), null);
  assert.deepEqual(count(d, 1, 6), { characters: 4, attachments: 0 });
  assert.deepEqual(count(d, 2, 4), { characters: 1, attachments: 0 });
  assert.deepEqual(count(d, 6, 1), { characters: 4, attachments: 0 });
});

test("选中计数：什么也没盖住（空文档 Ctrl+A）为 null，同记事本不显示已选", () => {
  const d = doc("");
  assert.equal(selectionCounts(d, new AllSelection(d)), null);
});

test("选中计数：跨行时每个被跨过的换行算 1，只选中换行为 1，空行的换行也算", () => {
  // [ab] 0-4，[] 4-6，[cd] 6-10。
  const d = mixed("ab", "", "cd");
  // 只选中第一行的换行：行末到下一行行首。
  assert.deepEqual(count(d, 3, 5), { characters: 1, attachments: 0 });
  // 空行的换行：空行行首到下一行行首。
  assert.deepEqual(count(d, 5, 7), { characters: 1, attachments: 0 });
  // b + 换行 + 换行 + c。
  assert.deepEqual(count(d, 2, 8), { characters: 4, attachments: 0 });
  // 全选：最后一行后面没有换行，与总数一致。
  assert.deepEqual(selectionCounts(d, new AllSelection(d)), { characters: 6, attachments: 0 });
  assert.equal(total(d), 6);
});

test("选中计数：图片不算字符；文字行与图片行之间、两行图片之间的换行算 1，同一行的图片之间不算", () => {
  // "甲" 0-3，a 3-4（行首）b 4-5 同一行，c 5-6 另起一行，v 6-7 视频同一行，"乙" 7-10。
  const d = mixed("甲", img("a", true), img("b"), img("c", true), img("v", false, "video"), "乙");
  // 甲 + 换行 + a + b + 换行（另起一行）+ c + v + 换行 + 乙。
  assert.deepEqual(selectionCounts(d, new AllSelection(d)), { characters: 5, attachments: 4 });
  assert.equal(total(d), 5);
  // 同一行两张图：不含换行。
  assert.deepEqual(count(d, 3, 5), { characters: 0, attachments: 2 });
  // 只选中一行的最后一张：它后面的换行不算（终点在换行之前）。
  assert.deepEqual(count(d, 4, 5), { characters: 0, attachments: 1 });
  // 跨过两行图片之间的换行。
  assert.deepEqual(count(d, 4, 6), { characters: 1, attachments: 2 });
  // 视频也算一个附件。
  assert.deepEqual(count(d, 5, 7), { characters: 0, attachments: 2 });
  // 文字行末到行首图片之前（BlockRange）：只有那个换行。
  const sel = rangeSelection(d, 2, 3);
  assert.ok(sel instanceof BlockRange);
  assert.deepEqual(selectionCounts(d, sel), { characters: 1, attachments: 0 });
  // 图片之后到下一行文字行首：只有那个换行。
  assert.deepEqual(count(d, 7, 8), { characters: 1, attachments: 0 });
  // 只选中行首图片：前面的换行不算。
  assert.deepEqual(count(d, 3, 4), { characters: 0, attachments: 1 });
  // 从文字中间选到最后一行图片之后：甲 + 换行 + 四张 + 一个换行。
  assert.deepEqual(count(d, 1, 7), { characters: 3, attachments: 4 });
});

test("选中计数：空行夹在图片之间，文件与音频也各算一个附件", () => {
  // a 0-1，"" 1-3，f 3-4 文件（行首），m 4-5 音频同一行。
  const d = mixed(img("a", true), "", img("f", true, "file"), img("m", false, "audio"));
  assert.deepEqual(selectionCounts(d, new AllSelection(d)), { characters: 2, attachments: 3 });
  assert.equal(total(d), 2);
  // 图片之后到空行行首：图片后的换行；空行行首到下一张图之前：空行的换行。
  assert.deepEqual(count(d, 1, 2), { characters: 1, attachments: 0 });
  assert.deepEqual(count(d, 2, 3), { characters: 1, attachments: 0 });
  assert.deepEqual(count(d, 1, 3), { characters: 2, attachments: 0 });
});

test("总数：文字码点 + 块数 - 1（每两块之间一个换行），空文档为 0；每个块一个附件", () => {
  assert.equal(stats({ blocks: [{ type: "line", text: "" }] }).characters, 0);
  assert.equal(stats({ blocks: [] }).characters, 0);
  assert.equal(stats({ blocks: [{ type: "line", text: "" }, { type: "line", text: "" }] }).characters, 1);
  // 一行里一张图片、一个文件：两个附件，块之间各一个换行。
  assert.deepEqual(
    stats({
      blocks: [
        { type: "line", text: "我😀" },
        {
          type: "images",
          images: [
            { id: "a", name: "a", width: 1, height: 1 },
            { id: "b", name: "b.txt", width: 0, height: 0, kind: "file", size: 3 },
          ],
        },
        { type: "line", text: "" },
      ],
    }),
    { characters: 4, attachments: 2 },
  );
});
