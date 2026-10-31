import type { JSONContent } from "@tiptap/core";
import type { DefaultFileName } from "./settings.ts";

/**
 * What a picture is: an image, a video or an audio recording (the two
 * "media"), or any other file, attached as it is.
 */
export type PictureKind = "image" | "video" | "audio" | "file";
export interface Picture {
  /** SHA-256 of the original bytes, which the .hush file stores unchanged. */
  id: string;
  name: string;
  /** Pixels of the image or of the video's frame; 0 for audio and a file. */
  width: number;
  height: number;
  /** Absent for an image, so older documents read and write unchanged. */
  kind?: PictureKind;
  /** Seconds, video and audio only. */
  duration?: number;
  /** Bytes, a file only. */
  size?: number;
}
export const kindOf = (pic: { kind?: PictureKind | null }): PictureKind =>
  pic.kind ?? "image";
/** A video's or a recording's length as m:ss (minutes not capped at 59). */
export function formatDuration(seconds: number | null | undefined): string {
  const total =
    typeof seconds === "number" && Number.isFinite(seconds)
      ? Math.max(0, Math.round(seconds))
      : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
/**
 * A file's size as Explorer would round it: bytes below 1 KB, else KB / MB / GB
 * with one decimal, a trailing `.0` dropped (`356 KB`, `1.2 MB`, `12 MB`).
 */
export function formatSize(bytes: number | null | undefined): string {
  let value =
    typeof bytes === "number" && Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB"];
  let unit = 0;
  value /= 1024;
  // 1023.96 KB rounds to 1024.0: show it as the next unit.
  while (unit < units.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    unit++;
  }
  return `${String(Math.round(value * 10) / 10)} ${units[unit]}`;
}
/** What a picture is called in text (TXT export, a plain-text copy): 图片 / 视频 / 音频 / 文件. */
export const PLACEHOLDER: Record<PictureKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  file: "文件",
};
export type Block =
  { type: "line"; text: string } | { type: "images"; images: Picture[] };
export interface Diary {
  blocks: Block[];
}

export function fromText(text: string): Diary {
  return {
    blocks: text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((text) => ({ type: "line", text })),
  };
}
export function toText(doc: Diary): string {
  return doc.blocks
    .map((block) =>
      block.type === "line"
        ? block.text
        : block.images
            .map((pic) => `[${PLACEHOLDER[kindOf(pic)]}：${pic.name}]`)
            .join(" "),
    )
    .join("\n");
}
/**
 * The editor holds one `image` node per picture. Each `images` block is one row
 * of images (wrapping when it does not fit), and consecutive `images` blocks are
 * consecutive rows, as text lines are. In the editor the first image of a row
 * has `newline: true`: after another image it starts a new row (a line break
 * between the two images). `fromEditor` starts a block at such an image and at
 * any image that does not follow an image, so older files, with one block per
 * run of images, read back and save unchanged.
 */
export function toEditor(doc: Diary): JSONContent {
  return {
    type: "doc",
    content: doc.blocks.flatMap((block): JSONContent[] =>
      block.type === "line"
        ? [
            {
              type: "paragraph",
              ...(block.text
                ? { content: [{ type: "text", text: block.text }] }
                : {}),
            },
          ]
        : block.images.map(({ id, name, width, height, kind, duration, size }, i) => ({
            type: "image",
            attrs: {
              id,
              name,
              width,
              height,
              ...(kind ? { kind } : {}),
              ...(duration != null ? { duration } : {}),
              ...(size != null ? { size } : {}),
              newline: i === 0,
            },
          })),
    ),
  };
}
export function fromEditor(doc: JSONContent): Diary {
  const blocks: Block[] = [];
  let previous: JSONContent | undefined;
  for (const node of doc.content ?? []) {
    if (node.type === "image") {
      const { id, name, width, height, kind, duration, size, newline } =
        node.attrs ?? {};
      const pic: Picture = { id, name, width, height };
      // Only media and files carry these, so an image (and an older document)
      // writes exactly what it read.
      if (kind && kind !== "image") pic.kind = kind;
      if (typeof duration === "number") pic.duration = duration;
      if (kind === "file" && typeof size === "number") pic.size = size;
      const last = blocks[blocks.length - 1];
      if (previous?.type === "image" && !newline && last?.type === "images")
        last.images.push(pic);
      else blocks.push({ type: "images", images: [pic] });
    } else
      blocks.push({
        type: "line",
        text: (node.content ?? []).map((child) => child.text ?? "").join(""),
      });
    previous = node;
  }
  return { blocks };
}
/**
 * Status bar counts: characters are Unicode code points in text lines; images
 * are images alone, not videos, recordings or files.
 */
