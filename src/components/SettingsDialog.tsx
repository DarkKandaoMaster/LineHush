import { useEffect, useState, type KeyboardEvent, type Ref } from "react";
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type CaretWidth,
  type DefaultFileName,
  type MarginSelection,
  type OpenFile,
  type SelectionCorners,
  type Settings,
  type Startup,
} from "../core/settings";

/**
 * Suggestions only; any installed font name can be typed. Chinese fonts go by
 * their Chinese names, which WebView2 resolves itself.
 */
const FONTS = [
  "微软雅黑",
  "Microsoft YaHei UI",
  "等线",
  "宋体",
  "新宋体",
  "黑体",
  "楷体",
  "仿宋",
  "Segoe UI",
  "Consolas",
  "Cascadia Mono",
  "Cascadia Code",
  "Yu Gothic UI",
  "Arial",
  "Times New Roman",
  "Courier New",
  "Sarasa Mono SC",
  "LXGW WenKai",
  "Noto Sans CJK SC",
];
/** One setting as radio buttons, one per line; `name` is also the label's id. */
function Choices<T extends string>(props: {
  name: string;
  label: string;
  choices: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <>
      <span id={props.name}>{props.label}</span>
      <div
        className="settings-choices"
        role="radiogroup"
        aria-labelledby={props.name}
      >
        {props.choices.map((choice) => (
          <label key={choice.value}>
            <input
              type="radio"
              name={props.name}
              value={choice.value}
              checked={props.value === choice.value}
              onChange={() => props.onChange(choice.value)}
            />
            {choice.label}
          </label>
        ))}
      </div>
    </>
  );
}

/** In pt; 10 is the default (same as Notepad). */
const SIZES = [9, 10, 10.5, 11, 12, 14];
/** “细”跟随 Windows 文本光标粗细（默认 1 屏幕像素），“中”为其 2 倍、“粗”为其 3 倍。 */
const CARET_WIDTH: { value: CaretWidth; label: string }[] = [
  { value: "thin", label: "细" },
  { value: "medium", label: "中" },
  { value: "thick", label: "粗" },
];
/** 选区形状相同，“圆角”半径 3 CSS px（VS Code），“方角”半径 0。 */
const SELECTION_CORNERS: { value: SelectionCorners; label: string }[] = [
  { value: "square", label: "方角" },
  { value: "rounded", label: "圆角" },
];
/** 左栏（编辑区左侧内边距）单击 / 拖动选中的“行”：整个逻辑行，或指针所在的那一折。 */
const MARGIN_SELECTION: { value: MarginSelection; label: string }[] = [
  { value: "line", label: "整行" },
  { value: "visualLine", label: "视觉行" },
];
/** 无标题笔记保存时预填的文件名：日期（YYYY-MM-DD），或正文第一行有字的文字。 */
const DEFAULT_FILE_NAME: { value: DefaultFileName; label: string }[] = [
  { value: "date", label: "日期" },
  { value: "firstLine", label: "首行文字" },
];
/** 文案照 Win11 记事本。 */
const OPEN_FILE: { value: OpenFile; label: string }[] = [
  { value: "tab", label: "在新标签页中打开" },
  { value: "window", label: "在新窗口中打开" },
];
const STARTUP: { value: Startup; label: string }[] = [
  { value: "lastSession", label: "打开上一会话中的内容" },
  { value: "newWindow", label: "打开新窗口" },
];

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  settings: Settings;
  onChange: (partial: Partial<Settings>) => void;
  onReset: () => void;
  /** After the dialog closed (button or Esc). */
  onClose: () => void;
}

/**
 * 打开设置：`show()` 照规范先把焦点给第一个控件（“字体”），随即挪到 `<dialog>` 本身
 * （`tabIndex={-1}`，不进 Tab 顺序），没有控件高亮，按 Tab 才进“字体”。
 */
export function openSettings(dialog: HTMLDialogElement | null) {
  if (!dialog) return;
  dialog.show();
  dialog.focus({ preventScroll: true });
}

/**
 * Changes apply while typing; there is nothing to confirm. The inputs keep
 * what is being typed (e.g. "1" on the way to "18") and only valid values
 * (6–30 pt, at most one decimal, e.g. 10.5) are applied; leaving a field shows the value in use again.
 */
