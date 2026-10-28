import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { redo, redoDepth, undo, undoDepth } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/react";
import {
  CONTEXT_MENU_REQUESTED,
  contextMenuCommand,
  contextMenuDismiss,
  contextMenuNative,
  nativeContextMenu,
  type ContextMenuRequested,
} from "../core/native";
import type { Tabs } from "../core/tabs";
import type { DiaryEditorHandle } from "../editor/DiaryEditor";
import { drawnCaret } from "../editor/caret-geometry";
import { removeNear } from "../editor/image-view";
import { headSide, keyboardInput, readDOMSelection } from "../editor/input";
import { findCommandsOf } from "./useFind";

/** 编辑区右键菜单的项（照 Win11 记事本的编辑区菜单）。 */
export type EditorCommand =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "delete"
  | "selectAll"
  | "find"
  | "replace";
/** 标签页右键菜单的项（照 Win11 记事本的标签页菜单）。 */
export type TabCommand = "newTab" | "closeTab" | "closeOthers" | "closeRight" | "reveal";
export type MenuCommand = EditorCommand | TabCommand;

/** 一个打开着的右键菜单：位置（视口 CSS 像素，菜单左上角）、所属标签页与各项是否可用。 */
interface MenuBase {
  /** 第几次打开（换一个就重建菜单）。 */
  serial: number;
  x: number;
  y: number;
  /** 编辑区菜单：当前标签页；标签页菜单：右键的那个标签页（不一定是当前的）。 */
  tab: string;
  /** 用键盘（Shift+F10 / 菜单键）打开：先高亮第一个可用项。 */
  keyboard: boolean;
  /** Rust 挂起的菜单请求（没有 Rust 时为 null），关菜单时以它完成。 */
  request: number | null;
}
/** 编辑区的菜单。 */
export interface EditorMenuState extends MenuBase {
  kind: "editor";
  canUndo: boolean;
  canRedo: boolean;
  /** 有选区：剪切、复制、删除可用。 */
  hasSelection: boolean;
  canPaste: boolean;
  /** 编辑器可编辑（保存等进行中时不可）：否则只有复制、全选、查找可用。 */
  editable: boolean;
}
/** 标签栏里某个标签页的菜单。 */
export interface TabMenuState extends MenuBase {
  kind: "tab";
  /** 窗口里还有别的标签页：“关闭其他标签页”可用。 */
  canCloseOthers: boolean;
  /** 它右边还有标签页：“关闭右侧标签页”可用。 */
  canCloseRight: boolean;
  /** 它有文件（不是“无标题”）：“打开文件所在位置”可用。 */
  canReveal: boolean;
}
export type ContextMenuState = EditorMenuState | TabMenuState;

/** 各标签页的编辑器（TabPane 登记），菜单的动作作用在打开菜单的那个标签页上。 */
const editors = new Map<string, RefObject<DiaryEditorHandle | null>>();
/** TabPane 登记自己的编辑器，供右键菜单使用。 */
export function useContextMenuTarget(
  tab: string,
  editor: RefObject<DiaryEditorHandle | null>,
) {
  useEffect(() => {
    editors.set(tab, editor);
    return () => {
      if (editors.get(tab) === editor) editors.delete(tab);
    };
  }, [tab, editor]);
}
const editorOf = (tab: string): Editor | null => {
  const editor = editors.get(tab)?.current?.editor;
  return editor && !editor.isDestroyed ? editor : null;
};

/** Shift+F10 或菜单键（Windows 打开右键菜单的键）。 */
export const isMenuKey = (event: KeyboardEvent) =>
  !event.ctrlKey &&
  !event.altKey &&
  !event.metaKey &&
  (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey));

const elementOf = (target: EventTarget | null) =>
  target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
/** 右键落在标签栏的哪个标签页上（含它的 × 按钮）；不在标签页上为 undefined。 */
const tabAt = (target: EventTarget | null) =>
  elementOf(target)?.closest<HTMLElement>(".tabbar .tab[data-tab]")?.dataset.tab;

