// User preferences: defaults, clamping and the CSS variables they set. Run
// directly by Node in `pnpm test`, so only erasable TypeScript here.

export interface Settings {
  /** One font name, or (with a comma or quote) a full CSS font-family list. */
  fontFamily: string;
  /**
   * Editor text size in pt (1 pt = 4/3 CSS px), at most one decimal, in
   * MIN_FONT_SIZE..MAX_FONT_SIZE.
   */
  fontSizePt: number;
  /**
   * 打开文件（双击 .hush、再次启动时带文件）：在最近使用的窗口里开新标签页，
   * 还是开新窗口。Ctrl+O 不受影响。
   */
  openFile: OpenFile;
  /**
   * 启动时：新建一个窗口（只恢复程序意外退出时留下的未保存修改），还是恢复上次
   * 关闭时的全部窗口与标签页。为后者时关闭最后一个窗口不询问保存，修改留到下次。
   */
  startup: Startup;
  /**
   * 光标粗细：“细”跟随 Windows 的文本光标粗细设置（默认 1 屏幕像素），“中”为其
   * 2 倍，“粗”为其 3 倍（默认设置下 3 屏幕像素，即 VS Code 在 150% 缩放下的样子），不设上限。
   * 都以屏幕像素计，不随缩放放大；
   * 见 src/editor/caret-math.ts 的 `caretWidth`。
   */
  caretWidth: CaretWidth;
  /**
   * 选区边角：“圆角”像 VS Code（半径 3 CSS px，外角与宽度变化处的内角都圆），
   * “方角”为同一个形状、半径 0。都由编辑器自己画（src/editor/caret.ts），
   * 不切回浏览器的原生选区。
   */
  selectionCorners: SelectionCorners;
  /**
   * 左栏选行：在编辑区左侧的内边距（左栏）单击 / 拖动时，“整行”选整个逻辑行（一个文字段落，
   * 或一整行图片），“视觉行”只选指针所在的那一折（软折行的一个行盒，或折行后的那一排图片）。
   * 都包含行尾的换行；见 src/editor/margin.ts。
   */
  marginSelection: MarginSelection;
  /**
   * 默认文件名：无标题笔记第一次保存（及另存为）时保存对话框里预填的名字。“日期”为
   * YYYY-MM-DD，“首行文字”取正文第一行有字的文字（去掉文件名不允许的字符，最多 30 个字，
   * 为空时退回日期）；见 src/core/document.ts 的 `suggestedName`。名字已被占用时由 Rust
   * 加 “ (2)”“ (3)”…（`suggest_save_path`）。
   */
  defaultFileName: DefaultFileName;
  /**
   * 自动检查更新：每次启动约 3 秒后由 Rust 检查一次 GitHub 上的最新正式版，有新版本才弹出
   * 更新对话框；没有新版本或网络不通时什么也不显示。见 src-tauri/src/update.rs。
   */
  checkUpdates: boolean;
}
export type CaretWidth = "thin" | "medium" | "thick";
const CARET_WIDTH_VALUES: readonly CaretWidth[] = ["thin", "medium", "thick"];
export type SelectionCorners = "square" | "rounded";
const SELECTION_CORNERS_VALUES: readonly SelectionCorners[] = ["square", "rounded"];
export type MarginSelection = "line" | "visualLine";
const MARGIN_SELECTION_VALUES: readonly MarginSelection[] = ["line", "visualLine"];
export type DefaultFileName = "date" | "firstLine";
const DEFAULT_FILE_NAME_VALUES: readonly DefaultFileName[] = ["date", "firstLine"];
export type OpenFile = "tab" | "window";
const OPEN_FILE_VALUES: readonly OpenFile[] = ["tab", "window"];
export type Startup = "newWindow" | "lastSession";
const STARTUP_VALUES: readonly Startup[] = ["newWindow", "lastSession"];

/**
 * Rust stores settings.json as it is and only reads `openFile`, `startup` and
 * `checkUpdates`, taking "tab", "newWindow" and true for anything else
 * (src-tauri/src/settings.rs);
 * every other check happens here. "微软雅黑" is Microsoft YaHei (not the UI
 * variant); WebView2 finds fonts by their Chinese names itself.
 */
