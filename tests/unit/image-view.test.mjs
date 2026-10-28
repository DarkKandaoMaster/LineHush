import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSchema } from "@tiptap/core";
import {
  AllSelection,
  EditorState,
  NodeSelection,
  TextSelection,
} from "@tiptap/pm/state";
import { closeHistory, history, undo } from "@tiptap/pm/history";
import { extensions } from "../../src/editor/schema.ts";
import { fromEditor } from "../../src/core/document.ts";
import {
  BlockRange,
  besideImage,
  caretAt,
  caretSpot,
  deleteBlocks,
  enterKey,
  extendByImage,
  imagePlugin,
  spotBy,
  insertImages,
  joinAt,
  leaveImages,
  lineOf,
  moveCaret,
  placeRows,
  removeNear,
  removeRange,
  rowBreak,
  selectedImages,
  selectionBetween,
  typeBetween,
  BLOCKS_MIME,
  blockNodes,
  blockPictures,
  clipboardBlocks,
  insertBlocks,
  mixedSlice,
  sliceBlocks,
  withoutPictures,
} from "../../src/editor/image-view.ts";

// The editor's real schema (paragraphs of plain text, one node per image).
const schema = getSchema(
  extensions({ preview() {}, source: async () => "", copy() {}, stage() {} }),
);
const img = (id, newline = false) =>
  schema.nodes.image.create({ id, name: `${id}.png`, width: 40, height: 30, newline });
/** Strings are text lines (possibly empty), other values image nodes. */
const doc = (...nodes) =>
  schema.nodes.doc.create(
    null,
    nodes.map((node) =>
      typeof node === "string"
        ? schema.nodes.paragraph.create(null, node ? schema.text(node) : null)
        : node,
    ),
  );
const plugin = imagePlugin(
  () => {},
  () => {},
);
const stateOf = (d, selection) =>
  EditorState.create({ doc: d, selection, plugins: [plugin] });
const caret = (d, pos) => stateOf(d, new BlockRange(d.resolve(pos)));
const text = (d, pos) => stateOf(d, TextSelection.create(d, pos));
/** Lines as their text, images as [id]. */
const content = (state) => {
  const out = [];
  state.doc.forEach((node) =>
    out.push(node.type.name === "image" ? `[${node.attrs.id}]` : node.textContent),
  );
  return out;
};
/** "caret 3" for the caret between blocks, "text 2" for a text caret, else the class and range. */
const where = (state) => {
  const sel = state.selection;
  if (sel instanceof BlockRange && sel.empty) return `caret ${sel.head}`;
  if (sel instanceof TextSelection && sel.empty) return `text ${sel.head}`;
  return `${sel.constructor.name} ${sel.from}-${sel.to}`;
};
function run(state, command, view) {
  let next = state;
  const handled = command(state, (tr) => (next = state.apply(tr)), view);
  return { handled, state: next };
}
/** Enough of an EditorView for the plugin's props. */
function fakeView(state, rect = { left: 100, right: 200 }) {
  const view = {
    state,
    composing: false,
    editable: true,
    dispatch(tr) {
      view.state = view.state.apply(tr);
    },
    nodeDOM: () => ({ getBoundingClientRect: () => rect }),
    // No DOM selection (createSelectionBetween keeps an anchor the DOM still has).
    dom: { ownerDocument: { getSelection: () => null } },
  };
  return view;
}
const decorations = (state) =>
  (plugin.props.decorations.call(plugin, state)?.find() ?? []).map(
    (d) => `${d.from}-${d.to} ${d.type.attrs.class}`,
  );

// "A", a, b, "B", "C": A 0-3 (text 1-2), a 3-4, b 4-5, B 5-8, C 8-11.
const mixed = doc("A", img("a"), img("b"), "B", "C");

test("块间光标只停在至少一侧是图片的位置，两行文字之间不停", () => {
  assert.equal(caretSpot(mixed.resolve(3)), true); // A | a
  assert.equal(caretSpot(mixed.resolve(4)), true); // a | b
  assert.equal(caretSpot(mixed.resolve(5)), true); // b | B
  assert.equal(caretSpot(mixed.resolve(8)), false); // B | C
  const edges = doc(img("a"), "A");
  assert.equal(caretSpot(edges.resolve(0)), true); // document start | a
  assert.equal(caretSpot(doc("A", img("a")).resolve(4)), true); // a | document end
  // caretAt: next to an image a collapsed BlockRange, between lines the near end of a line.
  assert.equal(where(stateOf(mixed, caretAt(mixed, 3, 1))), "caret 3");
  assert.equal(where(stateOf(mixed, caretAt(mixed, 8, 1))), "text 9");
  assert.equal(where(stateOf(mixed, caretAt(mixed, 8, -1))), "text 7");
  // The caret is drawn by the plugin, not by the browser.
  assert.equal(new BlockRange(mixed.resolve(3)).visible, false);
  assert.equal(new BlockRange(mixed.resolve(3), mixed.resolve(4)).visible, true);
});

test("左右键把图片当作一个字符：每经过图文边界多一个停靠点", () => {
  const steps = (state, dir, count) => {
    const seen = [];
    for (let i = 0; i < count; i++) {
      const result = run(state, moveCaret(dir));
      if (!result.handled) {
        seen.push("browser");
        break;
      }
      state = result.state;
      seen.push(where(state));
    }
    return seen;
  };
  // From the end of A: A|a, a|b, b|B, then the start of B; inside B the browser moves.
  assert.deepEqual(steps(text(mixed, 2), 1, 5), [
    "caret 3",
    "caret 4",
    "caret 5",
    "text 6",
    "browser",
  ]);
  assert.deepEqual(steps(text(mixed, 6), -1, 5), [
    "caret 5",
    "caret 4",
    "caret 3",
    "text 2",
    "browser",
  ]);
  // From the end of B into C: no stop between two text lines.
  assert.equal(run(text(mixed, 7), moveCaret(1)).handled, false);
  // The document edge next to an image is a stop; beyond it nothing moves.
  const edges = doc(img("a"), "A");
  assert.deepEqual(steps(text(edges, 2), -1, 3), ["caret 1", "caret 0", "caret 0"]);
  // Selected images collapse toward the key.
  const range = stateOf(mixed, new BlockRange(mixed.resolve(3), mixed.resolve(5)));
  assert.equal(where(run(range, moveCaret(-1)).state), "caret 3");
  assert.equal(where(run(range, moveCaret(1)).state), "caret 5");
  assert.equal(
    where(run(stateOf(mixed, NodeSelection.create(mixed, 3)), moveCaret(1)).state),
    "caret 4",
  );
});

test("单击图片按左右半区把光标放到图片前 / 后，不产生节点选中", () => {
  const image = mixed.nodeAt(3);
  const rect = { left: 100, right: 200 };
  assert.deepEqual(spotBy(3, image, 120, rect), { pos: 3, side: 1 });
  assert.deepEqual(spotBy(3, image, 149, rect), { pos: 3, side: 1 });
  assert.deepEqual(spotBy(3, image, 150, rect), { pos: 4, side: -1 });
  assert.deepEqual(spotBy(3, image, 199, rect), { pos: 4, side: -1 });
  const click = (clientX, direct = true) => {
    const view = fakeView(text(mixed, 1), rect);
    const handled = plugin.props.handleClickOn.call(
      plugin,
      view,
      3,
      image,
      3,
      { clientX },
      direct,
    );
    return { handled, state: view.state };
  };
  const left = click(110);
  assert.equal(left.handled, true);
  assert.equal(where(left.state), "caret 3");
  const right = click(190);
  assert.equal(where(right.state), "caret 4");
  assert.ok(!(right.state.selection instanceof NodeSelection));
  // Only a click on the image itself (not on a line around it) is taken.
  assert.equal(click(190, false).handled, false);
  // A double click keeps the caret (the tile opens the preview itself).
  assert.equal(
    plugin.props.handleDoubleClickOn.call(plugin, fakeView(left.state), 3, image, 3, {}, true),
    true,
  );
  // A DOM caret between blocks next to an image stays there.
  const between = plugin.props.createSelectionBetween.call(
    plugin,
    fakeView(left.state),
    mixed.resolve(5),
    mixed.resolve(5),
  );
  assert.ok(between instanceof BlockRange && between.empty);
  assert.equal(
    plugin.props.createSelectionBetween.call(
      plugin,
      fakeView(left.state),
      mixed.resolve(8),
      mixed.resolve(8),
    ),
    null,
  );
});

