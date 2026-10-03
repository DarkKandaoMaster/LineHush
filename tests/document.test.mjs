import test from "node:test";
import assert from "node:assert/strict";
import {
  fromText,
  toText,
  toEditor,
  fromEditor,
  toHtml,
  fileName,
  exportFile,
  exportImages,
} from "../src/core/document.ts";

const idA = "a".repeat(12) + "0".repeat(52);
const idB = "b".repeat(12) + "1".repeat(52);

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
    blocks: [
      { type: "line", text: "" },
      {
        type: "images",
        images: [{ id: idA, name: "图.png", width: 20, height: 10 }],
      },
      { type: "line", text: "" },
      { type: "line", text: "" },
    ],
  };
  assert.deepEqual(fromEditor(toEditor(doc)), doc);
  assert.equal(toText(doc), "\n[图片：图.png]\n\n");
});
test("HTML 导出转义正文，保留换行", () => {
  const html = toHtml(fromText('<script>\n\n & "\n'));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("white-space:pre-wrap"));
});
test("HTML 导出按 id 前缀命名附件，列表按 id 与文件名去重", () => {
  const a = { id: idA, name: "图 #1.png", width: 20, height: 10 };
  const doc = {
    blocks: [
      { type: "images", images: [a, { ...a, name: "另存.png" }] },
      { type: "line", text: "" },
      {
        type: "images",
        images: [a, { id: idB, name: "", width: 5, height: 5 }],
      },
    ],
  };
  assert.equal(exportFile(a), "aaaaaaaaaaaa-图 #1.png");
  assert.equal(exportFile(doc.blocks[2].images[1]), "bbbbbbbbbbbb");
  assert.deepEqual(exportImages(doc), [
    { id: idA, file: "aaaaaaaaaaaa-图 #1.png" },
    { id: idA, file: "aaaaaaaaaaaa-另存.png" },
    { id: idB, file: "bbbbbbbbbbbb" },
  ]);
  assert.deepEqual(exportImages(fromText("无图")), []);
  const html = toHtml(doc);
  assert.ok(
    html.includes(
      `src="附件/${encodeURIComponent("aaaaaaaaaaaa-图 #1.png")}" alt="图 #1.png"`,
    ),
  );
  assert.ok(html.includes('src="附件/bbbbbbbbbbbb"'));
});
test("文件名只取路径最后一段，无路径时为未命名", () => {
  // Windows paths (including the \\?\ prefix Rust returns) show only the file name.
  assert.equal(fileName("\\\\?\\D:\\日记\\测试.hush"), "测试.hush");
  assert.equal(fileName("D:/日记/测试.hush"), "测试.hush");
  assert.equal(fileName(null), "未命名");
});
