import test from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { extensions } from "../../src/editor/schema.ts";
import { selectedNewlines } from "../../src/editor/selection-shape.ts";

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
