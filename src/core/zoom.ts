/**
 * 正文缩放（照 Win11 记事本）：10%–500%，每步 10%，按百分比整数计（免得浮点累加出 0.30000000000000004）。
 * 每个窗口一个值、不持久化（hooks/useZoom.ts），只缩放正文文字（App.css 的 --editor-zoom）。
 */
export const ZOOM_MIN = 10;
export const ZOOM_MAX = 500;
export const ZOOM_STEP = 10;
export const ZOOM_DEFAULT = 100;

/** 夹到 10–500 并取整；非有限数回到 100。 */
export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent)));
}

/** 放大 / 缩小 `steps` 步（负数为缩小），结果夹在范围内。 */
export function zoomBy(percent: number, steps: number): number {
  return clampZoom(clampZoom(percent) + steps * ZOOM_STEP);
}

export type ZoomAction = "in" | "out" | "reset";

/**
 * Ctrl+<键> 对应的缩放动作（调用方已确认按着 Ctrl、没按 Alt）：Ctrl+= / Ctrl++（含小键盘 +）放大，
 * Ctrl+-（含小键盘 -）缩小，Ctrl+0（含小键盘 0）恢复 100%。按位置（`code`）认键，输入法报
 * `Process` 时也有效；`key` 兜底非美式布局。
 */
export function zoomKeyAction(event: {
  key: string;
  code: string;
  shiftKey: boolean;
}): ZoomAction | undefined {
  const { key, code, shiftKey } = event;
  if (code === "Equal" || code === "NumpadAdd" || key === "=" || key === "+") return "in";
  if (shiftKey) return undefined;
  if (code === "Minus" || code === "NumpadSubtract" || key === "-") return "out";
  if (code === "Digit0" || code === "Numpad0" || key === "0") return "reset";
  return undefined;
}

/** 一格滚轮的 deltaY（像素模式下 Chromium 约为 100）。 */
const WHEEL_NOTCH = 100;

/**
 * Ctrl+滚轮：本次事件缩放几步（向上滚为正）与留到下次的累计量。鼠标滚轮一格（按行 / 页的
 * deltaMode，或像素量不小于半格）算一步；触控板的小量累加到一格才算一步。
 */
export function wheelZoomSteps(
  pending: number,
  deltaY: number,
  deltaMode: number,
): { steps: number; pending: number } {
  if (deltaY === 0) return { steps: 0, pending };
  if (deltaMode !== 0 || Math.abs(deltaY) >= WHEEL_NOTCH / 2)
    return { steps: deltaY < 0 ? 1 : -1, pending: 0 };
  // 方向变了就从头累计。
  const sum = Math.sign(pending) === Math.sign(deltaY) ? pending + deltaY : deltaY;
  const notches = Math.trunc(sum / WHEEL_NOTCH);
  return { steps: 0 - notches, pending: sum - notches * WHEEL_NOTCH };
}
