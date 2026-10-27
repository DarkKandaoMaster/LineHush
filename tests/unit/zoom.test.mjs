import test from "node:test";
import assert from "node:assert/strict";
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  wheelZoomSteps,
  zoomBy,
  zoomKeyAction,
} from "../../src/core/zoom.ts";

test("缩放：范围 10%–500%，默认 100%", () => {
  assert.equal(ZOOM_DEFAULT, 100);
  assert.equal(ZOOM_MIN, 10);
  assert.equal(ZOOM_MAX, 500);
  assert.equal(clampZoom(5), 10);
  assert.equal(clampZoom(800), 500);
  assert.equal(clampZoom(120.4), 120);
  assert.equal(clampZoom(Number.NaN), 100);
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), 100);
});

test("缩放：每步 10%，到头不再变", () => {
  assert.equal(zoomBy(100, 1), 110);
  assert.equal(zoomBy(100, -1), 90);
  assert.equal(zoomBy(100, 3), 130);
  assert.equal(zoomBy(20, -1), 10);
  assert.equal(zoomBy(10, -1), 10);
  assert.equal(zoomBy(490, 1), 500);
  assert.equal(zoomBy(500, 1), 500);
  assert.equal(zoomBy(500, -1), 490);
  // 连按不累积浮点误差。
  let zoom = 100;
  for (let i = 0; i < 7; i++) zoom = zoomBy(zoom, -1);
  assert.equal(zoom, 30);
  for (let i = 0; i < 100; i++) zoom = zoomBy(zoom, 1);
  assert.equal(zoom, 500);
});

test("缩放快捷键：Ctrl+= / Ctrl++ / 小键盘 + 放大，Ctrl+- 缩小，Ctrl+0 恢复", () => {
  const key = (key, code, shiftKey = false) => zoomKeyAction({ key, code, shiftKey });
  assert.equal(key("=", "Equal"), "in");
  assert.equal(key("+", "Equal", true), "in");
  assert.equal(key("+", "NumpadAdd"), "in");
  assert.equal(key("-", "Minus"), "out");
  assert.equal(key("-", "NumpadSubtract"), "out");
  assert.equal(key("0", "Digit0"), "reset");
  assert.equal(key("0", "Numpad0"), "reset");
  // 输入法开启时 key 为 Process，按位置认。
  assert.equal(key("Process", "Equal"), "in");
  assert.equal(key("Process", "Minus"), "out");
  assert.equal(key("Process", "Digit0"), "reset");
  // 其他键、Shift 版的 - 与 0 不算。
  assert.equal(key("1", "Digit1"), undefined);
  assert.equal(key("s", "KeyS"), undefined);
  assert.equal(key("_", "Minus", true), undefined);
  assert.equal(key(")", "Digit0", true), undefined);
});

test("Ctrl+滚轮：一格一步，向上放大；触控板小量累加到一格", () => {
  assert.deepEqual(wheelZoomSteps(0, -100, 0), { steps: 1, pending: 0 });
  assert.deepEqual(wheelZoomSteps(0, 100, 0), { steps: -1, pending: 0 });
  // 高缩放比下一格的像素量更大，仍只算一步。
  assert.deepEqual(wheelZoomSteps(0, -150, 0), { steps: 1, pending: 0 });
  // 按行 / 按页滚动的一格。
  assert.deepEqual(wheelZoomSteps(0, 3, 1), { steps: -1, pending: 0 });
  assert.deepEqual(wheelZoomSteps(0, 0, 0), { steps: 0, pending: 0 });
  // 触控板：小量累加。
  let state = { steps: 0, pending: 0 };
  const steps = [];
  for (let i = 0; i < 5; i++) {
    state = wheelZoomSteps(state.pending, -30, 0);
    steps.push(state.steps);
  }
  assert.deepEqual(steps, [0, 0, 0, 1, 0]);
  assert.equal(state.pending, -50);
  // 方向变了从头累计。
  assert.deepEqual(wheelZoomSteps(-90, 20, 0), { steps: 0, pending: 20 });
});
