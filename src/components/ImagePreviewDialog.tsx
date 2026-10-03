import type { Ref } from "react";

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  name: string;
  source: string;
  /** Saving the original needs the desktop backend. */
  canSave: boolean;
  onSave: () => void;
  onClose: () => void;
}

export default function ImagePreviewDialog(props: Props) {
  return (
    <dialog
      ref={props.dialogRef}
      className="image-preview"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <header>
        <span>{props.name}</span>
        <div className="image-preview-actions">
          {props.canSave && <button onClick={props.onSave}>保存原图</button>}
          <button autoFocus aria-label="关闭原图" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </header>
      {props.source ? (
        <img src={props.source} alt={props.name} />
      ) : (
        <p>正在读取原图…</p>
      )}
    </dialog>
  );
}
