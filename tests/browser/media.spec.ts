import { test, expect, type Page } from "@playwright/test";
import {
  calls,
  editorOf,
  itemBox,
  load,
  selection,
  tile,
} from "./helpers";

// ---- Videos and recordings (2026-10-31): image nodes of kind "video" / "audio". ----

const MEDIA = "http://linehush-media.localhost";

/** `seconds` of silence as a WAV file (8 kHz, 8-bit mono), which every media element plays. */
function wav(seconds: number) {
  const samples = Math.round(8000 * seconds);
  const out = Buffer.alloc(44 + samples, 128);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(8000, 28);
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples, 40);
  return out;
}

/** Rust's media protocol: every id plays two seconds of silence. */
async function serveMedia(page: Page) {
  const body = wav(2);
  await page.route(`${MEDIA}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body }),
  );
}

const pic = { id: "a", name: "a.png", width: 200, height: 100 };
const clip = { id: "v", name: "旅行.mp4", width: 640, height: 360, kind: "video" as const, duration: 75.4 };
const memo = { id: "s", name: "一段很长很长很长很长很长很长的语音备忘录.m4a", width: 0, height: 0, kind: "audio" as const, duration: 61 };

test("视频：封面与时长、播放角标，与图片并排；双击或单击角标打开 <video> 预览，Esc 关闭", async ({ page }) => {
  await serveMedia(page);
  const errors = await load(page, {
    images: "png",
    blocks: [
      { type: "line", text: "上面" },
      { type: "images", images: [pic, clip] },
      { type: "line", text: "下面" },
    ],
  });
  const video = editorOf(page).locator(".video-tile");
  await expect(video).toHaveCount(1);
  // The cover frame is the thumbnail (read_image, not the original), scaled into 280×200.
  await expect
    .poll(() => video.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  expect((await calls(page, "read_image")).find((c: any) => c.id === "v")).toMatchObject({ original: false });
  const box = (await video.boundingBox())!;
  expect(Math.round(box.width)).toBe(280);
  expect(Math.round(box.height)).toBe(158);
  await expect(video.locator(".media-duration")).toHaveText("1:15");
  await expect(video.locator(".play-badge")).toBeVisible();
  // One row with the image: same top, the video right of it.
  const a = await itemBox(page, 0);
  const v = await itemBox(page, 1);
  expect(Math.abs(v.y - a.y)).toBeLessThan(1);
  expect(v.x).toBeGreaterThan(a.x + a.width);
  // Double click: the preview plays the video from the media protocol, not the original's bytes.
  await tile(page, 1).dblclick();
  const preview = page.locator("dialog.image-preview");
  await expect(preview).toBeVisible();
  const player = preview.locator("video");
  await expect(player).toHaveAttribute("src", `${MEDIA}/t1/v`);
  expect(await player.evaluate((el: HTMLVideoElement) => el.controls && el.autoplay)).toBe(true);
  await expect(preview.locator("img")).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "保存原文件" })).toBeVisible();
  expect((await calls(page, "read_image")).some((c: any) => c.original)).toBe(false);
  // The dialog itself has the focus (Enter there closes it); Esc closes it too.
  await expect(preview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(preview.locator("video")).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  // A click on the badge opens it as well, leaving the caret where it was.
  await editorOf(page).locator("p").last().click();
  await page.keyboard.press("End");
  const before = await selection(page);
  await video.locator(".play-badge").click();
  await expect(preview).toBeVisible();
  await expect(preview.locator("video")).toHaveCount(1);
  await preview.getByRole("button", { name: "关闭" }).click();
  await expect(preview).toBeHidden();
  expect(await selection(page)).toEqual(before);
  // Images and videos alike: the status bar counts only the image.
  await expect(page.locator(".statusbar")).toContainText("1 张图片");
  expect(errors).toEqual([]);
});

test("音频：胶囊显示名字与时长、与图片并排；播放按钮就地播放 / 暂停，不移动光标、不夺焦点；双击胶囊选中、不预览", async ({
  page,
}) => {
  await serveMedia(page);
  const errors = await load(page, {
    images: "png",
    blocks: [
      { type: "line", text: "上面" },
      { type: "images", images: [pic, memo] },
      { type: "line", text: "下面" },
    ],
  });
  const chip = editorOf(page).locator(".audio-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".audio-name")).toHaveText(memo.name);
  await expect(chip.locator(".audio-duration")).toHaveText("1:01");
  // A long name is cut short: the chip is at most 280px wide, 32px tall.
  const box = (await chip.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(280);
  expect(Math.round(box.height)).toBe(32);
  expect(
    await chip.locator(".audio-name").evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  // No thumbnail is read for a recording.
  expect((await calls(page, "read_image")).some((c: any) => c.id === "s")).toBe(false);
  const a = await itemBox(page, 0);
  const s = await itemBox(page, 1);
  expect(Math.abs(s.y - a.y)).toBeLessThan(1);
  expect(s.x).toBeGreaterThan(a.x + a.width);
  // The item is as wide as the chip, not as the whole name (clicks go by its halves).
  expect(Math.abs(s.width - box.width)).toBeLessThan(1);
  // The hidden <audio> loads nothing until played.
  const audio = chip.locator("audio");
  expect(await audio.evaluate((el: HTMLAudioElement) => [el.preload, el.hidden, el.src])).toEqual([
    "none",
    true,
    `${MEDIA}/t1/s`,
  ]);
  await editorOf(page).locator("p").first().click();
  await page.keyboard.press("End");
  const before = await selection(page);
  const play = chip.getByRole("button", { name: "播放" });
  await play.click();
  await expect(chip).toHaveClass(/playing/);
  await expect(chip.getByRole("button", { name: "暂停" })).toBeVisible();
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
  expect(await selection(page)).toEqual(before);
  await expect(editorOf(page)).toBeFocused();
  // Typing still goes where the caret was.
  await page.keyboard.type("!");
  await expect(editorOf(page).locator("p").first()).toHaveText("上面!");
  await chip.getByRole("button", { name: "暂停" }).click();
  await expect(chip).not.toHaveClass(/playing/);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  expect(await selection(page)).toEqual({ type: "text", anchor: 4, head: 4 });
  // A double click on the chip (not its button) selects the recording; no preview.
  await chip.locator(".audio-name").dblclick();
  expect(await selection(page)).toMatchObject({ type: "blockRange", anchor: 6, head: 7 });
  await expect(page.locator("dialog.image-preview")).toBeHidden();
  // Deleting it stops it (the node view goes).
  await chip.getByRole("button", { name: "播放" }).click();
  await expect(chip).toHaveClass(/playing/);
  const stopped = await audio.evaluateHandle((el) => el);
  await chip.locator(".audio-name").dblclick();
  await page.keyboard.press("Delete");
  await expect(editorOf(page).locator(".audio-chip")).toHaveCount(0);
  expect(await stopped.evaluate((el: HTMLAudioElement) => [el.paused, el.getAttribute("src")])).toEqual([
    true,
    null,
  ]);
  await expect(page.locator(".statusbar")).toContainText("1 张图片");
  expect(errors).toEqual([]);
});

test("导入音频：前端读出时长后经 import_media 存入（无封面），胶囊带文件名；读不出的报“不支持的媒体格式”", async ({
  page,
}) => {
  await serveMedia(page);
  const errors = await load(page);
  const input = page.locator(".tab-pane input[type=file]").first();
  await input.setInputFiles({ name: "录音.wav", mimeType: "audio/wav", buffer: wav(1.2) });
  const chip = editorOf(page).locator(".audio-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".audio-name")).toHaveText("录音.wav");
  await expect(chip.locator(".audio-duration")).toHaveText("0:01");
  const [imported] = await calls(page, "import_media");
  expect(imported.size).toBe(44 + 9600);
  expect(imported.headers).toMatchObject({
    "x-linehush-tab": "t1",
    "x-linehush-kind": "audio",
    "x-linehush-width": "0",
    "x-linehush-height": "0",
  });
  expect(Number(imported.headers["x-linehush-duration"])).toBeCloseTo(1.2, 2);
  expect(await calls(page, "media_poster")).toEqual([]);
  expect(await calls(page, "import_image")).toEqual([]);
  // The document model keeps kind and length, which the stash writes.
  await expect
    .poll(async () => {
      const stashed = await calls(page, "stash_document");
      return stashed.at(-1)?.document.blocks.find((b: any) => b.type === "images")?.images[0];
    })
    .toMatchObject({ id: "media1", name: "录音.wav", width: 0, height: 0, kind: "audio" });
  // Not a recording at all: turned away before Rust sees it.
  await input.setInputFiles({ name: "坏.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("不是音频") });
  await expect(page.locator(".error-banner")).toContainText("无法插入“坏.mp3”：不支持的媒体格式");
  expect(await calls(page, "import_media")).toHaveLength(1);
  await expect(chip).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("复制为纯文本：视频 / 音频写作 [视频] / [音频]，与图片同一行", async ({ page }) => {
  await serveMedia(page);
  await load(page, {
    images: "png",
    blocks: [
      { type: "line", text: "甲" },
      { type: "images", images: [pic, clip, memo] },
    ],
  });
  const text = await editorOf(page).evaluate((el: any) => {
    const view = el.editor.view;
    const slice = view.state.doc.slice(0, view.state.doc.content.size);
    return view.someProp("clipboardTextSerializer", (f: any) => f(slice, view));
  });
  expect(text).toBe("甲\n[图片] [视频] [音频]");
});

test("导入视频：前端读出画面尺寸与时长、截封面，经 import_media → media_poster 存入，正文显示封面", async ({
  page,
}) => {
  await serveMedia(page);
  const errors = await load(page);
  // A one-second WebM made by MediaRecorder (no duration in its header, as recordings often are).
  const recorded = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const draw = () => {
        context.fillStyle = performance.now() - started < 500 ? "#c33" : "#33c";
        context.fillRect(0, 0, 320, 240);
        if (performance.now() - started < 1000) requestAnimationFrame(draw);
        else resolve();
      };
      draw();
    });
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  const input = page.locator(".tab-pane input[type=file]").first();
  await input.setInputFiles({
    name: "片段.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(recorded, "base64"),
  });
  const video = editorOf(page).locator(".video-tile");
  await expect(video).toHaveCount(1);
  const [imported] = await calls(page, "import_media");
  expect(imported.headers).toMatchObject({
    "x-linehush-tab": "t1",
    "x-linehush-kind": "video",
    "x-linehush-width": "320",
    "x-linehush-height": "240",
  });
  const duration = Number(imported.headers["x-linehush-duration"]);
  expect(duration).toBeGreaterThan(0.5);
  expect(duration).toBeLessThan(3);
  // The cover frame went in before the node, as a PNG within 560×400.
  const [poster] = await calls(page, "media_poster");
  expect(poster.headers).toMatchObject({ "x-linehush-tab": "t1", "x-linehush-id": "media1" });
  expect(poster.size).toBeGreaterThan(0);
  await expect
    .poll(() => video.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(video.locator(".media-duration")).toHaveText(/^0:0[1-3]$/);
  const box = (await video.boundingBox())!;
  expect(Math.round(box.width)).toBe(267);
  expect(Math.round(box.height)).toBe(200);
  await expect(page.locator(".statusbar")).not.toContainText("图片");
  expect(errors).toEqual([]);
});