test("拖选的一端落在图片旁的块间位置时保留在那里，范围包含图片", () => {
  // "文本1" 0-5 (text 1-4), a 5-6: the document ends with the image.
  const d = doc("文本1", img("a"));
  const between = (anchor, head) => {
    const sel = selectionBetween(d.resolve(anchor), d.resolve(head));
    return sel && `${sel.constructor.name} ${sel.anchor}-${sel.head}`;
  };
  // From the text to past the last image, and back: the image is in the range.
  assert.equal(between(1, 6), "BlockRange 1-6");
  assert.equal(between(6, 1), "BlockRange 6-1");
  assert.deepEqual(
    decorations(stateOf(d, selectionBetween(d.resolve(1), d.resolve(6)))),
    ["5-6 image-selected"],
  );
  // A DOM caret there is the caret between blocks; text ranges are ProseMirror's.
  assert.equal(between(6, 6), "BlockRange 6-6");
  assert.equal(between(1, 3), null);
  // Mirrored: the document starts with the image.
  const first = doc(img("a"), "文本1");
  const sel = selectionBetween(first.resolve(5), first.resolve(0));
  assert.ok(sel instanceof BlockRange);
  assert.equal(`${sel.anchor}-${sel.head}`, "5-0");
  // Between two text lines the end is snapped into text as usual.
  const lines = doc("A", "B");
  assert.equal(selectionBetween(lines.resolve(1), lines.resolve(3)), null);
});

test("块间光标处打字：文字落到新起的一行，图片仍独占一行", () => {
  const d = doc(img("a"), "B");
  const typed = run(caret(d, 1), typeBetween("你好"));
  assert.equal(typed.handled, true);
  assert.deepEqual(content(typed.state), ["[a]", "你好", "B"]);
  assert.equal(where(typed.state), "text 4"); // after 你好
  // Before an image, between images, at the document's start.
  assert.deepEqual(content(run(caret(d, 0), typeBetween("x")).state), ["x", "[a]", "B"]);
  const pair = doc(img("a"), img("b"));
  assert.deepEqual(content(run(caret(pair, 1), typeBetween("x")).state), ["[a]", "x", "[b]"]);
  // Not at a caret between blocks: the editor's own typing.
  assert.equal(run(text(d, 2), typeBetween("x")).handled, false);
  // Keypresses reach the plugin through handleTextInput.
  const view = fakeView(caret(d, 1));
  assert.equal(plugin.props.handleTextInput.call(plugin, view, 1, 1, "字", () => null), true);
  assert.deepEqual(content(view.state), ["[a]", "字", "B"]);
  // Text inserted without a keypress (input method commit, emoji panel).
  const input = fakeView(caret(d, 1));
  let prevented = false;
  const event = {
    inputType: "insertText",
    data: "词",
    preventDefault: () => (prevented = true),
  };
  assert.equal(plugin.props.handleDOMEvents.beforeinput.call(plugin, input, event), true);
  assert.equal(prevented, true);
  assert.deepEqual(content(input.state), ["[a]", "词", "B"]);
  // A composition first gets an empty line with the caret in it, then fills it.
  const ime = fakeView(caret(d, 1));
  assert.equal(plugin.props.handleDOMEvents.compositionstart.call(plugin, ime, {}), false);
  assert.deepEqual(content(ime.state), ["[a]", "", "B"]);
  assert.equal(where(ime.state), "text 2");
  const late = fakeView(caret(d, 1));
  assert.equal(
    plugin.props.handleDOMEvents.beforeinput.call(plugin, late, {
      inputType: "insertCompositionText",
      data: "n",
      preventDefault: () => assert.fail("the composition must go on"),
    }),
    false,
  );
  assert.deepEqual(content(late.state), ["[a]", "", "B"]);
});

test("Backspace：图片后的行首，空行删掉该行、光标停到图片后；非空行什么也不做", () => {
  // a 0-1, empty line 1-3 (caret 2), B 3-6.
  const empty = run(text(doc(img("a"), "", "B"), 2), removeNear(-1));
  assert.equal(empty.handled, true);
  assert.deepEqual(content(empty.state), ["[a]", "B"]);
  assert.equal(where(empty.state), "caret 1");
  const full = text(doc(img("a"), "文字"), 2);
  const kept = run(full, removeNear(-1));
  assert.equal(kept.handled, true);
  assert.equal(kept.state, full);
  // Not at the start of the line, or no image before it: the editor's own Backspace.
  assert.equal(run(text(doc(img("a"), "文字"), 3), removeNear(-1)).handled, false);
  assert.equal(run(text(doc("A", ""), 4), removeNear(-1)).handled, false);
});

test("Delete：图片前的行末，空行删掉该行、光标停到图片前；非空行什么也不做", () => {
  const empty = run(text(doc("", img("a")), 1), removeNear(1));
  assert.equal(empty.handled, true);
  assert.deepEqual(content(empty.state), ["[a]"]);
  assert.equal(where(empty.state), "caret 0");
  const full = text(doc("文字", img("a")), 3);
  const kept = run(full, removeNear(1));
  assert.equal(kept.handled, true);
  assert.equal(kept.state, full);
  assert.equal(run(text(doc("文字", img("a")), 2), removeNear(1)).handled, false);
});

test("块间光标旁 Backspace / Delete 删相邻图片；相邻是文字行时同样只删空行", () => {
  // Backspace after an image removes it; the caret goes to the near line.
  const removed = run(caret(mixed, 5), removeNear(-1));
  assert.deepEqual(content(removed.state), ["A", "[a]", "B", "C"]);
  assert.equal(where(removed.state), "caret 4");
  const del = run(caret(mixed, 3), removeNear(1));
  assert.deepEqual(content(del.state), ["A", "[b]", "B", "C"]);
  assert.equal(where(del.state), "caret 3");
  // A line with text next to the caret stays.
  const kept = run(caret(mixed, 3), removeNear(-1));
  assert.equal(kept.handled, true);
  assert.deepEqual(content(kept.state), content(caret(mixed, 3)));
  // An empty one goes, and the caret stays by the image.
  const blank = run(caret(doc("", img("a")), 2), removeNear(-1));
  assert.deepEqual(content(blank.state), ["[a]"]);
  assert.equal(where(blank.state), "caret 0");
  // At the document's edge there is nothing to remove.
  assert.equal(run(caret(doc(img("a")), 0), removeNear(-1)).handled, true);
});

test("块间光标随编辑映射，失效时退回文字行", () => {
  const state = caret(doc("A", img("a"), "B"), 3);
  const next = state.apply(state.tr.delete(3, 4));
  assert.deepEqual(content(next), ["A", "B"]);
  assert.equal(where(next), "text 4");
  // Still next to an image: still the caret between blocks.
  const kept = state.apply(state.tr.insert(0, schema.nodes.paragraph.create()));
  assert.equal(where(kept), "caret 5");
});

