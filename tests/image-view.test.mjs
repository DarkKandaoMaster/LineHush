import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSchema } from "@tiptap/core";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { extensions } from "../src/editor/schema.ts";
import {
  BlockRange,
  caretAt,
  caretSpot,
  extendByImage,
  imagePlugin,
  imageSide,
  leaveImages,
  moveCaret,
  removeNear,
  selectedPictures,
  typeBetween,
} from "../src/editor/image-view.ts";

// The editor's real schema (paragraphs of plain text, one node per image).
const schema = getSchema(
  extensions({ preview() {}, source: async () => "", copy: () => false }),
);
const img = (id) =>
  schema.nodes.image.create({ id, name: `${id}.png`, width: 40, height: 30 });
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
const plugin = imagePlugin(() => false);
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
  assert.equal(imageSide(3, image, 120, rect), 3);
  assert.equal(imageSide(3, image, 149, rect), 3);
  assert.equal(imageSide(3, image, 150, rect), 4);
  assert.equal(imageSide(3, image, 199, rect), 4);
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
    selectedPictures(extended).map((p) => p.id),
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

test("光标画在相邻图片上，范围选区内的图片加 image-selected", () => {
  assert.deepEqual(decorations(caret(mixed, 3)), ["3-4 gap-before"]); // line | image
  assert.deepEqual(decorations(caret(mixed, 4)), ["3-4 gap-after"]); // image | image
  assert.deepEqual(decorations(caret(mixed, 5)), ["4-5 gap-after"]); // image | line
  assert.deepEqual(decorations(caret(doc(img("a"), "A"), 0)), ["0-1 gap-before"]);
  assert.deepEqual(decorations(caret(doc("A", img("a")), 4)), ["3-4 gap-after"]);
  assert.deepEqual(decorations(text(mixed, 2)), []);
  const range = stateOf(mixed, new BlockRange(mixed.resolve(3), mixed.resolve(5)));
  assert.deepEqual(decorations(range), ["3-4 image-selected", "4-5 image-selected"]);
  const across = stateOf(mixed, TextSelection.create(mixed, 1, 7));
  assert.deepEqual(decorations(across), ["3-4 image-selected", "4-5 image-selected"]);
});

test("选中图片的样式是与文字选区同色的半透明蒙层，没有蓝框", () => {
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.replace(/\/\*[\s\S]*?\*\//g, "").trim(),
    body,
  }));
  const hex = rules
    .find((r) => r.selector === ".tiptap ::selection")
    .body.match(/#([0-9a-f]{6})/i)[1];
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");
  const selected = rules.filter((r) =>
    /image-selected|ProseMirror-selectednode/.test(r.selector),
  );
  assert.ok(selected.length > 0);
  for (const rule of selected) assert.doesNotMatch(rule.body, /outline|border/);
  assert.ok(
    selected.some((r) => r.body.includes(`rgb(${rgb} /`)),
    `overlay in rgb(${rgb} / …)`,
  );
});
