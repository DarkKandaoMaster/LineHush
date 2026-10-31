import { useRef, type Ref } from "react";
import { formatSize, type PictureKind } from "../core/document";

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  name: string;
  source: string;
  /**
   * An image, a video (played with the media element's controls) or a file
   * (its name and size, to open or save; no source).
   */
  kind: PictureKind;
  /** A file's bytes. */
  size?: number;
  /** A file's 打开 button. */
  onOpen: () => void;
  onSave: () => void;
  /** The 关闭 button. */
  onClose: () => void;
  /** After the dialog closed, whichever way. */
  onClosed: () => void;
  /** 原图（视频的画面尺寸）载入后对话框变大，再看一次要不要把窗口挪进屏幕。 */
  onLoad: () => void;
}

const FILE_ICON = (
  <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
    <path
      d="M12 4.5h16.5L38 14v29.5H12z"
      fill="#fff"
      stroke="#0067c0"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    <path
      d="M28 4.5V14.5h10"
      fill="none"
      stroke="#0067c0"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Opening focuses the `<dialog>` itself (`tabIndex={-1}`, see useImagePreview), so no button shows a
 * focus ring; Enter there means “关闭”. Tab goes to “保存原图” (a video's or a file's “保存原文件”;
 * a file's “打开” before it) first (DOM order), then “关闭”; on a button Enter activates that button
 * as usual. A video starts playing on its own and stops, its source dropped, when the dialog closes.
 */
export default function ImagePreviewDialog(props: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const file = props.kind === "file";
  const what = { image: "原图", video: "视频", audio: "音频", file: "文件" }[props.kind];
  return (
    <dialog
      ref={props.dialogRef}
      className={file ? "image-preview file-preview" : "image-preview"}
      tabIndex={-1}
      aria-label={file ? props.name : undefined}
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
      {file ? (
        <>
          <div className="file-preview-body">
            {FILE_ICON}
            <span className="file-preview-name" title={props.name}>
              {props.name}
            </span>
            <span className="file-preview-size">{formatSize(props.size)}</span>
          </div>
          <div className="dialog-actions">
            <button onClick={props.onOpen}>打开</button>
            <button onClick={props.onSave}>保存原文件</button>
            <button aria-label="关闭文件" onClick={props.onClose}>
              关闭
            </button>
          </div>
        </>
      ) : (
        <>
          <header>
            <span>{props.name}</span>
            <div className="image-preview-actions">
              <button onClick={props.onSave}>
                {props.kind === "image" ? "保存原图" : "保存原文件"}
              </button>
              <button aria-label={`关闭${what}`} onClick={props.onClose}>
                关闭
              </button>
            </div>
          </header>
          {props.source && props.kind === "video" ? (
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
        </>
      )}
    </dialog>
  );
}