test("Shift+左右从块间光标选中整张图，上下键离开整串图片", () => {
  const extended = run(caret(mixed, 3), extendByImage(1)).state;
  assert.equal(where(extended), "BlockRange 3-4");
  assert.deepEqual(
    selectedImages(extended.selection).pictures.map((p) => p.id),
    ["a"],
  );
  // Up / Down from the caret, or from selected images, leave the whole run.
  assert.equal(where(run(caret(mixed, 4), leaveImages(-1)).state), "text 2");
  assert.equal(where(run(caret(mixed, 4), leaveImages(1)).state), "text 6");
  const last = doc("A", img("a"));
  const inserted = stateOf(last, new BlockRange(last.resolve(3), last.resolve(4)));
  assert.equal(where(run(inserted, leaveImages(1)).state), "caret 4");
  assert.equal(run(text(mixed, 1), leaveImages(1)).handled, false);
});

test("光标画在相邻图片旁（besideImage），范围选区内的图片加 image-selected", () => {
  const beside = (d, pos, side = -1) => besideImage(d.resolve(pos), side);
  assert.deepEqual(beside(mixed, 3), { pos: 3, after: false }); // line | image
  assert.deepEqual(beside(mixed, 4), { pos: 3, after: true }); // image | image
  assert.deepEqual(beside(mixed, 4, 1), { pos: 3, after: true }); // the same row
  assert.deepEqual(beside(mixed, 5), { pos: 4, after: true }); // image | line
  assert.deepEqual(beside(doc(img("a"), "A"), 0), { pos: 0, after: false });
  assert.deepEqual(beside(doc("A", img("a")), 4), { pos: 3, after: true });
  assert.equal(beside(mixed, 8), null); // line | line
  // The caret is the editor's own (caret.ts); the plugin draws nothing for it.
  assert.deepEqual(decorations(caret(mixed, 4)), []);
  assert.deepEqual(decorations(text(mixed, 2)), []);
  const range = stateOf(mixed, new BlockRange(mixed.resolve(3), mixed.resolve(5)));
  assert.deepEqual(decorations(range), ["3-4 image-selected", "4-5 image-selected"]);
  const across = stateOf(mixed, TextSelection.create(mixed, 1, 7));
  assert.deepEqual(decorations(across), ["3-4 image-selected", "4-5 image-selected"]);
});

test("选中图片的样式是与文字选区同色的半透明蒙层，没有蓝框", () => {
  const css = readFileSync(new URL("../../src/App.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.replace(/\/\*[\s\S]*?\*\//g, "").trim(),
    body,
  }));
  // The text selection is drawn by the editor (caret.ts) in --selection, the
  // active or the inactive colour by the editor's focus; the overlay uses the same.
  assert.match(
    rules.find((r) => r.selector === ".selection-layer path").body,
    /fill:\s*var\(--selection\)/,
  );
  const selected = rules.filter((r) =>
    /image-selected|ProseMirror-selectednode/.test(r.selector),
  );
  assert.ok(selected.length > 0);
  for (const rule of selected) assert.doesNotMatch(rule.body, /outline|border/);
  assert.ok(
    selected.some(
      (r) => /background:\s*var\(--selection\)/.test(r.body) && /opacity:\s*0\.5/.test(r.body),
    ),
    "overlay in var(--selection) at opacity 0.5",
  );
});

// ---- Rows of images (2026-10-22): an image with `newline` starts a new row. ----

/** An image starting a new row after the image before it (a line break between them). */
const row = (id) => img(id, true);
/** Lines as their text, each row of images as "[a b]". */
const layout = (state) => {
  const out = [];
  let image = false;
  state.doc.forEach((node) => {
    if (node.type.name !== "image") {
      out.push(node.textContent);
      image = false;
      return;
    }
    if (image && !node.attrs.newline)
      out[out.length - 1] = `${out[out.length - 1].slice(0, -1)} ${node.attrs.id}]`;
    else out.push(`[${node.attrs.id}]`);
    image = true;
  });
  return out;
};
/** Like `where`, with the side of a caret between blocks. */
const spot = (state) => {
  const sel = state.selection;
  return sel instanceof BlockRange && sel.empty
    ? `caret ${sel.head} ${sel.side}`
    : where(state);
};
const caretOn = (d, pos, side) => stateOf(d, new BlockRange(d.resolve(pos), undefined, side));
const decorationsWithSpacers = (state) =>
  (plugin.props.decorations.call(plugin, state)?.find() ?? [])
    .map((d) => `${d.from}-${d.to} ${d.type.attrs?.class ?? d.spec.key}`)
    .sort();

/** Inserts new images (by id) at the selection, as an import or a paste does. */
function insert(state, ...ids) {
  return insertNodes(state, ids.map((id) => img(id)));
}
function insertNodes(state, nodes) {
  const tr = state.tr;
  const range = insertImages(tr, nodes);
  return { state: state.apply(tr), range };
}

test("插入图片：块间光标处就地插入、并入那一行", () => {
  // Caret between two images of one row: inside that row.
  const pair = doc(img("a"), img("b"));
  const between = insert(caret(pair, 1), "n");
  assert.deepEqual(layout(between.state), ["[a n b]"]);
  assert.deepEqual(between.range, { from: 1, to: 2 });
  assert.equal(spot(between.state), "caret 2 -1");
  // Caret after a final image: appended to its row.
  const end = insert(caret(doc("A", img("a")), 4), "n");
  assert.deepEqual(layout(end.state), ["A", "[a n]"]);
  assert.equal(where(end.state), "caret 5");
  // Caret between a line and an image: before the image, in its row.
  const before = insert(caret(doc("A", img("a")), 3), "n");
  assert.deepEqual(layout(before.state), ["A", "[n a]"]);
  assert.equal(where(before.state), "caret 4");
});

/** `state` with the images `from`..`to` selected (one image: a NodeSelection). */
const imagesOn = (d, from, to) =>
  stateOf(
    d,
    to === from + 1
      ? NodeSelection.create(d, from)
      : new BlockRange(d.resolve(from), d.resolve(to)),
  );
const newlines = (state) => {
  const out = [];
  state.doc.forEach((node) => {
    if (node.type.name === "image") out.push(node.attrs.newline);
  });
  return out;
};

test("插入图片：选中图片时替换掉它们，新图片接替它们所在的行", () => {
  // The first image of a row (after a row): the new one starts that row.
  const first = insert(imagesOn(doc(img("z"), row("a"), img("b")), 1, 2), "n");
  assert.deepEqual(layout(first.state), ["[z]", "[n b]"]);
  assert.deepEqual(newlines(first.state), [false, true, false]);
  assert.deepEqual(first.range, { from: 1, to: 2 });
  assert.equal(spot(first.state), "caret 2 -1");
  // The first image of a row below a text line.
  const belowLine = insert(imagesOn(doc("A", row("a"), img("b")), 3, 4), "n");
  assert.deepEqual(layout(belowLine.state), ["A", "[n b]"]);
  assert.deepEqual(newlines(belowLine.state), [true, false]);
  // Inside a row, and at its end: the new one stays in that row.
  const middle = insert(imagesOn(doc(img("a"), img("b"), img("c")), 1, 2), "n");
  assert.deepEqual(layout(middle.state), ["[a n c]"]);
  assert.equal(spot(middle.state), "caret 2 -1");
  const end = insert(imagesOn(doc(img("a"), img("b"), row("y")), 1, 2), "n");
  assert.deepEqual(layout(end.state), ["[a n]", "[y]"]);
  assert.equal(spot(end.state), "caret 2 -1");
  // A whole row (between rows, or below a line): the new ones make a row of their own.
  const whole = insert(imagesOn(doc(img("z"), row("a"), img("b"), row("y")), 1, 3), "n", "m");
  assert.deepEqual(layout(whole.state), ["[z]", "[n m]", "[y]"]);
  assert.deepEqual(whole.range, { from: 1, to: 3 });
  assert.equal(spot(whole.state), "caret 3 -1");
  const wholeBelowLine = insert(imagesOn(doc("A", row("a"), img("b"), row("y"), "B"), 3, 5), "n");
  assert.deepEqual(layout(wholeBelowLine.state), ["A", "[n]", "[y]", "B"]);
  // Two rows selected: one row of the new ones.
  const across = insert(imagesOn(doc(img("a"), row("b")), 0, 2), "n");
  assert.deepEqual(layout(across.state), ["[n]"]);
  // A range ending inside a row: the rest of that row joins the new ones.
  const partial = insert(imagesOn(doc(img("a"), img("b"), row("c"), img("d")), 1, 3), "n");
  assert.deepEqual(layout(partial.state), ["[a n d]"]);
});

