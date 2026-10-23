import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  applySettings,
  cssFontFamily,
  normalizeSettings,
} from "../src/core/settings.ts";
import {
  MEDIUM_CARET_FACTOR,
  THICK_CARET_FACTOR,
  caretWidth,
} from "../src/editor/caret-math.ts";

test("设置规范化：字号（pt）保留一位小数并限制在 6–30，字体去空白、空则默认", () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    fontFamily: "微软雅黑",
    fontSizePt: 10,
    openFile: "tab",
    startup: "newWindow",
    caretWidth: "thin",
    selectionCorners: "rounded",
  });
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ fontSizePt: "abc", fontFamily: 3 }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ fontFamily: "  Consolas ", fontSizePt: 11.6 }), {
    fontFamily: "Consolas",
    fontSizePt: 11.6,
    openFile: "tab",
    startup: "newWindow",
    caretWidth: "thin",
    selectionCorners: "rounded",
  });
  assert.equal(normalizeSettings({ fontSizePt: 10.5 }).fontSizePt, 10.5);
  assert.equal(normalizeSettings({ fontSizePt: 12.55 }).fontSizePt, 12.6);
  assert.equal(normalizeSettings({ fontSizePt: 13.33 }).fontSizePt, 13.3);
  assert.equal(normalizeSettings({ fontSizePt: "10.5" }).fontSizePt, 10.5);
  assert.equal(normalizeSettings({ fontSizePt: 5.96 }).fontSizePt, 6);
  assert.equal(normalizeSettings({ fontSizePt: 2 }).fontSizePt, 6);
  assert.equal(normalizeSettings({ fontSizePt: 99 }).fontSizePt, 30);
  assert.equal(normalizeSettings({ fontFamily: "   " }).fontFamily, "微软雅黑");
});

test("旧设置文件的 fontSize（px）按 0.75 换算成 pt，有 fontSizePt 时以它为准", () => {
  assert.deepEqual(normalizeSettings({ fontFamily: "宋体", fontSize: 13 }), {
    fontFamily: "宋体",
    fontSizePt: 9.8,
    openFile: "tab",
    startup: "newWindow",
    caretWidth: "thin",
    selectionCorners: "rounded",
  });
  assert.equal(normalizeSettings({ fontSize: 14 }).fontSizePt, 10.5);
  assert.equal(normalizeSettings({ fontSizePt: 10, fontSize: 14 }).fontSizePt, 10);
  assert.equal(normalizeSettings({ fontSize: 99 }).fontSizePt, 30);
  assert.equal("fontSize" in normalizeSettings({ fontSize: 14 }), false);
});

test("打开文件：只认 tab / window，其他值取默认 tab，不影响其他字段", () => {
  assert.equal(normalizeSettings({ openFile: "window" }).openFile, "window");
  assert.equal(normalizeSettings({ openFile: "tab" }).openFile, "tab");
  for (const value of [undefined, null, "", "Window", "侧边栏", 1, true, ["window"]])
    assert.equal(normalizeSettings({ openFile: value }).openFile, "tab");
  assert.deepEqual(
    normalizeSettings({ fontFamily: "宋体", fontSizePt: 12, openFile: "新窗口" }),
    { fontFamily: "宋体", fontSizePt: 12, openFile: "tab", startup: "newWindow", caretWidth: "thin", selectionCorners: "rounded" },
  );
  // 已规范化的值再规范化不变（设置广播到其他窗口时会再走一遍）。
  const settings = {
    fontFamily: "Consolas",
    fontSizePt: 10.5,
    openFile: "window",
    startup: "lastSession",
    caretWidth: "thick",
    selectionCorners: "square",
  };
  assert.deepEqual(normalizeSettings(settings), settings);
});

test("启动时：只认 newWindow / lastSession，其他值取默认 newWindow，不影响其他字段", () => {
  assert.equal(normalizeSettings({ startup: "lastSession" }).startup, "lastSession");
  assert.equal(normalizeSettings({ startup: "newWindow" }).startup, "newWindow");
  assert.equal(normalizeSettings({}).startup, "newWindow");
  for (const value of [null, "", "LastSession", "last-session", "上次", 0, false, {}])
    assert.equal(normalizeSettings({ startup: value }).startup, "newWindow");
  assert.deepEqual(
    normalizeSettings({ fontSizePt: 12, openFile: "window", startup: "恢复" }),
    { fontFamily: "微软雅黑", fontSizePt: 12, openFile: "window", startup: "newWindow", caretWidth: "thin", selectionCorners: "rounded" },
  );
  // 旧设置文件没有 startup：取默认，其余照旧换算。
  assert.deepEqual(normalizeSettings({ fontFamily: "宋体", fontSize: 16 }), {
    fontFamily: "宋体",
    fontSizePt: 12,
    openFile: "tab",
    startup: "newWindow",
    caretWidth: "thin",
    selectionCorners: "rounded",
  });
});