export const DEFAULT_SETTINGS: Settings = {
  fontFamily: "微软雅黑",
  fontSizePt: 10,
  openFile: "tab",
  startup: "newWindow",
  caretWidth: "thin",
  selectionCorners: "rounded",
  marginSelection: "line",
  defaultFileName: "date",
  checkUpdates: true,
};
/** In pt. */
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 30;
/** Used after the chosen font, so missing fonts and Chinese text still look right. */
const FALLBACK_FONTS = [
  "Microsoft YaHei UI",
  "Microsoft YaHei",
  "Segoe UI",
  "sans-serif",
];

/**
 * Any stored or typed value made valid: size rounded to 0.1 and clamped, an
 * empty font is the default, an unknown `openFile`, `startup`, `caretWidth`,
 * `selectionCorners`, `marginSelection` or `defaultFileName` is the default;
 * `checkUpdates` is off only when it is `false`.
 */
export function normalizeSettings(value: unknown): Settings {
  const input = (typeof value === "object" && value !== null ? value : {}) as {
    fontFamily?: unknown;
    fontSizePt?: unknown;
    openFile?: unknown;
    startup?: unknown;
    caretWidth?: unknown;
    selectionCorners?: unknown;
    marginSelection?: unknown;
    defaultFileName?: unknown;
    checkUpdates?: unknown;
  };
  const family =
    typeof input.fontFamily === "string" ? input.fontFamily.trim() : "";
  const size = Number(input.fontSizePt);
  return {
    fontFamily: family || DEFAULT_SETTINGS.fontFamily,
    fontSizePt: Number.isFinite(size)
      ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size * 10) / 10))
      : DEFAULT_SETTINGS.fontSizePt,
    openFile: OPEN_FILE_VALUES.find((value) => value === input.openFile) ??
      DEFAULT_SETTINGS.openFile,
    startup: STARTUP_VALUES.find((value) => value === input.startup) ??
      DEFAULT_SETTINGS.startup,
    caretWidth: CARET_WIDTH_VALUES.find((value) => value === input.caretWidth) ??
      DEFAULT_SETTINGS.caretWidth,
    selectionCorners:
      SELECTION_CORNERS_VALUES.find((value) => value === input.selectionCorners) ??
      DEFAULT_SETTINGS.selectionCorners,
    marginSelection:
      MARGIN_SELECTION_VALUES.find((value) => value === input.marginSelection) ??
      DEFAULT_SETTINGS.marginSelection,
    defaultFileName:
      DEFAULT_FILE_NAME_VALUES.find((value) => value === input.defaultFileName) ??
      DEFAULT_SETTINGS.defaultFileName,
    checkUpdates:
      typeof input.checkUpdates === "boolean"
        ? input.checkUpdates
        : DEFAULT_SETTINGS.checkUpdates,
  };
}

/**
 * Names WebView2 cannot find. Chinese font names (微软雅黑, 等线, 宋体, 新宋体,
 * 黑体, 楷体, 仿宋, …) resolve as they are (tested 2026-10-19), but "微软雅黑 UI"
 * is not a real name of Microsoft YaHei UI. The settings file keeps what was
 * typed; only the CSS uses the alias.
 */
const FONT_ALIASES: Record<string, string> = {
  "微软雅黑 ui": "Microsoft YaHei UI",
};

/** A single name is quoted and followed by the fallbacks; a list is used as written. */
export function cssFontFamily(fontFamily: string) {
  if (/[,"']/.test(fontFamily)) return fontFamily;
  const font =
    FONT_ALIASES[fontFamily.replace(/\s+/g, " ").toLowerCase()] ?? fontFamily;
  const fonts = [
    font,
    ...FALLBACK_FONTS.filter(
      (fallback) => fallback.toLowerCase() !== font.toLowerCase(),
    ),
  ];
  return fonts
    .map((name) => (name === "sans-serif" ? name : `"${name}"`))
    .join(", ");
}

/** The CSS variables App.css reads in `.tiptap`. */
export function cssVariables(settings: Settings): Record<string, string> {
  return {
    "--editor-font-family": cssFontFamily(settings.fontFamily),
    "--editor-font-size": `${settings.fontSizePt}pt`,
  };
}

/** Writes the variables to an element's style, e.g. `document.documentElement.style`. */
export function applySettings(
  style: { setProperty: (name: string, value: string) => void },
  settings: Settings,
) {
  for (const [name, value] of Object.entries(cssVariables(settings)))
    style.setProperty(name, value);
}
