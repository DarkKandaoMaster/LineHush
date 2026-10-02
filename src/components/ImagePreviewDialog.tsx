import type { Ref } from "react";

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  name: string;
  source: string;
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
        <button autoFocus aria-label="关闭原图" onClick={props.onClose}>
          关闭
        </button>
      </header>
      {props.source ? (
        <img src={props.source} alt={props.name} />
      ) : (
        <p>正在读取原图…</p>
      )}
    </dialog>
  );
}
