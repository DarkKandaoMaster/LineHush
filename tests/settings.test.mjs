import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  applySettings,
  cssFontFamily,
  normalizeSettings,
} from "../src/core/settings.ts";

test("设置规范化：字号（pt）保留一位小数并限制在 6–30，字体去空白、空则默认", () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    fontFamily: "微软雅黑",
    fontSizePt: 10,
    openFile: "tab",
    startup: "newWindow",
  });
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ fontSizePt: "abc", fontFamily: 3 }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ fontFamily: "  Consolas ", fontSizePt: 11.6 }), {
    fontFamily: "Consolas",
    fontSizePt: 11.6,
    openFile: "tab",
    startup: "newWindow",
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
    { fontFamily: "宋体", fontSizePt: 12, openFile: "tab", startup: "newWindow" },
  );
  // 已规范化的值再规范化不变（设置广播到其他窗口时会再走一遍）。
  const settings = {
    fontFamily: "Consolas",
    fontSizePt: 10.5,
    openFile: "window",
    startup: "lastSession",
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
    { fontFamily: "微软雅黑", fontSizePt: 12, openFile: "window", startup: "newWindow" },
  );
  // 旧设置文件没有 startup：取默认，其余照旧换算。
  assert.deepEqual(normalizeSettings({ fontFamily: "宋体", fontSize: 16 }), {
    fontFamily: "宋体",
    fontSizePt: 12,
    openFile: "tab",
    startup: "newWindow",
  });
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
