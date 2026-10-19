import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  applySettings,
  cssFontFamily,
  normalizeSettings,
} from "../src/core/settings.ts";

test("设置规范化：字号取整并限制在 8–40，字体去空白、空则默认", () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ fontSize: "abc", fontFamily: 3 }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ fontFamily: "  Consolas ", fontSize: 15.6 }), {
    fontFamily: "Consolas",
    fontSize: 16,
  });
  assert.equal(normalizeSettings({ fontSize: 2 }).fontSize, 8);
  assert.equal(normalizeSettings({ fontSize: 99 }).fontSize, 40);
  assert.equal(normalizeSettings({ fontFamily: "   " }).fontFamily, "微软雅黑");
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
    fontSize: 18,
  });
  assert.deepEqual(style, {
    "--editor-font-family":
      '"SimSun", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
    "--editor-font-size": "18px",
  });
});
