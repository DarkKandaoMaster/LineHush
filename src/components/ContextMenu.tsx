import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContextMenuState, MenuCommand } from "../hooks/useContextMenu";
import { isMenuKey } from "../hooks/useContextMenu";

interface Props {
  menu: ContextMenuState;
  onRun: (command: MenuCommand) => void;
  onClose: () => void;
}

type Item = { command: MenuCommand; label: string; shortcut: string } | "separator";
/** 照 Win11 记事本编辑区的右键菜单（去掉了本应用没有的项）。 */
const ITEMS: Item[] = [
  { command: "undo", label: "撤消", shortcut: "Ctrl+Z" },
  { command: "redo", label: "重做", shortcut: "Ctrl+Y" },
  "separator",
  { command: "cut", label: "剪切", shortcut: "Ctrl+X" },
  { command: "copy", label: "复制", shortcut: "Ctrl+C" },
  { command: "paste", label: "粘贴", shortcut: "Ctrl+V" },
  { command: "delete", label: "删除", shortcut: "Del" },
  "separator",
  { command: "selectAll", label: "全选", shortcut: "Ctrl+A" },
  "separator",
  { command: "find", label: "查找", shortcut: "Ctrl+F" },
  { command: "replace", label: "替换", shortcut: "Ctrl+H" },
];
const COMMANDS = ITEMS.flatMap((item) => (item === "separator" ? [] : [item.command]));

function enabled(menu: ContextMenuState, command: MenuCommand) {
  if (!menu.editable && !["copy", "selectAll", "find"].includes(command)) return false;
  switch (command) {
    case "undo":
      return menu.canUndo;
    case "redo":
      return menu.canRedo;
    case "cut":
    case "copy":
    case "delete":
      return menu.hasSelection;
    case "paste":
      return menu.canPaste;
    default:
      return true;
  }
}
/** 菜单与视口边缘至少留出的距离（CSS 像素）。 */
const EDGE = 4;

/**
 * 编辑区的右键菜单（状态与动作见 hooks/useContextMenu.ts）：左上角在指针（或光标）处，
 * 右边 / 下边放不下时向左 / 向上翻，再夹在视口内。点菜单外、Esc、窗口失焦、滚动、
 * 改变窗口大小时关闭。焦点一直留在编辑器里（各项在 mousedown 上 preventDefault），
 * 菜单开着时 ↑ ↓ / Home / End 移动高亮、Enter / 空格执行，其余按键关掉菜单后照常生效。
 */
export default function ContextMenu({ menu, onRun, onClose }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const usable = COMMANDS.filter((command) => enabled(menu, command));
  const [active, setActive] = useState<MenuCommand | null>(
    menu.keyboard ? (usable[0] ?? null) : null,
  );

  useLayoutEffect(() => {
    const box = element.current!.getBoundingClientRect();
    const fit = (at: number, size: number, room: number) => {
      const flipped = at + size > room - EDGE ? at - size : at;
      return Math.max(EDGE, Math.min(flipped, room - EDGE - size));
    };
    setPlace({
      left: fit(menu.x, box.width, window.innerWidth),
      top: fit(menu.y, box.height, window.innerHeight),
    });
  }, [menu]);

  // 读最新的高亮与动作（监听只在打开时注册一次）。
  const latest = useRef({ active, usable, onRun, onClose });
  latest.current = { active, usable, onRun, onClose };
  useEffect(() => {
    const outside = (event: Event) => {
      if (!element.current?.contains(event.target as Node)) latest.current.onClose();
    };
    const close = () => latest.current.onClose();
    const keydown = (event: KeyboardEvent) => {
      const { active, usable, onRun, onClose } = latest.current;
      const move = (to: MenuCommand | undefined) => {
        event.preventDefault();
        event.stopPropagation();
        if (to) setActive(to);
      };
      const at = active ? usable.indexOf(active) : -1;
      switch (event.key) {
        case "ArrowDown":
          return move(usable[(at + 1) % usable.length]);
        case "ArrowUp":
          return move(usable[at <= 0 ? usable.length - 1 : at - 1]);
        case "Home":
          return move(usable[0]);
        case "End":
          return move(usable[usable.length - 1]);
        case "Enter":
        case " ":
          move(undefined);
          if (active) onRun(active);
          else onClose();
          return;
        case "Escape":
          move(undefined);
          onClose();
          return;
      }
      // 再按一次 Shift+F10 / 菜单键：关掉，由它重新打开。
      if (isMenuKey(event) || !["Shift", "Control", "Alt", "Meta"].includes(event.key)) onClose();
    };
    // 捕获阶段：先于编辑器与窗口的快捷键（Esc 不再去关查找条）。
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("wheel", outside, true);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("wheel", outside, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, []);

  return (
    <div
      ref={element}
      className="context-menu"
      role="menu"
      aria-label="编辑"
      style={
        place
          ? { left: place.left, top: place.top }
          : { left: menu.x, top: menu.y, visibility: "hidden" }
      }
      // 不抢焦点：焦点与 DOM 选区留在编辑器里（剪切 / 复制 / 粘贴作用在它上面）。
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {ITEMS.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={item.command}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={active === item.command ? "active" : undefined}
            disabled={!enabled(menu, item.command)}
            onPointerEnter={() => setActive(enabled(menu, item.command) ? item.command : null)}
            onPointerLeave={() => setActive(null)}
            onClick={() => onRun(item.command)}
          >
            <span className="context-menu-label">{item.label}</span>
            <span className="context-menu-shortcut">{item.shortcut}</span>
          </button>
        ),
      )}
    </div>
  );
}
