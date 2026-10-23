import test from "node:test";
import assert from "node:assert/strict";
import {
  SELECTION_RADIUS,
  cornerRadius,
  outline,
  runs,
  selectionPath,
} from "../../src/editor/selection-shape.ts";

const row = (left, right, top, bottom) => ({ left, right, top, bottom });
/** The path's commands, e.g. [["M", 3, 0], ["L", 97, 0], ["A", 3, 3, 0, 0, 1, 100, 3], ...]. */
const commands = (d) =>
  Array.from(d.matchAll(/([MLAZ])([^MLAZ]*)/g), ([, c, args]) => [
    c,
    ...args.trim().split(/[\s,]+/).filter(Boolean).map(Number),
  ]);

test("单行：一个四角半径 3 的圆角矩形，顺时针", () => {
  assert.equal(SELECTION_RADIUS, 3);
  const d = selectionPath([row(0, 100, 0, 20)]);
  assert.equal(
    d,
    "M100 3L100 17A3 3 0 0 1 97 20L3 20A3 3 0 0 1 0 17L0 3A3 3 0 0 1 3 0L97 0A3 3 0 0 1 100 3Z",
  );
  // Four arcs, all convex (sweep 1).
  const arcs = commands(d).filter(([c]) => c === "A");
  assert.equal(arcs.length, 4);
  assert.ok(arcs.every((a) => a[5] === 1));
});

test("三行左右参差：连成一个形状，外角凸、宽度变化处的内角凹（反向圆角）", () => {
  // Like a selection from the middle of line 1 to the middle of line 3.
  const rows = [row(60, 200, 0, 20), row(0, 200, 20, 40), row(0, 120, 40, 60)];
  assert.equal(runs(rows).length, 1);
  assert.deepEqual(outline(rows), [
    [200, 0],
    [200, 40],
    [120, 40],
    [120, 60],
    [0, 60],
    [0, 20],
    [60, 20],
    [60, 0],
  ]);
  const arcs = commands(selectionPath(rows)).filter(([c]) => c === "A");
  assert.equal(arcs.length, 8);
  // Corners in outline order (the path starts after the first corner and ends
  // with it): (200,40) and (60,20) turn inwards.
  const sweeps = arcs.map((a) => a[5]);
  assert.deepEqual(sweeps, [1, 0, 1, 1, 1, 0, 1, 1]);
  assert.ok(arcs.every((a) => a[1] === 3 && a[2] === 3));
});

test("凹角：上短下长，内角为反向圆弧，弧终点落在下一行顶边上", () => {
  const d = selectionPath([row(0, 50, 0, 20), row(0, 100, 20, 40)]);
  const list = commands(d);
  // The corner at (50, 20): in along x = 50 to (50, 17), out along y = 20 to (53, 20).
  const i = list.findIndex(([c, x, y]) => c === "L" && x === 50 && y === 17);
  assert.ok(i > 0, d);
  assert.deepEqual(list[i + 1], ["A", 3, 3, 0, 0, 0, 53, 20]);
});

test("半径被短边截断：边长不到两倍半径时取边长的一半", () => {
  // Line 2 is 2px wider than line 1: the step is 2px, its corners 1px.
  const d = selectionPath([row(0, 100, 0, 20), row(0, 102, 20, 40)]);
  const radii = commands(d)
    .filter(([c]) => c === "A")
    .map((a) => a[1]);
  assert.deepEqual(radii.sort((a, b) => a - b), [1, 1, 3, 3, 3, 3]);
  // A row 4px high: no radius over 2.
  const thin = commands(selectionPath([row(0, 100, 0, 4)])).filter(([c]) => c === "A");
  assert.ok(thin.every((a) => a[1] === 2));
});

test("方角（半径 0）：没有圆弧，路径就是外轮廓的直角多边形；cornerRadius 对应设置", () => {
  assert.equal(cornerRadius("rounded"), SELECTION_RADIUS);
  assert.equal(cornerRadius("square"), 0);
  // One row: a plain rectangle.
  assert.equal(
    selectionPath([row(0, 100, 0, 20)], cornerRadius("square")),
    "M100 0L100 20L0 20L0 0L100 0Z",
  );
  // Three staggered rows: one shape, every corner of the outline a right angle.
  const rows = [row(60, 200, 0, 20), row(0, 200, 20, 40), row(0, 120, 40, 60)];
  const list = commands(selectionPath(rows, 0));
  assert.ok(list.every(([c]) => c !== "A"));
  assert.equal(list.filter(([c]) => c === "Z").length, 1);
  const points = list.filter(([c]) => c === "M" || c === "L").map(([, x, y]) => [x, y]);
  // Starts at the outline's first corner, visits each in order, and closes on it.
  assert.deepEqual(points.slice(0, -1), outline(rows));
  assert.deepEqual(points[points.length - 1], points[0]);
  // Each edge axis-aligned (a right-angled polygon).
  for (let i = 1; i < points.length; i++)
    assert.ok(points[i][0] === points[i - 1][0] || points[i][1] === points[i - 1][1]);
  // Rows that do not overlap across still make separate shapes.
  assert.equal(
    commands(selectionPath([row(30, 37, 0, 20), row(0, 7, 20, 40)], 0)).filter(([c]) => c === "Z").length,
    2,
  );
});

test("不相接的行分成几个形状；宽度为 0 的行不画", () => {
  // "我|" to the next line's start: two rows that do not overlap across.
  const rows = [row(30, 37, 0, 20), row(0, 7, 20, 40)];
  assert.equal(runs(rows).length, 2);
  assert.equal(commands(selectionPath(rows)).filter(([c]) => c === "Z").length, 2);
  // Rows apart (an image between them).
  assert.equal(runs([row(0, 50, 0, 20), row(0, 50, 120, 140)]).length, 2);
  assert.equal(selectionPath([row(10, 10, 0, 20)]), "");
  assert.equal(selectionPath([]), "");
});
