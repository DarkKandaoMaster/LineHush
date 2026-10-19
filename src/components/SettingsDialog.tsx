import { useEffect, useState, type KeyboardEvent, type Ref } from "react";
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type Settings,
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
/** In pt; 10 is the default (same as Notepad). */
const SIZES = [9, 10, 10.5, 11, 12, 14];

interface Props {
  dialogRef: Ref<HTMLDialogElement>;
  settings: Settings;
  onChange: (partial: Partial<Settings>) => void;
  onReset: () => void;
  /** After the dialog closed (button or Esc). */
  onClose: () => void;
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
