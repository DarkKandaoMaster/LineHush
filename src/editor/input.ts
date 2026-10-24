import { Extension } from "@tiptap/core";
import { Plugin, type Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { drawnCaret } from "./caret-geometry.ts";
import { dragMove, dragPress, dragRelease } from "./image-view.ts";

/**
 * Where each selection change comes from: one set of listeners per editor
 * (`InputSource`) records it, and the others read it here.
 *
 * - The source (`sourceOf`): a press in the editor is "mouse", any key,
 *   typing, a paste or a drop "keyboard". After a click the caret is only kept
 *   visible, after the others with the safe zone around it (reveal.ts).
 * - The side of a soft wrap the caret is drawn on (`headSide`, below).
 * - Drag selections over and beside images (image-view's `dragPress` /
 *   `dragMove` / `dragRelease`), followed on the window.
 *
 * Before a key is handled, a DOM selection change the browser has not reported
 * yet is read first (`readDOMSelection`).
 */
type Source = "mouse" | "keyboard";

/**
 * Which of its two places the caret takes at a soft line wrap. A position
 * where a line wraps is both the end of the upper visual line and the start of
 * the lower one; ProseMirror's state cannot tell them apart and the DOM
 * Selection does not say where the browser draws it. The editor's own caret
 * (caret.ts) and the box kept in view (reveal.ts) follow the browser's rule,
 * measured in Edge (docs/caret-selection-2026-10-23.md, "Chromium 折行处光标规则"):
 *
 * - End (and Shift+End): the end of the upper line (-1).
 * - A click or a drag: the line under the pointer.
 * - ↑ / ↓: the line the move went to, the next one up or down from where the
 *   caret was: landing at a line's end (the remembered x past it) is the end of
 *   the upper line, landing at a line's start the start of the lower one.
 * - PageUp / PageDown: the line at the point the caret was put (reveal's pageMove).
 * - Anything else (←, →, Home, typing, deleting, pastes, a range collapsed):
 *   the start of the lower line (1), as the browser draws it.
 *
 * Elsewhere the side makes no difference and is 1.
 */
type Affinity = -1 | 1;

type Cause =
  | { kind: "default" }
  | { kind: "end" }
  | { kind: "point"; y: number; by: "pointer" | "page" }
  | { kind: "vertical"; dir: -1 | 1; from: number };

interface Input {
  source: Source;
  cause: Cause;
  /** The primary button is held since a press in the editor. */
  pressed: boolean;
  /** The side worked out for a selection, kept while that selection lasts. */
  resolved?: { selection: Selection; cause: Cause; side: Affinity };
}

const inputs = new WeakMap<EditorView, Input>();
const inputOf = (view: EditorView) => {
  let input = inputs.get(view);
  if (!input) {
    input = { source: "keyboard", cause: { kind: "default" }, pressed: false };
    inputs.set(view, input);
  }
  return input;
};

/** Where the last selection change came from. */
export const sourceOf = (view: EditorView) => inputOf(view).source;

/**
 * The caret is being put at the point `y` (client coordinates): the line
 * there, by the pointer (a click or a drag) or by PageUp / PageDown.
 */
export function pointAt(view: EditorView, y: number, by: "pointer" | "page") {
  inputOf(view).cause = { kind: "point", y, by };
}

/**
 * 由编辑器自己按指针定的选区（左栏选行，margin.ts；按下不进 ProseMirror）：来源记为鼠标
 * （reveal.ts 只保证可见），折行处光标画在 y 所在的那一行。
 */
export function pointerInput(view: EditorView, y: number) {
  inputOf(view).source = "mouse";
  pointAt(view, y, "pointer");
}

/**
 * The two places of a text position at a soft wrap, or null elsewhere (both
 * sides on the same visual line).
 */
function wrapAt(view: EditorView, pos: number) {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.inlineContent || !$pos.parentOffset || $pos.parentOffset >= $pos.parent.content.size)
    return null;
  const up = view.coordsAtPos(pos, -1);
  const down = view.coordsAtPos(pos, 1);
  return Math.abs(up.top - down.top) > 1 ? { up, down } : null;
}

/** The side for the text position `pos` (the head of the current selection). */
function decide(view: EditorView, pos: number, cause: Cause): Affinity {
  const wrap = wrapAt(view, pos);
  if (!wrap) return 1;
  switch (cause.kind) {
    case "end":
      return -1;
    case "point": {
      const away = (c: { top: number; bottom: number }) =>
        cause.y < c.top ? c.top - cause.y : cause.y > c.bottom ? cause.y - c.bottom : 0;
      return away(wrap.up) <= away(wrap.down) ? -1 : 1;
    }
    case "vertical":
      // The next line from where the caret was, in the direction it went.
      if (cause.dir > 0) return wrap.up.top > cause.from + 1 ? -1 : 1;
      return wrap.down.top < cause.from - 1 ? 1 : -1;
    default:
      return 1;
  }
}