export function stats(doc: Diary): { characters: number; images: number } {
  let characters = 0;
  let images = 0;
  for (const block of doc.blocks) {
    if (block.type === "line") characters += Array.from(block.text).length;
    else
      images += block.images.filter((pic) => kindOf(pic) === "image").length;
  }
  return { characters, images };
}
/**
 * Display name of a document path. Drafts have no path and are numbered per
 * window like Notepad: "无标题", "无标题 2", …
 */
export function fileName(path: string | null, untitled = 1): string {
  return (
    path?.split(/[\\/]/).pop() ??
    (untitled === 1 ? "无标题" : `无标题 ${untitled}`)
  );
}
/** Longest name `firstLineName` gives, in code points. */
export const FIRST_LINE_NAME_LENGTH = 30;
/**
 * The first text line with anything but whitespace, made a Windows file name:
 * whitespace runs become one space, `\ / : * ? " < > |` and control characters
 * are dropped, at most `FIRST_LINE_NAME_LENGTH` code points are kept (never half
 * a surrogate pair), and trailing dots and spaces go. Image rows are skipped.
 * Empty when there is no such line or nothing of it is left.
 */
export function firstLineName(doc: Diary): string {
  const line = doc.blocks.find(
    (block) => block.type === "line" && /\S/u.test(block.text),
  );
  if (line?.type !== "line") return "";
  const name = line.text
    .replace(/\s+/gu, " ")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return Array.from(name)
    .slice(0, FIRST_LINE_NAME_LENGTH)
    .join("")
    .replace(/[. ]+$/, "");
}
/**
 * The name (without `.hush`) an untitled document is first saved under, per the
 * “默认文件名” setting: the date as YYYY-MM-DD, or `firstLineName` and the date
 * when that is empty.
 */
export function suggestedName(
  doc: Diary,
  mode: DefaultFileName,
  now: Date = new Date(),
): string {
  const date = now.toLocaleDateString("sv-SE");
  return mode === "firstLine" ? firstLineName(doc) || date : date;
}
function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
/**
 * File name of an exported original inside `附件/`. The id prefix keeps
 * different images apart; a nameless picture gets no extension rather than a
 * guessed one (`.img` would open as a disk image on Windows).
 */
export function exportFile(pic: Picture): string {
  const prefix = pic.id.slice(0, 12);
  return pic.name ? `${prefix}-${pic.name}` : prefix;
}
/** Originals an HTML export writes next to it, once per id and file name. */
export function exportImages(doc: Diary): { id: string; file: string }[] {
  const images = new Map<string, { id: string; file: string }>();
  for (const block of doc.blocks)
    if (block.type === "images")
      for (const pic of block.images) {
        const file = exportFile(pic);
        images.set(`${pic.id}/${file}`, { id: pic.id, file });
      }
  return [...images.values()];
}
/** The exported body: a div per line, a div per row of pictures, each made by `item`. */
function bodyHtml(doc: Diary, item: (pic: Picture) => string): string {
  return doc.blocks
    .map((block) =>
      block.type === "line"
        ? `<div class="line">${escapeHtml(block.text) || "<br>"}</div>`
        : `<div class="images">${block.images.map(item).join("")}</div>`,
    )
    .join("\n");
}
const imgHtml = (pic: Picture, src: string) =>
  `<img src="${src}" alt="${escapeHtml(pic.name)}" width="${pic.width}" height="${pic.height}">`;