test("插入图片：替换文档末尾 / 唯一的图片不留空行", () => {
  const only = insert(imagesOn(doc(img("a")), 0, 1), "n");
  assert.deepEqual(layout(only.state), ["[n]"]);
  assert.deepEqual(content(only.state), ["[n]"]);
  assert.equal(only.state.doc.childCount, 1);
  assert.deepEqual(newlines(only.state), [true]);
  assert.equal(spot(only.state), "caret 1 -1");
  const last = insert(imagesOn(doc("A", img("a")), 3, 4), "n", "m");
  assert.deepEqual(layout(last.state), ["A", "[n m]"]);
  assert.equal(last.state.doc.childCount, 3);
  assert.equal(spot(last.state), "caret 5 -1");
});

test("插入图片：选中多张替换为多张，首张之后保留各自的换行", () => {
  const rows = doc(img("z"), row("a"), img("b"), row("y"));
  const pasted = insertNodes(imagesOn(rows, 1, 3), [img("x"), row("p"), img("q")]);
  assert.deepEqual(layout(pasted.state), ["[z]", "[x]", "[p q]", "[y]"]);
  assert.deepEqual(pasted.range, { from: 1, to: 4 });
  assert.equal(spot(pasted.state), "caret 4 -1");
  // Inside a row: the first new image joins it, the rest keep their rows.
  const inRow = insertNodes(imagesOn(doc(img("a"), img("b"), img("c")), 1, 2), [row("x"), row("y")]);
  assert.deepEqual(layout(inRow.state), ["[a x]", "[y c]"]);
});

test("插入图片替换选中图片是一步撤销，撤销后原图回来", () => {
  const d = doc(img("z"), row("a"), img("b"), row("y"));
  const state = EditorState.create({
    doc: d,
    selection: new BlockRange(d.resolve(1), d.resolve(3)),
    plugins: [plugin, history()],
  });
  const tr = closeHistory(state.tr);
  insertImages(tr, [img("n")]);
  const replaced = state.apply(tr);
  assert.deepEqual(layout(replaced), ["[z]", "[n]", "[y]"]);
  const undone = run(replaced, undo).state;
  assert.deepEqual(layout(undone), ["[z]", "[a b]", "[y]"]);
  assert.deepEqual(newlines(undone), [false, true, false, true]);
});

test("插入图片：在两行图片之间的换行处，行末（side -1）并入上一行，行首（side 1）并入下一行", () => {
  const rows = doc(img("a"), row("b"));
  assert.deepEqual(layout(stateOf(rows)), ["[a]", "[b]"]);
  const end = insert(caretOn(rows, 1, -1), "n");
  assert.deepEqual(layout(end.state), ["[a n]", "[b]"]);
  assert.equal(spot(end.state), "caret 2 -1");
  const start = insert(caretOn(rows, 1, 1), "n", "m");
  assert.deepEqual(layout(start.state), ["[a]", "[n m b]"]);
  assert.equal(spot(start.state), "caret 3 -1");
  // The new first image starts the row, the old one no longer does.
  assert.deepEqual(
    [1, 2, 3].map((pos) => start.state.doc.nodeAt(pos).attrs.newline),
    [true, false, false],
  );
});

test("插入图片：在文字行上自成一行，不补空行；之后的图片另起一行", () => {
  // The report: an image, then an empty line with the caret → the new image on a row of its own below.
  const report = insert(text(doc(img("a"), ""), 2), "n");
  assert.deepEqual(layout(report.state), ["[a]", "[n]"]);
  assert.deepEqual(content(report.state), ["[a]", "[n]"]);
  assert.deepEqual(report.range, { from: 1, to: 2 });
  assert.equal(spot(report.state), "caret 2 -1");
  // Two rows in the file, one after the other.
  assert.deepEqual(
    fromEditor(report.state.doc.toJSON()).blocks.map((b) => b.images.map((p) => p.id)),
    [["a"], ["n"]],
  );
  // The empty line replaced, the image below starts a new row.
  const above = insert(text(doc("", img("a"), ""), 1), "n");
  assert.deepEqual(layout(above.state), ["[n]", "[a]", ""]);
  assert.equal(above.state.doc.nodeAt(1).attrs.newline, true);
  assert.deepEqual(above.range, { from: 0, to: 1 });
  assert.equal(spot(above.state), "caret 1 -1");
  // Images on both sides: three rows.
  const both = insert(text(doc(img("a"), "", img("b")), 2), "n");
  assert.deepEqual(layout(both.state), ["[a]", "[n]", "[b]"]);
  assert.equal(spot(both.state), "caret 2 -1");
  // No image next to it: the empty line is replaced.
  const plain = insert(text(doc("文字", ""), 5), "n");
  assert.deepEqual(layout(plain.state), ["文字", "[n]"]);
  assert.equal(where(plain.state), "caret 5");
  // The caret at the end of a line above an image: after the line, the image a row below.
  const lineEnd = insert(text(doc("文字", img("a")), 3), "n");
  assert.deepEqual(layout(lineEnd.state), ["文字", "[n]", "[a]"]);
  assert.equal(where(lineEnd.state), "caret 5");
  // At the start of a line below an image: before the line, on a row of its own.
  const lineStart = insert(text(doc(img("a"), "文字"), 2), "n");
  assert.deepEqual(layout(lineStart.state), ["[a]", "[n]", "文字"]);
  assert.equal(where(lineStart.state), "caret 2");
  // In the middle of a line: it is split, nothing is added.
  const middle = insert(text(doc("甲乙", img("a")), 2), "n");
  assert.deepEqual(layout(middle.state), ["甲", "[n]", "乙", "[a]"]);
  assert.equal(where(middle.state), "caret 4");
  // Several images: one row, the caret at its end; a second insertion there joins it.
  const several = insert(text(doc("", img("a"), ""), 1), "n", "m");
  assert.deepEqual(layout(several.state), ["[n m]", "[a]", ""]);
  assert.deepEqual(several.range, { from: 0, to: 2 });
  assert.equal(spot(several.state), "caret 2 -1");
  const again = insert(several.state, "k");
  assert.deepEqual(layout(again.state), ["[n m k]", "[a]", ""]);
  assert.equal(spot(again.state), "caret 3 -1");
});

test("插入图片是一步撤销", () => {
  const d = doc(img("a"), "", img("b"));
  const state = EditorState.create({
    doc: d,
    selection: TextSelection.create(d, 2),
    plugins: [plugin, history()],
  });
  const tr = closeHistory(state.tr);
  insertImages(tr, [img("n"), img("m")]);
  const inserted = state.apply(tr);
  assert.deepEqual(layout(inserted), ["[a]", "[n m]", "[b]"]);
  const undone = run(inserted, undo).state;
  assert.deepEqual(layout(undone), ["[a]", "", "[b]"]);
  assert.equal(undone.doc.nodeAt(3).attrs.newline, false);
});

