/**
 * The outline of a text selection drawn like VS Code's `editor.roundedSelection`
 * (its `selectionsOverlay.ts`, radius 3px): one rectangle per line, joined
 * into one shape, with every corner rounded, the outer ones and the inner ones
 * where two lines of different width meet. No DOM here, so the Node tests can
 * load it.
 */

import type { Node as PmNode } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";
import type { SelectionCorners } from "../core/settings.ts";

/**
 * Positions of the top-level paragraphs whose line break is inside the
 * selection: the paragraph at p of size n ends with a line break between
 * p + n - 1 and p + n, which is selected when from <= p + n - 1 and to >= p + n.
 * The last block of the document has no line break after it. Like Notepad /
 * VS Code, the drawn selection (caret.ts) shows each as one space's width after
 * the line's text; the browser draws nothing for "我|" to the next line's start.
 */
export function selectedNewlines(doc: PmNode, selection: Selection): number[] {
  const { from, to, empty } = selection;
  if (empty) return [];
  const out: number[] = [];
  const last = doc.childCount - 1;
  doc.nodesBetween(from, to, (node, pos, _parent, index) => {
    const end = pos + node.nodeSize;
    if (node.type.name === "paragraph" && index < last && from <= end - 1 && to >= end)
      out.push(pos);
    return false;
  });
  return out;
}

/**
 * What the status bar shows as selected (“已选 3 个字符，1 个附件”): the code
 * points of the selected text (an emoji or a Chinese character is one) plus
 * one character per line break the selection covers, and the attachments it
 * covers (every `image` node: an image, a video, a recording or a file each
 * one). Null for an empty selection, so nothing is counted while typing, and
 * when it covers nothing (Ctrl+A in an empty document), as in Notepad.
 *
 * A line break is every boundary between two top-level blocks except between
 * two images of the same row (the one after without `newline`): text line |
 * text line, text line | image, image | text line, and a row break, as
 * `stats` counts them in the whole document. The break at boundary b spans from
 * the end of the block before (b - 1 inside a text line, b after an image) to
 * the start of the block after (b + 1 inside a text line, b before an image),
 * and is selected when the selection covers that span: from the end of a line
 * to the next line's start (also a BlockRange from after an image to the start
 * of the text line below); a row break, which has no width, only when the
 * selection reaches past it on both sides. Between two text lines a selection
 * may also end at b itself (as `selectedNewlines` takes it).
 */
export function selectionCounts(
  doc: PmNode,
  selection: Selection,
): { characters: number; attachments: number } | null {
  const { from, to, empty } = selection;
  if (empty) return null;
  let characters = 0;
  let attachments = 0;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const text = node.text ?? "";
      characters += Array.from(
        text.slice(Math.max(0, from - pos), Math.min(text.length, to - pos)),
      ).length;
      return false;
    }
    // A picture (one position) is visited only when the range covers it whole.
    if (node.type.name === "image") {
      attachments++;
      return false;
    }
    return true;
  });
  let b = 0;
  for (let i = 0; i < doc.childCount - 1; i++) {
    const before = doc.child(i);
    const after = doc.child(i + 1);
    b += before.nodeSize;
    if (b - 1 > to) break;
    const beforeImage = before.type.name === "image";
    const afterImage = after.type.name === "image";
    if (beforeImage && afterImage && !after.attrs.newline) continue;
    const start = beforeImage ? b : b - 1;
    const end = afterImage || !beforeImage ? b : b + 1;
    if (from > start || to < end) continue;
    if (beforeImage && afterImage && (from === b || to === b)) continue;
    characters++;
  }
  return characters || attachments ? { characters, attachments } : null;
}

/** VS Code's corner radius in CSS pixels. */
export const SELECTION_RADIUS = 3;

/**
 * The corner radius for the “选区边角” setting: "rounded" is VS Code's,
 * "square" the same shape with no rounding (a right-angled polygon).
 */
export function cornerRadius(choice: SelectionCorners) {
  return choice === "square" ? 0 : SELECTION_RADIUS;
}

