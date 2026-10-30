import { useRef, type Ref } from "react";

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  name: string;
  source: string;
  /** A video, played with the media element's controls, rather than an image. */
  video: boolean;
  onSave: () => void;
  /** The 关闭 button. */
  onClose: () => void;
  /** After the dialog closed, whichever way. */
  onClosed: () => void;
  /** 原图（视频的画面尺寸）载入后对话框变大，再看一次要不要把窗口挪进屏幕。 */
  onLoad: () => void;
}

/**
 * Opening focuses the `<dialog>` itself (`tabIndex={-1}`, see useImagePreview), so no button shows a
 * focus ring; Enter there means “关闭”. Tab goes to “保存原图” (a video's “保存原文件”) first (DOM
 * order), then “关闭”; on a button Enter activates that button as usual. A video starts playing on
 * its own and stops, its source dropped, when the dialog closes.
 */
export default function ImagePreviewDialog(props: Props) {
  const video = useRef<HTMLVideoElement>(null);
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
      onClose={() => {
        const player = video.current;
        if (player) {
          player.pause();
          player.removeAttribute("src");
          player.load();
        }
        props.onClosed();
      }}
    >
      <header>
        <span>{props.name}</span>
        <div className="image-preview-actions">
          <button onClick={props.onSave}>
            {props.video ? "保存原文件" : "保存原图"}
          </button>
          <button
            aria-label={props.video ? "关闭视频" : "关闭原图"}
            onClick={props.onClose}
          >
            关闭
          </button>
        </div>
      </header>
      {props.source && props.video ? (
        <video
          ref={video}
          src={props.source}
          controls
          autoPlay
          aria-label={props.name}
          onLoadedMetadata={props.onLoad}
        />
      ) : props.source ? (
        <img src={props.source} alt={props.name} onLoad={props.onLoad} />
      ) : (
        <p>正在读取原图…</p>
      )}
    </dialog>
  );
}