test("光标粗细：只认 thin / medium / thick，缺省或其他值取默认 thin，不影响其他字段；medium 为 2、thick 为 3 屏幕像素", () => {
  assert.equal(DEFAULT_SETTINGS.caretWidth, "thin");
  assert.equal(normalizeSettings({}).caretWidth, "thin");
  assert.equal(normalizeSettings({ caretWidth: "thin" }).caretWidth, "thin");
  assert.equal(normalizeSettings({ caretWidth: "medium" }).caretWidth, "medium");
  assert.equal(normalizeSettings({ caretWidth: "thick" }).caretWidth, "thick");
  for (const value of [undefined, null, "", "Thick", "Medium", "粗", "中", "bold", 2, 3, true, ["thick"], {}])
    assert.equal(normalizeSettings({ caretWidth: value }).caretWidth, "thin");
  // medium 往返不变，也不影响其他字段。
  const medium = { ...DEFAULT_SETTINGS, fontSizePt: 11, caretWidth: "medium" };
  assert.deepEqual(normalizeSettings(medium), medium);
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(medium))), medium);
  assert.deepEqual(
    normalizeSettings({ fontSizePt: 12, startup: "lastSession", caretWidth: "粗" }),
    {
      fontFamily: "微软雅黑",
      fontSizePt: 12,
      openFile: "tab",
      startup: "lastSession",
      caretWidth: "thin",
      selectionCorners: "rounded",
    },
  );
  // “细”跟随系统设置，“中”为其 2 倍，“粗”为其 3 倍，不设上限，闪烁不受影响。
  const system = { width: 2, blinkMs: 530, timeoutMs: 5000 };
  assert.equal(MEDIUM_CARET_FACTOR, 2);
  assert.equal(THICK_CARET_FACTOR, 3);
  assert.equal(caretWidth(system, "thin"), 2);
  assert.equal(caretWidth(system, "medium"), 4);
  assert.equal(caretWidth(system, "thick"), 6);
  assert.equal(caretWidth({ ...system, width: 1 }, "thin"), 1);
  assert.equal(caretWidth({ ...system, width: 1 }, "medium"), 2);
  assert.equal(caretWidth({ ...system, width: 1 }, "thick"), 3);
  assert.equal(caretWidth({ ...system, width: 5 }, "medium"), 10);
  assert.equal(caretWidth({ ...system, width: 5 }, "thick"), 15);
});

test("光标粗细按 Windows 文本光标粗细的倍数：系统宽 3 时细 / 中 / 粗为 3 / 6 / 9", () => {
  const metrics = { width: 3, blinkMs: 530, timeoutMs: 5000 };
  assert.equal(caretWidth(metrics, "thin"), 3);
  assert.equal(caretWidth(metrics, "medium"), 6);
  assert.equal(caretWidth(metrics, "thick"), 9);
});

test("选区边角：只认 square / rounded，缺省或其他值取默认 rounded，不影响其他字段", () => {
  assert.equal(DEFAULT_SETTINGS.selectionCorners, "rounded");
  assert.equal(normalizeSettings({}).selectionCorners, "rounded");
  assert.equal(normalizeSettings(null).selectionCorners, "rounded");
  assert.equal(normalizeSettings({ selectionCorners: "square" }).selectionCorners, "square");
  assert.equal(normalizeSettings({ selectionCorners: "rounded" }).selectionCorners, "rounded");
  for (const value of [undefined, null, "", "Square", "方角", "round", 0, false, ["square"], {}])
    assert.equal(normalizeSettings({ selectionCorners: value }).selectionCorners, "rounded");
  // 不认识的值不影响其他字段，其他字段的非法值也不影响它。
  assert.deepEqual(
    normalizeSettings({ fontSizePt: 12, caretWidth: "thick", selectionCorners: "方角" }),
    {
      fontFamily: "微软雅黑",
      fontSizePt: 12,
      openFile: "tab",
      startup: "newWindow",
      caretWidth: "thick",
      selectionCorners: "rounded",
    },
  );
  assert.deepEqual(
    normalizeSettings({ fontSizePt: "abc", openFile: "侧边栏", selectionCorners: "square" }),
    { ...DEFAULT_SETTINGS, selectionCorners: "square" },
  );
  // 旧设置文件（只有 px 字号）：取默认圆角。
  assert.equal(normalizeSettings({ fontFamily: "宋体", fontSize: 16 }).selectionCorners, "rounded");
});

test("设置写成 CSS 变量：单个字体名加引号与回退字体，字体列表原样使用", () => {
  assert.equal(
    cssFontFamily("Microsoft YaHei UI"),
    '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
  );
  // 中文字体名 WebView2 能直接解析，原样使用；只有“微软雅黑 UI”不是真实字体名，要换成英文名。
  assert.equal(
    cssFontFamily("微软雅黑"),
    '"微软雅黑", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
  );
  assert.equal(
    cssFontFamily("微软雅黑  UI"),
    '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
  );
  assert.equal(normalizeSettings({ fontFamily: "微软雅黑 UI" }).fontFamily, "微软雅黑 UI");
  assert.equal(
    cssFontFamily("Consolas"),
    '"Consolas", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
  );
  assert.equal(cssFontFamily('Consolas, "SimSun"'), 'Consolas, "SimSun"');
  const style = {};
  applySettings({ setProperty: (name, value) => (style[name] = value) }, {
    fontFamily: "SimSun",
    fontSizePt: 18,
  });
  assert.deepEqual(style, {
    "--editor-font-family":
      '"SimSun", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
    "--editor-font-size": "18pt",
  });
  applySettings(
    { setProperty: (name, value) => (style[name] = value) },
    normalizeSettings({ fontFamily: "SimSun", fontSizePt: 12.5 }),
  );
  assert.equal(style["--editor-font-size"], "12.5pt");
  applySettings({ setProperty: (name, value) => (style[name] = value) }, DEFAULT_SETTINGS);
  assert.equal(style["--editor-font-size"], "10pt");
});
