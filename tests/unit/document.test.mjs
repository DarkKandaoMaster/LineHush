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
  firstLineName,
  suggestedName,
  stats,
  formatDuration,
  formatSize,
} from "../../src/core/document.ts";
import { isImageFile, isMediaFile } from "../../src/core/media-probe.ts";

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

test("首行文件名：跳过图片与空白行，去掉非法与控制字符，压缩空白，去掉末尾点与空格", () => {
  const pic = { id: idA, name: "图.png", width: 20, height: 10 };
  const name = (...blocks) =>
    firstLineName({
      blocks: blocks.map((b) =>
        typeof b === "string" ? { type: "line", text: b } : b,
      ),
    });
  assert.equal(name(""), "");
  assert.equal(name("", " \t ", "\u3000"), "");
  assert.equal(name({ type: "images", images: [pic] }), "");
  assert.equal(name("", { type: "images", images: [pic] }, "  十月 一日  ", "第二行"), "十月 一日");
  assert.equal(name('a\\b/c:d*e?f"g<h>i|j'), "abcdefghij");
  assert.equal(name("a\u0001b\u007fc\u0085d"), "abcd");
  assert.equal(name("a\t\tb   c\u3000\u3000d"), "a b c d");
  assert.equal(name("a : b"), "a b");
  assert.equal(name("结尾. . ."), "结尾");
  assert.equal(name("version 1.0..."), "version 1.0");
  assert.equal(name("...前导点保留"), "...前导点保留");
  // 只剩非法字符：为空（调用方退回日期），不往下找。
  assert.equal(name("???", "第二行"), "");
});

test("首行文件名最多 30 个码点，不截断代理对，截断后再去末尾空格", () => {
  const line = (text) => firstLineName({ blocks: [{ type: "line", text }] });
  assert.equal(line("一".repeat(40)), "一".repeat(30));
  // 😀 是代理对：按码点数，不留半个。
  const emoji = "😀".repeat(31);
  assert.equal(line(emoji), "😀".repeat(30));
  assert.equal(Array.from(line("a😀".repeat(20))).length, 30);
  assert.ok(!/[\uD800-\uDBFF]$/.test(line("a" + "😀".repeat(40))));
  assert.equal(line("a".repeat(29) + " b"), "a".repeat(29));
  assert.equal(line("a".repeat(29) + ".b"), "a".repeat(29));
});

test("建议文件名：日期为 YYYY-MM-DD，首行文字为空时退回日期", () => {
  const now = new Date(2026, 9, 8, 23, 59);
  const doc = fromText("\n今天 / 下雨\n");
  assert.equal(suggestedName(doc, "date", now), "2026-10-08");
  assert.equal(suggestedName(doc, "firstLine", now), "今天 下雨");
  assert.equal(suggestedName(fromText("\n\n"), "firstLine", now), "2026-10-08");
  assert.equal(suggestedName(fromText("<>"), "firstLine", now), "2026-10-08");
  assert.match(suggestedName(doc, "date"), /^\d{4}-\d{2}-\d{2}$/);
});

// ---- Videos and recordings (2026-10-31): pictures of kind "video" / "audio". ----

const idV = "c".repeat(12) + "2".repeat(52);
const idS = "d".repeat(12) + "3".repeat(52);
const pic = { id: idA, name: "图.png", width: 20, height: 10 };
const clip = { id: idV, name: "片 <1>.mp4", width: 1920, height: 1080, kind: "video", duration: 75.4 };
const memo = { id: idS, name: "语音.m4a", width: 0, height: 0, kind: "audio", duration: 3 };

test("视频 / 音频：kind 与时长经编辑器往返不变，图片仍只有四个字段", () => {
  const doc = { blocks: [{ type: "images", images: [pic, clip, memo] }, { type: "line", text: "" }] };
  const editor = toEditor(doc);
  assert.deepEqual(editor.content[1].attrs, { ...clip, newline: false });
  assert.deepEqual(editor.content[0].attrs, { ...pic, newline: true });
  assert.deepEqual(fromEditor(editor), doc);
  // The editor's JSON carries every attribute (kind "image", duration null for
  // an image); an image still writes only its four fields, so an older
  // document saves (and compares for the dirty mark) unchanged.
  const full = {
    type: "doc",
    content: editor.content.map((node) =>
      node.type === "image"
        ? { ...node, attrs: { kind: "image", duration: null, ...node.attrs } }
        : node,
    ),
  };
  assert.equal(JSON.stringify(fromEditor(full)), JSON.stringify(doc));
  assert.deepEqual(Object.keys(fromEditor(full).blocks[0].images[0]), ["id", "name", "width", "height"]);
});

