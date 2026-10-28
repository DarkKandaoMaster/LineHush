import type { JSONContent } from "@tiptap/core";
import type { DefaultFileName } from "./settings.ts";

export interface Picture {
  /** SHA-256 of the original bytes, which the .hush file stores unchanged. */
  id: string;
  name: string;
  width: number;
  height: number;
}
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
        : block.images.map((pic) => `[图片：${pic.name}]`).join(" "),
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
        : block.images.map(({ id, name, width, height }, i) => ({
            type: "image",
            attrs: { id, name, width, height, newline: i === 0 },
          })),
    ),
  };
}
export function fromEditor(doc: JSONContent): Diary {
  const blocks: Block[] = [];
  let previous: JSONContent | undefined;
  for (const node of doc.content ?? []) {
    if (node.type === "image") {
      const { id, name, width, height, newline } = node.attrs ?? {};
      const pic: Picture = { id, name, width, height };
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
/** Status bar counts: characters are Unicode code points in text lines. */
export function stats(doc: Diary): { characters: number; images: number } {
  let characters = 0;
  let images = 0;
  for (const block of doc.blocks) {
    if (block.type === "line") characters += Array.from(block.text).length;
    else images += block.images.length;
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
/** The exported body: a div per line, a div of images per row, each image's `src` from `src`. */
function bodyHtml(doc: Diary, src: (pic: Picture) => string): string {
  return doc.blocks
    .map((block) =>
      block.type === "line"
        ? `<div class="line">${escapeHtml(block.text) || "<br>"}</div>`
        : `<div class="images">${block.images.map((pic) => `<img src="${src(pic)}" alt="${escapeHtml(pic.name)}" width="${pic.width}" height="${pic.height}">`).join("")}</div>`,
    )
    .join("\n");
}
export function toHtml(doc: Diary): string {
  const body = bodyHtml(
    doc,
    (pic) => `附件/${escapeHtml(encodeURIComponent(exportFile(pic)))}`,
  );
  return (
    '<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LineHush 笔记</title>\n' +
    '<style>body{background:#f9f9f9;color:#202020;font:16px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;margin:24px}.line{white-space:pre-wrap;overflow-wrap:anywhere;min-height:1.6em}.images{display:flex;flex-wrap:wrap;gap:8px}.images+.images{margin-top:16px}img{max-width:280px;max-height:200px;object-fit:contain;width:auto;height:auto}</style>\n<body>' +
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
 * 自定义协议提供），等比缩小到不超出 A4 版心，且不跨页拆开。
 */
export function toPrintHtml(doc: Diary, options: PrintOptions): string {
  const body = bodyHtml(doc, (pic) => `/image/${encodeURIComponent(pic.id)}`);
  // 字体列表里若有 `</` 会提前结束 <style>，转成 CSS 转义。
  const font = options.fontFamily.replace(/</g, "\\3c ");
  return (
    `<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(options.title)}</title>\n` +
    `<style>@page{size:A4;margin:15mm}html,body{background:#fff}body{color:#202020;margin:0;font-family:${font};font-size:${options.fontSizePt}pt;line-height:normal}` +
    ".line{white-space:pre-wrap;overflow-wrap:anywhere;min-height:1lh}.images{display:flex;flex-wrap:wrap;gap:8px;break-inside:avoid}.images+.images{margin-top:16px}" +
    "img{max-width:100%;max-height:160mm;width:auto;height:auto;object-fit:contain;break-inside:avoid}</style>\n<body>" +
    body +
    "</body></html>"
  );
}
