import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { letterOf } from "../core/keys";
import type { Tabs } from "../core/tabs";
import { findCommandsOf } from "./useFind";

/**
 * Loads the window's tabs, then registers the shortcuts (Ctrl+N new tab,
 * Ctrl+Shift+N new window, Ctrl+O,
 * Ctrl+S / Ctrl+Shift+S, Ctrl+W close tab, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9;
 * 查找 / 替换：Ctrl+F、Ctrl+H、F3 / Shift+F3，查找条开着时 Alt+C / Alt+W),
 * the close guard and the requests from Rust (a file to open, a tab to show).
 * Registration waits for initialize(); `active` makes the StrictMode
 * mount → unmount → mount cycle register each listener exactly once.
 */
export function useWindowGuards(tabs: Tabs) {
  useEffect(() => {
    let active = true;
    const removers: (() => void)[] = [];
    const keep = (remove: () => void) => {
      if (active) removers.push(remove);
      else remove();
    };
    /**
     * 查找 / 替换的快捷键，交给当前标签页（hooks/useFind.ts）。一律 preventDefault：
     * Ctrl+F、F3 / Shift+F3 否则会打开 WebView2 自带的页内查找条。
     */
    function findKeys(event: KeyboardEvent): boolean {
      if (event.isComposing || event.metaKey) return false;
      // 有对话框开着时不生效，但仍拦掉自带的查找条。
      const dialog = !!document.querySelector("dialog[open]");
      const find = dialog ? undefined : findCommandsOf(tabs.activeTab()?.id);
      if (event.key === "F3" && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (event.shiftKey) find?.prev();
        else find?.next();
        return true;
      }
      const letter = letterOf(event);
      if (event.ctrlKey && !event.altKey && !event.shiftKey && (letter === "f" || letter === "h")) {
        event.preventDefault();
        if (letter === "f") find?.find();
        else find?.replace();
        return true;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (letter === "c" || letter === "w") &&
        find?.isOpen()
      ) {
        event.preventDefault();
        find.toggle(letter === "c" ? "caseSensitive" : "wholeWord");
        return true;
      }
      return false;
    }
    function keydown(event: KeyboardEvent) {
      if (findKeys(event)) return;
      if (
        event.isComposing ||
        !event.ctrlKey ||
        event.altKey ||
        // An open dialog (preview, settings, "save changes?") keeps the keys.
        document.querySelector("dialog[open]")
      )
        return;
      if (event.key === "Tab") {
        event.preventDefault();
        tabs.cycle(event.shiftKey ? -1 : 1);
        return;
      }
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && !event.shiftKey) {
        event.preventDefault();
        tabs.activateIndex(Number(digit[1]));
        return;
      }
      const letter = letterOf(event);
      if (!letter || !["n", "o", "s", "w"].includes(letter)) return;
      if (letter === "n" && event.shiftKey) {
        event.preventDefault();
        void tabs.newWindow();
        return;
      }
      const current = tabs.activeTab();
      // File commands wait for a running import of the current tab.
      if (letter !== "n" && current?.session.getSnapshot().importing) return;
      event.preventDefault();
      if (letter === "n") void tabs.newTab();
      if (letter === "o") void tabs.openFile();
      if (letter === "w" && current) void tabs.closeTab(current.id);
      if (letter === "s" && current)
        void (event.shiftKey
          ? current.session.saveDocumentAs()
          : current.session.saveDocument());
    }
    void tabs.initialize().then(async () => {
      if (!active) return;
      window.addEventListener("keydown", keydown);
      removers.push(() => window.removeEventListener("keydown", keydown));
      const current = getCurrentWindow();
      try {
        keep(
          await current.onCloseRequested((event) => {
            // The tabs were released: let the window close (and window-state
            // record it) instead of asking again.
            if (tabs.closing()) return;
            event.preventDefault();
            void tabs.closeWindow();
          }),
        );
      } catch (e) {
        if (active) tabs.report(`无法启用关闭保护：${e}`);
      }
      // Events Rust sends to this window only: a file to open (double-clicked
      // while running), or the tab that already shows the file asked for.
      try {
        keep(await tabs.listen());
      } catch (e) {
        if (active) tabs.report(`无法接收要打开的文件：${e}`);
      }
      // The file LineHush was launched with, if any.
      if (active) void tabs.openRequested();
    });
    return () => {
      active = false;
      removers.splice(0).forEach((remove) => remove());
    };
  }, [tabs]);
}