test("视频 / 音频：TXT 占位文字、状态栏只数图片、时长 m:ss", () => {
  const doc = { blocks: [{ type: "line", text: "甲" }, { type: "images", images: [pic, clip, memo] }] };
  assert.equal(toText(doc), "甲\n[图片：图.png] [视频：片 <1>.mp4] [音频：语音.m4a]");
  assert.deepEqual(stats(doc), { characters: 1, images: 1 });
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(3), "0:03");
  assert.equal(formatDuration(59.6), "1:00");
  assert.equal(formatDuration(75.4), "1:15");
  assert.equal(formatDuration(3725), "62:05");
  assert.equal(formatDuration(undefined), "0:00");
  assert.equal(formatDuration(NaN), "0:00");
});

test("视频 / 音频：HTML 导出用 <video> / <audio> 引用附件，打印页视频放封面与时长、音频为一行文字", () => {
  const doc = { blocks: [{ type: "images", images: [pic, clip, memo] }] };
  const html = toHtml(doc);
  assert.ok(
    html.includes(
      `<video controls preload="metadata" src="附件/${encodeURIComponent(exportFile(clip))}" title="片 &lt;1&gt;.mp4" width="1920" height="1080"></video>`,
    ),
  );
  assert.ok(
    html.includes(
      `<audio controls preload="metadata" src="附件/${encodeURIComponent(exportFile(memo))}" title="语音.m4a"></audio>`,
    ),
  );
  assert.ok(html.includes(`<img src="附件/${encodeURIComponent(exportFile(pic))}"`));
  // Every original goes to 附件/, media too.
  assert.deepEqual(exportImages(doc).map((x) => x.id), [idA, idV, idS]);
  const print = toPrintHtml(doc, { fontFamily: "sans-serif", fontSizePt: 10, title: "t" });
  assert.ok(
    print.includes(
      `<span class="video"><img src="/poster/${idV}" alt="片 &lt;1&gt;.mp4" width="1920" height="1080"><span class="duration">1:15</span></span>`,
    ),
  );
  assert.ok(print.includes('<div class="audio">🔊 语音.m4a（0:03）</div>'));
  assert.ok(print.includes(`<img src="/image/${idA}"`));
  assert.ok(!print.includes("<video") && !print.includes("<audio"));
});

test("媒体文件：按 MIME 或（没有可信 MIME 时）扩展名认出视频 / 音频", () => {
  const yes = [
    { name: "a.bin", type: "video/mp4" },
    { name: "a", type: "audio/x-m4a" },
    { name: "录音.MP3", type: "" },
    ...["mp4", "m4v", "webm", "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"].map((ext) => ({
      name: `x.${ext}`,
      type: "",
    })),
    { name: "x.webm", type: "application/octet-stream" },
  ];
  for (const file of yes) assert.equal(isMediaFile(file), true, file.name);
  const no = [
    { name: "a.png", type: "image/png" },
    { name: "a.mp4", type: "image/png" },
    { name: "a.heic", type: "" },
    { name: "mp4", type: "" },
    { name: "a.txt", type: "text/plain" },
  ];
  for (const file of no) assert.equal(isMediaFile(file), false, file.name);
});

// ---- Files (2026-11-01): pictures of kind "file", any other file attached as it is. ----

const idF = "e".repeat(12) + "4".repeat(52);
const attached = { id: idF, name: "报告 <终稿>.docx", width: 0, height: 0, kind: "file", size: 364544 };

