import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CAPTION_HOVER, physicalRect, setCaptionButtons } from "../core/native";
import type { Tab } from "../core/tabs";
import TabBar from "./TabBar";

interface Props {
  tabs: Tab[];
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /**
   * 有对话框开着：标签栏 inert，整条盖上与遮罩同色的半透明层（原图预览为深色 "dark"），
   * 标题按钮与拖动区照常可用。
   */
  dimmed: false | "light" | "dark";
  /** 关闭按钮；由 App 决定对话框开着时怎么办（见 useDialogs.closeWindow）。 */
  onCloseWindow: () => void;
}

/** 按下标题按钮不能把焦点从编辑器拿走。 */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * 自绘标题栏，参照 Win11 记事本：左侧标签栏（含末尾“+”），中间空白可拖动、双击最大化 /
 * 还原，右侧 最小化 / 最大化（还原）/ 关闭。不画标题文字与应用图标；窗口标题仍由
 * `setTitle` 设置，供任务栏显示。窗口失焦时标签文字与按钮图标变淡。
 */
export default function TitleBar(props: Props) {
  const caption = useCaption();
  return (
    <div
      className={`titlebar${caption.focused ? "" : " inactive"}${props.dimmed ? " dimmed" : ""}${props.dimmed === "dark" ? " dark" : ""}`}
      data-tauri-drag-region
    >
      <TabBar
        tabs={props.tabs}
        active={props.active}
        onActivate={props.onActivate}
        onClose={props.onClose}
        onNew={props.onNew}
        inert={!!props.dimmed}
      />
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="caption-buttons">
        <button
          className="caption-min"
          title="最小化"
          aria-label="最小化"
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={() => void getCurrentWindow().minimize()}
        >
          <MinimizeIcon />
        </button>
        <button
          ref={caption.maximizeButton}
          className={`caption-max${caption.hover ? " hover" : ""}${caption.pressed ? " pressed" : ""}`}
          title={caption.maximized ? "向下还原" : "最大化"}
          aria-label={caption.maximized ? "向下还原" : "最大化"}
          tabIndex={-1}
          onMouseDown={keepFocus}
          // 覆盖窗口就位后点击由 Rust 处理，这里只在它还没就位时起作用。
          onClick={() => void getCurrentWindow().toggleMaximize()}
        >
          {caption.maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          className="caption-close"
          title="关闭"
          aria-label="关闭"
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={props.onCloseWindow}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

interface CaptionState {
  focused: boolean;
  maximized: boolean;
  /** Rust 报告的最大化按钮悬停 / 按下（鼠标在覆盖窗口上时网页收不到鼠标事件）。 */
  hover: boolean;
  pressed: boolean;
  maximizeButton: RefObject<HTMLButtonElement | null>;
}

/**
 * 跟踪窗口焦点、最大化状态与最大化按钮的悬停，并把最大化按钮的位置（客户区物理
 * 像素）报给 Rust，供贴靠布局（Snap layouts）的覆盖窗口使用（见 caption.rs）。
 */
function useCaption(): CaptionState {
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [maximized, setMaximized] = useState(false);
  const [hover, setHover] = useState({ hover: false, pressed: false });
  const maximizeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const current = getCurrentWindow();
    let active = true;
    const removers: (() => void)[] = [];
    const keep = (remove: () => void) => {
      if (active) removers.push(remove);
      else remove();
    };
    const syncMaximized = () =>
      void current
        .isMaximized()
        .then((value) => active && setMaximized(value))
        .catch(console.error);
    syncMaximized();
    void current
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then(keep, console.error);
    void current.onResized(syncMaximized).then(keep, console.error);
    void current
      .listen<{ button: string | null; pressed: boolean }>(
        CAPTION_HOVER,
        ({ payload }) =>
          setHover({
            hover: payload.button === "maximize",
            pressed: payload.pressed,
          }),
      )
      .then(keep, console.error);
    return () => {
      active = false;
      removers.splice(0).forEach((remove) => remove());
    };
  }, []);

  // 最大化按钮的位置：布局、窗口大小或缩放比例变化时重新上报。
  useEffect(() => {
    const button = maximizeButton.current;
    if (!button) return;
    let last = "";
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = physicalRect(button);
        const key = JSON.stringify(rect);
        if (key === last) return;
        last = key;
        setCaptionButtons(rect).catch((e) => {
          last = "";
          console.error(e);
        });
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(button);
    observer.observe(document.documentElement);
    window.addEventListener("resize", report);
    // 拖到缩放比例不同的显示器上时，CSS 尺寸可能不变而物理像素变了。
    let media: MediaQueryList | undefined;
    const watchScale = () => {
      media?.removeEventListener("change", onScale);
      media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", onScale);
    };
    function onScale() {
      watchScale();
      report();
    }
    watchScale();
    report();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", report);
      media?.removeEventListener("change", onScale);
    };
  }, []);

  return { focused, maximized, ...hover, maximizeButton };
}

/*
 * 标题按钮图标：仿 Segoe Fluent Icons 的 10×10 线条字形，用内联 SVG 画，不依赖字体。
 */
function CaptionIcon(props: { children: ReactNode }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}
function MinimizeIcon() {
  return (
    <CaptionIcon>
      <path d="M0 5.5H10" />
    </CaptionIcon>
  );
}
function MaximizeIcon() {
  return (
    <CaptionIcon>
      <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
    </CaptionIcon>
  );
}
/** 还原：前面一个方框，右上方露出后面方框的两条边。 */
function RestoreIcon() {
  return (
    <CaptionIcon>
      <rect x="0.5" y="2.5" width="7" height="7" rx="1.25" />
      <path d="M2.5 2.5V2A1.5 1.5 0 0 1 4 0.5H8A1.5 1.5 0 0 1 9.5 2V6A1.5 1.5 0 0 1 8 7.5H7.5" />
    </CaptionIcon>
  );
}
function CloseIcon() {
  return (
    <CaptionIcon>
      <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" />
    </CaptionIcon>
  );
}
