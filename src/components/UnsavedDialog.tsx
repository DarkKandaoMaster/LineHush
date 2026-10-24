import { useRef, type Ref } from "react";

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  name: string;
  /** Receives the dialog's return value: a button's value, or "cancel" after Esc / the title bar ×. */
  onClose: (value: string) => void;
}

/**
 * Buttons are in Notepad order. Opening focuses the `<dialog>` itself (`tabIndex={-1}`, see
 * useUnsavedPrompt), so no button shows a focus ring; Enter there means “保存”, the default
 * button. Tab goes to “保存” first; on a button Enter activates that button as usual.
 */
export default function UnsavedDialog(props: Props) {
  const saveButton = useRef<HTMLButtonElement>(null);
  return (
    <dialog
      ref={props.dialogRef}
      className="unsaved-dialog"
      tabIndex={-1}
      aria-labelledby="unsaved-title"
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.nativeEvent.isComposing ||
          event.target !== event.currentTarget
        )
          return;
        event.preventDefault();
        // Submitting with the button sets returnValue to "save" and closes the dialog.
        saveButton.current?.form?.requestSubmit(saveButton.current);
      }}
      onClose={(event) => props.onClose(event.currentTarget.returnValue)}
    >
      <form method="dialog">
        <p id="unsaved-title">是否保存对“{props.name}”的更改？</p>
        <div className="dialog-actions">
          <button ref={saveButton} value="save" className="primary">
            保存
          </button>
          <button value="discard">不保存</button>
          <button value="cancel">取消</button>
        </div>
      </form>
    </dialog>
  );
}
