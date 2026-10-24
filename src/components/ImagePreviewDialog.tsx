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

/**
 * Opening focuses the `<dialog>` itself (`tabIndex={-1}`, see useImagePreview), so no button shows a
 * focus ring; Enter there means “关闭”. Tab goes to “保存原图” first (DOM order), then “关闭”; on a
 * button Enter activates that button as usual.
 */
export default function ImagePreviewDialog(props: Props) {
  return (
    <dialog
      ref={props.dialogRef}
      className="image-preview"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.nativeEvent.isComposing ||
          event.target !== event.currentTarget
        )
          return;
        event.preventDefault();
        props.onClose();
      }}
      onClose={props.onClosed}
    >
      <header>
        <span>{props.name}</span>
        <div className="image-preview-actions">
          <button onClick={props.onSave}>保存原图</button>
          <button aria-label="关闭原图" onClick={props.onClose}>
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
