import test from "node:test";
import assert from "node:assert/strict";
import {
  SAFE_ZONE_LINES,
  pageLines,
  revealScrollTop,
  safeZone,
} from "../src/editor/reveal.ts";

// A 600px viewport over content, a 20px line, the safe zone 5 lines (100px).
const reveal = (scrollTop, boxTop, boxBottom, padding = 100) =>
  revealScrollTop({ scrollTop, viewportHeight: 600, boxTop, boxBottom, padding });

test("盒子连同安全区已在视口内：不滚动", () => {
  assert.equal(reveal(1000, 1100, 1120), 1000);
  // Exactly at both edges of the safe zone.
  assert.equal(reveal(1000, 1100, 1500), 1000);
  assert.equal(reveal(1000, 1480, 1500), 1000);
});

test("在上方：盒顶减安全区到视口顶；在下方：盒底加安全区到视口底", () => {
  // Inside the viewport but within the top safe zone.
  assert.equal(reveal(1000, 1050, 1070), 950);
  // Above the viewport.
  assert.equal(reveal(1000, 500, 520), 400);
  // Within the bottom safe zone.
  assert.equal(reveal(1000, 1540, 1560), 1060);
  // Below the viewport: the least scrolling that shows it with its zone.
  assert.equal(reveal(1000, 3000, 3200), 2700);
});

test("盒子连同安全区比视口高：滚到盒顶（减安全区），高图片先露出顶部", () => {
  assert.equal(reveal(0, 1000, 1500), 900);
  assert.equal(reveal(5000, 1000, 1500), 900);
  // Without a safe zone (after a click) a box taller than the viewport too.
  assert.equal(reveal(0, 1000, 1700, 0), 1000);
});

test("没有安全区（鼠标）：只保证光标可见", () => {
  assert.equal(reveal(1000, 1590, 1610, 0), 1010);
  assert.equal(reveal(1000, 990, 1010, 0), 990);
  assert.equal(reveal(1000, 1000, 1600, 0), 1000);
});

test("结果不夹到 0：由调用方按滚动范围夹", () => {
  assert.equal(reveal(0, 16, 33), -84);
});

test("安全区为 5 行、至多半个视口；一页为能放下的行数减 2", () => {
  assert.equal(SAFE_ZONE_LINES, 5);
  assert.equal(safeZone(17.33, 619), 5 * 17.33);
  assert.equal(safeZone(30, 200), 100);
  assert.equal(pageLines(17.33, 619), 33);
  assert.equal(pageLines(20, 600), 28);
  assert.equal(pageLines(40, 60), 1);
});