test("粘贴复制的多行图片：第一张按落点，其余保留各自的换行", () => {
  const pasted = insertNodes(text(doc(img("a"), ""), 2), [img("x"), row("y"), img("z")]);
  assert.deepEqual(layout(pasted.state), ["[a]", "[x]", "[y z]"]);
  // Into a row from its end: the first joins it, the rest keep their rows.
  const joined = insertNodes(caret(doc(img("a")), 1), [row("x"), row("y")]);
  assert.deepEqual(layout(joined.state), ["[a x]", "[y]"]);
});

test("joinAt / placeRows：插入位置决定并入哪一行", () => {
  // a 0-1, b 1-2 (new row), c 2-3, "x" 3-6.
  const d = doc(img("a"), row("b"), img("c"), "x");
  assert.equal(rowBreak(d.resolve(1)), true);
  assert.equal(rowBreak(d.resolve(2)), false);
  assert.equal(joinAt(d.resolve(1), -1), -1); // end of the upper row
  assert.equal(joinAt(d.resolve(1), 1), 1); // start of the lower row
  assert.equal(joinAt(d.resolve(2), 1), -1); // inside a row: that row
  assert.equal(joinAt(d.resolve(3), 1), -1); // after a row, before a line
  assert.equal(joinAt(d.resolve(0), -1), 1); // before a row
  assert.equal(joinAt(doc("x", "y").resolve(3), -1), 0); // between lines: a row of its own
  const state = stateOf(d);
  const placed = (at, join) => {
    const tr = state.tr.insert(at, [img("n"), row("m")]);
    placeRows(tr, at, at + 2, join);
    return layout(state.apply(tr));
  };
  assert.deepEqual(placed(1, 1), ["[a]", "[n]", "[m b c]", "x"]);
  assert.deepEqual(placed(1, -1), ["[a n]", "[m]", "[b c]", "x"]);
  assert.deepEqual(placed(1, 0), ["[a]", "[n]", "[m]", "[b c]", "x"]);
});

test("删除图片保持行结构：删掉行首图片时下一张接过换行，删掉图片之间的空行留下换行", () => {
  const rows = doc(img("a"), row("b"), img("c"));
  // The row's first image goes: the next one starts the row; the caret at its start.
  const first = removeRange(stateOf(rows).tr, 1, 2, -1);
  assert.deepEqual(layout(stateOf(first.doc)), ["[a]", "[c]"]);
  assert.equal(spot(stateOf(first.doc, first.selection)), "caret 1 1");
  // Inside a row: the row closes up.
  const inside = removeRange(stateOf(doc(img("a"), img("b"), img("c"))).tr, 1, 2, -1);
  assert.deepEqual(layout(stateOf(inside.doc)), ["[a c]"]);
  assert.equal(spot(stateOf(inside.doc, inside.selection)), "caret 1 -1");
  // An empty line between images counts as a line break: rows, not one row.
  const blank = run(text(doc(img("a"), "", img("b")), 2), removeNear(-1));
  assert.deepEqual(layout(blank.state), ["[a]", "[b]"]);
  assert.equal(spot(blank.state), "caret 1 -1");
  // Deleting a range of images (deleteSelection, e.g. typing over it) keeps the break.
  const four = doc(img("a"), row("b"), img("c"), img("d"));
  const ranged = stateOf(four, new BlockRange(four.resolve(1), four.resolve(3)));
  const deleted = ranged.apply(ranged.tr.deleteSelection());
  assert.deepEqual(layout(deleted), ["[a]", "[d]"]);
  // deleteBlocks directly: nothing to keep when no break was deleted.
  const tr = stateOf(four).tr;
  deleteBlocks(tr, 2, 3);
  assert.deepEqual(layout(stateOf(tr.doc)), ["[a]", "[b d]"]);
});

test("换行处 Backspace / Delete：行首 Backspace、行末 Delete 去掉换行合并两行；另一侧删图片", () => {
  const rows = doc(img("a"), row("b"), img("c"));
  const merged = run(caretOn(rows, 1, 1), removeNear(-1));
  assert.equal(merged.handled, true);
  assert.deepEqual(layout(merged.state), ["[a b c]"]);
  assert.equal(where(merged.state), "caret 1");
  const mergedByDelete = run(caretOn(rows, 1, -1), removeNear(1));
  assert.deepEqual(layout(mergedByDelete.state), ["[a b c]"]);
  // Backspace at the end of the upper row removes its last image.
  const back = run(caretOn(rows, 1, -1), removeNear(-1));
  assert.deepEqual(layout(back.state), ["[b c]"]);
  assert.equal(where(back.state), "caret 0");
  // Delete at the start of the lower row removes its first image; the caret stays at the row's start.
  const del = run(caretOn(rows, 1, 1), removeNear(1));
  assert.deepEqual(layout(del.state), ["[a]", "[c]"]);
  assert.equal(spot(del.state), "caret 1 1");
  // Inside a row: the image before / after goes, as before.
  const row3 = doc(img("a"), img("b"), img("c"));
  assert.deepEqual(layout(run(caretOn(row3, 1, 1), removeNear(-1)).state), ["[b c]"]);
  assert.deepEqual(layout(run(caretOn(row3, 1, -1), removeNear(1)).state), ["[a c]"]);
});

test("Enter：同一行两图之间换行，换行处行首插空行在前、行末插空行在后", () => {
  const enter = (state) => run(state, enterKey);
  // Inside a row: the images after the caret start a new row, the caret at its start.
  const split = enter(caretOn(doc(img("a"), img("b")), 1, -1));
  assert.equal(split.handled, true);
  assert.deepEqual(layout(split.state), ["[a]", "[b]"]);
  assert.equal(spot(split.state), "caret 1 1");
  // Enter again at the start of that row: an empty line above it, the caret stays before b.
  const down = enter(split.state);
  assert.deepEqual(layout(down.state), ["[a]", "", "[b]"]);
  assert.equal(where(down.state), "caret 3");
  // At the end of the upper row: an empty line below it with the caret in it.
  const below = enter(caretOn(doc(img("a"), row("b")), 1, -1));
  assert.deepEqual(layout(below.state), ["[a]", "", "[b]"]);
  assert.equal(where(below.state), "text 2");
  // Next to a text line and at the document's edges: an empty line with the caret in it, as before.
  assert.deepEqual(layout(enter(caret(doc(img("a"), "x"), 1)).state), ["[a]", "", "x"]);
  assert.equal(where(enter(caret(doc(img("a"), "x"), 1)).state), "text 2");
  assert.deepEqual(layout(enter(caret(doc(img("a")), 0)).state), ["", "[a]"]);
  assert.deepEqual(layout(enter(caret(doc(img("a")), 1)).state), ["[a]", ""]);
  // Selected images in a row are replaced by the line break.
  const three = doc(img("a"), img("b"), img("c"));
  const replaced = enter(stateOf(three, new BlockRange(three.resolve(1), three.resolve(2))));
  assert.deepEqual(layout(replaced.state), ["[a]", "[c]"]);
  // In a text line Enter is the editor's own.
  assert.equal(enter(text(doc("文字"), 2)).handled, false);
});