test("文件：大小按 B / KB / MB / GB 一位小数、去掉末尾 .0", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1), "1 B");
  assert.equal(formatSize(1023), "1023 B");
  assert.equal(formatSize(1024), "1 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(364544), "356 KB");
  assert.equal(formatSize(1258291), "1.2 MB");
  assert.equal(formatSize(12 * 1024 * 1024), "12 MB");
  assert.equal(formatSize(1024 * 1024 - 1), "1 MB");
  assert.equal(formatSize(3.5 * 1024 ** 3), "3.5 GB");
  assert.equal(formatSize(2048 * 1024 ** 3), "2048 GB");
  assert.equal(formatSize(undefined), "0 B");
  assert.equal(formatSize(NaN), "0 B");
});

test("文件：size 经编辑器往返不变，图片 / 媒体不写 size", () => {
  const doc = { blocks: [{ type: "images", images: [pic, attached, memo] }, { type: "line", text: "" }] };
  const editor = toEditor(doc);
  assert.deepEqual(editor.content[1].attrs, { ...attached, newline: false });
  assert.deepEqual(fromEditor(editor), doc);
  // The editor's JSON carries every attribute (size null unless a file).
  const full = {
    type: "doc",
    content: editor.content.map((node) =>
      node.type === "image"
        ? { ...node, attrs: { kind: "image", duration: null, size: null, ...node.attrs } }
        : node,
    ),
  };
  assert.equal(JSON.stringify(fromEditor(full)), JSON.stringify(doc));
  const [image, file, audio] = fromEditor(full).blocks[0].images;
  assert.deepEqual(Object.keys(image), ["id", "name", "width", "height"]);
  assert.deepEqual(Object.keys(file), ["id", "name", "width", "height", "kind", "size"]);
  assert.ok(!("size" in audio));
  // A stray size on an image is not written.
  const stray = { type: "doc", content: [{ type: "image", attrs: { ...pic, size: 5, newline: true } }] };
  assert.deepEqual(Object.keys(fromEditor(stray).blocks[0].images[0]), ["id", "name", "width", "height"]);
});

test("文件：TXT 占位、HTML 写附件链接、打印页一行文字；状态栏不数文件", () => {
  const doc = { blocks: [{ type: "line", text: "甲" }, { type: "images", images: [pic, attached] }] };
  assert.equal(toText(doc), "甲\n[图片：图.png] [文件：报告 <终稿>.docx]");
  assert.deepEqual(stats(doc), { characters: 1, images: 1 });
  const html = toHtml(doc);
  const href = `附件/${encodeURIComponent(exportFile(attached))}`;
  assert.ok(
    html.includes(
      `<div class="images"><img src="附件/${encodeURIComponent(exportFile(pic))}" alt="图.png" width="20" height="10"><a class="file" href="${href}" download="报告 &lt;终稿&gt;.docx">📎 报告 &lt;终稿&gt;.docx（356 KB）</a></div>`,
    ),
  );
  assert.deepEqual(exportImages(doc), [
    { id: idA, file: exportFile(pic) },
    { id: idF, file: `${"e".repeat(12)}-报告 <终稿>.docx` },
  ]);
  const print = toPrintHtml(doc, { fontFamily: "sans-serif", fontSizePt: 10, title: "t" });
  assert.ok(print.includes('<div class="file">📎 报告 &lt;终稿&gt;.docx（356 KB）</div>'));
  assert.ok(!print.includes(`/image/${idF}`) && !print.includes(`/poster/${idF}`));
});

test("文件：图片按 MIME 或扩展名认出，其余（非媒体）都是文件", () => {
  const images = [
    { name: "a", type: "image/png" },
    { name: "a.heic", type: "image/heic" },
    ...["png", "jpg", "jpeg", "gif", "webp", "BMP"].map((ext) => ({ name: `x.${ext}`, type: "" })),
    { name: "x.png", type: "application/octet-stream" },
  ];
  for (const file of images) assert.equal(isImageFile(file), true, file.name);
  const others = [
    { name: "a.txt", type: "text/plain" },
    { name: "a.docx", type: "" },
    { name: "笔记.hush", type: "" },
    { name: "a.bin", type: "" },
    { name: "png", type: "" },
    { name: "a.png", type: "video/mp4" },
    { name: "a.mp4", type: "" },
  ];
  for (const file of others) assert.equal(isImageFile(file), false, file.name);
});