/**
 * 右键或菜单键落在哪：编辑区（自绘菜单）、标签栏的标签页（自绘的标签页菜单）、
 * 输入框（WebView2 自带的菜单）、别处（不弹菜单）。
 */
function placeOf(target: EventTarget | null, tabs: Tabs): "editor" | "tab" | "input" | "none" {
  const element = elementOf(target);
  if (!element) return "none";
  if (element.closest("input, textarea")) return "input";
  // 对话框开着时页面其余部分 inert（useDialogs），不弹菜单。
  if (document.querySelector("dialog[open]")) return "none";
  // 标签栏里的标签页（标签之间与 + 按钮等空白处不算）。
  if (tabAt(element) !== undefined) return "tab";
  const tab = tabs.activeTab()?.id;
  if (tab === undefined || !editorOf(tab)) return "none";
  // 当前标签页的编辑区：正文、图片、左栏、下方空白；查找条（输入框以外）不算。
  const area = element.closest(".tab-pane:not([hidden]) .editor-area");
  return area && !element.closest(".find-widget") ? "editor" : "none";
}

/**
 * 编辑区的右键菜单（照 Win11 记事本，components/ContextMenu.tsx 画），代替 WebView2 自带的。
 *
 * - 编辑区里右键或按 Shift+F10 / 菜单键：真实窗口里 contextmenu 事件照常通过，WebView2 的
 *   菜单请求由 Rust 挂起后发来 `context-menu-requested`（src-tauri/src/context_menu.rs），
 *   这时按刚才的 contextmenu 事件弹出菜单；“粘贴”交回 WebView2 执行（网页脚本粘贴不了），
 *   关菜单或选别的项时以“不选命令”完成请求。没有 Rust 时（浏览器测试）直接响应 contextmenu。
 * - 标签栏的标签页上右键：标签页菜单（新建 / 关闭 / 关闭其他 / 关闭右侧 / 打开文件所在位置），
 *   作用在右键的那个标签页上，不切换标签页；与编辑区菜单同样经 Rust 的请求弹出。标签页不可聚焦，
 *   没有键盘打开的方式。
 * - 输入框里（查找条、设置）：WebView2 自带的菜单。其余地方（标签栏空白、工具栏、状态栏、
 *   对话框……）：什么菜单也不弹。
 * - 用键盘打开时菜单在光标处，否则在指针处。
 */
