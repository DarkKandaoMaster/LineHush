import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CARET_METRICS,
  blinkIterations,
  caretBox,
  toDevicePixel,
} from "../../src/editor/caret-math.ts";

test("光标像素对齐：150% 下 1 个屏幕像素宽，边落在屏幕像素上，相对容器换算", () => {
  // The container at 73.0 CSS px (109.5 screen px), the caret at x = 16.4.
  const box = caretBox({ x: 16.4, top: 89.1, bottom: 106.5 }, { left: 0, top: 73 }, 1, 1.5);
  assert.ok(Math.abs(box.width - 1 / 1.5) < 1e-9);
  // In client coordinates every edge is a whole screen pixel.
  const whole = (v) => Math.abs(v * 1.5 - Math.round(v * 1.5)) < 1e-9;
  assert.ok(whole(box.left));
  assert.ok(whole(box.top + 73));
  assert.ok(whole(box.top + 73 + box.height));
  assert.equal(toDevicePixel(16.4, 1.5), 25 / 1.5);
  // Thicker in Windows settings: that many screen pixels.
  assert.ok(Math.abs(caretBox({ x: 0, top: 0, bottom: 10 }, { left: 0, top: 0 }, 3, 1.5).width - 2) < 1e-9);
  // At 100% a whole CSS pixel.
  assert.equal(caretBox({ x: 10.6, top: 0, bottom: 10 }, { left: 0, top: 0 }, 1, 1).left, 11);
});

test("闪烁次数：默认 5000 / 1060 次后停住；不闪烁为 0；无超时为无限", () => {
  assert.equal(blinkIterations(DEFAULT_CARET_METRICS), 5000 / 1060);
  assert.equal(blinkIterations({ width: 1, blinkMs: 0, timeoutMs: 5000 }), 0);
  assert.equal(blinkIterations({ width: 1, blinkMs: 500, timeoutMs: 0 }), Infinity);
});

test("块间光标以 x 为中线：宽度取整后居中，边仍在屏幕像素上", () => {
  // At 150% one screen pixel is 2/3 CSS px: the caret's left edge is half of that left of x.
  const box = caretBox({ x: 20, top: 0, bottom: 10, centered: true }, { left: 0, top: 0 }, 1, 1.5);
  assert.equal(box.left, toDevicePixel(20 - 1 / 3, 1.5));
  assert.ok(Math.abs(box.width - 1 / 1.5) < 1e-9);
  // Three screen pixels wide, centred on x = 20 at 100%.
  assert.equal(caretBox({ x: 20, top: 0, bottom: 10, centered: true }, { left: 0, top: 0 }, 3, 1).left, 19);
});