test("左右键在两行图片之间的换行处走两步：上一行行末、下一行行首", () => {
  // "A" 0-3, a 3-4, b 4-5 (new row), "B" 5-8.
  const d = doc("A", img("a"), row("b"), "B");
  const steps = (state, dir, count) => {
    const seen = [];
    for (let i = 0; i < count; i++) {
      state = run(state, moveCaret(dir)).state;
      seen.push(spot(state));
    }
    return seen;
  };
  assert.deepEqual(steps(text(d, 2), 1, 5), [
    "caret 3 -1",
    "caret 4 -1",
    "caret 4 1",
    "caret 5 -1",
    "text 6",
  ]);
  assert.deepEqual(steps(text(d, 6), -1, 5), [
    "caret 5 -1",
    "caret 4 1",
    "caret 4 -1",
    "caret 3 1",
    "text 2",
  ]);
  // Inside a row it is one step, as before.
  const same = doc(img("a"), img("b"));
  assert.deepEqual(steps(caretOn(same, 0, 1), 1, 2), ["caret 1 -1", "caret 2 -1"]);
});

test("换行处的光标按 side 画在上一行末图片右侧或下一行首图片左侧；换行画成 spacer", () => {
  const rows = doc(img("a"), row("b"));
  assert.deepEqual(besideImage(rows.resolve(1), -1), { pos: 0, after: true });
  assert.deepEqual(besideImage(rows.resolve(1), 1), { pos: 1, after: false });
  assert.deepEqual(decorationsWithSpacers(caretOn(rows, 1, -1)), ["1-1 image-row-break"]);
  // Inside a row the side does not show: drawn after the image before it.
  assert.deepEqual(besideImage(doc(img("a"), img("b")).resolve(1), 1), { pos: 0, after: true });
  assert.deepEqual(decorationsWithSpacers(caretOn(doc(img("a"), img("b")), 1, 1)), []);
  // No spacer after a text line or at the document's start, whatever newline says.
  assert.deepEqual(decorationsWithSpacers(stateOf(doc(row("a"), "x", row("b")))), []);
});

test("单击换行两侧的图片：上一行末图片右半为行末，下一行首图片左半为行首", () => {
  const rows = doc(img("a"), row("b"));
  const click = (pos, clientX) => {
    const view = fakeView(caret(rows, 0));
    plugin.props.handleClickOn.call(plugin, view, pos, rows.nodeAt(pos), pos, { clientX }, true);
    return spot(view.state);
  };
  assert.equal(click(0, 190), "caret 1 -1");
  assert.equal(click(1, 110), "caret 1 1");
  // The DOM reads back the same position whichever side: the side is kept.
  const state = caretOn(rows, 1, 1);
  const kept = plugin.props.createSelectionBetween.call(
    plugin,
    fakeView(state),
    rows.resolve(1),
    rows.resolve(1),
  );
  assert.equal(kept, state.selection);
});

test("块间光标的 side：eq / toJSON / 书签 / 映射 / 撤销都保留", () => {
  const rows = doc(img("a"), row("b"));
  const start = new BlockRange(rows.resolve(1), undefined, 1);
  const end = new BlockRange(rows.resolve(1), undefined, -1);
  assert.equal(start.eq(end), false);
  assert.equal(start.eq(new BlockRange(rows.resolve(1), undefined, 1)), true);
  assert.deepEqual(start.toJSON(), { type: "blockRange", anchor: 1, head: 1, side: 1 });
  assert.deepEqual(new BlockRange(rows.resolve(0), rows.resolve(2)).toJSON(), {
    type: "blockRange",
    anchor: 0,
    head: 2,
  });
  const state = stateOf(rows, start);
  const moved = state.apply(state.tr.insert(0, schema.nodes.paragraph.create()));
  assert.equal(spot(moved), "caret 3 1");
  const tr = state.tr.insert(0, schema.nodes.paragraph.create());
  assert.equal(start.getBookmark().map(tr.mapping).resolve(tr.doc).side, 1);
  // Undo brings back the caret on its side.
  const h = EditorState.create({ doc: rows, selection: start, plugins: [plugin, history()] });
  const merged = run(h, removeNear(-1)).state;
  assert.deepEqual(layout(merged), ["[a b]"]);
  const undone = run(merged, undo).state;
  assert.deepEqual(layout(undone), ["[a]", "[b]"]);
  assert.equal(spot(undone), "caret 1 1");
});

test("拖动图片：落在行首图片左半 → 成为该行行首；落在图片右半 → 并入该行，拖走的行首图片把换行交给下一张", () => {
  // Rows [a b] [c d]: a 0-1, b 1-2, c 2-3 (new row), d 3-4.
  const d = doc(img("a"), img("b"), row("c"), img("d"));
  const drop = (from, inside, clientX) => {
    const state = stateOf(d);
    const view = fakeView(state);
    const node = NodeSelection.create(d, from);
    view.dragging = { slice: node.content(), move: true, node };
    view.posAtCoords = () => ({ pos: inside, inside });
    view.focus = () => {};
    const handled = plugin.props.handleDOMEvents.drop.call(plugin, view, {
      clientX,
      clientY: 0,
      ctrlKey: false,
      target: null,
      preventDefault() {},
    });
    assert.equal(handled, true);
    return layout(view.state);
  };
  // a onto the left half of c (the start of the second row).
  assert.deepEqual(drop(0, 2, 110), ["[b]", "[a c d]"]);
  // c onto the right half of b: c joins the first row, d starts the second.
  assert.deepEqual(drop(2, 1, 190), ["[a b c]", "[d]"]);
});

test("状态栏行号：每行图片算一行（折行不算），文字行各算一行", () => {
  // "A", [a b], [c], "", [d]
  const d = doc("A", img("a"), img("b"), row("c"), "", img("d"));
  assert.deepEqual(
    Array.from({ length: d.childCount }, (_, i) => lineOf(d, i)),
    [1, 2, 2, 3, 4, 5],
  );
});

test("复制选中的图片：rows 标出另起一行的图片（第一张恒为 false）", () => {
  const d = doc(img("a"), row("b"), img("c"));
  const all = selectedImages(new BlockRange(d.resolve(0), d.resolve(3)));
  assert.deepEqual(all.pictures.map((p) => p.id), ["a", "b", "c"]);
  assert.deepEqual(all.rows, [false, true, false]);
  // The pictures never carry the row flag (Rust's Picture rejects unknown fields).
  assert.deepEqual(Object.keys(all.pictures[1]), ["id", "name", "width", "height"]);
  const tail = selectedImages(new BlockRange(d.resolve(1), d.resolve(3)));
  assert.deepEqual(tail.rows, [false, false]);
  assert.equal(selectedImages(caret(d, 1).selection), null);
  assert.equal(selectedImages(NodeSelection.create(d, 1)).pictures[0].id, "b");
});

test("复制 / 剪切纯图片：取消事件、不写剪贴板，交给 Rust（copy）；剪切按 Backspace 的落点删除", () => {
  const copied = [];
  const imagesPlugin = imagePlugin(
    (pictures, rows) => copied.push([pictures.map((p) => p.id), rows]),
    () => assert.fail("not staged"),
  );
  // a 0-1, b 1-2 (a new row), c 2-3: copy b and c, then cut them.
  const d = doc(img("a"), row("b"), img("c"));
  const view = fakeView(stateOf(d, new BlockRange(d.resolve(1), d.resolve(3))));
  let prevented = 0;
  const event = {
    clipboardData: {
      clearData: () => assert.fail("clipboard cleared"),
      setData: () => assert.fail("clipboard written"),
    },
    preventDefault() {
      prevented++;
    },
  };
  const { copy, cut } = imagesPlugin.props.handleDOMEvents;
  assert.equal(copy.call(imagesPlugin, view, event), true);
  assert.equal(prevented, 1);
  assert.deepEqual(copied, [[["b", "c"], [false, false]]]);
  assert.deepEqual(layout(view.state), ["[a]", "[b c]"]);
  assert.equal(cut.call(imagesPlugin, view, event), true);
  assert.equal(prevented, 2);
  assert.equal(copied.length, 2);
  assert.deepEqual(layout(view.state), ["[a]"]);
  assert.equal(where(view.state), "caret 1");
});

