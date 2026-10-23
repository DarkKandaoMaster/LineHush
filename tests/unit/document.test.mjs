import test from "node:test";
import assert from "node:assert/strict";
import {
  fromText,
  toText,
  toEditor,
  fromEditor,
  toHtml,
  toPrintHtml,
  fileName,
  exportFile,
  exportImages,
} from "../../src/core/document.ts";

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
test("每个图片块是一行图片：编辑器中展开为单张图片节点，行首图片 newline，往返不变", () => {
  const a = { id: idA, name: "甲.png", width: 20, height: 10 };
  const b = { id: idB, name: "乙.jpg", width: 300, height: 400 };
  // Two rows a line break apart (consecutive blocks), then a row after an empty line.
  const doc = {
    blocks: [
      { type: "line", text: "前" },
      { type: "images", images: [a, b, a] },
      { type: "images", images: [b, a] },
      { type: "line", text: "" },
      { type: "images", images: [b] },
    ],
  };
  const editor = toEditor(doc);
  assert.deepEqual(
    editor.content.map((node) =>
      node.type === "image" ? (node.attrs.newline ? "图↵" : "图") : "行",
    ),
    ["行", "图↵", "图", "图", "图↵", "图", "行", "图↵"],
  );
  assert.deepEqual(editor.content[2], {
    type: "image",
    attrs: { ...b, newline: false },
  });
  assert.deepEqual(fromEditor(editor), doc);
  // Extra node attributes (newline among them) never reach the file.
  for (const block of fromEditor(editor).blocks)
    if (block.type === "images")
      for (const pic of block.images)
        assert.deepEqual(Object.keys(pic), ["id", "name", "width", "height"]);
});
test("fromEditor：newline 或前一个节点不是图片时开新行；相邻且无 newline 的图片同一行", () => {
  const a = { id: idA, name: "甲.png", width: 20, height: 10 };
  const b = { id: idB, name: "乙.jpg", width: 300, height: 400 };
  const blocks = (...content) =>
    fromEditor({ type: "doc", content }).blocks.map((block) =>
      block.type === "line"
        ? `行${block.text}`
        : block.images.map((pic) => (pic.id === idA ? "a" : "b")).join(""),
    );
  const image = (pic, newline) => ({ type: "image", attrs: { ...pic, newline } });
  // Images that become neighbours without a line break share a row.
  assert.deepEqual(blocks(image(a, true), image(b, false), image(a, false)), ["aba"]);
  // A line break splits the row.
  assert.deepEqual(blocks(image(a, true), image(b, true), image(a, false)), ["a", "ba"]);
  // After a text line an image starts a row whatever its newline (no meaning there).
  assert.deepEqual(
    blocks(image(a, false), { type: "paragraph" }, image(b, false), image(a, false)),
    ["a", "行", "ba"],
  );
  // Without the attribute at all (older editor JSON): neighbours share a row.
  assert.deepEqual(
    blocks({ type: "image", attrs: a }, { type: "image", attrs: { ...b, extra: 1 } }),
    ["ab"],
  );
});
test("旧文件（每组一个图片块）读回后首图 newline，原样存回", () => {
  const a = { id: idA, name: "甲.png", width: 20, height: 10 };
  const b = { id: idB, name: "乙.jpg", width: 300, height: 400 };
  const old = {
    blocks: [
      { type: "images", images: [a, b, a, b] },
      { type: "line", text: "" },
      { type: "images", images: [b] },
      { type: "line", text: "后" },
    ],
  };
  const editor = toEditor(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(
    editor.content.filter((n) => n.type === "image").map((n) => n.attrs.newline),
    [true, false, false, false, true],
  );
  assert.deepEqual(fromEditor(editor), old);
  // TXT: one line per row of images.
  const rows = {
    blocks: [
      { type: "images", images: [a, b] },
      { type: "images", images: [b] },
    ],
  };
  assert.equal(toText(rows), "[图片：甲.png] [图片：乙.jpg]\n[图片：乙.jpg]");
});
test("HTML 与 PDF 导出：每行图片一个 div.images，相邻两行之间是换行间距", () => {
  const a = { id: idA, name: "甲.png", width: 20, height: 10 };
  const doc = {
    blocks: [
      { type: "images", images: [a, a] },
      { type: "images", images: [a] },
    ],
  };
  for (const html of [
    toHtml(doc),
    toPrintHtml(doc, { fontFamily: "sans-serif", fontSizePt: 10, title: "t" }),
  ]) {
    assert.equal(html.match(/<div class="images">/g).length, 2);
    assert.ok(html.includes(".images+.images{margin-top:16px}"));
  }
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
test("PDF 打印页：逐行转义保留空行，图片读 /image/<id>，按设置的字体与字号排版", () => {
  const a = { id: idA, name: "图 <1>.png", width: 1200, height: 800 };
  const b = { id: idB, name: "", width: 5, height: 5 };
  const doc = {
    blocks: [
      { type: "line", text: '<b>粗</b> & "引号"' },
      { type: "line", text: "" },
      { type: "images", images: [a, b] },
      { type: "line", text: "  缩进" },
    ],
  };
  const html = toPrintHtml(doc, {
    fontFamily: '"微软雅黑", "Microsoft YaHei UI", sans-serif',
    fontSizePt: 10.5,
    title: "日记 <草稿>",
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("<title>日记 &lt;草稿&gt;</title>"));
  assert.ok(
    html.includes(
      '<div class="line">&lt;b&gt;粗&lt;/b&gt; &amp; &quot;引号&quot;</div>\n<div class="line"><br></div>',
    ),
  );
  assert.ok(html.includes('<div class="line">  缩进</div>'));
  assert.ok(
    html.includes(
      `<div class="images"><img src="/image/${idA}" alt="图 &lt;1&gt;.png" width="1200" height="800"><img src="/image/${idB}" alt="" width="5" height="5"></div>`,
    ),
  );
  assert.ok(!html.includes("附件/"));
  assert.ok(html.includes("@page{size:A4;margin:15mm}"));
  assert.ok(
    html.includes(
      'font-family:"微软雅黑", "Microsoft YaHei UI", sans-serif;font-size:10.5pt;line-height:normal',
    ),
  );
  assert.ok(html.includes("background:#fff"));
  assert.ok(html.includes("white-space:pre-wrap"));
  assert.ok(html.includes("max-height:160mm"));
  assert.ok(html.includes(".images{display:flex;flex-wrap:wrap;gap:8px;break-inside:avoid}"));
  // 字体列表不能提前结束 <style>。
  const hostile = toPrintHtml(fromText("x"), {
    fontFamily: "a</style><script>",
    fontSizePt: 10,
    title: "t",
  });
  assert.ok(!hostile.includes("</style><script>"));
});
test("文件名只取路径最后一段，无路径时为“无标题”并按编号区分", () => {
  // Windows paths (including the \\?\ prefix Rust returns) show only the file name.
  assert.equal(fileName("\\\\?\\D:\\日记\\测试.hush"), "测试.hush");
  assert.equal(fileName("D:/日记/测试.hush", 3), "测试.hush");
  assert.equal(fileName(null), "无标题");
  assert.equal(fileName(null, 1), "无标题");
  assert.equal(fileName(null, 2), "无标题 2");
  assert.equal(fileName(null, 12), "无标题 12");
});
