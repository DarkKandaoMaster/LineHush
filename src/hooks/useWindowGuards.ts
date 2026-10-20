import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Tabs } from "../core/tabs";

/** The letter of Ctrl+<letter>, also when an input method reports the key as "Process". */
function letterOf(event: KeyboardEvent) {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  return /^Key([A-Z])$/.exec(event.code)?.[1].toLowerCase();
}

/**
 * Loads the window's tabs, then registers the shortcuts (Ctrl+N new tab,
 * Ctrl+Shift+N new window, Ctrl+O,
 * Ctrl+S / Ctrl+Shift+S, Ctrl+W close tab, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9),
 * the close guard and the requests from Rust (a file to open, a tab to show).
 * Registration waits for initialize(); `active` makes the StrictMode
 * mount → unmount → mount cycle register each listener exactly once.
 */
export function useWindowGuards(tabs: Tabs) {
  const { desktop } = tabs;
  useEffect(() => {
    let active = true;
    const removers: (() => void)[] = [];
    const keep = (remove: () => void) => {
      if (active) removers.push(remove);
      else remove();
    };
    function keydown(event: KeyboardEvent) {
      if (
        event.isComposing ||
        !(event.ctrlKey || event.metaKey) ||
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
      if (!desktop) return;
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
  }, [desktop, tabs]);
}
