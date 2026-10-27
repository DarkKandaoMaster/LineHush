interface Props {
  line: number;
  column: number;
  characters: number;
  images: number;
  /** The window's text zoom in percent (hooks/useZoom.ts). */
  zoom: number;
}

/** 照 Win11 记事本的状态栏：左边位置与字数，右边缩放百分比，各项之间一条短竖线。 */
export default function StatusBar(props: Props) {
  return (
    <footer className="statusbar">
      <span className="status-item status-position">
        第 {props.line} 行，第 {props.column} 列
      </span>
      <span className="status-item">
        {props.characters} 字符
        {props.images > 0 && <span> · {props.images} 张图片</span>}
      </span>
      <span className="spacer" />
      <span className="status-item status-zoom">{props.zoom}%</span>
    </footer>
  );
}
