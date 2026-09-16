import test from "node:test";
import assert from "node:assert/strict";
import {
  fromText,
  toText,
  toEditor,
  fromEditor,
  toHtml,
} from "../src/document.ts";

test("文本往返保留空文档、中文、连续空行和末尾空行", () => {
  for (const text of [
    "",
    "\n",
    "中文\n\n第二行\n\n",
    "  空格\t制表符  ",
    "# 不转换 **格式**",
  ]) {
    const doc = fromText(text);
    assert.equal(toText(JSON.parse(JSON.stringify(doc))), text);
    assert.deepEqual(fromEditor(toEditor(doc)), doc);
  }
});
test("统一 CRLF 与 CR，不裁剪空白", () => {
  assert.equal(toText(fromText("a\r\n\r\nb\r")), "a\n\nb\n");
});
test("图片组前后的空行往返完整", () => {
  const doc = {
    version: 1,
    blocks: [
      { type: "line", text: "" },
      {
        type: "images",
        images: [{ path: "附件/a.png", name: "图.png", width: 20, height: 10 }],
      },
      { type: "line", text: "" },
      { type: "line", text: "" },
    ],
  };
  assert.deepEqual(fromEditor(toEditor(doc)), doc);
  assert.equal(toText(doc), "\n[图片：图.png]\n\n");
});
test("HTML 导出转义正文、文件名，保留换行", () => {
  const html = toHtml(fromText('<script>\n\n & "\n'));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("white-space:pre-wrap"));
});