/** Pastes lines (strings) and images (nodes) at the selection, as a paste of a mixed copy does. */
function paste(state, ...items) {
  const tr = state.tr;
  const range = insertBlocks(
    tr,
    items.map((item) =>
      typeof item === "string"
        ? schema.nodes.paragraph.create(null, item ? schema.text(item) : null)
        : item,
    ),
  );
  return { state: state.apply(tr), range };
}

test("粘贴文字 + 图片：在文字行上首尾文字与光标所在行合并，图片自成一行", () => {
  // In the middle of a line: 甲|乙 → 甲一 / [a] / 二乙, the caret after 二.
  const middle = paste(text(doc("甲乙", img("x")), 2), "一", img("a"), "二");
  assert.deepEqual(layout(middle.state), ["甲一", "[a]", "二乙", "[x]"]);
  assert.equal(where(middle.state), "text 7");
  assert.deepEqual(middle.range, { from: 2, to: 7 });
  // Ending with an image at the end of a line above an image: that image starts a new row.
  const end = paste(text(doc("甲", img("x")), 2), "一", img("a"));
  assert.deepEqual(layout(end.state), ["甲一", "[a]", "[x]"]);
  assert.equal(end.state.doc.nodeAt(5).attrs.newline, true);
  assert.equal(spot(end.state), "caret 5 -1");
  // Starting with an image on an empty line below an image: the line is replaced, a new row.
  const empty = paste(text(doc(img("x"), "", "B"), 2), img("a"), "一");
  assert.deepEqual(layout(empty.state), ["[x]", "[a]", "一", "B"]);
  assert.equal(where(empty.state), "text 4");
  // At the start of a line: the image before it, the last line joins it.
  const start = paste(text(doc("乙"), 1), img("a"), "一");
  assert.deepEqual(layout(start.state), ["[a]", "一乙"]);
  assert.equal(where(start.state), "text 3");
  assert.deepEqual(start.range, { from: 0, to: 3 });
  // Rows inside the content keep their line breaks; images at the ends of a line
  // with text on both sides split it.
  const rows = paste(text(doc("甲乙"), 2), img("a"), row("b"), img("c"));
  assert.deepEqual(layout(rows.state), ["甲", "[a]", "[b c]", "乙"]);
  assert.equal(spot(rows.state), "caret 6 -1");
});

test("粘贴文字 + 图片：块间光标处首尾图片按 joinAt 并入那一行，文字自成一行", () => {
  // Inside a row: both ends join it.
  const inside = paste(caret(doc(img("a"), img("b")), 1), img("x"), "一", img("y"));
  assert.deepEqual(layout(inside.state), ["[a x]", "一", "[y b]"]);
  assert.equal(spot(inside.state), "caret 6 -1");
  // At the start of the lower row (side 1): the first image starts a row of its own.
  const lower = paste(caretOn(doc(img("a"), row("b")), 1, 1), img("x"), "t");
  assert.deepEqual(layout(lower.state), ["[a]", "[x]", "t", "[b]"]);
  assert.equal(where(lower.state), "text 4");
  // At the end of the upper row (side -1): the row after keeps its line break.
  const upper = paste(caretOn(doc(img("a"), row("b")), 1, -1), "t", img("y"));
  assert.deepEqual(layout(upper.state), ["[a]", "t", "[y]", "[b]"]);
  // Before the first image of the document: the last image joins that row.
  const first = paste(caretOn(doc(img("a")), 0, 1), "t", img("y"));
  assert.deepEqual(layout(first.state), ["t", "[y a]"]);
});

test("粘贴文字 + 图片替换选区：删除走 deleteBlocks，全选后粘贴得到粘贴的内容", () => {
  const word = paste(stateOf(doc("甲乙丙"), TextSelection.create(doc("甲乙丙"), 2, 3)), "一", img("a"), "二");
  assert.deepEqual(layout(word.state), ["甲一", "[a]", "二丙"]);
  const d = doc("A", img("a"), "B");
  const all = paste(stateOf(d, new AllSelection(d)), "一", img("x"));
  assert.deepEqual(layout(all.state), ["一", "[x]"]);
  // A range from a line into a row of images: the row's next image starts its row.
  const r = doc("A", img("a"), img("b"), "B");
  const range = paste(stateOf(r, new BlockRange(r.resolve(2), r.resolve(4))), img("x"));
  assert.deepEqual(layout(range.state), ["A", "[x]", "[b]", "B"]);
});

test("粘贴文字 + 图片是一步撤销", () => {
  const d = doc("甲乙", img("x"));
  const state = EditorState.create({
    doc: d,
    selection: TextSelection.create(d, 2),
    plugins: [plugin, history()],
  });
  const tr = closeHistory(state.tr);
  insertBlocks(tr, blockNodes(schema, [
    { type: "line", text: "一" },
    { type: "images", images: [{ id: "a", name: "a.png", width: 40, height: 30 }] },
    { type: "line", text: "二" },
  ]));
  const pasted = state.apply(tr);
  assert.deepEqual(layout(pasted), ["甲一", "[a]", "二乙", "[x]"]);
  assert.deepEqual(layout(run(pasted, undo).state), ["甲乙", "[x]"]);
});

test("混合选区：sliceBlocks / blockNodes 保留换行，mixedSlice 只认既有图片又有文字行的选区", () => {
  const d = doc("A", img("a"), row("b"), img("c"), "", "B");
  const all = stateOf(d, new AllSelection(d));
  const blocks = sliceBlocks(mixedSlice(all));
  assert.deepEqual(
    blocks.map((b) => (b.type === "line" ? b.text : b.images.map((p) => p.id).join(" "))),
    ["A", "a", "b c", "", "B"],
  );
  assert.deepEqual(
    blockNodes(schema, blocks).map((n) => (n.type.name === "image" ? n.attrs.newline : n.textContent)),
    ["A", true, true, false, "", "B"],
  );
  assert.deepEqual(blockPictures(blocks).map((p) => p.id), ["a", "b", "c"]);
  // A partial line is cut.
  const part = stateOf(d, TextSelection.create(d, 2, 7));
  assert.deepEqual(sliceBlocks(mixedSlice(part)).map((b) => b.type), ["line", "images", "images", "line"]);
  // Only text, only images, nothing: not mixed. An image with an empty line is.
  assert.equal(mixedSlice(stateOf(doc("A", "B"), TextSelection.create(doc("A", "B"), 1, 5))), null);
  assert.equal(mixedSlice(stateOf(d, new BlockRange(d.resolve(3), d.resolve(6)))), null);
  assert.equal(mixedSlice(caret(d, 3)), null);
  assert.notEqual(mixedSlice(stateOf(d, new BlockRange(d.resolve(5), d.resolve(8)))), null);
});