export function useContextMenu(tabs: Tabs) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const current = useRef(menu);
  const show = (next: ContextMenuState | null) => {
    current.current = next;
    setMenu(next);
  };

  useEffect(() => {
    const native = nativeContextMenu();
    /** 刚才那个通过了的 contextmenu 事件，等 Rust 的请求来了按它弹菜单。 */
    let waiting:
      | { place: "editor"; x: number; y: number; keyboard: boolean }
      | { place: "tab"; tab: string; x: number; y: number; keyboard: boolean }
      | { place: "input" }
      | null = null;
    /** 刚按过 Shift+F10 / 菜单键：接下来的 contextmenu 由键盘引起。 */
    let menuKey = false;
    let serial = 0;
    /**
     * 右键按在左栏或图片上：WebView2 把那里当作不可编辑处（左栏是盖在正文上的透明层，图片是
     * contenteditable=false），它的菜单里就没有“粘贴”。按下后到 contextmenu 为止让这两样
     * 不接收指针（.context-target），contextmenu 的命中落到下面的正文上（光标照常：按在选区外
     * 时移过去）。
     */
    let target: Element | null = null;
    let release = 0;
    const clearTarget = () => {
      window.clearTimeout(release);
      target?.classList.remove("context-target");
      target = null;
    };

    function open(
      at: { x: number; y: number; keyboard: boolean },
      canPaste: boolean,
      request: number | null,
    ) {
      const tab = tabs.activeTab()?.id;
      const editor = tab === undefined ? null : editorOf(tab);
      if (tab === undefined || !editor || document.querySelector("dialog[open]")) {
        if (request !== null) void contextMenuDismiss(request).catch(console.error);
        return;
      }
      const { view } = editor;
      // 右键按在选区外时浏览器刚把光标移到那里，它的 selectionchange 还没到 ProseMirror。
      readDOMSelection(view);
      const { state } = view;
      let { x, y } = at;
      if (at.keyboard) {
        // 光标处（自绘光标的下端；选中图片等没有光标时在编辑区左上角）。
        const spot = drawnCaret(view, headSide(view));
        const box = view.dom.getBoundingClientRect();
        x = spot ? spot.x : box.left;
        y = spot ? spot.bottom : box.top;
      }
      // 还开着的上一个菜单就此换掉（它挂起的请求已由 Rust 在新请求到来时了结）。
      show({
        kind: "editor",
        serial: ++serial,
        x,
        y,
        tab,
        keyboard: at.keyboard,
        canUndo: undoDepth(state) > 0,
        canRedo: redoDepth(state) > 0,
        hasSelection: !state.selection.empty,
        canPaste,
        editable: view.editable,
        request,
      });
    }
    /** 标签页 `at.tab` 的菜单（不切换标签页）。 */
    function openTab(
      at: { tab: string; x: number; y: number; keyboard: boolean },
      request: number | null,
    ) {
      const list = tabs.getSnapshot().tabs;
      const index = list.findIndex((tab) => tab.id === at.tab);
      if (index < 0 || document.querySelector("dialog[open]")) {
        if (request !== null) void contextMenuDismiss(request).catch(console.error);
        return;
      }
      show({
        kind: "tab",
        serial: ++serial,
        x: at.x,
        y: at.y,
        tab: at.tab,
        keyboard: at.keyboard,
        request,
        canCloseOthers: list.length > 1,
        canCloseRight: index < list.length - 1,
        canReveal: list[index].session.getSnapshot().path !== null,
      });
    }

    function contextmenu(event: MouseEvent) {
      // 菜单内容按这次命中生成之后再恢复（见 pointerdown）。
      if (target) {
        window.clearTimeout(release);
        release = window.setTimeout(clearTarget, 0);
      }
      const keyboard = menuKey || event.button !== 2;
      menuKey = false;
      const place = placeOf(event.target, tabs);
      if (place === "input") {
        // 自带的菜单（真实窗口里经 Rust：先要完成它挂起的请求）。
        waiting = native ? { place } : null;
        return;
      }
      if (place === "none") {
        event.preventDefault();
        return;
      }
      const at = { x: event.clientX, y: event.clientY, keyboard };
      if (place === "tab") {
        const tab = tabAt(event.target)!;
        if (native) waiting = { place, tab, ...at };
        else {
          event.preventDefault();
          openTab({ tab, ...at }, null);
        }
        return;
      }
      if (native) waiting = { place, ...at };
      else {
        event.preventDefault();
        open(at, false, null);
      }
    }
    function keydown(event: KeyboardEvent) {
      if (!isMenuKey(event) || event.isComposing) return;
      menuKey = true;
      // 没有 Rust 时不等浏览器的 contextmenu（无头浏览器里按键不一定引起它），直接弹出。
      if (!native && placeOf(document.activeElement, tabs) === "editor") {
        event.preventDefault();
        menuKey = false;
        open({ x: 0, y: 0, keyboard: true }, false, null);
      }
    }
    function pointerdown(event: PointerEvent) {
      menuKey = false;
      clearTarget();
      if (event.button !== 2 || !(event.target instanceof Element)) return;
      if (!event.target.closest(".margin-gutter, .image-item")) return;
      if (placeOf(event.target, tabs) !== "editor") return;
      target = event.target.closest(".editor-area");
      target?.classList.add("context-target");
    }
    function pointerup() {
      // contextmenu 在松开后才来（Windows）；没来（例如拖出窗口）也不留着。
      if (target) release = window.setTimeout(clearTarget, 500);
    }
    window.addEventListener("contextmenu", contextmenu, true);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("pointerdown", pointerdown, true);
    window.addEventListener("pointerup", pointerup, true);

    let active = true;
    let unlisten: (() => void) | undefined;
    if (native)
      getCurrentWindow()
        .listen<ContextMenuRequested>(CONTEXT_MENU_REQUESTED, ({ payload }) => {
          const at = waiting;
          waiting = null;
          if (at?.place === "editor") open(at, payload.canPaste, payload.id);
          else if (at?.place === "tab") openTab(at, payload.id);
          else if (at?.place === "input") void contextMenuNative(payload.id).catch(console.error);
          else void contextMenuDismiss(payload.id).catch(console.error);
        })
        .then((remove) => {
          if (active) unlisten = remove;
          else remove();
        })
        .catch(console.error);
    return () => {
      active = false;
      unlisten?.();
      window.removeEventListener("contextmenu", contextmenu, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("pointerdown", pointerdown, true);
      window.removeEventListener("pointerup", pointerup, true);
      clearTarget();
    };
  }, [tabs]);

  /** 关掉菜单（点外面、Esc、失焦、滚动），不执行任何项。 */
  const close = useCallback(() => {
    const open = current.current;
    if (!open) return;
    show(null);
    if (open.request !== null) void contextMenuDismiss(open.request).catch(console.error);
  }, []);

  /**
   * 执行一项。须在点击处理里同步调用：剪切 / 复制用 `execCommand`，只在用户操作里有效，
   * 且焦点与 DOM 选区要还在编辑器里（菜单在 mousedown 上 preventDefault，不抢焦点）。
   */
  const run = useCallback((command: MenuCommand) => {
    const open = current.current;
    if (!open) return;
    show(null);
    const finish = () => {
      if (open.request !== null) void contextMenuDismiss(open.request).catch(console.error);
    };
    if (open.kind === "tab") {
      finish();
      // 关闭类走现有的关闭流程（有修改时照常询问）。
      if (command === "newTab") void tabs.newTab();
      else if (command === "closeTab") void tabs.closeTab(open.tab);
      else if (command === "closeOthers") void tabs.closeTabs(open.tab, "others");
      else if (command === "closeRight") void tabs.closeTabs(open.tab, "right");
      else if (command === "reveal") void tabs.revealTab(open.tab);
      return;
    }
    const editor = editorOf(open.tab);
    if (!editor) return finish();
    const { view } = editor;
    if (command === "paste") {
      if (open.request !== null)
        void contextMenuCommand(open.request, "paste").catch(console.error);
      return;
    }
    finish();
    if (command === "find" || command === "replace") {
      const find = findCommandsOf(open.tab);
      if (command === "find") find?.find();
      else find?.replace();
      return;
    }
    if (!view.hasFocus()) view.focus();
    if (command === "cut" || command === "copy") {
      // 走编辑器现有的 copy / cut 事件处理（图片、图文混合、纯文字），与 Ctrl+C / Ctrl+X 相同。
      document.execCommand(command);
      return;
    }
    if (!view.editable) return;
    // 与对应按键一样记为键盘操作（滚动揭示保留安全区）。
    keyboardInput(view);
    if (command === "undo") undo(view.state, view.dispatch);
    else if (command === "redo") redo(view.state, view.dispatch);
    else if (command === "selectAll") editor.commands.selectAll();
    // Delete 键：选中的图片 / 块间范围走图片的删除规则，文字选区照常删除。
    else if (command === "delete")
      removeNear(1)(view.state, view.dispatch, view) || editor.commands.deleteSelection();
  }, [tabs]);

  return { menu, close, run };
}