export function toHtml(doc: Diary): string {
  const body = bodyHtml(doc, (pic) => {
    const src = `附件/${escapeHtml(encodeURIComponent(exportFile(pic)))}`;
    const title = escapeHtml(pic.name);
    switch (kindOf(pic)) {
      case "video":
        return `<video controls preload="metadata" src="${src}" title="${title}" width="${pic.width}" height="${pic.height}"></video>`;
      case "audio":
        return `<audio controls preload="metadata" src="${src}" title="${title}"></audio>`;
      case "file":
        return `<a class="file" href="${src}" download="${title}">📎 ${title}（${formatSize(pic.size)}）</a>`;
      default:
        return imgHtml(pic, src);
    }
  });
  return (
    '<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LineHush 笔记</title>\n' +
    '<style>body{background:#f9f9f9;color:#202020;font:16px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;margin:24px}.line{white-space:pre-wrap;overflow-wrap:anywhere;min-height:1.6em}.images{display:flex;flex-wrap:wrap;gap:8px}.images+.images{margin-top:16px}img,video{max-width:280px;max-height:200px;object-fit:contain;width:auto;height:auto}audio{max-width:100%}a.file{align-self:center;color:inherit}</style>\n<body>' +
    body +
    "</body></html>"
  );
}
/** PDF 导出所用打印页的字体、字号与标题。 */
export interface PrintOptions {
  /** CSS 字体列表，如 `cssFontFamily` 的结果。 */
  fontFamily: string;
  fontSizePt: number;
  title: string;
}
/**
 * Rust 在隐藏窗口里加载并用 WebView2 PrintToPdf 打印成 PDF 的页面。文字行与编辑区
 * 一致（同字体、字号、字体自然行高）；图片从 `/image/<id>` 读原图（由 Rust 的
 * 自定义协议提供），等比缩小到不超出 A4 版心，且不跨页拆开。视频放 `/poster/<id>` 的
 * 封面并在右下角叠时长；音频为一行文字“🔊 名字（m:ss）”，文件为“📎 名字（大小）”。
 */
export function toPrintHtml(doc: Diary, options: PrintOptions): string {
  const body = bodyHtml(doc, (pic) => {
    const id = encodeURIComponent(pic.id);
    switch (kindOf(pic)) {
      case "video":
        return `<span class="video">${imgHtml(pic, `/poster/${id}`)}<span class="duration">${formatDuration(pic.duration)}</span></span>`;
      case "audio":
        return `<div class="audio">🔊 ${escapeHtml(pic.name)}（${formatDuration(pic.duration)}）</div>`;
      case "file":
        return `<div class="file">📎 ${escapeHtml(pic.name)}（${formatSize(pic.size)}）</div>`;
      default:
        return imgHtml(pic, `/image/${id}`);
    }
  });
  // 字体列表里若有 `</` 会提前结束 <style>，转成 CSS 转义。
  const font = options.fontFamily.replace(/</g, "\\3c ");
  return (
    `<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(options.title)}</title>\n` +
    `<style>@page{size:A4;margin:15mm}html,body{background:#fff}body{color:#202020;margin:0;font-family:${font};font-size:${options.fontSizePt}pt;line-height:normal}` +
    ".line{white-space:pre-wrap;overflow-wrap:anywhere;min-height:1lh}.images{display:flex;flex-wrap:wrap;gap:8px;break-inside:avoid}.images+.images{margin-top:16px}" +
    "img{max-width:100%;max-height:160mm;width:auto;height:auto;object-fit:contain;break-inside:avoid}" +
    ".video{position:relative;display:block;max-width:100%;break-inside:avoid}.video img{display:block}" +
    ".duration{position:absolute;right:4px;bottom:4px;padding:0 4px;border-radius:3px;background:#000a;color:#fff;font-size:9pt}" +
    ".audio,.file{white-space:pre-wrap;overflow-wrap:anywhere}</style>\n<body>" +
    body +
    "</body></html>"
  );
}
