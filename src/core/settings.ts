// User preferences: defaults, clamping and the CSS variables they set. Run
// directly by Node in `pnpm test`, so only erasable TypeScript here.

export interface Settings {
  /** One font name, or (with a comma or quote) a full CSS font-family list. */
  fontFamily: string;
  /**
   * Editor text size in pt (1 pt = 4/3 CSS px), at most one decimal, in
   * MIN_FONT_SIZE..MAX_FONT_SIZE. Older files stored `fontSize` in px.
   */
  fontSizePt: number;
}

/**
 * Keep in step with `Settings::default` in src-tauri/src/settings.rs. "微软雅黑"
 * is Microsoft YaHei (not the UI variant); WebView2 finds fonts by their
 * Chinese names itself.
 */
export const DEFAULT_SETTINGS: Settings = {
  fontFamily: "微软雅黑",
  fontSizePt: 10,
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
 * empty font is the default. A file without `fontSizePt` but with the older
 * `fontSize` (px) has it converted (× 0.75).
 */
export function normalizeSettings(value: unknown): Settings {
  const input = (typeof value === "object" && value !== null ? value : {}) as {
    fontFamily?: unknown;
    fontSizePt?: unknown;
    fontSize?: unknown;
  };
  const family =
    typeof input.fontFamily === "string" ? input.fontFamily.trim() : "";
  const size =
    input.fontSizePt === undefined && typeof input.fontSize === "number"
      ? input.fontSize * 0.75
      : Number(input.fontSizePt);
  return {
    fontFamily: family || DEFAULT_SETTINGS.fontFamily,
    fontSizePt: Number.isFinite(size)
      ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size * 10) / 10))
      : DEFAULT_SETTINGS.fontSizePt,
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
