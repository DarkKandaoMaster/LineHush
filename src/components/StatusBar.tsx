interface Props {
  line: number;
  column: number;
  /** The whole document's characters (line breaks included) and attachments (core/document.ts `stats`). */
  characters: number;
  attachments: number;
  /** The selection's share, null when nothing is selected (editor/selection-shape.ts `selectionCounts`). */
  selected: { characters: number; attachments: number } | null;
  /** The window's text zoom in percent (hooks/useZoom.ts). */
  zoom: number;
}

/**
 * 照 Win11 记事本的状态栏：左边位置、总数、选中三栏，右边缩放百分比，各项之间一条短竖线。
 * 总数“4 个字符，1 个附件”位置固定；选中栏“已选 3 个字符，0 个附件”只在选区非空时出现。
 * 文档里没有附件（图片 / 视频 / 音频 / 文件）时两栏都不写附件部分。
 */
export default function StatusBar(props: Props) {
  const { characters, attachments, selected } = props;
  const withAttachments = (count: number) =>
    attachments > 0 ? `，${count} 个附件` : "";
  return (
    <footer className="statusbar">
      <span className="status-item status-position">
        行 {props.line}，列 {props.column}
      </span>
      <span className="status-item status-count">
        {`${characters} 个字符${withAttachments(attachments)}`}
      </span>
      {selected && (
        <span className="status-item status-selected">
          {`已选 ${selected.characters} 个字符${withAttachments(selected.attachments)}`}
        </span>
      )}
      <span className="spacer" />
      <span className="status-item status-zoom">{props.zoom}%</span>
    </footer>
  );
}