/**
 * The side at which to draw the selection's head when it is in a text line:
 * worked out once per selection, from the input that made it. A click that
 * leaves the selection where it was (ProseMirror then makes no new one) still
 * puts the caret on the line clicked; other inputs that change nothing (a
 * shortcut, a key at the document's end) leave it alone.
 */
export function headSide(view: EditorView): Affinity {
  const input = inputOf(view);
  const { selection } = view.state;
  const { cause, resolved: known } = input;
  if (known && known.selection === selection) {
    if (known.cause === cause || cause.kind !== "point") {
      known.cause = cause;
      return known.side;
    }
  }
  const side = selection.$head.parent.inlineContent ? decide(view, selection.head, cause) : 1;
  input.resolved = { selection, cause, side };
  return side;
}

/**
 * Reads a DOM selection change ProseMirror has not seen yet. The browser
 * reports its own caret moves with `selectionchange`, an event dispatched as a
 * separate task; keys repeated quickly enough (auto-repeat, input queued while
 * the page was busy) arrive before it, and ProseMirror's keydown only flushes
 * an observer flush that is already scheduled (`DOMObserver.forceFlush`), not
 * one whose event is still to come. Key handlers would then decide from the
 * caret's previous position: at the end of a text line that an image follows
 * they would leave the key to the browser, which takes the caret out of the
 * line into the gap before the image (no caret rectangle there; its own
 * scrolling then jumps to the top) or past the images. This does what the
 * pending `selectionchange` would (`DOMObserver.onSelectionChange` → `flush`).
 */
function readDOMSelection(view: EditorView) {
  const internal = view as unknown as {
    domObserver?: { forceFlush(): void; flush(): void };
    input?: { mouseDown: unknown };
  };
  const observer = internal.domObserver;
  if (!observer || view.composing || internal.input?.mouseDown) return;
  observer.forceFlush();
  observer.flush();
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Process"]);

function inputPlugin() {
  return new Plugin({
    view(view) {
      const win = view.dom.ownerDocument.defaultView!;
      const input = inputOf(view);
      // In the capture phase on the editor, ahead of ProseMirror's handlers and
      // the keymaps (handleKeyDown).
      const key = (event: KeyboardEvent) => {
        input.source = "keyboard";
        // The pending change belongs to the key before, with its cause.
        if (!event.isComposing && event.keyCode !== 229) readDOMSelection(view);
        if (MODIFIERS.has(event.key) || event.isComposing) return;
        if (event.key === "End") input.cause = { kind: "end" };
        else if (event.key === "ArrowUp" || event.key === "ArrowDown")
          input.cause = {
            kind: "vertical",
            dir: event.key === "ArrowUp" ? -1 : 1,
            // The caret's top before the move.
            from:
              drawnCaret(view, headSide(view))?.top ??
              view.coordsAtPos(view.state.selection.head).top,
          };
        // PageUp / PageDown: reveal's pageMove says where (pointAt).
        else if (event.key !== "PageUp" && event.key !== "PageDown")
          input.cause = { kind: "default" };
      };
      const typed = () => {
        input.source = "keyboard";
        input.cause = { kind: "default" };
      };
      const down = (event: MouseEvent) => {
        input.source = "mouse";
        if (event.button !== 0) return;
        input.pressed = true;
        pointAt(view, event.clientY, "pointer");
        dragPress(view, event);
      };
      // Bubbling to the window: after ProseMirror's own listener, also outside the editor.
      const move = (event: MouseEvent) => {
        // A drag selection follows the pointer.
        if (input.pressed) {
          if (event.buttons & 1) pointAt(view, event.clientY, "pointer");
          else input.pressed = false;
        }
        dragMove(view, event);
      };
      const up = () => {
        input.pressed = false;
        dragRelease(view);
      };
      const others = ["beforeinput", "compositionstart", "paste", "drop"];
      view.dom.addEventListener("keydown", key, true);
      view.dom.addEventListener("mousedown", down, true);
      for (const type of others) view.dom.addEventListener(type, typed, true);
      win.addEventListener("mousemove", move);
      win.addEventListener("mouseup", up, true);
      return {
        destroy() {
          view.dom.removeEventListener("keydown", key, true);
          view.dom.removeEventListener("mousedown", down, true);
          for (const type of others) view.dom.removeEventListener(type, typed, true);
          win.removeEventListener("mousemove", move);
          win.removeEventListener("mouseup", up, true);
          dragRelease(view, true);
          inputs.delete(view);
        },
      };
    },
  });
}

/** The listeners behind `sourceOf`, `headSide` and drag selections (see the top of this file). */
export const InputSource = Extension.create({
  name: "inputSource",
  addProseMirrorPlugins: () => [inputPlugin()],
});
