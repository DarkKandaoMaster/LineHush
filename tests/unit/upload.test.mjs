import test from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_BYTES,
  FILE_LIMIT,
  FILE_TOO_LARGE,
  checkFileSize,
  chunkRanges,
  folderPercent,
  isChunked,
  progressText,
  sameProgress,
  showsProgress,
  uploadPercent,
} from "../../src/core/upload.ts";

test("chunkRanges：按块切开、末块取余、空文件没有块", () => {
  assert.equal(CHUNK_BYTES, 8 * 1024 * 1024);
  assert.deepEqual(chunkRanges(0), []);
  assert.deepEqual(chunkRanges(1), [[0, 1]]);
  assert.deepEqual(chunkRanges(10, 4), [
    [0, 4],
    [4, 8],
    [8, 10],
  ]);
  assert.deepEqual(chunkRanges(8, 4), [
    [0, 4],
    [4, 8],
  ]);
  const mb20 = 20 * 1024 * 1024;
  const ranges = chunkRanges(mb20);
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges.at(-1), [2 * CHUNK_BYTES, mb20]);
});

test("isChunked：恰好一块仍整块送，多一个字节才分块", () => {
  assert.equal(isChunked(0), false);
  assert.equal(isChunked(CHUNK_BYTES), false);
  assert.equal(isChunked(CHUNK_BYTES + 1), true);
});

test("checkFileSize：256 MB 以内放行，超过报与 Rust 相同的文案", () => {
  checkFileSize(0);
  checkFileSize(FILE_LIMIT);
  assert.throws(() => checkFileSize(FILE_LIMIT + 1), { message: FILE_TOO_LARGE });
  assert.equal(FILE_TOO_LARGE, "文件过大（上限 256 MB）");
});

test("uploadPercent：向下取整，送完才到 100", () => {
  assert.equal(uploadPercent(0, 100), 0);
  assert.equal(uploadPercent(999, 1000), 99);
  assert.equal(uploadPercent(1000, 1000), 100);
  assert.equal(uploadPercent(8, 20), 40);
  assert.equal(uploadPercent(0, 0), 100);
});

test("progressText：单个不写序号，多个写第几个 / 共几个；没有百分比时只写名字", () => {
  const item = { name: "旅行.mp4", index: 1, total: 1, percent: 45 };
  assert.equal(progressText(item), "正在插入“旅行.mp4”… 45%");
  assert.equal(
    progressText({ ...item, index: 2, total: 5, percent: 100 }),
    "正在插入 2 / 5：“旅行.mp4”… 100%",
  );
  assert.equal(progressText({ ...item, name: "小.txt", percent: null }), "正在插入“小.txt”…");
  assert.equal(
    progressText({ ...item, name: "相册.zip", index: 3, total: 3, percent: null }),
    "正在插入 3 / 3：“相册.zip”…",
  );
  assert.equal(progressText({ ...item, percent: 0 }), "正在插入“旅行.mp4”… 0%");
});

test("showsProgress：批次里有分块的文件（不论类型）或文件夹（不论大小）才显示横幅，全是小文件不显示", () => {
  const file = (name, type, size = 1) => ({ name, type, size });
  const small = [
    file("a.png", "image/png"),
    file("清单.txt", "text/plain"),
    file("录音.wav", "audio/wav"),
    file("v.mp4", "video/mp4", CHUNK_BYTES),
  ];
  assert.equal(showsProgress([]), false);
  assert.equal(showsProgress(small), false);
  for (const big of [
    file("大图.jpg", "image/jpeg", CHUNK_BYTES + 1),
    file("视频.mp4", "video/mp4", 20 * 1024 * 1024),
    file("录音.flac", "audio/flac", CHUNK_BYTES + 1),
    file("数据.bin", "", CHUNK_BYTES + 1),
  ])
    assert.equal(showsProgress([...small, big]), true, big.name);
  assert.equal(showsProgress([small[0], { folder: "相册", path: "D:/相册" }]), true);
  assert.equal(showsProgress([{ folder: "空", read: async () => ({ name: "空", files: [], dirs: [] }) }]), true);
});

test("folderPercent：按已打包字节；文件全是空的按文件数；没有文件为 100", () => {
  assert.equal(folderPercent(0, 1000, 0, 3), 0);
  assert.equal(folderPercent(450, 1000, 1, 3), 45);
  assert.equal(folderPercent(999, 1000, 2, 3), 99);
  assert.equal(folderPercent(1000, 1000, 3, 3), 100);
  // Empty files only: by count.
  assert.equal(folderPercent(0, 0, 0, 4), 0);
  assert.equal(folderPercent(0, 0, 1, 4), 25);
  assert.equal(folderPercent(0, 0, 4, 4), 100);
  // An empty folder (or one with only folders).
  assert.equal(folderPercent(0, 0, 0, 0), 100);
});

test("sameProgress：逐项比较，null 只等于 null", () => {
  const a = { name: "a", index: 1, total: 2, percent: null };
  assert.equal(sameProgress(null, null), true);
  assert.equal(sameProgress(a, null), false);
  assert.equal(sameProgress(null, a), false);
  assert.equal(sameProgress(a, { ...a }), true);
  for (const change of [{ name: "b" }, { index: 2 }, { total: 3 }, { percent: 0 }])
    assert.equal(sameProgress(a, { ...a, ...change }), false, JSON.stringify(change));
});