test("clipboardBlocks：只认版本 1、由文字行与非空图片行组成的数据", () => {
  const id = "ab".repeat(32);
  const pic = { id, name: "a.png", width: 3, height: 2 };
  const good = { v: 1, blocks: [{ type: "line", text: "甲" }, { type: "images", images: [pic] }] };
  assert.deepEqual(clipboardBlocks(JSON.stringify(good)), [
    { type: "line", text: "甲" },
    { type: "images", images: [pic] },
  ]);
  const bad = [
    "",
    "不是 JSON",
    "null",
    JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ v: 1, blocks: [] }),
    JSON.stringify({ v: 1, blocks: [null] }),
    JSON.stringify({ v: 1, blocks: [{ type: "line" }] }),
    JSON.stringify({ v: 1, blocks: [{ type: "images", images: [] }] }),
    JSON.stringify({ v: 1, blocks: [{ type: "images", images: [{ ...pic, id: 1 }] }] }),
    JSON.stringify({ v: 1, blocks: [{ type: "heading", text: "x" }] }),
    JSON.stringify([good]),
  ];
  for (const data of bad) assert.equal(clipboardBlocks(data), null, data);
  // Images no longer available are left out, a row left empty with them.
  const blocks = [
    { type: "line", text: "甲" },
    { type: "images", images: [pic, { ...pic, id: "cd".repeat(32) }] },
    { type: "images", images: [{ ...pic, id: "ef".repeat(32) }] },
  ];
  assert.deepEqual(withoutPictures(blocks, ["cd".repeat(32), "ef".repeat(32)]), [
    { type: "line", text: "甲" },
    { type: "images", images: [pic] },
  ]);
  assert.equal(withoutPictures(blocks, []), blocks);
});

test("复制 / 剪切混合选区：写纯文字与 blocks、不写 HTML，暂存原图；剪切按 deleteBlocks 保持行结构", () => {
  const staged = [];
  const mixedPlugin = imagePlugin(
    () => assert.fail("not copied by Rust"),
    (pictures) => staged.push(...pictures.map((p) => p.id)),
  );
  // a 0-1, "t" 1-4, b 4-5, c 5-6: cut "t" and b.
  const d = doc(img("a"), "t", img("b"), img("c"));
  const view = fakeView(stateOf(d, new BlockRange(d.resolve(1), d.resolve(5))));
  // The editor's text serializer (DiaryEditor's, images as placeholders) writes the text.
  view.someProp = (name, f) =>
    name === "clipboardTextSerializer" ? f(() => "t\n[图片]") : undefined;
  const written = {};
  let prevented = false;
  const event = {
    clipboardData: {
      clearData() {},
      setData(type, value) {
        written[type] = value;
      },
    },
    preventDefault() {
      prevented = true;
    },
  };
  assert.equal(mixedPlugin.props.handleDOMEvents.cut.call(mixedPlugin, view, event), true);
  assert.equal(prevented, true);
  assert.deepEqual(Object.keys(written).sort(), [BLOCKS_MIME, "text/plain"].sort());
  assert.equal(written["text/plain"], "t\n[图片]");
  assert.deepEqual(JSON.parse(written[BLOCKS_MIME]), {
    v: 1,
    blocks: [
      { type: "line", text: "t" },
      { type: "images", images: [{ id: "b", name: "b.png", width: 40, height: 30 }] },
    ],
  });
  assert.deepEqual(staged, ["b"]);
  // The text line went, so c starts a new row after a.
  assert.deepEqual(layout(view.state), ["[a]", "[c]"]);
  // Only images, or only text: not this path.
  const plain = fakeView(stateOf(doc("A", "B"), TextSelection.create(doc("A", "B"), 1, 5)));
  assert.equal(mixedPlugin.props.handleDOMEvents.copy.call(mixedPlugin, plain, event), false);
});

test("拖动混合选区：剪切后粘贴到落点；Ctrl 为复制；落在选区内不动", () => {
  // 甲 0-3, a 3-4, 乙 4-7, 丙 7-10; "甲" and a selected.
  const d = doc("甲", img("a"), "乙", "丙");
  const drop = (pos, ctrlKey = false) => {
    const view = fakeView(stateOf(d, new BlockRange(d.resolve(1), d.resolve(4))));
    view.dragging = { slice: view.state.selection.content(), move: true };
    view.posAtCoords = () => ({ pos, inside: -1 });
    view.focus = () => {};
    const handled = plugin.props.handleDOMEvents.drop.call(plugin, view, {
      clientX: 0,
      clientY: 0,
      ctrlKey,
      target: null,
      preventDefault() {},
    });
    assert.equal(handled, true);
    assert.equal(view.dragging, null);
    return view.state;
  };
  // To the end of 丙: 甲 joins it, the image a row of its own after it; the dropped content selected.
  const moved = drop(9);
  assert.deepEqual(layout(moved), ["", "乙", "丙甲", "[a]"]);
  assert.equal(where(moved), "BlockRange 7-10");
  assert.deepEqual(layout(drop(9, true)), ["甲", "[a]", "乙", "丙甲", "[a]"]);
  // Inside the selection: nothing changes.
  const still = drop(2);
  assert.equal(still.doc.eq(d), true);
  assert.equal(where(still), "BlockRange 1-4");
});

// ---- 2026-10-28 ----
import { foldOf, pastImages, rangeSelection } from "../../src/editor/image-view.ts";

test("foldOf：按顶边把一行图片分成视觉行，返回第 k 张所在那一折的 [首, 尾后)", () => {
  const tops = [0, 0, 0.4, 110, 110, 220];
  assert.deepEqual(foldOf(tops, 0), [0, 3]);
  assert.deepEqual(foldOf(tops, 2), [0, 3]);
  assert.deepEqual(foldOf(tops, 3), [3, 5]);
  assert.deepEqual(foldOf(tops, 4), [3, 5]);
  assert.deepEqual(foldOf(tops, 5), [5, 6]);
  assert.deepEqual(foldOf([12], 0), [0, 1]);
});

test("pastImages：上下键越过整串图片，落到下一行行首 / 上一行行末，或文档边缘", () => {
  // A 0-3 (text 1-2), a 3-4, b 4-5, B 5-8, C 8-11.
  assert.equal(pastImages(mixed, 3, 1), 6);
  assert.equal(pastImages(mixed, 4, 1), 6);
  assert.equal(pastImages(mixed, 5, -1), 2);
  const end = doc("A", img("a"), img("b"));
  assert.equal(pastImages(end, 3, 1), 5);
  assert.equal(pastImages(doc(img("a"), "A"), 1, -1), 0);
});

test("图片不会以节点选中留在状态里：浏览器读回的 NodeSelection 变为来向一侧的块间光标", () => {
  const select = (state) =>
    state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 3))).selection;
  // From above (the text before it): before the image, at the start of its row.
  const fromAbove = select(text(mixed, 1));
  assert.ok(fromAbove instanceof BlockRange && fromAbove.empty);
  assert.deepEqual(fromAbove.toJSON(), { type: "blockRange", anchor: 3, head: 3, side: 1 });
  // From below: after it.
  const fromBelow = select(text(mixed, 6));
  assert.deepEqual(fromBelow.toJSON(), { type: "blockRange", anchor: 4, head: 4, side: -1 });
});

test("块间范围保留 head 的 side（画光标用），eq / toJSON 仍不比较；DOM 读回同一范围时保留", () => {
  // Rows a | b: the line break at 1.
  const rows = doc(img("a"), img("b", true), "B");
  const up = rangeSelection(rows, 2, 1, -1);
  assert.ok(up instanceof BlockRange);
  assert.equal(up.side, 1);
  assert.equal(rangeSelection(rows, 0, 1, 1).side, -1);
  assert.equal(rangeSelection(rows, 2, 1, 1, 1).side, 1);
  assert.deepEqual(up.toJSON(), { type: "blockRange", anchor: 2, head: 1 });
  assert.ok(up.eq(rangeSelection(rows, 2, 1, 1)));
  // Mapping and the history bookmark keep it.
  const state = stateOf(rows, up);
  const typed = state.apply(state.tr.insertText("x", 4));
  assert.equal(typed.selection.side, 1);
  assert.equal(up.getBookmark().resolve(rows).side, 1);
  // Read back from the DOM as the same range (no DOM selection in the fake view).
  const view = fakeView(state);
  const back = plugin.props.createSelectionBetween.call(plugin, view, rows.resolve(2), rows.resolve(1));
  assert.equal(back, up);
});
