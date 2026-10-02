import type { JSONContent } from "@tiptap/core";

export interface Picture {
  path: string;
  name: string;
  width: number;
  height: number;
}
export type Block =
  { type: "line"; text: string } | { type: "images"; images: Picture[] };
export interface Diary {
  version: 1;
  blocks: Block[];
}

export function fromText(text: string): Diary {
  return {
    version: 1,
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
export function toEditor(doc: Diary): JSONContent {
  return {
    type: "doc",
    content: doc.blocks.map((block) =>
      block.type === "line"
        ? {
            type: "paragraph",
            ...(block.text
              ? { content: [{ type: "text", text: block.text }] }
              : {}),
          }
        : { type: "imageGroup", attrs: { images: block.images } },
    ),
  };
}
export function fromEditor(doc: JSONContent): Diary {
  return {
    version: 1,
    blocks: (doc.content ?? []).map((node): Block =>
      node.type === "imageGroup"
        ? { type: "images", images: node.attrs?.images }
        : {
            type: "line",
            text: (node.content ?? [])
              .map((child) => child.text ?? "")
              .join(""),
          },
    ),
  };
}
/** A document with a single empty line; switching away from it never asks to save. */
export function isEmpty(doc: Diary): boolean {
  return doc.blocks.length <= 1 && toText(doc) === "";
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
/** Display name of a document path; drafts have no path. */
export function fileName(path: string | null): string {
  return path?.split(/[\\/]/).pop() ?? "未命名";
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
export function toHtml(doc: Diary): string {
  const body = doc.blocks
    .map((block) =>
      block.type === "line"
        ? `<div class="line">${escapeHtml(block.text) || "<br>"}</div>`
        : `<div class="images">${block.images.map((pic) => `<img src="${escapeHtml(pic.path)}" alt="${escapeHtml(pic.name)}" width="${pic.width}" height="${pic.height}">`).join("")}</div>`,
    )
    .join("\n");
  return (
    '<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LineHush 日记</title>\n' +
    '<style>body{background:#f9f9f9;color:#202020;font:16px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;margin:24px}.line{white-space:pre-wrap;overflow-wrap:anywhere;min-height:1.6em}.images{display:flex;flex-wrap:wrap;gap:8px}img{max-width:280px;max-height:200px;object-fit:contain;width:auto;height:auto}</style>\n<body>' +
    body +
    "</body></html>"
  );
}