export default function SettingsDialog(props: Props) {
  const { settings, onChange } = props;
  const [family, setFamily] = useState(settings.fontFamily);
  const [size, setSize] = useState(String(settings.fontSizePt));
  // Values changed elsewhere (loading, presets, 恢复默认) replace what is shown.
  useEffect(() => {
    setFamily((typed) =>
      typed.trim() === settings.fontFamily ? typed : settings.fontFamily,
    );
  }, [settings.fontFamily]);
  useEffect(() => {
    setSize((typed) =>
      Number(typed) === settings.fontSizePt
        ? typed
        : String(settings.fontSizePt),
    );
  }, [settings.fontSizePt]);
  const typeSize = (value: string) => {
    setSize(value);
    const number = Number(value);
    if (
      value.trim() &&
      Math.round(number * 10) / 10 === number &&
      number >= MIN_FONT_SIZE &&
      number <= MAX_FONT_SIZE
    )
      onChange({ fontSizePt: number });
  };
  const showFamily = () => setFamily(settings.fontFamily);
  const showSize = () => setSize(String(settings.fontSizePt));
  // Enter would submit the form and close the dialog.
  const enter = (show: () => void) => (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    show();
  };
  return (
    <dialog
      ref={props.dialogRef}
      className="settings-dialog"
      tabIndex={-1}
      aria-labelledby="settings-title"
      onClose={props.onClose}
    >
      <form method="dialog">
        <h2 id="settings-title">设置</h2>
        <div className="settings-grid">
          <label htmlFor="settings-font">字体</label>
          <input
            id="settings-font"
            list="settings-fonts"
            value={family}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              const value = event.currentTarget.value;
              setFamily(value);
              if (value.trim()) onChange({ fontFamily: value });
            }}
            onBlur={showFamily}
            onKeyDown={enter(showFamily)}
          />
          <datalist id="settings-fonts">
            {FONTS.map((font) => (
              <option key={font} value={font} />
            ))}
          </datalist>
          <label htmlFor="settings-size">字号（pt）</label>
          <div className="settings-size">
            <input
              id="settings-size"
              type="number"
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              step={0.1}
              value={size}
              onChange={(event) => typeSize(event.currentTarget.value)}
              onBlur={showSize}
              onKeyDown={enter(showSize)}
            />
            {SIZES.map((preset) => (
              <button
                key={preset}
                type="button"
                className={preset === settings.fontSizePt ? "selected" : ""}
                aria-pressed={preset === settings.fontSizePt}
                onClick={() => onChange({ fontSizePt: preset })}
              >
                {preset}
              </button>
            ))}
          </div>
          <Choices
            name="settings-caret-width"
            label="光标粗细"
            choices={CARET_WIDTH}
            value={settings.caretWidth}
            onChange={(caretWidth) => onChange({ caretWidth })}
          />
          <Choices
            name="settings-selection-corners"
            label="选区边角"
            choices={SELECTION_CORNERS}
            value={settings.selectionCorners}
            onChange={(selectionCorners) => onChange({ selectionCorners })}
          />
          <Choices
            name="settings-margin-selection"
            label="左栏选行"
            choices={MARGIN_SELECTION}
            value={settings.marginSelection}
            onChange={(marginSelection) => onChange({ marginSelection })}
          />
          <Choices
            name="settings-default-file-name"
            label="默认文件名"
            choices={DEFAULT_FILE_NAME}
            value={settings.defaultFileName}
            onChange={(defaultFileName) => onChange({ defaultFileName })}
          />
          <span id="settings-updates">更新</span>
          <div className="settings-choices" role="group" aria-labelledby="settings-updates">
            <label>
              <input
                type="checkbox"
                checked={settings.checkUpdates}
                onChange={(event) =>
                  onChange({ checkUpdates: event.currentTarget.checked })
                }
              />
              自动检查更新
            </label>
          </div>
          <Choices
            name="settings-open-file"
            label="打开文件"
            choices={OPEN_FILE}
            value={settings.openFile}
            onChange={(openFile) => onChange({ openFile })}
          />
          <Choices
            name="settings-startup"
            label="启动时"
            choices={STARTUP}
            value={settings.startup}
            onChange={(startup) => onChange({ startup })}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={props.onReset}>
            恢复默认
          </button>
          <button value="close" className="primary">
            关闭
          </button>
        </div>
      </form>
    </dialog>
  );
}
