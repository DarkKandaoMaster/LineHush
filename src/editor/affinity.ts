import { Plugin, PluginKey, type Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

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
export type Affinity = -1 | 1;

type Cause =
  | { kind: "default" }
  | { kind: "end" }
  | { kind: "point"; y: number }
  | { kind: "vertical"; dir: -1 | 1; from: number };

const causes = new WeakMap<EditorView, Cause>();
/** The side worked out for a selection, kept while that selection lasts. */
const resolved = new WeakMap<
  EditorView,
  { selection: Selection; cause: Cause | undefined; side: Affinity }
>();

/** The caret is being put at the point `y` (client coordinates): the line there. */
export function pointAt(view: EditorView, y: number) {
  causes.set(view, { kind: "point", y });
}

/**
 * The two places of a text position at a soft wrap, or null elsewhere (both
 * sides on the same visual line).
 */
export function wrapAt(view: EditorView, pos: number) {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.inlineContent || !$pos.parentOffset || $pos.parentOffset >= $pos.parent.content.size)
    return null;
  const up = view.coordsAtPos(pos, -1);
  const down = view.coordsAtPos(pos, 1);
  return Math.abs(up.top - down.top) > 1 ? { up, down } : null;
}

/** The side for the text position `pos` (the head of the current selection). */
function decide(view: EditorView, pos: number): Affinity {
  const wrap = wrapAt(view, pos);
  const cause = causes.get(view) ?? { kind: "default" };
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
  const { selection } = view.state;
  const cause = causes.get(view);
  const known = resolved.get(view);
  if (known && known.selection === selection) {
    if (known.cause === cause || cause?.kind !== "point") {
      known.cause = cause;
      return known.side;
    }
  }
  const side = selection.$head.parent.inlineContent ? decide(view, selection.head) : 1;
  resolved.set(view, { selection, cause, side });
  return side;
}

/** The current caret's top, before a vertical move. */
function caretTop(view: EditorView) {
  const { head, $head } = view.state.selection;
  if ($head.parent.inlineContent) return view.coordsAtPos(head, headSide(view)).top;
  const dom = view.nodeDOM(head) as HTMLElement | null;
  return dom?.getBoundingClientRect().top ?? view.coordsAtPos(head).top;
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Process"]);

/** Records the input behind each selection change (see the top of this file). */
export function affinityPlugin() {
  return new Plugin({
    key: new PluginKey("affinity"),
    view(view) {
      const win = view.dom.ownerDocument.defaultView!;
      let pressed = false;
      const key = (event: KeyboardEvent) => {
        if (MODIFIERS.has(event.key) || event.isComposing) return;
        if (event.key === "End") causes.set(view, { kind: "end" });
        else if (event.key === "ArrowUp" || event.key === "ArrowDown")
          causes.set(view, {
            kind: "vertical",
            dir: event.key === "ArrowUp" ? -1 : 1,
            from: caretTop(view),
          });
        // PageUp / PageDown: reveal's pageMove says where (pointAt).
        else if (event.key !== "PageUp" && event.key !== "PageDown")
          causes.set(view, { kind: "default" });
      };
      const others = () => causes.set(view, { kind: "default" });
      const down = (event: MouseEvent) => {
        if (event.button !== 0) return;
        pressed = true;
        pointAt(view, event.clientY);
      };
      // A drag selection follows the pointer, also outside the editor.
      const move = (event: MouseEvent) => {
        if (!pressed) return;
        if (event.buttons & 1) pointAt(view, event.clientY);
        else pressed = false;
      };
      const up = () => {
        pressed = false;
      };
      const inputs = ["beforeinput", "compositionstart", "paste", "drop"];
      view.dom.addEventListener("keydown", key, true);
      view.dom.addEventListener("mousedown", down, true);
      for (const type of inputs) view.dom.addEventListener(type, others, true);
      win.addEventListener("mousemove", move, true);
      win.addEventListener("mouseup", up, true);
      return {
        destroy() {
          view.dom.removeEventListener("keydown", key, true);
          view.dom.removeEventListener("mousedown", down, true);
          for (const type of inputs) view.dom.removeEventListener(type, others, true);
          win.removeEventListener("mousemove", move, true);
          win.removeEventListener("mouseup", up, true);
          causes.delete(view);
          resolved.delete(view);
        },
      };
    },
  });
}