/** One visual line of the selection. */
export interface Row {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

type Point = [number, number];

/** Rows closer than this are taken to touch (rounding of line boxes). */
const TOUCH = 0.5;

/** Splits rows (in order, top to bottom) into runs that touch, each one shape. */
export function runs(rows: Row[]): Row[][] {
  const out: Row[][] = [];
  let run: Row[] = [];
  for (const row of rows) {
    if (!(row.right > row.left) || !(row.bottom > row.top)) continue;
    const last = run[run.length - 1];
    if (
      last &&
      Math.abs(row.top - last.bottom) <= TOUCH &&
      row.left < last.right &&
      last.left < row.right
    )
      run.push({ ...row, top: last.bottom });
    else {
      if (run.length) out.push(run);
      run = [{ ...row }];
    }
  }
  if (run.length) out.push(run);
  return out;
}

/**
 * The corners of one run, clockwise on the screen (y down): down the right
 * edges of its rows, back up the left ones; repeated and collinear points
 * dropped, so every corner is a turn.
 */
export function outline(run: Row[]): Point[] {
  const points: Point[] = [];
  for (const row of run) points.push([row.right, row.top], [row.right, row.bottom]);
  for (let i = run.length - 1; i >= 0; i--)
    points.push([run[i].left, run[i].bottom], [run[i].left, run[i].top]);
  let changed = true;
  while (changed && points.length > 2) {
    changed = false;
    for (let i = 0; i < points.length && points.length > 2; i++) {
      const prev = points[(i + points.length - 1) % points.length];
      const here = points[i];
      const next = points[(i + 1) % points.length];
      const same = prev[0] === here[0] && prev[1] === here[1];
      const straight =
        (prev[0] === here[0] && here[0] === next[0]) ||
        (prev[1] === here[1] && here[1] === next[1]);
      if (same || straight) {
        points.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return points;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/**
 * The SVG path of the selection: each run of rows a closed outline whose
 * corners are quarter circles of radius `radius`, or less where an edge is
 * shorter than two radii (each corner takes at most half of each edge). A
 * corner turning clockwise (convex, the outline goes clockwise) sweeps
 * clockwise; one turning back (concave) sweeps the other way, so the inner
 * corners are rounded too.
 */
export function selectionPath(rows: Row[], radius = SELECTION_RADIUS): string {
  const parts: string[] = [];
  for (const run of runs(rows)) {
    const points = outline(run);
    const n = points.length;
    if (n < 4) continue;
    const corners = points.map((here, i) => {
      const prev = points[(i + n - 1) % n];
      const next = points[(i + 1) % n];
      const lenPrev = Math.hypot(here[0] - prev[0], here[1] - prev[1]);
      const lenNext = Math.hypot(next[0] - here[0], next[1] - here[1]);
      const r = Math.max(0, Math.min(radius, lenPrev / 2, lenNext / 2));
      const into: Point = [
        here[0] + ((prev[0] - here[0]) / lenPrev) * r,
        here[1] + ((prev[1] - here[1]) / lenPrev) * r,
      ];
      const out: Point = [
        here[0] + ((next[0] - here[0]) / lenNext) * r,
        here[1] + ((next[1] - here[1]) / lenNext) * r,
      ];
      const cross =
        (here[0] - prev[0]) * (next[1] - here[1]) -
        (here[1] - prev[1]) * (next[0] - here[0]);
      return { into, out, r, sweep: cross > 0 ? 1 : 0 };
    });
    let d = `M${fmt(corners[0].out[0])} ${fmt(corners[0].out[1])}`;
    for (let k = 1; k <= n; k++) {
      const c = corners[k % n];
      d += `L${fmt(c.into[0])} ${fmt(c.into[1])}`;
      if (c.r > 0)
        d += `A${fmt(c.r)} ${fmt(c.r)} 0 0 ${c.sweep} ${fmt(c.out[0])} ${fmt(c.out[1])}`;
    }
    parts.push(d + "Z");
  }
  return parts.join("");
}
