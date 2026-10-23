import type { Ref } from "react";

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  name: string;
  /** Receives the dialog's return value: a button's value, or "cancel" after Esc / the title bar ×. */
  onClose: (value: string) => void;
}

/** Buttons are in Notepad order; "保存" comes first, so opening the dialog focuses it. */
export default function UnsavedDialog(props: Props) {
  return (
    <dialog
      ref={props.dialogRef}
      className="unsaved-dialog"
      aria-labelledby="unsaved-title"
      onClose={(event) => props.onClose(event.currentTarget.returnValue)}
    >
      <form method="dialog">
        <p id="unsaved-title">是否保存对“{props.name}”的更改？</p>
        <div className="dialog-actions">
          <button value="save" className="primary">
            保存
          </button>
          <button value="discard">不保存</button>
          <button value="cancel">取消</button>
        </div>
      </form>
    </dialog>
  );
}
