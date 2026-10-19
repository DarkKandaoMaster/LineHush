interface Props {
  line: number;
  column: number;
  characters: number;
  images: number;
}

export default function StatusBar(props: Props) {
  return (
    <footer className="statusbar">
      <span>
        第 {props.line} 行，第 {props.column} 列
      </span>
      <span>
        {props.characters} 字符
        {props.images > 0 && <span> · {props.images} 张图片</span>}
      </span>
    </footer>
  );
}
