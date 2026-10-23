import type { Ref } from "react";

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  name: string;
  source: string;
  onSave: () => void;
  /** The 关闭 button. */
  onClose: () => void;
  /** After the dialog closed, whichever way. */
  onClosed: () => void;
  /** 原图载入后对话框变大，再看一次要不要把窗口挪进屏幕。 */
  onLoad: () => void;
}

export default function ImagePreviewDialog(props: Props) {
  return (
    <dialog
      ref={props.dialogRef}
      className="image-preview"
      onClose={props.onClosed}
    >
      <header>
        <span>{props.name}</span>
        <div className="image-preview-actions">
          <button onClick={props.onSave}>保存原图</button>
          <button autoFocus aria-label="关闭原图" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </header>
      {props.source ? (
        <img src={props.source} alt={props.name} onLoad={props.onLoad} />
      ) : (
        <p>正在读取原图…</p>
      )}
    </dialog>
  );
}
