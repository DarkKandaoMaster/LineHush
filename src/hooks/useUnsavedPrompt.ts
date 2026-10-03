import { useCallback, useRef, useState } from "react";
import type { UnsavedChoice } from "../core/session";

/**
 * "Save changes?" as an in-app modal <dialog>. `ask` is stable, so it can be handed
 * to createSession once; the dialog's close event answers the pending question.
 */
export function useUnsavedPrompt() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const pending = useRef<(choice: UnsavedChoice) => void>(undefined);
  const ask = useCallback((name: string) => {
    setName(name);
    const element = dialog.current!;
    element.returnValue = "";
    element.showModal();
    return new Promise<UnsavedChoice>((resolve) => {
      pending.current = resolve;
    });
  }, []);
  /** Buttons close the dialog with their value; Esc closes it with "". */
  const closed = useCallback((value: string) => {
    pending.current?.((value || "cancel") as UnsavedChoice);
    pending.current = undefined;
  }, []);
  return { dialog, name, ask, closed };
}
