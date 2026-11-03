import { useCallback, useRef, useState } from "react";
import { revealWindow } from "../core/native";
import type { UnsavedChoice } from "../core/session";

/**
 * "Save changes?" as an in-app <dialog> (non-modal, see useDialogs). `ask` is stable, so it can be handed
 * to createSession once; the dialog's close event answers the pending question.
 */
export function useUnsavedPrompt() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const pending = useRef<(choice: UnsavedChoice) => void>(undefined);
  const ask = useCallback((name: string) => {
    setName(name);
    // 任务栏中键 / 右键“关闭窗口”时窗口可能在后台或最小化：先把它显示并带到前台，否则看不到询问。
    // 放在 show() 之前：最小化时 requestAnimationFrame 不走，useDialogs 的 revealRect 要等窗口还原后再报位置。
    revealWindow().catch(console.error);
    const element = dialog.current!;
    element.returnValue = "";
    element.show();
    // show() focuses "保存"; the dialog itself takes focus instead (see UnsavedDialog).
    element.focus({ preventScroll: true });
    return new Promise<UnsavedChoice>((resolve) => {
      pending.current = resolve;
    });
  }, []);
  /** Buttons close the dialog with their value; Esc and the title bar × with "cancel". */
  const closed = useCallback((value: string) => {
    pending.current?.((value || "cancel") as UnsavedChoice);
    pending.current = undefined;
  }, []);
  return { dialog, name, ask, closed };
}
