/**
 * The arithmetic of the editor's own caret (caret.ts), without the DOM so the
 * Node tests can load it.
 */

import type { CaretWidth } from "../core/settings.ts";

/** Windows' text caret settings (Rust `caret_metrics`). */
export interface CaretMetrics {
  /** Width in screen pixels ("Text cursor thickness"), not scaled with the display. */
  width: number;
  /** Half a blink cycle in milliseconds; 0 when the caret does not blink. */
  blinkMs: number;
  /** How long it blinks before it stands still (Notepad does); 0 for always. */
  timeoutMs: number;
}

/** Windows' defaults, until Rust has read the settings. */
export const DEFAULT_CARET_METRICS: CaretMetrics = {
  width: 1,
  blinkMs: 530,
  timeoutMs: 5000,
};

/** The “光标粗细” setting: this many times the Windows caret width. */
const CARET_FACTORS: Record<CaretWidth, number> = { thin: 1, medium: 2, thick: 3 };
// Named for tests/unit/settings.test.mjs.
export const MEDIUM_CARET_FACTOR = CARET_FACTORS.medium;
export const THICK_CARET_FACTOR = CARET_FACTORS.thick;

/**
 * The caret's width in screen pixels for the “光标粗细” setting: the Windows
 * setting (`metrics.width`) times `CARET_FACTORS` (at the default 1 screen
 * pixel: 1 / 2 / 3), with no upper limit. Blinking always follows Windows.
 */
export const caretWidth = (metrics: CaretMetrics, choice: CaretWidth) =>
  metrics.width * CARET_FACTORS[choice];

/**
 * Where the caret goes, in client coordinates: across at `x`, its left edge
 * (in text and between blocks alike); down from `top` to `bottom`.
 */
export interface CaretSpot {
  x: number;
  top: number;
  bottom: number;
}

/** The caret's box in CSS pixels relative to `origin` (its positioned container). */
interface CaretBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Rounds a client coordinate in CSS pixels to the nearest screen pixel. */
export const toDevicePixel = (value: number, dpr: number) =>
  Math.round(value * dpr) / dpr;

/**
 * The caret as drawn: `width` screen pixels wide whatever the display scale,
 * with every edge on a screen pixel. Otherwise a line narrower than a CSS pixel
 * (one screen pixel at 150% is 0.67 CSS px) is antialiased into two grey
 * columns. The edges are rounded in client coordinates, where screen pixels
 * are, and only then made relative to `origin`, which may sit between them.
 */
export function caretBox(
  spot: CaretSpot,
  origin: { left: number; top: number },
  width: number,
  dpr: number,
): CaretBox {
  const across = Math.max(1, Math.round(width)) / dpr;
  const left = toDevicePixel(spot.x, dpr);
  const top = toDevicePixel(spot.top, dpr);
  const bottom = Math.max(toDevicePixel(spot.bottom, dpr), top + 1 / dpr);
  return {
    left: left - origin.left,
    top: top - origin.top,
    width: across,
    height: bottom - top,
  };
}

/**
 * How many blink cycles (on, then off) to run: none when the caret does not
 * blink, endless without a timeout. A fractional count is fine for an
 * animation; when it ends the caret is left on, as in Notepad.
 */
export function blinkIterations({ blinkMs, timeoutMs }: CaretMetrics): number {
  if (!(blinkMs > 0)) return 0;
  return timeoutMs > 0 ? timeoutMs / (2 * blinkMs) : Infinity;
}
