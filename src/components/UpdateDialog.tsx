import type { Ref } from "react";
import type { UpdateInfo } from "../core/native";
import { updateBusy, type UpdatePhase } from "../hooks/useUpdate";

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  info: UpdateInfo | null;
  phase: UpdatePhase;
  /** “立即更新” / “重试”。 */
  onInstall: () => void;
  /** “以后再说” / “关闭”。 */
  onDismiss: () => void;
  /** 对话框关掉之后（按钮、Esc、标题栏 ×）。 */
  onClosed: () => void;
}

/** 状态行：下载进度、暂存、安装，或失败原因；等用户选择时没有。 */
function status(phase: UpdatePhase): string {
  switch (phase.kind) {
    case "downloading":
      return phase.percent === null
        ? `正在下载… ${(phase.downloaded / 1048576).toFixed(1)} MB`
        : `正在下载… ${phase.percent}%`;
    case "stashing":
      return "正在暂存未保存的修改…";
    case "installing":
      return "正在安装…（安装完成后 LineHush 会自动重新打开）";
    case "failed":
      return phase.reason;
    default:
      return "";
  }
}

/**
 * 发现新版本（照保存询问的样子）。打开时焦点在 `<dialog>` 本身（`tabIndex={-1}`，见
 * useUpdate 的 `present`），没有按钮高亮；此时 Enter 等于主按钮（“立即更新”，失败后为“重试”），
 * 按 Tab 先到主按钮。下载 / 暂存 / 安装期间两个按钮变灰，Esc 与标题栏 × 不响应（useDialogs）。
 */
export default function UpdateDialog(props: Props) {
  const { info, phase } = props;
  const busy = updateBusy(phase);
  const failed = phase.kind === "failed";
  const text = status(phase);
  return (
    <dialog
      ref={props.dialogRef}
      className="update-dialog"
      tabIndex={-1}
      aria-labelledby="update-title"
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.nativeEvent.isComposing ||
          event.target !== event.currentTarget
        )
          return;
        event.preventDefault();
        if (!busy) props.onInstall();
      }}
      onClose={props.onClosed}
    >
      <p id="update-title">
        发现新版本 {info?.version}（当前 {info?.current}）
      </p>
      {info?.notes && <div className="update-notes">{info.notes}</div>}
      {text && (
        <p
          className={`update-status${failed ? " failed" : ""}`}
          role={failed ? "alert" : "status"}
        >
          {text}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={props.onInstall}
        >
          {failed ? "重试" : "立即更新"}
        </button>
        <button type="button" disabled={busy} onClick={props.onDismiss}>
          {failed ? "关闭" : "以后再说"}
        </button>
      </div>
    </dialog>
  );
}
