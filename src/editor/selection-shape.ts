/**
 * The outline of a text selection drawn like VS Code's `editor.roundedSelection`
 * (its `selectionsOverlay.ts`, radius 3px): one rectangle per line, joined
 * into one shape, with every corner rounded, the outer ones and the inner ones
 * where two lines of different width meet. No DOM here, so the Node tests can
 * load it.
 */

/** VS Code's corner radius in CSS pixels. */
export const SELECTION_RADIUS = 3;

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
